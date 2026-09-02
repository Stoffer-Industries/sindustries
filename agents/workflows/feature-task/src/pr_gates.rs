//! PR-gate helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W36 audit, finding A3: "feature-task
//! `main.rs` is 8,602 lines / 205 top-level items"). This module clusters the
//! helpers that read GitHub PR state, parse review status, and decide
//! whether a PR carries the canonical clippy-evidence string:
//!
//! - `pr_changed_files` — thin `gh` wrapper, returns the file list of a PR
//! - `parse_github_review_state` / `decode_pr_body_output` — pure JSON
//!   parsing of `gh pr view --json ...` output
//! - `ReviewState` — review-state classification consumed by the lobster
//!   gates in `main.rs` (`verify_delivery`, `feedback_aggregate`, `post_merge`)
//! - `body_has_checked_acceptance` — regex check for `- [x]` rows
//! - `CLIPPY_EVIDENCE_COMMAND` / `body_has_clippy_evidence` /
//!   `clippy_evidence_missing_failure` / `clippy_enforce_enabled` /
//!   `clippy_evidence_failures` — clippy-evidence gate (W34 follow-up, task
//!   `55c98158`)
//! - `FEATURE_TASK_RUST_PREFIX` / `touches_rust_feature_workflow` — predicate
//!   used by the gate to decide whether a PR is in scope for the rust
//!   feature-task workflow
//!
//! `pr_body` and the review-state → blocker-failure constructors
//! (`verify_delivery_review_failure`, `post_merge_pr_failure`,
//! `feedback_review_failure`, `is_latest_pr_url`, `pr_number`) stay in
//! `main.rs` per the W36 design: pr_gates consumes `pr_body` via
//! `crate::pr_body`, and the failure constructors carry workflow-state
//! orchestration logic that does not belong in a leaf helpers module.
//!
//! All items are `pub(crate)` — only `main.rs` consumes this surface.

use anyhow::Result;
use regex::Regex;
use serde_json::Value;
use std::process::Command;

/// True iff the PR's changed files touch the Rust feature-task workflow.
pub(crate) fn touches_rust_feature_workflow(files: &[String]) -> bool {
    files
        .iter()
        .any(|path| path.starts_with(FEATURE_TASK_RUST_PREFIX))
}

/// Path prefix that identifies a PR as touching the Rust feature-task
/// workflow. Mirrors the gate predicate in `clippy_evidence_failures`.
pub(crate) const FEATURE_TASK_RUST_PREFIX: &str = "agents/workflows/feature-task/";

/// Sentinel substring identifying the canonical clippy command for the
/// feature-task workflow. The gate (`clippy_evidence_failures`) requires
/// this exact substring to appear in the PR body so reviewers can copy the
/// command verbatim and reproduce the gate locally.
pub(crate) const CLIPPY_EVIDENCE_COMMAND: &str =
    "cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings";

/// True iff the PR body contains the canonical clippy command. Matches the
/// command line in either fenced or unfenced contexts.
pub(crate) fn body_has_clippy_evidence(body: &str) -> bool {
    body.lines()
        .any(|line| line.contains(CLIPPY_EVIDENCE_COMMAND))
}

/// Build the clippy-evidence blocker failure string. Kept centralised so the
/// clippy-evidence gate and the AC checklist can both cite the canonical
/// command verbatim.
pub(crate) fn clippy_evidence_missing_failure() -> String {
    format!(
        "[feature-task-progress-checklist] missing clippy evidence for Rust workflow PR. \
         Run: {CLIPPY_EVIDENCE_COMMAND}"
    )
}

