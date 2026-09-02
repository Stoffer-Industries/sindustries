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
    let files = pr_changed_files(url);
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
/// Returns an empty `Vec` if `gh` fails or the response cannot be decoded —
/// callers treat that as "no files touched" rather than a hard error so the
/// gate degrades gracefully on transient gh failures.
pub(crate) fn pr_changed_files(url: &str) -> Vec<String> {
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
        _ => return Vec::new(),
    };
    let raw = String::from_utf8(output.stdout).unwrap_or_default();
    raw.lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
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
