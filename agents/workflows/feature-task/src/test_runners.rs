//! Production `TestRunner` implementations + the dispatch logic that
//! routes each cited `testID` to the right runner by name shape.
//!
//! Extracted from `src/main.rs` as part of W36 A3+A4 (task `d578e547`,
//! tech design `docs/specs/feature-task-main-rs-split-tech-design.md`).
//! The sibling modules follow the same `pub(crate)` pattern that
//! `ac_parsing.rs` and `analytics.rs` already established in this crate.
//!
//! Public-to-this-crate surface (`pub(crate)`):
//!
//! - [`NpmTestRunner`], [`CargoTestRunner`], [`ShellTestRunner`],
//!   [`PytestTestRunner`], [`DispatchingTestRunner`] — five
//!   implementations of `ac_parsing::TestRunner`
//! - [`TestRunnerKind`] enum + [`select_test_runner_kind`] dispatcher
//! - [`cargo_test_leaf_outcome`] — `cargo test` stdout pass/fail verdict
//! - [`repo_root_dir`] — compile-time-resolved repo root path
//!
//! Every `#[cfg(test)] mod tests` block below is colocated with the code it
//! covers; nothing here relies on symbols defined in `main.rs` beyond the
//! crate-root items (`ac_parsing`, `test_resolution`).

use std::path::{Path, PathBuf};

use anyhow::Result;
use regex::Regex;

use crate::ac_parsing;

// ---------------------------------------------------------------------------
// Mechanical evidence gate (task 5e35dc25 — migrate Ash's mechanical
// verify.ts checks into the lobster).
//
// `NpmTestRunner` is the production implementation of the `TestRunner`
// trait declared in `ac_parsing` for JS/TS citations. It used to shell out
// to `pnpm test --filter <name>`, but this repo has never had a
// `pnpm-workspace.yaml` — only the legacy `package.json` `"workspaces"`
// field, which pnpm 10.x does not honor (`WARN The "workspaces" field in
// package.json is not supported by pnpm`), so `pnpm --filter` always
// resolved zero projects and every JS/TS citation mechanically failed
// regardless of whether the real test passed. This repo's actual JS/TS
// tooling is npm workspaces (`npm ci`, `npm test --workspace <pkg>` — see
// `.github/workflows/ci.yml`), so this runs the equivalent
// `npm test --workspace <pkg> -- -t "<test_name>"` against the workspace
// package resolved from the PR's own changed files (`resolve_npm_workspace`
// below), mirroring `PytestTestRunner`'s `nearest_pyproject_dir` approach
// for Python. A `test_name` that doesn't match any test in that workspace
// still exits 0 (vitest reports "0 passed" and treats a non-matching `-t`
// filter as nothing to do, not a failure) — the same silent-pass trap
// `cargo_test_leaf_outcome` already guards against for Rust citations
// (PR #541) — so this parses stdout for an actual "N passed" with N > 0
// before treating the run as a genuine pass.
pub(crate) struct NpmTestRunner {
    pub(crate) workspace: Option<String>,
}

/// True when vitest's default reporter output shows at least one test that
/// actually ran and passed (`Tests  N passed` with N > 0, not just
/// `N skipped`). A `-t` filter matching nothing still exits 0 with every
/// test reported "skipped" — without this check that would read as a pass.
fn has_passed_tests(stdout: &str) -> bool {
    let re = Regex::new(r"Tests\s+(\d+)\s+passed").unwrap();
    re.captures(stdout)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .is_some_and(|n| n > 0)
}