/// Returns true when the clippy-evidence gate is enabled.
/// The gate ships disabled by default; flip `CLIPPY_ENFORCE=true` once the
/// feature-task clippy CI gate (`cbe3333a`) has been green for ≥1 week.
pub(crate) fn clippy_enforce_enabled() -> bool {
    std::env::var("CLIPPY_ENFORCE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "On"))
        .unwrap_or(false)
}

/// Check a PR for clippy evidence and append a failure if the PR touches
/// the feature-task Rust workflow and the PR body does not include the
/// canonical clippy command. Returns the failure list for the caller to
/// push into the lobster blocked comment.
pub(crate) fn clippy_evidence_failures(url: &str) -> Vec<String> {
    if !clippy_enforce_enabled() {
        return Vec::new();
    }
    let files = match pr_changed_files(url) {
        Ok(f) => f,
        Err(err) => {
            // Fail closed on `gh` errors: a merge gate that cannot read its
            // evidence must block, matching the `pr_body` Err discipline
            // (W36 audit finding A2). The empty-diff path (Ok(vec![])) is
            // intentionally NOT a failure — a label-only PR with no file
            // changes legitimately does not touch the Rust workflow.
            return vec![format!(
                "Could not list changed files for clippy evidence check ({url}): {err}."
            )];
        }
    };
    if !touches_rust_feature_workflow(&files) {
        return Vec::new();
    }
    match crate::pr_body(url) {
        Ok(body) if body_has_clippy_evidence(&body) => Vec::new(),
        Ok(_) => vec![clippy_evidence_missing_failure()],
        Err(err) => vec![format!(
            "Could not read PR body for clippy evidence check ({url}): {err}."
        )],
    }
}

/// Return the list of changed files for a PR via `gh pr view --json files`.
/// Returns `Ok(Vec)` with the file paths on a successful read (the Vec is
/// empty when the PR legitimately has no file changes), or `Err` with a
/// caller-actionable message when the `gh` invocation fails or its output
/// cannot be decoded. Callers that treat an empty diff as "doesn't touch
/// Rust" preserve that behaviour by matching on `Ok(files)` and reading
/// `.is_empty()`; `Err(_)` is reserved for the fail-closed path so a
/// transient `gh` blip cannot silently bypass a merge gate.
pub(crate) fn pr_changed_files(url: &str) -> Result<Vec<String>, String> {
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            url,
            "--json",
            "files",
            "--jq",
            ".files[].path",
        ])
        .output();
    let output = match output {
        Ok(out) if out.status.success() => out,
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            return Err(format!(
                "gh pr view {url} --json files --jq .files\\[\\].path exited {}: {stderr}",
                out.status
            ));
        }
        Err(err) => {
            return Err(format!(
                "failed to spawn `gh pr view` for {url}: {err}"
            ));
        }
    };
    let raw = String::from_utf8(output.stdout).unwrap_or_default();
    Ok(raw
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

/// gh 2.87.3 sometimes emits a JSON-encoded string (quote-wrapped, with
/// escaped newlines) when the body contains non-ASCII Unicode. Fall back to
/// raw passthrough if decoding fails so unexpected gh output preserves the
/// previous behaviour.
pub(crate) fn decode_pr_body_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') {
        if let Ok(Value::String(decoded)) = serde_json::from_str(trimmed) {
            return decoded;
        }
    }
    raw.to_string()
}

/// Parse the JSON output of `gh pr view --json reviewDecision,state,mergedAt,comments,reviews`
/// into a `ReviewState` classification used by the lobster gates
/// (`verify_delivery`, `feedback_aggregate`, `post_merge`).
pub(crate) fn parse_github_review_state(raw: &str) -> Result<ReviewState> {
    let value: Value = serde_json::from_str(raw)?;
    if value
        .get("mergedAt")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        return Ok(ReviewState::Merged);
    }
    if value.get("state").and_then(Value::as_str) == Some("CLOSED") {
        return Ok(ReviewState::ClosedUnmerged);
    }
    let decision = value
        .get("reviewDecision")
        .and_then(Value::as_str)
        .unwrap_or("");
    if decision == "CHANGES_REQUESTED" {
        return Ok(ReviewState::ChangesRequested);
    }
    let comments = value
        .get("comments")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let review_comments = value
        .get("reviews")
        .and_then(Value::as_array)
        .map_or(0, |reviews| {
            reviews
                .iter()
                .filter(|review| {
                    !review
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                })
                .count()
        });
    if comments + review_comments > 0 && decision != "APPROVED" {
        return Ok(ReviewState::CommentsPresent);
    }
    if decision == "APPROVED" {
        return Ok(ReviewState::Approved);
    }
    Ok(ReviewState::Required)
}

/// Review-state classification produced by `parse_github_review_state` and
/// consumed by the lobster gates in `main.rs`. Order in source matches
/// display order in `verify_delivery_review_failure`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewState {
    Approved,
    Required,
    ChangesRequested,
    CommentsPresent,
    Merged,
    ClosedUnmerged,
}

