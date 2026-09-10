//! Feedback-aggregate stage handler + review-failure helper for the
//! feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a god file"). This module hosts the `feedback_aggregate`
//! stage handler and the small `feedback_review_failure` helper that maps a
//! PR review state to the corresponding failure string for the
//! `feedback_aggregate` gate. Sibling to `verify_delivery.rs` (PR-A) and
//! the planned `post_merge.rs` (PR-C).
//!
//! Public surface (all `pub(crate)` — only `main.rs` and sibling modules
//! consume these):
//! - `feedback_aggregate` — `acceptance → done` gate; iterates the task's
//!   implementer PRs, calls `inspect_pr` for each, accumulates
//!   `feedback_review_failure` strings, and routes either `[feature-task-progress-checklist]`
//!   clear or `[implementer-feedback]` failure comments. Spec-drift and
//!   manual-block guards short-circuit before the PR review loop.
//! - `feedback_review_failure` — review-state → blocker-failure
//!   constructor for the `feedback_aggregate` gate. Mirrors
//!   `verify_delivery_review_failure` in `verify_delivery.rs` but
//!   rejects `CommentsPresent` as well as `ChangesRequested` (the
//!   feedback-aggregate stage runs in `acceptance`, where open review
//!   comments must be resolved before Tom's `accepted` gate).
//!
//! The helper does no I/O, no network, and no state mutation. It is
//! exercised as a focused unit via the `#[cfg(test)] mod tests` block
//! at the bottom of this file; the stage handler's higher-level
//! integration coverage stays in `main.rs`.

use crate::brain_spec_lifecycle::{
    block_on_spec_drift_fluid, block_with_manual_block, manual_block_failures,
};
use crate::pr_gates;
use crate::product_spec_parsing::{implementer_pr_urls, inspect_pr};
use crate::{
    add_comment, api_get_task, read_envelope, reconcile_workflow_attention,
    spec_checksum_mismatch_message, Envelope, StageArgs,
};
use anyhow::Result;

/// `acceptance → done` stage handler. Aggregates PR review feedback across
/// the task's latest implementer PRs and either clears the gate or posts
/// an `[implementer-feedback]` comment summarising the failures. Spec-drift
/// and manual-block guards short-circuit before the PR review loop.
pub(crate) fn feedback_aggregate(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "feedback_aggregate")? {
        if !drift.criteria_met {
            return Ok(drift);
        }
        env = drift;
    }
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "feedback_aggregate",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    let mut failures = Vec::new();
    for url in implementer_pr_urls(&env.task) {
        match inspect_pr(&url) {
            Ok(review) => {
                if let Some(failure) = feedback_review_failure(&url, review) {
                    failures.push(failure);
                }
            }
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
    }
    if failures.is_empty() {
        env.criteria_met = true;
        env.action_taken = "feedback_clear".to_string();
        return Ok(env);
    }
    if !args.dry_run {
        if let Err(err) = add_comment(
            &args.base_url,
            &env.task.id,
            &format!("[implementer-feedback]\n{}", failures.join("\n")),
        ) {
            if let Some(message) = spec_checksum_mismatch_message(&err) {
                env.criteria_met = false;
                env.action_taken = "feedback_aggregate_blocked_spec_drift".to_string();
                env.failures = vec![message];
                return Ok(env);
            }
            return Err(err);
        }
        env.task = api_get_task(&args.base_url, &env.task.id)?;
    }
    env.criteria_met = false;
    env.action_taken = "feedback_routed".to_string();
    env.failures = failures;
    Ok(env)
}

/// Map a PR review state to the corresponding `feedback_aggregate` gate
/// failure string. `ChangesRequested` and `CommentsPresent` block (open
/// review comments must be resolved before the `accepted` gate). Every
/// other state (including `Required`, `Approved`, `Merged`) is a
/// pass-through.
pub(crate) fn feedback_review_failure(url: &str, review: pr_gates::ReviewState) -> Option<String> {
    match review {
        pr_gates::ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        pr_gates::ReviewState::CommentsPresent => {
            Some(format!("Open review comments remain on {url}."))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_aggregate_waits_on_required_review_without_failure() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(feedback_review_failure(url, pr_gates::ReviewState::Required).is_none());
        assert_eq!(
            feedback_review_failure(url, pr_gates::ReviewState::ChangesRequested),
            Some(format!("Changes requested on {url}."))
        );
    }
}