impl ac_parsing::TestRunner for NpmTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        let Some(workspace) = &self.workspace else {
            return Ok(ac_parsing::TestOutcome {
                exit_code: 1,
                stdout: String::new(),
                stderr: "no npm workspace package could be resolved from this PR's changed \
                         files; cannot run a JS/TS test citation"
                    .to_string(),
            });
        };
        let output = std::process::Command::new("npm")
            .args(["test", "--workspace", workspace, "--", "-t", test_name])
            .current_dir(repo_root_dir())
            .output()
            .map_err(|err| format!("spawn npm test --workspace {workspace}: {err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if output.status.success() && has_passed_tests(&stdout) {
            return Ok(ac_parsing::TestOutcome {
                exit_code: 0,
                stdout,
                stderr,
            });
        }
        if output.status.success() {
            // Exit 0 but nothing matched the name filter — silent-pass trap.
            return Ok(ac_parsing::TestOutcome {
                exit_code: 1,
                stdout,
                stderr: format!(
                    "no test named \"{test_name}\" matched in npm workspace \"{workspace}\" \
                     (vitest ran 0 matching tests)"
                ),
            });
        }
        Ok(ac_parsing::TestOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    }
}

/// Resolve the npm workspace package name a PR most likely needs its JS/TS
/// test citations run against, from the PR's changed files. Takes the
/// first changed file that resolves to a workspace package (via
/// `nearest_package_json_dir`) and returns that package's `"name"` field.
/// A PR touching more than one JS/TS package only gets citations checked
/// against the first one — the citation format has no per-AC package
/// scope to disambiguate further, the same single-value-per-PR
/// simplification `is_rust_pr` already makes.
pub(crate) fn resolve_npm_workspace(repo_root: &Path, pr_files: &[String]) -> Option<String> {
    for file in pr_files {
        let Some(package_dir) =
            crate::test_resolution::nearest_package_json_dir(repo_root, &repo_root.join(file))
        else {
            continue;
        };
        let Ok(contents) = std::fs::read_to_string(package_dir.join("package.json")) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(name) = parsed.get("name").and_then(|v| v.as_str()) {
            return Some(name.to_string());
        }
    }
    None
}

// `CargoTestRunner` is the production `TestRunner` for ACs whose cited test
// lives in this Rust crate rather than a JS workspace (dispatched by
// `pr_changed_files` prefix in `verify_delivery` — see task e67c8835, where
// `PnpmTestRunner` mis-diagnosed a passing `cargo test` as a failure because
// pnpm has no manifest to filter against here).
pub(crate) struct CargoTestRunner;

impl ac_parsing::TestRunner for CargoTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        // Resolved at compile time to this crate's own directory, so this
        // works regardless of the runtime CWD (the lobster pipeline invokes
        // the binary via `cargo run --manifest-path <abs-path>` without
        // guaranteeing any particular CWD, and `cargo test` for this crate's
        // own unit tests runs with CWD = crate root, not repo root).
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        // No `--exact`: cited AC names are bare function names (e.g.
        // `some_test`), but cargo reports module-qualified paths (e.g.
        // `tests::some_test`), and `--exact` requires the full path to
        // match. That combination previously ran 0 tests and exited 0 for
        // *every* citation, real or typo'd — a silent pass, not a check
        // (caught in review on PR #541). The substring filter here is just
        // a coarse candidate selection; `cargo_test_leaf_outcome` below does
        // the actual exact-match verdict against the parsed output.
        let output = std::process::Command::new("cargo")
            .arg("test")
            .arg("--manifest-path")
            .arg(&manifest_path)
            .args(["--bin", "feature-task", test_name])
            .output()
            .map_err(|err| format!("spawn cargo test: {err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let exit_code = cargo_test_leaf_outcome(&stdout, test_name);
        Ok(ac_parsing::TestOutcome {
            exit_code,
            stdout,
            stderr,
        })
    }
}

