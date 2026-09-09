//! Verify-delivery leaf helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module
//! hosts the small, pure helpers used by the `verify_delivery` stage
//! handler (still in `main.rs` for this PR-A slice) and by `post_merge`
//! (line 1513 of `main.rs`). The stage handler itself moves with the
//! follow-up slice in this task's trajectory.
//!
//! Public surface (all `pub(crate)` — only `main.rs` consumes these):
//! - `pr_number` — extract the PR number from a GitHub PR URL
//! - `is_latest_pr_url` — membership test for the
//!   `latest_implementer_pr_urls(task)` set
//! - `verify_delivery_review_failure` — review-state → blocker-failure
//!   constructor for the `verify_delivery` gate
//! - `qa_agent_verified_failures` — failure strings for the `qa_agent`
//!   structured-approval gate; the gate predicate itself
//!   (`qa_agent_verified`) stays in `main.rs` for PR-A and moves with
//!   PR-D (task_approvals.rs)
//!
//! These helpers do no I/O, no network, and no state mutation. They
//! are exercised as focused units via the `#[cfg(test)] mod tests`
//! block at the bottom of this file; the stage handler's higher-level
//! integration coverage stays in `main.rs`.

use crate::pr_gates;

/// Extract the PR number from a GitHub PR URL for ordering.
pub(crate) fn pr_number(url: &str) -> u64 {
    url.rsplit('/')
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
}

/// True when `candidate` is a member of `latest_pr_urls` — the pre-computed
/// result of `latest_implementer_pr_urls`, i.e. the PR(s) named in the most
/// recent `[implementer-prs]`/`[rowan-prs]` comment. Used by `verify_delivery`
/// and `post_merge` to skip review-state and body checks against superseded
/// PRs (e.g. a v1 branch that was closed-without-merge and replaced by a v2
/// branch, or an accidental duplicate PR that a later comment corrected
/// away from). Callers must pass `latest_implementer_pr_urls(task)`, not the
/// full historical `implementer_pr_urls(task)` — comparing by PR-number
/// magnitude instead of comment recency broke on task 30251df0, where the
/// abandoned duplicate PR happened to have the higher number.
pub(crate) fn is_latest_pr_url(candidate: &str, latest_pr_urls: &[String]) -> bool {
    latest_pr_urls.iter().any(|url| url == candidate)
}

/// Map a PR review state to the corresponding `verify_delivery` gate failure
/// string. `ChangesRequested` and `ClosedUnmerged` block; every other state
/// (including `Approved`, `Required`, and unknown) is a pass-through.
pub(crate) fn verify_delivery_review_failure(
    url: &str,
    review: pr_gates::ReviewState,
) -> Option<String> {
    match review {
        pr_gates::ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        pr_gates::ReviewState::ClosedUnmerged => Some(format!("PR {url} is closed without merge.")),
        _ => None,
    }
}

/// Failure strings for the `qa_agent` gate. Empty when the gate is satisfied.
/// Used by `verify_delivery` to short-circuit the transition with a
/// `[qa-agent-blocked]` comment. Gate predicate (`qa_agent_verified`) lives
/// in `main.rs` until PR-D (task_approvals.rs).
pub(crate) fn qa_agent_verified_failures(task: &crate::Task) -> Vec<String> {
    if crate::qa_agent_verified(task) {
        vec![]
    } else {
        vec!["Structured `qa_agent` approval is missing or not approved; Ash must run mechanical verification (cited tests pass, cited files exist, evidence matches the diff) before this task reaches Tom's acceptance. See task `f6a4d56a` AC1.".to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_delivery_review_gate_allows_pending_review() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(verify_delivery_review_failure(url, pr_gates::ReviewState::Required).is_none());
        assert!(verify_delivery_review_failure(url, pr_gates::ReviewState::CommentsPresent).is_none());
        assert!(verify_delivery_review_failure(url, pr_gates::ReviewState::Merged).is_none());
        assert_eq!(
            verify_delivery_review_failure(url, pr_gates::ReviewState::ChangesRequested),
            Some(format!("Changes requested on {url}."))
        );
        assert_eq!(
            verify_delivery_review_failure(url, pr_gates::ReviewState::ClosedUnmerged),
            Some(format!("PR {url} is closed without merge."))
        );
    }

    #[test]
    fn pr_number_extracts_from_url() {
        assert_eq!(
            pr_number("https://github.com/Stoffer-Industries/sindustries/pull/142"),
            142
        );
        assert_eq!(pr_number("not-a-url"), 0);
    }

    #[test]
    fn is_latest_pr_url_returns_true_only_for_members_of_latest_set() {
        // `latest_pr_urls` is a pre-resolved set (the most recent
        // [implementer-prs] comment's URLs), not "all PR URls ever seen" —
        // membership, not PR-number magnitude, decides "latest" now.
        let latest_urls =
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/368".to_string()];
        assert!(!is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &latest_urls
        ));
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/368",
            &latest_urls
        ));
    }

    #[test]
    fn is_latest_pr_url_handles_single_url() {
        let urls =
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/365".to_string()];
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_returns_false_for_empty_list() {
        let urls: Vec<String> = vec![];
        assert!(!is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_returns_false_for_candidate_not_in_latest_set() {
        let latest_urls =
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/365".to_string()];
        assert!(!is_latest_pr_url("not-a-url", &latest_urls));
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &latest_urls
        ));
    }

    #[test]
    fn is_latest_pr_url_true_for_every_member_of_a_multi_workstream_latest_set() {
        // A single [implementer-prs] comment can legitimately name multiple
        // PRs for concurrent workstreams (see
        // implementer_pr_urls_preserve_merged_prs_for_delivery). All of them
        // are "latest" together — none should be treated as superseded just
        // because another has a higher PR number.
        let latest_urls = vec![
            "https://github.com/foo/bar/pull/10".to_string(),
            "https://github.com/baz/qux/pull/12".to_string(),
        ];
        assert!(is_latest_pr_url("https://github.com/foo/bar/pull/10", &latest_urls));
        assert!(is_latest_pr_url("https://github.com/baz/qux/pull/12", &latest_urls));
    }
}