//! Spec-check, ready-checks, and code-task variant stage handlers for the
//! feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a god file"). This module hosts the four
//! `open -> ready` / `ready -> doing` stage handlers (`spec_check`,
//! `ready_checks`, `code_task_tech_design_check`, `code_task_ready_checks`)
//! and the small workflow-attention reconcile cluster
//! (`workflow_attention_owner`, `ash_was_last_commenter`,
//! `managed_owner_reason_satisfied`, `reconciled_attention_owners`,
//! `reconcile_workflow_attention`, `workflow_handoff`,
//! `transition_or_block`) that they all compose.
//!
//! `pub(crate)` surface (only `main.rs` and sibling stage modules consume
//! these):
//!
//! - `spec_check` — `open -> ready` stage handler for feature tasks; runs
//!   spec-drift reconciliation, manual-block guards, and the
//!   `lobster_state::spec_failures` gate; routes the missing-spec-checksum
//!   revert-to-open path.
//! - `ready_checks` — `ready -> doing` stage handler for feature tasks;
//!   runs the tech-design approval gate, the implementer-required gate, and
//!   the implementer-doing-capacity gate.
//! - `code_task_tech_design_check` — `open -> ready` stage handler for
//!   `taskType: code` tasks; replaces the strict tech-design gate with the
//!   optional `[tech-design]` / `[tech-design-not-required]` waiver
//!   combination.
//! - `code_task_ready_checks` — `ready -> doing` stage handler for code
//!   tasks; runs the assignee + capacity gate only (the tech-design gate
//!   already ran in the prior stage).
//! - `workflow_attention_owner` — derive the workflow-owned head slot
//!   (`Quinn` for unapproved tech design, `Ash` for unverified `qa_agent`,
//!   `Tom` for unapproved `accepted`); returns `None` when the gate is
//!   satisfied.
//! - `ash_was_last_commenter` — gate so Ash's own comments do not let a
//!   stale `Ash` head persist into the next lobster sweep.
//! - `managed_owner_reason_satisfied` — predicate for whether the head of
//!   `attention_owners` is satisfied (gates head removal in
//!   `reconciled_attention_owners`).
//! - `reconciled_attention_owners` — produce the post-reconciliation
//!   attention-owners stack by reconciling only the workflow-owned head
//!   slot.
//! - `reconcile_workflow_attention` — apply `reconciled_attention_owners`
//!   to the task via `api_patch`, idempotent on equal stacks.
//! - `workflow_handoff` — build an `ActiveWorkflowHandoff` value
//!   (`role_id`, `gate`, `reason`).
//! - `transition_or_block` — single transition-or-block helper used by all
//!   four stage handlers; writes the `[feature-task-progress-checklist]` or
//!   `[code-task-progress-checklist]` comment, runs the `api_patch` to the
//!   next status, persists the `[lobster-state]` write, and emits the
//!   `gate_failure` analytics event on block.
//!
//! Spec drift is intentionally NOT blocked here: Tom owns the ACs during
//! QA and may legitimately refine them. The spec-resync flow
//! (`block_on_spec_drift_fluid` in `brain_spec_lifecycle`) handles drift
//! tracking across stages.

use anyhow::Result;
use serde_json::{json, Value};

use crate::task_approvals;
use crate::{
    brain_spec_lifecycle,
    product_spec_parsing, ActiveWorkflowHandoff, Envelope, StageArgs, Task, api_client,
    bootstrap_task_spec_layout, lobster_state, move_approved_chat_spec_if_needed,
};