/// Determine pass/fail for `test_name` from `cargo test` stdout.
///
/// **Matching rules (W36 A4 fix, task `d578e547` PR-D, audit T3.1):**
/// - If `test_name` is qualified (contains `::`), match the full cited
///   path against each `test <path> ... <status>` line's path segment.
///   This is the unambiguous resolution path: two tests like
///   `unit::works` and `tests::works` are distinguished by citing
///   `unit::works` or `tests::works` explicitly.
/// - If `test_name` is a bare leaf (no `::`), match the leaf segment of
///   each path. Multiple distinct paths sharing the cited leaf
///   constitute an **ambiguous citation** and resolve to exit code `1`,
///   mirroring the no-silent-pass + ambiguity discipline that
///   `resolve_repo_file_by_name` (in `test_resolution.rs`) applies to
///   shell test scripts. This prevents a same-leaf test in a different
///   module from silently satisfying an AC that intended a different
///   one — the bug class caught in audit T3.1 (W36 A4).
///
/// cargo's own process exit code cannot be used directly: it is 0 both
/// when the named test ran and passed, AND when the filter matched zero
/// tests (nonexistent or typo'd name) — see PR #541 review. Returns `0`
/// only if exactly the right path matched and reports `ok`; returns `1`
/// otherwise (no match / ambiguous citation / matched-and-failed).
///
/// The function signature and call sites are unchanged from PR-A..PR-C;
/// only the matcher body changed (see `docs/specs/feature-task-main-rs-split-tech-design.md`
/// Open Question 2).
pub(crate) fn cargo_test_leaf_outcome(stdout: &str, test_name: &str) -> i32 {
    let use_full_path = test_name.contains("::");
    let mut matched_paths: Vec<&str> = Vec::new();
    let mut matched_failed = false;
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("test ") else {
            continue;
        };
        let Some((path, status)) = rest.rsplit_once(" ... ") else {
            continue;
        };
        let matches = if use_full_path {
            path == test_name
        } else {
            path.rsplit("::").next().unwrap_or(path) == test_name
        };
        if !matches {
            continue;
        }
        if !matched_paths.contains(&path) {
            matched_paths.push(path);
        }
        if status.trim() != "ok" {
            matched_failed = true;
        }
    }
    if matched_paths.is_empty() {
        return 1;
    }
    // Ambiguity discipline: a bare leaf citation must resolve to a single
    // distinct path. Two modules defining the same leaf (e.g. `unit::works`
    // and `tests::works`) make a bare citation of `works` ambiguous and
    // must not silently pass — same discipline `resolve_repo_file_by_name`
    // applies to shell script citations. Qualified citations use exact
    // full-path matching, so `matched_paths.len()` is at most 1 and no
    // ambiguity check is needed there.
    if !use_full_path && matched_paths.len() > 1 {
        return 1;
    }
    if matched_failed {
        return 1;
    }
    0
}

/// Absolute path to the repository root, derived from this crate's own
/// compile-time location (`agents/workflows/feature-task`) rather than the
/// runtime CWD — the lobster pipeline invokes this binary via `cargo run
/// --manifest-path <abs-path>` without guaranteeing any particular CWD
/// (same reasoning as `CargoTestRunner`'s `manifest_path` above).
pub(crate) fn repo_root_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("CARGO_MANIFEST_DIR is agents/workflows/feature-task under the repo root")
        .to_path_buf()
}

/// `ShellTestRunner` executes ACs whose cited test is a bash test script
/// (e.g. `infra/cloud/scripts/tests/*.test.sh`). These scripts are not JS
/// (so `ac_parsing`'s `.test.jsx`-style file-citation regex never matches
/// them, meaning they fall to the test-runner branch, not the file-diff
/// branch) and are not Rust, so before this runner existed every such
/// citation fell through to `PnpmTestRunner`, which always failed with
/// `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` regardless of whether the script
/// itself passed (task 5baf6809, 2026-08-28).
pub(crate) struct ShellTestRunner;