/// True iff the PR body contains at least one checked acceptance line.
/// Used by `verify_delivery` to reject draft-style bodies with no `- [x]`
/// AC evidence before the lobster runs the AC coverage check.
pub(crate) fn body_has_checked_acceptance(body: &str) -> bool {
    Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+.+")
        .unwrap()
        .is_match(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- W36 audit finding A2: clippy gate fails closed on `gh` errors ----

    /// Mutex serialising tests that mutate process-global state (PATH, the
    /// CLIPPY_ENFORCE env var). Cargo runs unit tests in parallel by
    /// default; without serialisation, two tests can both rewrite PATH and
    /// the second one's restore overwrites the first's view of "the
    /// previous PATH" — leaving the test environment permanently broken.
    /// The existing `clippy_enforce_enabled_respects_env_flag` shares the
    /// same hazard; lock contention is cheap (tests run fast) so we just
    /// serialise all env-var tests behind this one lock.
    static CLIPPY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Write a temporary directory containing a `gh` shell shim that exits
    /// non-zero with the given stderr, prepend that directory to PATH for
    /// the duration of `body`, then restore PATH. Used to simulate a
    /// transient `gh` API failure without mocking the entire Rust
    /// subprocess layer.
    ///
    /// Holds `CLIPPY_ENV_LOCK` for the full critical section (PATH set →
    /// body → PATH restore) so the helper, the body's `CLIPPY_ENFORCE`
    /// mutations, and any sibling env-var test cannot interleave. Without
    /// this lock, two `gh` shims can race on PATH and `remove_var` /
    /// `set_var` calls from sibling tests can be observed mid-flight by
    /// `clippy_enforce_enabled()`. See commit history on PR #562 (afe39f3d
    /// follow-up) for the failure mode this addresses.
    fn with_failing_gh_shim<F: FnOnce() -> R, R>(stderr_msg: &str, body: F) -> R {
        use std::os::unix::fs::PermissionsExt;
        let _env_guard = CLIPPY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("gh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho '{stderr_msg}' 1>&2\nexit 1\n"),
        )
        .expect("write gh shim");
        let mut perm = std::fs::metadata(&script).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&script, perm).unwrap();

        let prev = std::env::var("PATH").unwrap_or_default();
        let new_path = format!(
            "{}:{}",
            dir.path().display(),
            if prev.is_empty() {
                "/usr/bin:/bin".to_string()
            } else {
                prev.clone()
            }
        );
        std::env::set_var("PATH", &new_path);
        let result = body();
        // Restore PATH: if it was unset, unset it again; otherwise restore
        // the captured value. Setting PATH to "" leaves the process with an
        // empty PATH, which is not the same as unset and breaks downstream
        // Command::new("...") lookups in sibling tests.
        match prev.is_empty() {
            true => std::env::remove_var("PATH"),
            false => std::env::set_var("PATH", &prev),
        }
        drop(_env_guard);
        result
    }

    #[test]
    fn pr_changed_files_gh_failure_returns_err() {
        // AC1: signature change from Vec<String> to Result<Vec<String>, String>
        // so callers can distinguish "no files" from "`gh` failed".
        // `with_failing_gh_shim` acquires CLIPPY_ENV_LOCK for the full
        // critical section — no extra guard needed here.
        let result = with_failing_gh_shim("simulated transient gh failure", || {
            pr_changed_files("https://github.com/Stoffer-Industries/sindustries/pull/1")
        });
        let err = result.expect_err("expected Err when gh exits non-zero");
        assert!(
            err.contains("simulated transient gh failure"),
            "expected stderr in Err, got: {err}"
        );
        assert!(
            err.contains("exit"),
            "expected 'exit' status word in Err, got: {err}"
        );
    }

    #[test]
    fn clippy_evidence_failures_gh_failure_blocks_rust_pr() {
        // AC2 + AC4: when CLIPPY_ENFORCE=true and `gh` fails, the gate
        // records a failure (fail-closed, matching pr_body Err discipline)
        // instead of silently passing.
        // `with_failing_gh_shim` already holds CLIPPY_ENV_LOCK for the
        // whole critical section, so the body's CLIPPY_ENFORCE mutations
        // are serialised with PATH setup and any sibling env-var test.
        let result = with_failing_gh_shim("gh api timeout", || {
            std::env::set_var("CLIPPY_ENFORCE", "true");
            let failures = clippy_evidence_failures("https://github.com/foo/bar/pull/42");
            std::env::remove_var("CLIPPY_ENFORCE");
            failures
        });
        assert!(
            !result.is_empty(),
            "expected non-empty failures when gh errors and CLIPPY_ENFORCE=true"
        );
        assert!(
            result
                .iter()
                .any(|f| f.contains("Could not list changed files")),
            "expected 'Could not list changed files' in failures, got: {result:?}"
        );
        assert!(
            result.iter().any(|f| f.contains("pull/42")),
            "expected the PR URL to be retained in the failure message, got: {result:?}"
        );
    }

    #[test]
    fn clippy_evidence_failures_gh_failure_ignored_when_enforce_disabled() {
        // AC5-adjacent: when CLIPPY_ENFORCE is unset the gate short-circuits
        // BEFORE invoking gh — both today's contract (don't run the gate
        // unless explicitly opted in) and today's behaviour (silent pass on
        // unset). Verifies the new Result plumbing does not regress this.
        // `with_failing_gh_shim` already holds CLIPPY_ENV_LOCK — no extra
        // guard needed.
        let result = with_failing_gh_shim("gh api timeout", || {
            std::env::remove_var("CLIPPY_ENFORCE");
            clippy_evidence_failures("https://github.com/foo/bar/pull/99")
        });
        assert!(
            result.is_empty(),
            "expected empty failures when CLIPPY_ENFORCE unset, got: {result:?}"
        );
    }

    #[test]
    fn clippy_evidence_matches_canonical_command() {
        let body = "## Test plan\n\
                    - [x] run `cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings`\n";
        assert!(body_has_clippy_evidence(body));
    }

    #[test]
    fn clippy_evidence_matches_command_outside_fence() {
        let body = "Verified locally with: cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings\n";
        assert!(body_has_clippy_evidence(body));
    }

    #[test]
    fn clippy_evidence_rejects_unrelated_clippy_command() {
        // Different manifest path — should not match the feature-task gate.
        let body = "cargo clippy --manifest-path services/budget-api/Cargo.toml --all-targets -- -D warnings\n";
        assert!(!body_has_clippy_evidence(body));
    }

    #[test]
    fn clippy_evidence_rejects_missing_command() {
        let body = "## Test plan\n- [x] AC1: ran unit tests\n";
        assert!(!body_has_clippy_evidence(body));
    }

    #[test]
    fn touches_rust_feature_workflow_matches_prefix() {
        let files = vec![
            "agents/workflows/feature-task/src/main.rs".to_string(),
            "agents/workflows/feature-task/Cargo.toml".to_string(),
        ];
        assert!(touches_rust_feature_workflow(&files));
    }

    #[test]
    fn touches_rust_feature_workflow_rejects_other_paths() {
        let files = vec![
            "agents/workflows/code-task/src/main.rs".to_string(),
            "docs/specs/feature-task.md".to_string(),
        ];
        assert!(!touches_rust_feature_workflow(&files));
    }

    #[test]
    fn touches_rust_feature_workflow_rejects_empty_list() {
        let files: Vec<String> = vec![];
        assert!(!touches_rust_feature_workflow(&files));
    }

    #[test]
    fn clippy_evidence_failure_includes_canonical_command() {
        let failure = clippy_evidence_missing_failure();
        assert!(failure.contains(CLIPPY_EVIDENCE_COMMAND));
        assert!(failure.contains("missing clippy evidence"));
    }

    #[test]
    fn clippy_enforce_enabled_respects_env_flag() {
        // This test mutates CLIPPY_ENFORCE directly (no `with_failing_gh_shim`
        // helper), so it must hold CLIPPY_ENV_LOCK for the full body — see
        // the lock's doc comment for the rationale.
        let _env_guard = CLIPPY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Default is disabled
        std::env::remove_var("CLIPPY_ENFORCE");
        assert!(!clippy_enforce_enabled());

        // Explicit truthy values
        for v in ["1", "true", "TRUE", "yes", "YES", "on", "On"] {
            std::env::set_var("CLIPPY_ENFORCE", v);
            assert!(
                clippy_enforce_enabled(),
                "CLIPPY_ENFORCE={v} should enable gate"
            );
        }

        // Falsy values stay disabled
        for v in ["0", "false", "no", "off", "", "anything-else"] {
            std::env::set_var("CLIPPY_ENFORCE", v);
            assert!(
                !clippy_enforce_enabled(),
                "CLIPPY_ENFORCE={v} should leave gate disabled"
            );
        }

        std::env::remove_var("CLIPPY_ENFORCE");
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new("fixtures").join(name))
            .unwrap_or_else(|err| panic!("read fixture {name}: {err}"))
    }

    #[test]
    fn parse_review_state_approved() {
        assert_eq!(
            parse_github_review_state(&fixture("github_approved.json")).unwrap(),
            ReviewState::Approved
        );
    }

    #[test]
    fn parse_review_state_changes_requested() {
        assert_eq!(
            parse_github_review_state(&fixture("github_changes_requested.json")).unwrap(),
            ReviewState::ChangesRequested
        );
    }

    #[test]
    fn parse_review_state_merged() {
        assert_eq!(
            parse_github_review_state(&fixture("github_merged.json")).unwrap(),
            ReviewState::Merged
        );
    }

    #[test]
    fn parse_review_state_required() {
        assert_eq!(
            parse_github_review_state(&fixture("github_required.json")).unwrap(),
            ReviewState::Required
        );
    }
}