/// `open -> ready` stage handler for feature tasks.
///
/// Pipeline (in order):
///   1. Reconcile workflow-owned attention head.
///   2. Bootstrap the task's brain-spec layout (creates `brain/tasks/specs/`
///      tree if missing).
///   3. Block on spec drift if a re-approval is in flight.
///   4. Manual-block guard.
///   5. Move an approved chat spec into in-progress (if linked).
///   6. If already past `open`, ensure `specChecksum` is populated; revert
///      to `open` if missing.
///   7. Run `spec_failures`; transition to `ready` when empty.
pub(crate) fn spec_check(args: StageArgs) -> Result<Envelope> {
    let mut env = api_client::read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    bootstrap_task_spec_layout(product_spec_parsing::workspace_root(&args))?;
    if let Some(drift) =
        brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env.clone(), "spec_check")?
    {
        if !drift.criteria_met {
            return Ok(drift);
        }
        // Resync succeeded — propagate fresh task/state so downstream
        // stages in the same pipeline run see the updated specChecksum.
        env = drift;
    }
    let manual_failures = brain_spec_lifecycle::manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return brain_spec_lifecycle::block_with_manual_block(
            &args,
            env,
            "spec_check",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    // Spec lifecycle movement is independent from legacy approval/description
    // reconciliation. An authoritative structured approval must still move a
    // linked chat spec into in-progress; this helper patches only the Spec path.
    if !args.dry_run {
        env = move_approved_chat_spec_if_needed(&args, env)?;
    }
    if lobster_state::is_past(&env.task, "open") {
        let failures = lobster_state::missing_spec_checksum_failures(
            &env.task,
            &args.repo,
            product_spec_parsing::workspace_root(&args),
        );
        if !failures.is_empty() {
            if !args.dry_run {
                api_client::api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"status": "open", "workflowHandoff": workflow_handoff("product_spec_approver", "spec", "Product spec approval is required")}),
                )?;
                env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
                let fingerprint = failures.join("\n");
                if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
                    env.lobster_state.failure_fingerprint = Some(fingerprint);
                    api_client::add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!(
                            "[feature-task-progress-checklist]\nTask advanced past spec check without passing the gate. Reverted to `open`.\n{}",
                            failures.join("\n")
                        ),
                    )?;
                    lobster_state::write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
                }
            }
            env.criteria_met = false;
            env.action_taken = "spec_check_reverted_to_open".to_string();
            env.failures = failures;
            return Ok(env);
        }
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_open".to_string();
        return Ok(env);
    }
    let failures = lobster_state::spec_failures(
        &env.task,
        &args.repo,
        product_spec_parsing::workspace_root(&args),
    );
    // The legacy task-description approval mirror (mirror_task_approval_to_brain_spec_if_needed)
    // is removed as part of e2aba106 WS2: approval state is now exclusively structured TaskApproval
    // rows, and the brain spec file marker is owned by the brain-spec workflow, not the task
    // description. The auto-mirror previously rewrote the brain spec file from the task-description
    // checkbox; with the task-description checkbox gone, there is nothing to mirror from.
    transition_or_block(
        &args,
        env,
        "ready",
        "spec_check",
        failures,
        Some(workflow_handoff(
            "product_spec_approver",
            "spec",
            "Product spec approval is required",
        )),
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `ready`.",
    )
}

/// `ready -> doing` stage handler for feature tasks.
///
/// Pipeline (in order):
///   1. Reconcile workflow-owned attention head.
///   2. Block on spec drift if a re-approval is in flight.
///   3. Manual-block guard.
///   4. Tech-design URL + structured-approval gate.
///   5. Implementer-required gate.
///   6. Implementer-doing-capacity gate.
///   7. Transition to `doing` when all gates are satisfied.
pub(crate) fn ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = api_client::read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    if let Some(drift) =
        brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env.clone(), "ready_checks")?
    {
        if !drift.criteria_met {
            return Ok(drift);
        }
        env = drift;
    }
    let manual_failures = brain_spec_lifecycle::manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return brain_spec_lifecycle::block_with_manual_block(
            &args,
            env,
            "ready_checks",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    if lobster_state::is_past(&env.task, "ready") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_ready".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    if product_spec_parsing::tech_design_url(&env.task).is_none() {
        failures.push("Missing task comment `[tech-design] <url>`.".to_string());
    }
    if !product_spec_parsing::tech_design_approved_structured(&env.task) {
        failures.push("Structured `tech_design` approval is missing or not approved.".to_string());
    }
    let implementer = lobster_state::task_implementer(&env.task);
    if implementer.is_none() {
        failures
            .push("Task must have an assignee/implementer before moving to `doing`.".to_string());
    }
    if let (Some(implementer), Ok(tasks)) = (
        implementer.as_deref(),
        lobster_state::list_all_active_tasks(&args.base_url),
    ) {
        let current_id = &env.task.id;
        failures.extend(lobster_state::implementer_doing_capacity_failures(
            &tasks,
            current_id,
            implementer,
        ));
    }
    transition_or_block(
        &args,
        env,
        "doing",
        "ready_checks",
        failures,
        Some(workflow_handoff(
            "tech_design_approver",
            "tech_design",
            "Tech design approval is required",
        )),
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `doing`.",
    )
    // Note: `qa_agent` gate rows are now created by `POST /tasks` itself
    // (task d9cd8a83) as `state: pending` rows. The previous
    // `ensure_qa_agent_gate` POST-then-DELETE bootstrap is gone — see the
    // d9cd8a83 tech design for the migration story and the rollout
    // rationale.
}