impl ShellTestRunner {
    pub(crate) fn run_in(
        &self,
        repo_root: &Path,
        test_name: &str,
    ) -> Result<ac_parsing::TestOutcome, String> {
        let script_path = crate::test_resolution::resolve_repo_file_by_name(repo_root, test_name)?;
        let output = std::process::Command::new("bash")
            .arg(&script_path)
            .current_dir(repo_root)
            .output()
            .map_err(|err| format!("spawn bash {}: {err}", script_path.display()))?;
        Ok(ac_parsing::TestOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl ac_parsing::TestRunner for ShellTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        self.run_in(&repo_root_dir(), test_name)
    }
}

/// `PytestTestRunner` executes ACs whose cited test is a pytest nodeid
/// (`path/to/test_file.py::test_function`, task 60971f78's citation
/// shape). Same underlying bug as the shell case: `PnpmTestRunner` has no
/// pnpm manifest to filter a Python nodeid against and always fails. `uv`
/// is this repo's Python package manager for these workflows (see
/// `agents/workflows/*/pyproject.toml` + `uv.lock`).
pub(crate) struct PytestTestRunner;

impl PytestTestRunner {
    pub(crate) fn run_in(
        &self,
        repo_root: &Path,
        test_name: &str,
    ) -> Result<ac_parsing::TestOutcome, String> {
        let (file_part, _func_part) = test_name
            .split_once("::")
            .ok_or_else(|| format!("not a pytest nodeid (missing '::'): {test_name}"))?;
        let file_abs = repo_root.join(file_part);
        let project_dir = crate::test_resolution::nearest_pyproject_dir(repo_root, &file_abs)
            .ok_or_else(|| format!("no pyproject.toml found above {}", file_abs.display()))?;
        let rel_file = file_abs.strip_prefix(&project_dir).map_err(|err| {
            format!(
                "compute pytest path relative to {}: {err}",
                project_dir.display()
            )
        })?;
        let nodeid_rel = format!("{}::{_func_part}", rel_file.display());
        let output = std::process::Command::new("uv")
            .args(["run", "pytest", &nodeid_rel])
            .current_dir(&project_dir)
            .output()
            .map_err(|err| format!("spawn uv run pytest {nodeid_rel}: {err}"))?;
        Ok(ac_parsing::TestOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl ac_parsing::TestRunner for PytestTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        self.run_in(&repo_root_dir(), test_name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestRunnerKind {
    Shell,
    Pytest,
    Cargo,
    Npm,
}

/// Choose which runner should execute a cited `testID` based on the shape
/// of the name itself, not just which crate/workspace the PR happened to
/// touch. A single PR can mix Rust, shell, Python, and JS ACs, so
/// dispatch looks at each citation independently rather than picking one
/// runner for the whole PR (tasks 5baf6809 / 60971f78).
pub(crate) fn select_test_runner_kind(test_name: &str, is_rust_pr: bool) -> TestRunnerKind {
    if test_name.contains(".py::") {
        TestRunnerKind::Pytest
    } else if test_name.ends_with(".sh") {
        TestRunnerKind::Shell
    } else if is_rust_pr {
        TestRunnerKind::Cargo
    } else {
        TestRunnerKind::Npm
    }
}

/// Dispatches each AC's cited test to the runner matching its shape (see
/// `select_test_runner_kind`) instead of a single runner chosen once per
/// PR. `is_rust_pr` remains the disambiguator for bare Rust test names —
/// by shape alone those are indistinguishable from a pnpm test-suite name,
/// so the PR-touches-this-crate signal (task e67c8835) is still needed for
/// that one case.
pub(crate) struct DispatchingTestRunner {
    pub(crate) is_rust_pr: bool,
    pub(crate) npm_workspace: Option<String>,
}

impl ac_parsing::TestRunner for DispatchingTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        match select_test_runner_kind(test_name, self.is_rust_pr) {
            TestRunnerKind::Shell => ShellTestRunner.run(test_name),
            TestRunnerKind::Pytest => PytestTestRunner.run(test_name),
            TestRunnerKind::Cargo => CargoTestRunner.run(test_name),
            TestRunnerKind::Npm => NpmTestRunner {
                workspace: self.npm_workspace.clone(),
            }
            .run(test_name),
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests for the moved cluster. Each `#[test]` migrates with its parent
// code; no test was added or removed in this extraction.
#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn has_passed_tests_true_when_at_least_one_test_passed() {
        let stdout = " RUN  v4.1.11 /repo/apps/mission-control\n\n\
             Test Files  1 passed | 13 skipped (14)\n\
                  Tests  1 passed | 226 skipped (227)\n";
        assert!(has_passed_tests(stdout));
    }

    #[test]
    fn has_passed_tests_false_when_the_name_filter_matched_nothing() {
        // Regression for the silent-pass trap: vitest exits 0 and reports
        // every test "skipped" when `-t` matches no test at all, not a
        // genuine pass (task 30251df0-adjacent lobster-blocked-forever
        // pattern, same class of bug as PR #541's cargo exact-match fix).
        let stdout = " RUN  v4.1.11 /repo/apps/mission-control\n\n\
             Test Files  14 skipped (14)\n\
                  Tests  227 skipped (227)\n";
        assert!(!has_passed_tests(stdout));
    }

    #[test]
    fn has_passed_tests_false_on_empty_or_unparseable_output() {
        assert!(!has_passed_tests(""));
        assert!(!has_passed_tests("npm error code 127\nsh: vitest: command not found\n"));
    }

    #[test]
    fn resolve_npm_workspace_finds_the_package_touched_by_the_pr() {
        let root = tempdir().unwrap();
        let package = root.path().join("apps/mission-control");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            "{\"name\": \"@sindustries/mission-control\"}\n",
        )
        .unwrap();

        let pr_files = vec!["apps/mission-control/src/Sidebar.test.jsx".to_string()];
        let found = resolve_npm_workspace(root.path(), &pr_files);
        assert_eq!(found, Some("@sindustries/mission-control".to_string()));
    }

    #[test]
    fn resolve_npm_workspace_skips_files_with_no_resolvable_package_and_tries_the_next() {
        let root = tempdir().unwrap();
        let package = root.path().join("services/tasks-api");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            "{\"name\": \"@sindustries/tasks-api\"}\n",
        )
        .unwrap();
        fs::create_dir_all(root.path().join("docs/specs")).unwrap();

        let pr_files = vec![
            "docs/specs/some-doc.md".to_string(),
            "services/tasks-api/src/routes/tasks.ts".to_string(),
        ];
        let found = resolve_npm_workspace(root.path(), &pr_files);
        assert_eq!(found, Some("@sindustries/tasks-api".to_string()));
    }

    #[test]
    fn resolve_npm_workspace_returns_none_for_a_docs_only_pr() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/specs")).unwrap();

        let pr_files = vec!["docs/specs/some-doc.md".to_string()];
        assert_eq!(resolve_npm_workspace(root.path(), &pr_files), None);
    }

