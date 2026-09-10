//! Post-merge stage handler for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module
//! hosts the `acceptance -> done` transition plus the two helpers it
//! composes: the per-PR review-state failure constructor and the
//! best-effort worktree-cleanup runner.
//!
//! `pub(crate)` surface (only `main.rs` consumes these): `post_merge`
//! (the `acceptance -> done` stage handler; idempotent on already-archived
//! tasks), `post_merge_pr_failure` (review-state -> blocker-failure
//! constructor used by `post_merge`'s PR sweep; skips ClosedUnmerged for
//! PRs NOT in the latest-implementer set, mirroring `verify_delivery`'s
//! latest-only filter), and `run_post_merge_worktree_cleanup` (best-effort
//! `git worktree remove` sweep for any worktree created for this task).
//!
//! The worktree-cleanup implementation (`cleanup_task_worktree_for_task`
//! plus its helpers) stays in `main.rs` for this slice and follows with
//! the reconciliation cluster as PR-D. `post_merge.rs` consumes them via
//! `crate::{cleanup_task_worktree_for_task, format_worktree_cleanup_summary,
//! WorktreeEntry, ...}` — the same pattern `verify_delivery.rs` uses for
//! `implementer_pr_urls` etc.
//!
//! Spec drift is intentionally NOT blocked at post_merge: Tom owns the ACs
//! during QA and may legitimately refine them. The spec-resync flow
//! (unchecking "Approved by Tom" and requiring explicit re-approval)
//! handles drift tracking.

use anyhow::Result;

use crate::brain_spec_lifecycle::{
    archive_done_task_spec, block_with_manual_block, manual_block_failures,
};
use crate::pr_gates;
use crate::product_spec_parsing::{implementer_pr_urls, inspect_pr, latest_implementer_pr_urls};
use crate::task_approvals;
use crate::{
    ac_parsing, add_comment, analytics, api_get_task, api_patch, cleanup_task_worktree_for_task,
    format_worktree_cleanup_summary, is_past, pr_body, read_envelope, transition_or_block,
    workflow_handoff, write_state, Envelope, StageArgs, Task,
};

/// PRs that are *not* in `latest_pr_urls` (see `latest_implementer_pr_urls`)
/// are treated as superseded (same principle as `verify_delivery`'s
/// latest-only filter) and do not block. A ClosedUnmerged PR that is still
/// in `latest_pr_urls` fails, as do open / review / unknown states on any
/// listed PR.
pub(crate) fn post_merge_pr_failure(
    url: &str,
    state: pr_gates::ReviewState,
    latest_pr_urls: &[String],
) -> Option<String> {
    match state {
        pr_gates::ReviewState::Merged => None,
        pr_gates::ReviewState::ClosedUnmerged
            if !crate::verify_delivery::is_latest_pr_url(url, latest_pr_urls) =>
        {
            None
        }
        other => Some(format!("PR {url} is not merged: {other:?}.")),
    }
}

/// Best-effort removal of any feature-task worktree that was created for this
/// task. Runs on every post_merge invocation that reaches the `done` state
/// (including idempotent re-runs) so stale worktrees cannot accumulate.
/// Cleanup failures are surfaced as a `[feature-task-progress-checklist]`
/// comment but never block the lobster.
pub(crate) fn run_post_merge_worktree_cleanup(
    args: &StageArgs,
    mut env: Envelope,
) -> Result<Envelope> {
    if args.dry_run {
        return Ok(env);
    }
    let results = cleanup_task_worktree_for_task(&args.repo, &env.task.id);
    let had_failure = results
        .iter()
        .any(|r| matches!(r.outcome, crate::WorktreeCleanupOutcome::Failed(_)));
    if results.is_empty() {
        return Ok(env);
    }
    let header = if had_failure {
        "Post-merge worktree cleanup encountered errors (non-fatal):"
    } else {
        "Post-merge worktree cleanup:"
    };
    let body = format_worktree_cleanup_summary(&results);
    // Best-effort: a comment write failure should not block the lobster.
    let _ = add_comment(
        &args.base_url,
        &env.task.id,
        &format!("[feature-task-progress-checklist]\n{header}\n{body}"),
    );
    if had_failure {
        // Surface the failure on the envelope so the heartbeat can see it,
        // but do not flip criteria_met -- the task is still done.
        if env.action_taken.is_empty() || env.action_taken == "moved_to_done" {
            env.action_taken = "moved_to_done_worktree_cleanup_warning".to_string();
        } else {
            env.action_taken = format!("{}_worktree_cleanup_warning", env.action_taken);
        }
    }
    Ok(env)
}