// ---- Code-task stages (task f77b7a60) ----
//
// `code-task-tech-design-check` (task 3ba96b5e) and `code-task-ready-checks`
// mirror the feature-task stages for
// `taskType: code` tasks. They:
//   * Skip the spec-drift machinery entirely — code tasks have no
//     `**Spec:**` line and no `specChecksum`.
//   * Set `LobsterState.workflow` to `"code-task-workflow"` on every state
//     comment so feature and code task state stay distinguishable.
//   * Use `[code-task-*]` comment tags instead of the feature-task
//     equivalents so the comment alone names which gate is open (AC4 of
//     task 3ba96b5e).
//   * Replace the strict tech-design gate with an optional gate: either
//     `[tech-design]` + `[tech-design-approved] true`, or an explicit
//     `[tech-design-not-required] <reason>` waiver. The tech-design gate
//     runs in `code-task-tech-design-check` (open → ready); the assignee
//     + capacity gate runs in `code-task-ready-checks` (ready → doing).
//
// `verify_delivery`, `feedback_aggregate`, and `post_merge` are shared with
// feature tasks. Code tasks therefore use the same PR, AC, workstream, and
// handoff contract once they reach implementation.

/// `open -> ready` stage handler for `taskType: code` tasks.
///
/// Pipeline (in order):
///   1. Reconcile workflow-owned attention head.
///   2. Pin `LobsterState.workflow` to `code-task-workflow`.
///   3. Manual-block guard.
///   4. Tech-design gate (optional: approved design OR explicit waiver).
///   5. Transition to `ready` when satisfied.
pub(crate) fn code_task_tech_design_check(args: StageArgs) -> Result<Envelope> {
    let mut env = api_client::read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    env.lobster_state.workflow = lobster_state::workflow_for_task(&env.task);
    let manual_failures = brain_spec_lifecycle::manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return brain_spec_lifecycle::block_with_manual_block(
            &args,
            env,
            "code_task_tech_design_check",
            manual_failures,
            "[code-task-blocked]",
        );
    }
    if lobster_state::is_past(&env.task, "open") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_open".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    // Tech design gate is optional: either an approved tech design or an
    // explicit waiver must be present. If both are present, prefer the
    // approved design (a waiver without an approved design is fine for
    // small tasks).
    let has_tech_design = product_spec_parsing::tech_design_url(&env.task).is_some();
    let has_tech_design_approved = product_spec_parsing::tech_design_approved_structured(&env.task);
    let has_waiver = product_spec_parsing::tech_design_waived(&env.task);
    if !has_tech_design && !has_waiver {
        failures.push(
            "Missing task comment `[tech-design] <url>` or `[tech-design-not-required] <reason>`."
                .to_string(),
        );
    } else if has_tech_design && !has_tech_design_approved && !has_waiver {
        failures.push("Structured `tech_design` approval is missing or not approved.".to_string());
    }
    transition_or_block(
        &args,
        env,
        "ready",
        "code_task_tech_design_check",
        failures,
        Some(workflow_handoff(
            "tech_design_approver",
            "tech_design",
            "Tech design approval is required",
        )),
        "[code-task-tech-design-checklist]",
        "Code task workflow moved task to `ready`.",
    )
}