    #[test]
    fn cargo_test_runner_reports_success_for_a_real_passing_test() {
        // Regression test for task e67c8835: `CargoTestRunner` must resolve
        // its own manifest via `CARGO_MANIFEST_DIR` (compile-time constant)
        // rather than a CWD-relative path, since `cargo test` runs this test
        // with CWD = crate root while the production binary is invoked via
        // `cargo run --manifest-path <abs>` with no guaranteed CWD. Targets
        // a real, side-effect-free test in this same file so a genuine
        // `cargo test` round-trip exercises the full runner, not a stub.
        let outcome = ac_parsing::TestRunner::run(
            &CargoTestRunner,
            "routing_advances_stale_implementer_to_tom_at_acceptance",
        )
        .expect("spawn cargo test");
        assert_eq!(
            outcome.exit_code, 0,
            "expected passing test to report exit 0\nstdout: {}\nstderr: {}",
            outcome.stdout, outcome.stderr
        );
        // Guards against the exact bug caught in PR #541 review: `--exact`
        // against a bare (non-module-qualified) name matched zero tests and
        // still exited 0, so `exit_code == 0` alone does not prove the test
        // actually ran. Confirm the target line is present and reports `ok`.
        assert!(
            outcome.stdout.contains(
                "test tests::routing_advances_stale_implementer_to_tom_at_acceptance ... ok"
            ),
            "expected the target test to actually run, got:\n{}",
            outcome.stdout
        );
    }

