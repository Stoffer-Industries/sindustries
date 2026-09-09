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

/// Escape regex metacharacters in a literal test description before it is
/// used as vitest's `-t` filter, which matches as a regex, not a literal
/// substring. A resolved `it()`/`test()` description can contain any
/// character the source author wrote — parens are common (task 2c3bf69b
/// AC3: `"...checkboxes enabled (task 2c3bf69b override)"`) — and an
/// unescaped `(...)` is a non-capturing group boundary, not two literal
/// characters, so the real test name (which does contain literal parens)
/// silently fails to match. Escaping is safe for the raw-citation fallback
/// case too: a citation `resolve_npm_test_filters` couldn't parse into a
/// known shape is still meant to match literally, never as a deliberate
/// regex.
fn regex_escape_literal(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for ch in s.chars() {
        if "\\.+*?()|[]{}^$".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
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
        let repo_root = repo_root_dir();
        let filters = resolve_npm_test_filters(&repo_root, test_name);
        let mut stdout = String::new();
        let mut stderr = String::new();
        for resolved in &filters {
            // A citation's own file (when known, e.g. `file#Lline` or
            // `file > desc`) resolves the workspace that file actually
            // lives in — needed because a single PR can touch more than
            // one JS/TS package (e.g. `apps/tasks` + `services/tasks-api`
            // in the same PR, task 2c3bf69b), and `self.workspace` is
            // only ever the *first* changed file's package. Falls back to
            // `self.workspace` for citations with no resolvable file
            // (bare slugs) or when the citation's file isn't itself in a
            // known workspace.
            let workspace = resolved
                .file
                .as_ref()
                .and_then(|file| resolve_npm_workspace(&repo_root, std::slice::from_ref(file)))
                .or_else(|| self.workspace.clone());
            let Some(workspace) = workspace else {
                stderr.push_str(
                    "no npm workspace package could be resolved for this citation; cannot run \
                     a JS/TS test citation\n",
                );
                return Ok(ac_parsing::TestOutcome {
                    exit_code: 1,
                    stdout,
                    stderr,
                });
            };
            let filter = &resolved.filter;
            let outcome = run_npm_filter(&workspace, &repo_root, filter)?;
            stdout.push_str(&outcome.stdout);
            stdout.push('\n');
            if outcome.exit_code == 0 {
                continue;
            }
            // Retry as an AND of comma-joined sub-descriptions before
            // failing outright — implementers sometimes cite several
            // `it()` names for one AC as "desc one, desc two, desc three"
            // (task 37bbc104 AC4) rather than splitting them with `;`
            // like `resolve_npm_test_filters` already expects at the top
            // level. Only attempted after the whole-string filter already
            // failed to match, so a description that legitimately
            // contains a comma and matches as-is never reaches this path.
            if filter.contains(", ") {
                let sub_filters: Vec<&str> = filter
                    .split(", ")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                let mut all_sub_passed = !sub_filters.is_empty();
                let mut sub_stderr = String::new();
                for sub in &sub_filters {
                    let sub_outcome = run_npm_filter(&workspace, &repo_root, sub)?;
                    stdout.push_str(&sub_outcome.stdout);
                    stdout.push('\n');
                    if sub_outcome.exit_code != 0 {
                        all_sub_passed = false;
                        sub_stderr.push_str(&sub_outcome.stderr);
                        sub_stderr.push('\n');
                    }
                }
                if all_sub_passed {
                    continue;
                }
                stderr.push_str(&sub_stderr);
                return Ok(ac_parsing::TestOutcome {
                    exit_code: 1,
                    stdout,
                    stderr,
                });
            }
            stderr.push_str(&outcome.stderr);
            return Ok(ac_parsing::TestOutcome {
                exit_code: 1,
                stdout,
                stderr,
            });
        }
        Ok(ac_parsing::TestOutcome {
            exit_code: 0,
            stdout,
            stderr,
        })
    }
}