/// `ready -> doing` stage handler for `taskType: code` tasks.
///
/// Pipeline (in order):
///   1. Reconcile workflow-owned attention head.
///   2. Pin `LobsterState.workflow` to `code-task-workflow`.
///   3. Manual-block guard.
///   4. Implementer-required gate.
///   5. Implementer-doing-capacity gate.
///   6. Transition to `doing` when satisfied.
pub(crate) fn code_task_ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = api_client::read_envelope()?;
    reconcile_workflow_attention(&args, &mut env)?;
    env.lobster_state.workflow = lobster_state::workflow_for_task(&env.task);
    let manual_failures = brain_spec_lifecycle::manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return brain_spec_lifecycle::block_with_manual_block(
            &args,
            env,
            "code_task_ready_checks",
            manual_failures,
            "[code-task-blocked]",
        );
    }
    if lobster_state::is_past(&env.task, "ready") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_ready".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    // The tech-design gate has already moved the task to `ready` in the
    // previous stage. This stage is purely about assignee + capacity.
    let implementer = lobster_state::task_implementer(&env.task);
    if implementer.is_none() {
        failures
            .push("Task must have an assignee/implementer before moving to `doing`.".to_string());
    }
    if let (Some(implementer), Ok(tasks)) = (
        implementer.as_deref(),
        lobster_state::list_all_active_tasks(&args.base_url),
    ) {
        let current_id = &env.task.id;
        failures.extend(lobster_state::implementer_doing_capacity_failures(
            &tasks,
            current_id,
            implementer,
        ));
    }
    transition_or_block(
        &args,
        env,
        "doing",
        "code_task_ready_checks",
        failures,
        None,
        "[code-task-progress-checklist]",
        "Code task workflow moved task to `doing`.",
    )
}

/// `acceptance → done` stage handler — moved to `feedback_aggregate.rs`
/// in PR-B (W37 A3 main.rs carve). Imported here as
/// `crate::feedback_aggregate::feedback_aggregate`.
///
/// `feedback_aggregate` review-failure helper — moved to
/// `feedback_aggregate.rs` in PR-B. Imported here as
/// `crate::feedback_aggregate::feedback_review_failure`.
///
/// Cross-stage structured-approval predicates — moved to
/// `task_approvals.rs` in PR-D (W37 A3 main.rs carve). Imported here as
/// `crate::task_approvals::{task_approval_granted,
/// spec_check_should_skip_legacy_mutation, accepted_structured,
/// accepted_structured_failures, qa_agent_verified}`. The legacy
/// approval-marker + acceptance-criteria cross-check tests stay in
/// `main.rs::mod tests` and reference the new module via
/// `crate::task_approvals::*` paths per the W36 carve convention.
///
/// Git-worktree cleanup cluster (`parse_git_worktree_porcelain`,
/// `task_id_prefix`, `select_matching_task_worktrees`,
/// `remove_worktrees_best_effort`, `cleanup_task_worktree_for_task`,
/// `format_worktree_cleanup_summary`, the `WorktreeEntry` /
/// `WorktreeCleanupOutcome` / `WorktreeCleanupResult` types and the
/// `TASK_ID_PREFIX_LEN` constant) — moved to `git_worktree.rs` in
/// PR-H (W37 A3 main.rs carve). Imported here as
/// `crate::git_worktree::{cleanup_task_worktree_for_task,
/// format_worktree_cleanup_summary, WorktreeEntry,
/// WorktreeCleanupOutcome, WorktreeCleanupResult, ...}`. The
/// post-merge test (`run_post_merge_worktree_cleanup`) consumes the
/// helpers via `crate::git_worktree::*` paths per the W37 carve
/// convention.
pub(crate) fn workflow_attention_owner(task: &Task) -> Option<&'static str> {
    match task.status.as_str() {
        "ready"
            if !product_spec_parsing::tech_design_approved_structured(task)
                && !product_spec_parsing::tech_design_waived(task) =>
        {
            Some("Quinn")
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && !task_approvals::qa_agent_verified(task)
                && !ash_was_last_commenter(task) =>
        {
            Some("Ash")
        }
        "acceptance" if !task_approvals::accepted_structured(task) => Some("Tom"),
        _ => None,
    }
}