    #[test]
    fn cargo_test_runner_reports_failure_for_a_nonexistent_test_name() {
        // A cited AC test that doesn't exist (typo, renamed, never written)
        // must be a hard failure, not a silent pass. Before this fix, cargo
        // exits 0 when a filter matched zero tests, which the old
        // `output.status.code()`-only implementation reported as success.
        let outcome = ac_parsing::TestRunner::run(
            &CargoTestRunner,
            "this_test_definitely_does_not_exist_in_this_crate_xyz",
        )
        .expect("spawn cargo test");
        assert_ne!(
            outcome.exit_code, 0,
            "expected a nonexistent test citation to fail, got exit 0\nstdout: {}",
            outcome.stdout
        );
    }

    #[test]
    fn cargo_test_leaf_outcome_matches_bare_name_against_qualified_path() {
        let stdout = "\nrunning 1 test\ntest tests::some_module::my_test ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "my_test"), 0);
    }

    #[test]
    fn cargo_test_leaf_outcome_fails_on_zero_matching_tests() {
        let stdout = "\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 248 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "typo_d_name"), 1);
    }

    #[test]
    fn cargo_test_leaf_outcome_fails_when_matching_test_failed() {
        let stdout = "\nrunning 1 test\ntest tests::my_test ... FAILED\n\nfailures:\n\n---- tests::my_test stdout ----\nassertion failed\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "my_test"), 1);
    }

    #[test]
    fn cargo_test_leaf_outcome_does_not_falsely_match_a_substring_prefix() {
        // A citation of `my_test` must not match an unrelated test whose
        // name merely contains it as a substring (e.g. `my_test_extended`)
        // — only an exact leaf-segment match counts.
        let stdout = "\nrunning 1 test\ntest tests::my_test_extended ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "my_test"), 1);
    }

    // ---- W36 A4 hardening (task `d578e547` PR-D, audit T3.1) ----
    // cargo_test_leaf_outcome now distinguishes qualified citations
    // (full-path match) from bare leaf citations (leaf match with
    // ambiguity discipline), mirroring resolve_repo_file_by_name.

    #[test]
    fn cargo_test_leaf_outcome_errors_on_ambiguous_same_leaf_across_modules() {
        // AC5: deterministic behavior on a multi-module same-leaf scenario.
        // Two tests share the leaf `works` in different modules. Citing
        // bare `works` is ambiguous and must return 1, not silently pass —
        // the bug class caught in audit T3.1.
        let stdout = "\nrunning 2 tests\n\
                      test unit::works ... ok\n\
                      test tests::works ... ok\n\
                      \n\
                      test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "works"), 1);
    }

    #[test]
    fn cargo_test_leaf_outcome_resolves_qualified_citation_to_exact_path() {
        // AC3: qualified citation `unit::works` strictly matches
        // `unit::works`, not `tests::works`, even when both are present.
        let stdout = "\nrunning 2 tests\n\
                      test unit::works ... ok\n\
                      test tests::works ... ok\n\
                      \n\
                      test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "unit::works"), 0);
    }

    #[test]
    fn cargo_test_leaf_outcome_qualified_citation_fails_when_intended_path_missing() {
        // AC3: when a qualified citation does not appear in stdout, no
        // fallback to leaf match is attempted — that would reintroduce
        // the leaf-ambiguity bug the A4 hardening closes.
        let stdout = "\nrunning 1 test\n\
                      test tests::works ... ok\n\
                      \n\
                      test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "unit::works"), 1);
    }

    #[test]
    fn cargo_test_leaf_outcome_qualified_citation_fails_when_intended_path_failed() {
        // AC3: when the exact qualified path matches but the test reports
        // FAILED, return 1 — same as the leaf-match failure path.
        let stdout = "\nrunning 2 tests\n\
                      test unit::works ... ok\n\
                      test tests::works ... FAILED\n\
                      \n\
                      test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "tests::works"), 1);
    }

    #[test]
    fn cargo_test_leaf_outcome_unambiguous_bare_leaf_still_succeeds() {
        // AC4 regression guard: bare leaf citation still resolves when
        // exactly one path matches the leaf, even with other modules
        // present whose leaves do not collide.
        let stdout = "\nrunning 2 tests\n\
                      test unit::works ... ok\n\
                      test tests::other_test ... ok\n\
                      \n\
                      test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out\n";
        assert_eq!(cargo_test_leaf_outcome(stdout, "works"), 0);
    }