/// `acceptance -> done` transition for the feature-task workflow.
///
/// Behaviour summary:
/// - Reconcile attention owners (separate concern, stays in main.rs).
/// - Honour manual blocks via `manual_block_failures` (block with
///   `[feature-task-blocked]`).
/// - Re-checked ACs after a merge: any unchecked AC not covered by any
///   merged PR body reverts the task to `doing` and posts a
///   `[feature-task-progress-checklist]` comment.
/// - Past-acceptance (Tom already verified) path: reverts to `acceptance`
///   if qa_failures is non-empty (defense-in-depth), or marks
///   `already_past_acceptance` and runs the worktree-cleanup sweep on the
///   terminal `done` state.
/// - Default path: collect PR failure strings (driven by
///   `post_merge_pr_failure`), call `transition_or_block` to attempt the
///   `done` handoff, and on success archive the spec + run worktree cleanup.
pub(crate) fn post_merge(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    crate::reconcile_workflow_attention(&args, &mut env)?;
    // Spec drift is not blocked at post_merge: Tom owns the ACs during QA and may
    // legitimately refine them. The resync flow (unchecking "Approved by Tom" and
    // requiring explicit re-approval) handles drift tracking; see the spec-resync
    // feature task for full implementation.
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "post_merge",
            manual_failures,
            "[feature-task-blocked]",
        );
    }

    // If the task has unchecked ACs that don't appear in any merged PR body, those ACs
    // were added after the PRs landed and are not yet implemented. Revert to `doing`
    // so the implementer picks up the new work and opens a follow-up PR.
    // Unchecked ACs that DO appear in a merged PR are mid-QA (Tom hasn't checked them
    // off yet) — those are fine; leave them until qa-ac-verified.
    let description = env.task.description.clone().unwrap_or_default();
    let unchecked_acs = ac_parsing::unchecked_task_ac_labels(&description);
    if !unchecked_acs.is_empty() {
        let pr_bodies: Vec<String> = implementer_pr_urls(&env.task)
            .iter()
            .filter_map(|url| pr_body(url).ok())
            .collect();
        let needs_pr = ac_parsing::ac_labels_needing_new_pr(&unchecked_acs, &pr_bodies);
        if !needs_pr.is_empty() {
            let labels = needs_pr.join(", ");
            let fingerprint = format!("uncovered_acs:{labels}");
            if !args.dry_run {
                api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    serde_json::json!({"status": "doing", "workflowHandoff": serde_json::Value::Null}),
                )?;
                env.task = api_get_task(&args.base_url, &env.task.id)?;
                if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
                    env.lobster_state.failure_fingerprint = Some(fingerprint);
                    add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!(
                            "[feature-task-progress-checklist]\nUnchecked ACs ({labels}) are not covered by any merged PR — reverted to `doing`. Open a new PR covering these ACs; once merged, Tom can verify with `[qa-ac-verified] true`."
                        ),
                    )?;
                    write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
                }
            }
            env.criteria_met = false;
            env.action_taken = "post_merge_reverted_to_doing".to_string();
            env.failures = vec![format!(
                "Unchecked ACs ({labels}) are not covered by any merged PR."
            )];
            return Ok(env);
        }
    }

    // AC text check runs pre-merge at the doing → acceptance gate (verify_delivery).
    // Require Tom's explicit sign-off before closing.
    let qa_failures = task_approvals::accepted_structured_failures(&env.task);
    if is_past(&env.task, "acceptance") {
        if !qa_failures.is_empty() {
            if !args.dry_run {
                api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    serde_json::json!({"status": "acceptance", "workflowHandoff": workflow_handoff("qa_verifier", "qa", "Acceptance criteria require QA verification")}),
                )?;
                env.task = api_get_task(&args.base_url, &env.task.id)?;
                let fingerprint = qa_failures.join("\n");
                if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
                    env.lobster_state.failure_fingerprint = Some(fingerprint);
                    add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!(
                            "[feature-task-progress-checklist]\nTask advanced to `done` without Tom verifying task ACs. Reverted to `acceptance`.\n{}",
                            qa_failures.join("\n")
                        ),
                    )?;
                    write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
                }
            }
            env.criteria_met = false;
            env.action_taken = "post_merge_reverted_to_acceptance".to_string();
            env.failures = qa_failures;
            // AC2: every gate failure emits a `gate_failure` event. The non-past
            // `post_merge` path goes through `transition_or_block` which calls
            // `emit_gate_failure_events`; this `is_past` early-return path
            // doesn't, so it must emit here to keep the weekly analytics
            // dashboard (`qualityFailureCount`) consistent across re-runs.
            if !args.dry_run && !env.failures.is_empty() {
                analytics::emit_gate_failure_events(&args, &env.task, "post_merge", &env.failures);
            }
            return Ok(env);
        }
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_acceptance".to_string();
        let env = run_post_merge_worktree_cleanup(&args, env)?;
        // AC1: best-effort terminal summary emission (idempotent on re-run
        // via stable eventKey). Never blocks task progression.
        if !args.dry_run && env.criteria_met && env.task.status == "done" {
            analytics::emit_terminal_summary_event(&args, &env.task, "done");
        }
        return Ok(env);
    }
    let mut failures = qa_failures;
    let pr_urls = implementer_pr_urls(&env.task);
    let latest_urls = latest_implementer_pr_urls(&env.task);
    for url in &pr_urls {
        match inspect_pr(url) {
            Ok(state) => {
                if let Some(failure) = post_merge_pr_failure(url, state, &latest_urls) {
                    failures.push(failure);
                }
            }
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
    }
    let env = transition_or_block(
        &args,
        env,
        "done",
        "post_merge",
        failures,
        Some(workflow_handoff(
            "qa_verifier",
            "qa",
            "Acceptance criteria require QA verification",
        )),
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `done`.",
    )?;
    // If the transition succeeded, archive the task spec into brain/tasks/specs/done/
    // and rewrite the description's Spec line. Idempotent: re-running post_merge
    // on an already-archived task is a no-op.
    if env.criteria_met && env.task.status == "done" {
        // AC1: best-effort terminal summary emission (idempotent on re-run).
        if !args.dry_run {
            analytics::emit_terminal_summary_event(&args, &env.task, "done");
        }
        let env = archive_done_task_spec(&args, env)?;
        return run_post_merge_worktree_cleanup(&args, env);
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_merge_skips_superseded_closed_unmerged_prs() {
        // A v1 PR was closed-without-merge and replaced by a v2 (the latest
        // implementer PR). post_merge should NOT block on the v1.
        let closed = "https://github.com/owner/repo/pull/100";
        let merged = "https://github.com/owner/repo/pull/101";
        let latest_urls = vec![merged.to_string()];
        assert!(
            post_merge_pr_failure(closed, pr_gates::ReviewState::ClosedUnmerged, &latest_urls)
                .is_none(),
            "superseded closed-unmerged PRs must not block"
        );
        assert!(
            post_merge_pr_failure(merged, pr_gates::ReviewState::Merged, &latest_urls).is_none()
        );
    }

    #[test]
    fn post_merge_skips_closed_unmerged_pr_with_lower_number_than_superseded_duplicate() {
        // Regression: prior implementation compared PR numbers, which broke
        // when the abandoned duplicate PR happened to have the higher number.
        // The latest-only filter via latest_implementer_pr_urls resolves this.
        let later_closed = "https://github.com/owner/repo/pull/100";
        let later_merged = "https://github.com/owner/repo/pull/200";
        let urls = vec![later_merged.to_string()];
        assert!(
            post_merge_pr_failure(later_closed, pr_gates::ReviewState::ClosedUnmerged, &urls,)
                .is_none()
        );
    }

    #[test]
    fn post_merge_still_fails_latest_closed_unmerged_pr() {
        // The latest-implementer PR is itself closed-without-merge:
        // must fail (no further fallback).
        let later_closed = "https://github.com/owner/repo/pull/200";
        let urls = vec![later_closed.to_string()];
        assert!(
            post_merge_pr_failure(later_closed, pr_gates::ReviewState::ClosedUnmerged, &urls)
                .is_some()
        );
    }

    #[test]
    fn post_merge_still_fails_open_earlier_pr() {
        // Even an earlier implementer PR that's open must fail — the
        // latest-only filter only carves out closed-unmerged supersedure.
        let earlier_open = "https://github.com/owner/repo/pull/100";
        let later_merged = "https://github.com/owner/repo/pull/200";
        let urls = vec![later_merged.to_string(), earlier_open.to_string()];
        assert!(
            post_merge_pr_failure(earlier_open, pr_gates::ReviewState::Approved, &urls).is_some()
        );
        assert!(
            post_merge_pr_failure(later_merged, pr_gates::ReviewState::Merged, &urls).is_none()
        );
    }

    // Worktree-cleanup helpers live in main.rs for this slice; once the
    // reconciliation cluster (PR-D) moves them, these tests follow.
}