/// Ash routes ordinary verification failures back to the delivery assignee by
/// removing herself from the attention stack. Keep that handoff intact until
/// someone else comments; otherwise the next lobster sweep immediately
/// derives Ash again from the still-open `qa_agent` gate and overwrites the
/// delivery owner's slot.
pub(crate) fn ash_was_last_commenter(task: &Task) -> bool {
    task.comments
        .last()
        .and_then(|comment| comment.author.as_deref())
        .is_some_and(|author| author.trim().eq_ignore_ascii_case("Ash"))
}

pub(crate) fn managed_owner_reason_satisfied(task: &Task, owner: &str) -> bool {
    match owner {
        // Removal is gated on this owner's *own* structured closeout landing,
        // not on the status happening to be one where their named gate is
        // inert. The status-mismatch clauses used to return true on a `doing`
        // task for all three managed owners simultaneously, which let a single
        // sweep drain a multi-entry array across multiple stage calls.
        // `workflow_attention_owner` already handles replacement of a stale
        // Quinn/Ash/Tom head in any other state via the `Some(desired)` arm.
        "Quinn" => {
            product_spec_parsing::tech_design_approved_structured(task)
                || product_spec_parsing::tech_design_waived(task)
        }
        "Ash" => task_approvals::qa_agent_verified(task),
        // Tom owns the accepted gate only once the task reaches acceptance.
        // While still doing, a pending accepted approval must not leave Tom
        // blocking delivery-owner routing.
        "Tom" => task.status != "acceptance" || task_approvals::accepted_structured(task),
        _ => false,
    }
}

/// Reconcile only the workflow-owned head slot. Tail entries (including
/// duplicate names) are copied byte-for-byte; when an unrelated head is
/// present the managed owner is prepended rather than overwriting it.
pub(crate) fn reconciled_attention_owners(task: &Task) -> Vec<String> {
    let mut owners = task.attention_owners.clone();
    if let Some(desired) = workflow_attention_owner(task) {
        if owners
            .first()
            .is_some_and(|owner| owner.eq_ignore_ascii_case(desired))
        {
            return owners;
        }
        if owners.first().is_some_and(|owner| {
            task.assignee
                .as_deref()
                .is_some_and(|assignee| owner.eq_ignore_ascii_case(assignee))
                || matches!(owner.as_str(), "Quinn" | "Ash" | "Tom")
        }) {
            owners[0] = desired.to_string();
        } else {
            owners.insert(0, desired.to_string());
        }
    } else if owners
        .first()
        .is_some_and(|owner| managed_owner_reason_satisfied(task, owner))
    {
        owners.remove(0);
    }
    owners
}

pub(crate) fn reconcile_workflow_attention(args: &StageArgs, env: &mut Envelope) -> Result<()> {
    let desired = reconciled_attention_owners(&env.task);
    if desired == env.task.attention_owners {
        return Ok(());
    }
    if args.dry_run {
        env.task.attention_owners = desired;
        return Ok(());
    }
    api_client::api_patch::<Task>(
        &args.base_url,
        &env.task.id,
        json!({"attentionOwners": desired}),
    )?;
    env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
    Ok(())
}

pub(crate) fn workflow_handoff(role_id: &str, gate: &str, reason: &str) -> ActiveWorkflowHandoff {
    ActiveWorkflowHandoff {
        role_id: role_id.to_string(),
        gate: Some(gate.to_string()),
        reason: Some(reason.to_string()),
    }
}