    #[test]
    fn select_test_runner_kind_picks_pytest_for_py_nodeid() {
        assert_eq!(
            select_test_runner_kind("agents/workflows/x/tests/test_y.py::test_z", true),
            TestRunnerKind::Pytest
        );
        assert_eq!(
            select_test_runner_kind("agents/workflows/x/tests/test_y.py::test_z", false),
            TestRunnerKind::Pytest
        );
    }

    #[test]
    fn select_test_runner_kind_picks_shell_for_dot_sh_name() {
        assert_eq!(
            select_test_runner_kind("package-json-no-pnpm-pin.test.sh", true),
            TestRunnerKind::Shell
        );
        assert_eq!(
            select_test_runner_kind("package-json-no-pnpm-pin.test.sh", false),
            TestRunnerKind::Shell
        );
    }

    #[test]
    fn select_test_runner_kind_falls_back_to_cargo_or_npm_by_pr_flag() {
        assert_eq!(
            select_test_runner_kind("routing_does_not_drain_managed_owners", true),
            TestRunnerKind::Cargo
        );
        assert_eq!(
            select_test_runner_kind("routing_does_not_drain_managed_owners", false),
            TestRunnerKind::Npm
        );
    }

    #[test]
    fn shell_test_runner_reports_success_for_a_real_passing_script() {
        let root = tempdir().unwrap();
        let script = root.path().join("pass.test.sh");
        fs::write(&script, "#!/usr/bin/env bash\nexit 0\n").unwrap();

        let outcome = ShellTestRunner.run_in(root.path(), "pass.test.sh").unwrap();
        assert_eq!(outcome.exit_code, 0);
    }

    #[test]
    fn shell_test_runner_reports_failure_for_a_real_failing_script() {
        let root = tempdir().unwrap();
        let script = root.path().join("fail.test.sh");
        fs::write(&script, "#!/usr/bin/env bash\nexit 1\n").unwrap();

        let outcome = ShellTestRunner.run_in(root.path(), "fail.test.sh").unwrap();
        assert_ne!(outcome.exit_code, 0);
    }

    #[test]
    fn shell_test_runner_errors_for_a_nonexistent_citation() {
        let root = tempdir().unwrap();
        let err = ShellTestRunner
            .run_in(root.path(), "typo_d_name.test.sh")
            .unwrap_err();
        assert!(err.contains("no file named"), "unexpected error: {err}");
    }

    #[test]
    fn pytest_test_runner_reports_success_for_a_real_passing_test() {
        if Command::new("uv").arg("--version").output().is_err() {
            eprintln!("skipping: uv not installed in this environment");
            return;
        }
        let root = tempdir().unwrap();
        let project = root.path().join("agents/workflows/x");
        let tests_dir = project.join("tests");
        fs::create_dir_all(&tests_dir).unwrap();
        fs::write(
            project.join("pyproject.toml"),
            "[project]\nname = \"tmp-pytest-fixture\"\nversion = \"0.0.0\"\nrequires-python = \">=3.11\"\ndependencies = [\"pytest\"]\n",
        )
        .unwrap();
        fs::write(
            tests_dir.join("test_sample.py"),
            "def test_pass():\n    assert True\n\n\ndef test_fail():\n    assert False\n",
        )
        .unwrap();

        let pass_outcome = PytestTestRunner
            .run_in(
                root.path(),
                "agents/workflows/x/tests/test_sample.py::test_pass",
            )
            .expect("spawn uv run pytest");
        assert_eq!(
            pass_outcome.exit_code, 0,
            "expected passing pytest to report exit 0\nstdout: {}\nstderr: {}",
            pass_outcome.stdout, pass_outcome.stderr
        );

        let fail_outcome = PytestTestRunner
            .run_in(
                root.path(),
                "agents/workflows/x/tests/test_sample.py::test_fail",
            )
            .expect("spawn uv run pytest");
        assert_ne!(
            fail_outcome.exit_code, 0,
            "expected failing pytest to report a nonzero exit"
        );
    }
}
