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
//! - [`PnpmTestRunner`], [`CargoTestRunner`], [`ShellTestRunner`],
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

use crate::ac_parsing;

// ---------------------------------------------------------------------------
// Mechanical evidence gate (task 5e35dc25 — migrate Ash's mechanical
// verify.ts checks into the lobster).
//
// `PnpmTestRunner` is the production implementation of the `TestRunner`
// trait declared in `ac_parsing`. It shells out to `pnpm test --filter
// <name>` and surfaces the exit code + stdout/stderr as a `TestOutcome`.
// Unit tests in `ac_parsing` substitute `AlwaysPassTestRunner` /
// `AlwaysFailTestRunner` so they can exercise the mechanical-evidence
// path without spawning `pnpm`.
//
// Mirrors Ash's `verify.ts` invocation closely; if the project's test
// invocation diverges, this is the single place to update.
pub(crate) struct PnpmTestRunner;

impl ac_parsing::TestRunner for PnpmTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        let output = std::process::Command::new("pnpm")
            .args(["test", "--filter", test_name])
            .output()
            .map_err(|err| format!("spawn pnpm test: {err}"))?;
        Ok(ac_parsing::TestOutcome {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
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

/// Determine pass/fail for `test_name` from `cargo test` stdout by matching
/// the leaf (post-`::`) segment of each `test <path> ... <status>` line.
///
/// cargo's own process exit code cannot be used directly: it is 0 both when
/// the named test ran and passed, AND when the filter matched zero tests
/// (nonexistent or typo'd name) — see PR #541 review. Returns `0` only if at
/// least one matching test ran and every match reports `ok`; returns `1` if
/// no test matched `test_name` at all, or if any match failed.
///
/// **Note (W36 A4):** this currently uses leaf-only matching. The
/// `tests::works` vs `unit::works` ambiguity hardening (audit T3.1) lands
/// in PR-D immediately after PR-C merges. The function signature and call
/// sites stay unchanged; only the matcher body changes.
pub(crate) fn cargo_test_leaf_outcome(stdout: &str, test_name: &str) -> i32 {
    let mut found = false;
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("test ") else {
            continue;
        };
        let Some((path, status)) = rest.rsplit_once(" ... ") else {
            continue;
        };
        if path.rsplit("::").next().unwrap_or(path) != test_name {
            continue;
        }
        found = true;
        if status.trim() != "ok" {
            return 1;
        }
    }
    if found {
        0
    } else {
        1
    }
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
    Pnpm,
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
        TestRunnerKind::Pnpm
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
}

impl ac_parsing::TestRunner for DispatchingTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        match select_test_runner_kind(test_name, self.is_rust_pr) {
            TestRunnerKind::Shell => ShellTestRunner.run(test_name),
            TestRunnerKind::Pytest => PytestTestRunner.run(test_name),
            TestRunnerKind::Cargo => CargoTestRunner.run(test_name),
            TestRunnerKind::Pnpm => PnpmTestRunner.run(test_name),
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
    fn select_test_runner_kind_falls_back_to_cargo_or_pnpm_by_pr_flag() {
        assert_eq!(
            select_test_runner_kind("routing_does_not_drain_managed_owners", true),
            TestRunnerKind::Cargo
        );
        assert_eq!(
            select_test_runner_kind("routing_does_not_drain_managed_owners", false),
            TestRunnerKind::Pnpm
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