/// `comment_tag` is the bracket tag written on the progress-checklist
/// comment when failures are present (e.g. `[feature-task-progress-checklist]`
/// or `[code-task-progress-checklist]`). `move_message` is the human prose
/// prepended to the `[lobster-state]` write when the task transitions.
#[allow(clippy::too_many_arguments)]
pub(crate) fn transition_or_block(
    args: &StageArgs,
    mut env: Envelope,
    next_status: &str,
    action: &str,
    failures: Vec<String>,
    handoff_on_block: Option<ActiveWorkflowHandoff>,
    comment_tag: &str,
    move_message: &str,
) -> Result<Envelope> {
    env.failures = failures.clone();
    env.criteria_met = failures.is_empty();
    if failures.is_empty() {
        env.action_taken = if args.dry_run {
            format!("would_move_to_{next_status}")
        } else {
            format!("moved_to_{next_status}")
        };
        if !args.dry_run {
            let mut patch = json!({"status": next_status, "workflowHandoff": Value::Null});
            if next_status == "ready" {
                patch["specChecksum"] =
                    Value::String(product_spec_parsing::spec_checksum(&env.task));
            }
            if let Err(err) = api_client::api_patch::<Task>(&args.base_url, &env.task.id, patch) {
                if let Some(message) = api_client::spec_checksum_mismatch_message(&err) {
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
            env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
            reconcile_workflow_attention(args, &mut env)?;
            if let Err(err) = lobster_state::write_state(
                &args.base_url,
                &env.task.id,
                &env.lobster_state,
                Some(move_message),
            ) {
                if let Some(message) = api_client::spec_checksum_mismatch_message(&err) {
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
        }
    } else {
        env.action_taken = format!("{action}_blocked");
        let fingerprint = failures.join("\n");
        if !args.dry_run {
            api_client::api_patch::<Task>(
                &args.base_url,
                &env.task.id,
                json!({"workflowHandoff": handoff_on_block}),
            )?;
            env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
        }
        if !args.dry_run && env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
            env.lobster_state.failure_fingerprint = Some(fingerprint);
            if let Err(err) = api_client::add_comment(
                &args.base_url,
                &env.task.id,
                &format!("{comment_tag}\n{}", failures.join("\n")),
            ) {
                if let Some(message) = api_client::spec_checksum_mismatch_message(&err) {
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
            if let Err(err) = lobster_state::write_state(&args.base_url, &env.task.id, &env.lobster_state, None) {
                if let Some(message) = api_client::spec_checksum_mismatch_message(&err) {
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
        }
        // Best-effort analytics emission (AC2): every gate failure emits
        // a single `gate_failure` event with capacity/quality classification.
        // Never block the workflow on analytics POST failures.
        crate::analytics::emit_gate_failure_events(args, &env.task, action, &env.failures);
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Task;

    fn task_with_status(status: &str) -> Task {
        Task {
            id: "00000000-0000-0000-0000-000000000001".to_string(),
            title: "test".to_string(),
            status: status.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn workflow_attention_owner_returns_none_for_unrelated_status() {
        assert!(workflow_attention_owner(&task_with_status("open")).is_none());
        assert!(workflow_attention_owner(&task_with_status("done")).is_none());
    }

    #[test]
    fn ash_was_last_commenter_matches_case_insensitive_ash() {
        let mut task = task_with_status("doing");
        task.comments = vec![crate::TaskComment {
            author: Some("ash".to_string()),
            ..Default::default()
        }];
        assert!(ash_was_last_commenter(&task));
        let mut task = task_with_status("doing");
        task.comments = vec![crate::TaskComment {
            author: Some("ASH".to_string()),
            ..Default::default()
        }];
        assert!(ash_was_last_commenter(&task));
        let mut task = task_with_status("doing");
        task.comments = vec![crate::TaskComment {
            author: Some("Rowan".to_string()),
            ..Default::default()
        }];
        assert!(!ash_was_last_commenter(&task));
        let task = task_with_status("doing");
        assert!(!ash_was_last_commenter(&task));
    }

    #[test]
    fn managed_owner_reason_satisfied_quinn_requires_approved_tech_design() {
        let task = task_with_status("ready");
        assert!(!managed_owner_reason_satisfied(&task, "Quinn"));
    }

    #[test]
    fn managed_owner_reason_satisfied_unknown_owner_is_never_satisfied() {
        let task = task_with_status("ready");
        assert!(!managed_owner_reason_satisfied(&task, "Nobody"));
    }

    #[test]
    fn reconciled_attention_owners_copies_stack_when_workflow_owner_absent() {
        let mut task = task_with_status("open");
        task.attention_owners = vec!["Rowan".to_string()];
        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan"]);
    }
}