/// Run a single resolved vitest name filter against `workspace` and report
/// pass/fail, guarding the same silent-pass trap `has_passed_tests` exists
/// for (a non-matching `-t` filter exits 0 with everything "skipped").
fn run_npm_filter(
    workspace: &str,
    repo_root: &Path,
    filter: &str,
) -> Result<ac_parsing::TestOutcome, String> {
    let pattern = regex_escape_literal(filter);
    let output = std::process::Command::new("npm")
        .args(["test", "--workspace", workspace, "--", "-t", &pattern])
        .current_dir(repo_root)
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
        return Ok(ac_parsing::TestOutcome {
            exit_code: 1,
            stdout,
            stderr: format!(
                "no test named \"{filter}\" matched in npm workspace \"{workspace}\" \
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

/// True when `path` is a bare JS/TS test-file path (`foo.test.ts`,
/// `bar.spec.jsx`, …) with no trailing description — the same shape
/// `ac_parsing::test_file_re` uses to decide a citation is a file
/// reference rather than a test name.
fn is_test_file_path(path: &str) -> bool {
    Regex::new(r"^\S+\.(?:test|spec)\.[mc]?[jt]sx?$")
        .unwrap()
        .is_match(path)
}

/// Find the description string of the `it(`/`test(` call nearest to (at or
/// before) `line` in `rel_file`, read relative to `repo_root`. Citations
/// naming a file + line (e.g. `#L78`) point at the body of a test rather
/// than its description, so this walks forward from the top of the file
/// tracking the last-seen `it(`/`test(` literal up to `line` — the
/// enclosing test. Single-line `it('desc', ...)` declarations only (this
/// repo's prevailing style); a description that itself spans multiple
/// lines is not resolved and the caller falls back to the raw citation.
fn nearest_test_description(repo_root: &Path, rel_file: &str, line: usize) -> Option<String> {
    let contents = std::fs::read_to_string(repo_root.join(rel_file)).ok()?;
    // No backreferences in the `regex` crate, so each quote style gets its
    // own capture group instead of a shared `\1` close-quote match.
    let re = Regex::new(
        r#"(?:^|[^.\w])(?:it|test)\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)"#,
    )
    .unwrap();
    let mut best: Option<String> = None;
    for (idx, text) in contents.lines().enumerate() {
        if idx + 1 > line {
            break;
        }
        if let Some(caps) = re.captures(text) {
            if let Some(desc) = caps.get(1).or_else(|| caps.get(2)).or_else(|| caps.get(3)) {
                best = Some(unescape_js_string(desc.as_str()));
            }
        }
    }
    best
}

/// Undo JS string-literal escaping in a description captured verbatim
/// from source text (e.g. `Tom\'s` inside a single-quoted literal is the
/// two characters `\` `'` in the source, but the string's real value —
/// and what vitest reports as the test name — is just `'`). Handles the
/// escapes that actually show up in this repo's test descriptions;
/// unrecognised `\x` sequences are left as `x` (backslash dropped), which
/// only matters for escapes this repo doesn't use.
fn unescape_js_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// One resolved vitest `-t` filter, plus the source file it was resolved
/// from when known. The file lets the caller resolve *that citation's*
/// workspace specifically, rather than the one workspace resolved for the
/// whole PR — needed when a PR touches more than one JS/TS package (task
/// 2c3bf69b: `apps/tasks` + `services/tasks-api` in the same PR, where the
/// PR-level `resolve_npm_workspace` only ever picks the first).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResolvedFilter {
    pub(crate) file: Option<String>,
    pub(crate) filter: String,
}

/// Parse one or more `#L<n>` / `#L<n>-<m>` line references out of a
/// citation, resolving each to the enclosing test's real description via
/// `nearest_test_description`. Handles the multi-range shape
/// `file.ts#L8 + #L78-100` (task 2c3bf69b AC1) where only the first `+`
/// segment carries the file path and later segments reuse it. Returns
/// `None` if the citation has no `#L` marker at all, or if every `#L`
/// reference fails to resolve (stale line number, unreadable file, …) so
/// the caller can fall back to the raw citation text instead of silently
/// dropping the AC's evidence.
fn resolve_line_citations(repo_root: &Path, citation: &str) -> Option<Vec<ResolvedFilter>> {
    if !citation.contains("#L") {
        return None;
    }
    let mut current_file: Option<String> = None;
    let mut resolved: Vec<ResolvedFilter> = Vec::new();
    for chunk in citation.split('+') {
        let chunk = chunk.trim();
        let Some((maybe_file, rest)) = chunk.split_once("#L") else {
            continue;
        };
        let file = if maybe_file.trim().is_empty() {
            current_file.clone()?
        } else {
            let file = maybe_file.trim().to_string();
            current_file = Some(file.clone());
            file
        };
        let line_digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(line) = line_digits.parse::<usize>() else {
            continue;
        };
        if let Some(name) = nearest_test_description(repo_root, &file, line) {
            if !resolved.iter().any(|r| r.filter == name) {
                resolved.push(ResolvedFilter {
                    file: Some(file.clone()),
                    filter: name,
                });
            }
        }
    }
    if resolved.is_empty() { None } else { Some(resolved) }
}

/// Resolve one `<file> > <description>` citation segment (vitest's own
/// reporter path format) to the bare description, which is what actually
/// appears in a test's reported name — the file portion is never part of
/// it, so passing the segment through unchanged to `-t` can never match
/// (task 37bbc104 AC1-3/5).
fn resolve_arrow_citation(segment: &str) -> Option<ResolvedFilter> {
    let (prefix, rest) = segment.split_once(" > ")?;
    let prefix = prefix.trim();
    is_test_file_path(prefix).then(|| ResolvedFilter {
        file: Some(prefix.to_string()),
        filter: rest.trim().to_string(),
    })
}

/// Resolve one `<file> <description>` citation segment (no `>` separator,
/// just a leading file token) to the bare description, the same
/// file-prefix-strip `resolve_arrow_citation` does for the `>` shape
/// (tasks 1016cbff AC2, PR #598/#608 style citations).
fn resolve_leading_filename_citation(segment: &str) -> Option<ResolvedFilter> {
    let re = Regex::new(r"^(\S+\.(?:test|spec)\.[mc]?[jt]sx?)\s+(.+)$").unwrap();
    let caps = re.captures(segment)?;
    Some(ResolvedFilter {
        file: Some(caps[1].to_string()),
        filter: caps[2].trim().to_string(),
    })
}

/// Split a raw AC test citation into the list of vitest `-t` filters that
/// must each independently match and pass. Citations vary in shape by
/// implementer — a bare literal test name, a `file#Lline` reference, a
/// `file > description` (vitest's own path format), a `file description`
/// pair, or several of those joined by `;` for one AC (task 1016cbff AC3)
/// — so each `;`-separated segment is resolved independently and any
/// segment that doesn't match a known shape is kept as-is. That keeps
/// today's literal-match behaviour for citations this can't parse (e.g. a
/// bare slug with no file/line reference at all) rather than dropping
/// them, so those still fail loudly instead of silently passing.
pub(crate) fn resolve_npm_test_filters(repo_root: &Path, citation: &str) -> Vec<ResolvedFilter> {
    // A `#L` line reference is resolved against the *whole* citation
    // first, before any `;` splitting: several real citations use `;` as
    // ordinary sentence punctuation after a line range to explain why it
    // covers the AC (task 2c3bf69b AC2/AC4/AC5, e.g. "...#L78-100 covers
    // the grant path; the existing DELETE branches ... are unchanged"),
    // and splitting on `;` first would strand that explanatory clause as
    // its own unresolvable sub-citation and fail an AC whose cited test
    // actually does resolve and pass. `resolve_line_citations` already
    // walks `+`-joined ranges within one citation on its own, so this
    // only needs to fall through to the `;`-as-multi-citation-delimiter
    // case (task 1016cbff AC3: two independent `file > desc` citations
    // for one AC) when there is no line reference at all.
    if let Some(resolved) = resolve_line_citations(repo_root, citation) {
        return resolved;
    }
    let mut filters = Vec::new();
    for segment in citation.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        if let Some(resolved) = resolve_arrow_citation(segment) {
            filters.push(resolved);
        } else if let Some(resolved) = resolve_leading_filename_citation(segment) {
            filters.push(resolved);
        } else {
            filters.push(ResolvedFilter {
                file: None,
                filter: segment.to_string(),
            });
        }
    }
    if filters.is_empty() {
        filters.push(ResolvedFilter {
            file: None,
            filter: citation.to_string(),
        });
    }
    filters
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
        let normalized = normalize_pytest_citation(test_name);
        let (file_part, _func_part) = normalized
            .split_once("::")
            .ok_or_else(|| format!("not a pytest nodeid (missing '::'): {test_name}"))?;
        let file_abs = repo_root.join(file_part);
        let Some(project_dir) = crate::test_resolution::nearest_pyproject_dir(repo_root, &file_abs)
        else {
            return run_unittest_in(repo_root, &file_abs, _func_part, test_name);
        };
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

/// Run a standard-library `unittest` node when the cited Python workflow has
/// no `pyproject.toml`. The content-tasks workflow is intentionally a plain
/// Python/unittest project: CI runs `python -m unittest discover` there, so
/// requiring a uv project would reject valid citations before their tests can
/// run (task 1016cbff).
fn run_unittest_in(
    repo_root: &Path,
    file_abs: &Path,
    func_part: &str,
    original_citation: &str,
) -> Result<ac_parsing::TestOutcome, String> {
    let rel_file = file_abs.strip_prefix(repo_root).map_err(|err| {
        format!(
            "compute unittest module relative to {}: {err}",
            repo_root.display()
        )
    })?;
    let mut module = rel_file.to_string_lossy().replace(['/', '\\'], ".");
    if let Some(stripped) = module.strip_suffix(".py") {
        module = stripped.to_string();
    }
    let target = format!("{}.{}", module, func_part.replace("::", "."));
    let output = std::process::Command::new("python3")
        .args(["-m", "unittest", &target])
        .current_dir(repo_root)
        .output()
        .map_err(|err| format!("spawn python3 -m unittest {target}: {err}"))?;
    if output.status.success() {
        return Ok(ac_parsing::TestOutcome {
            exit_code: 0,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(ac_parsing::TestOutcome {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: format!(
            "python3 -m unittest failed for citation \"{original_citation}\": {}",
            String::from_utf8_lossy(&output.stderr)
        ),
    })
}

impl ac_parsing::TestRunner for PytestTestRunner {
    fn run(&self, test_name: &str) -> Result<ac_parsing::TestOutcome, String> {
        self.run_in(&repo_root_dir(), test_name)
    }
}

/// Convert the space-separated pytest citation shape implementers
/// sometimes write instead of the canonical `file.py::Class::method`
/// nodeid — e.g. `path/to/test_foo.py FooTest.test_bar` (task 1016cbff
/// AC4/AC5) — into a real nodeid. Already-`::`-qualified citations pass
/// through unchanged; a bare dotted `Class.method` after the `.py ` file
/// token becomes `Class::method` (pytest's own nodeid separator for
/// unittest-style classes).
fn normalize_pytest_citation(test_name: &str) -> String {
    if test_name.contains("::") {
        return test_name.to_string();
    }
    let Some((file, rest)) = test_name.split_once(".py ") else {
        return test_name.to_string();
    };
    let qualname = rest.trim().replace('.', "::");
    format!("{file}.py::{qualname}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestRunnerKind {
    Shell,
    Pytest,
    Cargo,
    Npm,
}

/// Detect the space-separated pytest citation shape `normalize_pytest_citation`
/// converts to a nodeid — a `.py` file token, one space, then a bare
/// dotted `Class.method` (or `function`) name with no whitespace of its
/// own. Anchored on both ends so a prose citation that merely mentions a
/// `.py` file in passing doesn't get misrouted to the Pytest runner.
fn looks_like_pytest_space_nodeid(test_name: &str) -> bool {
    Regex::new(r"^\S+\.py \S+\.\S+$")
        .unwrap()
        .is_match(test_name.trim())
}

/// Choose which runner should execute a cited `testID` based on the shape
/// of the name itself, not just which crate/workspace the PR happened to
/// touch. A single PR can mix Rust, shell, Python, and JS ACs, so
/// dispatch looks at each citation independently rather than picking one
/// runner for the whole PR (tasks 5baf6809 / 60971f78).
pub(crate) fn select_test_runner_kind(test_name: &str, is_rust_pr: bool) -> TestRunnerKind {
    if test_name.contains(".py::") || looks_like_pytest_space_nodeid(test_name) {
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
    fn regex_escape_literal_escapes_parens_so_they_match_literally() {
        // Task 2c3bf69b AC3: the real `it()` description contains literal
        // parens ("...enabled (task 2c3bf69b override)"); unescaped, `(`
        // is a non-capturing regex group boundary, not two literal
        // characters, and the pattern silently matches nothing.
        assert_eq!(
            regex_escape_literal("enabled (task 2c3bf69b override)"),
            r"enabled \(task 2c3bf69b override\)"
        );
    }

    #[test]
    fn regex_escape_literal_is_a_no_op_for_plain_text() {
        assert_eq!(
            regex_escape_literal("lets Tom grant tech_design"),
            "lets Tom grant tech_design"
        );
    }

    #[test]
    fn unescape_js_string_undoes_an_escaped_apostrophe() {
        // Task 2c3bf69b AC3's real citation resolves into a description
        // captured from `it('renders Tom\'s tech_design ...', ...)` — the
        // source has the two characters `\` `'`, but the JS string's real
        // value (and what vitest reports) is just `'`.
        assert_eq!(unescape_js_string(r"Tom\'s tech_design"), "Tom's tech_design");
    }

    #[test]
    fn nearest_test_description_unescapes_an_escaped_apostrophe_in_source() {
        let root = tempdir().unwrap();
        let dir = root.path().join("apps/tasks/src/components");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("ApprovalsSection.test.jsx"),
            "describe('ApprovalsSection', () => {\n\
             it('renders Tom\\'s tech_design and qa_agent checkboxes enabled (task override)', async () => {\n\
             });\n\
             });\n",
        )
        .unwrap();

        let name = nearest_test_description(
            root.path(),
            "apps/tasks/src/components/ApprovalsSection.test.jsx",
            2,
        );
        assert_eq!(
            name,
            Some("renders Tom's tech_design and qa_agent checkboxes enabled (task override)".to_string())
        );
    }

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

    // ---- citation resolution (task 5baf6809-adjacent: PR #610 fixed the
    // wrong half of the pnpm->npm bug — the runner found the right
    // workspace but still passed the raw AC citation text verbatim as the
    // `-t` filter, and real citations are file#Lline refs, vitest's own
    // `file > description` path format, or several of those joined by
    // `;`, never a literal test-name string on their own) ----

    fn resolved(file: Option<&str>, filter: &str) -> ResolvedFilter {
        ResolvedFilter {
            file: file.map(str::to_string),
            filter: filter.to_string(),
        }
    }

    #[test]
    fn resolve_arrow_citation_strips_the_file_prefix() {
        // Task 37bbc104 AC1: vitest's own reporter path format. The file
        // segment is never part of a test's reported name, so it must be
        // stripped before use as a `-t` filter.
        assert_eq!(
            resolve_arrow_citation(
                "services/gymtrack-mcp/test/rateLimit.test.js > lets the first request \
                 through and 429s once the per-IP window is exceeded"
            ),
            Some(resolved(
                Some("services/gymtrack-mcp/test/rateLimit.test.js"),
                "lets the first request through and 429s once the per-IP window is exceeded"
            ))
        );
    }

    #[test]
    fn resolve_arrow_citation_rejects_a_non_file_prefix() {
        // No `.test.`/`.spec.` extension before " > " — not this shape,
        // must not be misread as one (falls through to the raw-citation
        // fallback in `resolve_npm_test_filters` instead).
        assert_eq!(resolve_arrow_citation("some prose > with an arrow in it"), None);
    }

    #[test]
    fn resolve_leading_filename_citation_strips_the_file_token() {
        // Task 1016cbff AC2 style: `<file> <description>` with no `>`.
        assert_eq!(
            resolve_leading_filename_citation("ContentSchedulerTab.test.jsx thread surface"),
            Some(resolved(Some("ContentSchedulerTab.test.jsx"), "thread surface"))
        );
    }

    #[test]
    fn resolve_leading_filename_citation_none_for_a_bare_slug() {
        // Tasks ec75969b/3d80fd5a: a symbolic testID with no file token
        // at all must fall through unresolved, not be mangled.
        assert_eq!(
            resolve_leading_filename_citation("mission-control-vercel-deploy-fixtures"),
            None
        );
    }

    #[test]
    fn resolve_line_citations_finds_the_enclosing_test_by_line_number() {
        let root = tempdir().unwrap();
        let dir = root.path().join("services/tasks-api/test");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("taskApprovals.test.ts"),
            "import { it } from 'vitest';\n\n\
             it('accepts a durable unexpired browser session cookie', async () => {\n\
             });\n\n\
             it('lets Tom grant tech_design and qa_agent as an override', async () => {\n\
             });\n",
        )
        .unwrap();

        let names = resolve_line_citations(
            root.path(),
            "services/tasks-api/test/taskApprovals.test.ts#L7",
        );
        assert_eq!(
            names,
            Some(vec![resolved(
                Some("services/tasks-api/test/taskApprovals.test.ts"),
                "lets Tom grant tech_design and qa_agent as an override"
            )])
        );
    }

    #[test]
    fn resolve_line_citations_reuses_the_file_across_a_plus_joined_range() {
        // Task 2c3bf69b AC1's real citation shape: only the first `+`
        // segment carries the file path, later segments are bare `#L`
        // ranges against that same file.
        let root = tempdir().unwrap();
        let dir = root.path().join("services/tasks-api/test");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("taskApprovals.test.ts"),
            "import { it } from 'vitest';\n\n\
             it('first test', async () => {\n\
             });\n\n\
             it('second test', async () => {\n\
             });\n",
        )
        .unwrap();

        let names = resolve_line_citations(
            root.path(),
            "services/tasks-api/test/taskApprovals.test.ts#L3 + #L6-8",
        );
        let file = Some("services/tasks-api/test/taskApprovals.test.ts");
        assert_eq!(
            names,
            Some(vec![resolved(file, "first test"), resolved(file, "second test")])
        );
    }

    #[test]
    fn resolve_line_citations_none_without_a_hash_l_marker() {
        assert_eq!(resolve_line_citations(Path::new("/tmp"), "just a plain name"), None);
    }

    #[test]
    fn resolve_npm_test_filters_splits_semicolon_joined_citations() {
        // Task 1016cbff AC3: two file+description citations for one AC.
        let root = tempdir().unwrap();
        let filters = resolve_npm_test_filters(
            root.path(),
            "a.test.ts > first thing; b.test.ts > second thing",
        );
        assert_eq!(
            filters,
            vec![
                resolved(Some("a.test.ts"), "first thing"),
                resolved(Some("b.test.ts"), "second thing")
            ]
        );
    }

    #[test]
    fn resolve_npm_test_filters_keeps_a_line_citation_whole_across_an_explanatory_semicolon() {
        // Task 2c3bf69b AC2's real citation shape: `;` here is sentence
        // punctuation after the line range, not a second citation. Must
        // resolve via the line reference, not fragment on `;` and strand
        // "the existing DELETE branches ..." as an unresolvable citation.
        let root = tempdir().unwrap();
        let dir = root.path().join("services/tasks-api/test");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("taskApprovals.test.ts"),
            "import { it } from 'vitest';\n\n\
             it('lets Tom grant tech_design and qa_agent as an override', async () => {\n\
             });\n",
        )
        .unwrap();

        let filters = resolve_npm_test_filters(
            root.path(),
            "services/tasks-api/test/taskApprovals.test.ts#L3 covers the grant path; \
             the existing DELETE branches in the same file exercise revocation",
        );
        assert_eq!(
            filters,
            vec![resolved(
                Some("services/tasks-api/test/taskApprovals.test.ts"),
                "lets Tom grant tech_design and qa_agent as an override"
            )]
        );
    }

    #[test]
    fn resolve_npm_test_filters_falls_back_to_the_raw_citation_when_unrecognised() {
        // Tasks ec75969b/3d80fd5a: a bare symbolic slug with no file
        // reference at all is not a shape this can resolve — it must
        // still be attempted (and fail loudly) rather than dropped.
        let root = tempdir().unwrap();
        let filters = resolve_npm_test_filters(root.path(), "mission-control-vercel-deploy-fixtures");
        assert_eq!(
            filters,
            vec![resolved(None, "mission-control-vercel-deploy-fixtures")]
        );
    }

    #[test]
    fn normalize_pytest_citation_converts_space_separated_classname_to_a_nodeid() {
        // Task 1016cbff AC4: implementers sometimes cite a pytest
        // unittest-style test as `<file>.py <Class>.<method>` instead of
        // the canonical `<file>.py::<Class>::<method>` nodeid.
        assert_eq!(
            normalize_pytest_citation(
                "agents/workflows/content-tasks/tests/test_foo.py FooTest.test_bar"
            ),
            "agents/workflows/content-tasks/tests/test_foo.py::FooTest::test_bar"
        );
    }

    #[test]
    fn normalize_pytest_citation_passes_through_an_already_qualified_nodeid() {
        assert_eq!(
            normalize_pytest_citation("agents/foo/test_bar.py::test_baz"),
            "agents/foo/test_bar.py::test_baz"
        );
    }

    #[test]
    fn looks_like_pytest_space_nodeid_matches_the_file_space_classname_dot_method_shape() {
        assert!(looks_like_pytest_space_nodeid(
            "agents/workflows/content-tasks/tests/test_foo.py FooTest.test_bar"
        ));
    }

    #[test]
    fn looks_like_pytest_space_nodeid_rejects_prose_mentioning_a_py_file() {
        assert!(!looks_like_pytest_space_nodeid(
            "see agents/foo/test_bar.py for the fixture setup"
        ));
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

    #[test]
    fn pytest_test_runner_falls_back_to_unittest_without_a_pyproject() {
        let root = tempdir().unwrap();
        let tests_dir = root.path().join("agents/workflows/content-tasks/tests");
        fs::create_dir_all(&tests_dir).unwrap();
        fs::write(
            tests_dir.join("test_sample.py"),
            "import unittest\n\n\nclass SampleTest(unittest.TestCase):\n    def test_pass(self):\n        self.assertTrue(True)\n",
        )
        .unwrap();

        let outcome = PytestTestRunner
            .run_in(
                root.path(),
                "agents/workflows/content-tasks/tests/test_sample.py::SampleTest::test_pass",
            )
            .expect("spawn python3 -m unittest");
        assert_eq!(
            outcome.exit_code, 0,
            "expected unittest fallback to report exit 0\nstdout: {}\nstderr: {}",
            outcome.stdout, outcome.stderr
        );
    }
}
