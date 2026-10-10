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
//!   (`Quinn` for unapproved tech design or an unresolved Ash deferral,
//!   `Ash` for unverified `qa_agent`, `Tom` for unapproved `accepted`);
//!   returns `None` when the gate is satisfied.
//!   Tom is only a workflow owner at `acceptance`; a `doing` task may retain
//!   Tom only after Quinn has explicitly escalated to him and recorded the
//!   escalation marker in the task audit trail.
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
    api_client, brain_spec_lifecycle, brain_spec_reconcile, lobster_state, product_spec_parsing,
    ActiveWorkflowHandoff, Envelope, StageArgs, Task,
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
    brain_spec_reconcile::bootstrap_task_spec_layout(product_spec_parsing::workspace_root(&args))?;
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
        env = brain_spec_reconcile::move_approved_chat_spec_if_needed(&args, env)?;
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
                    lobster_state::write_state(
                        &args.base_url,
                        &env.task.id,
                        &env.lobster_state,
                        None,
                    )?;
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
pub(crate) fn workflow_attention_owner(task: &Task) -> Option<String> {
    match task.status.as_str() {
        "ready"
            if !product_spec_parsing::tech_design_approved_structured(task)
                && !product_spec_parsing::tech_design_waived(task) =>
        {
            Some("Quinn".to_string())
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && task_approvals::qa_agent_deferred(task)
                && !task_approvals::qa_agent_deferred_waiting_on_capability_extension(task)
                && !task_approvals::qa_agent_deferred_capability_extension_complete(task) =>
        {
            Some("Quinn".to_string())
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && latest_lobster_delivery_failure(task) =>
        {
            // Lobster owns the delivery-evidence gate, but a failed checklist
            // is still normal delivery work for the assignee. Keep Ash
            // dormant without turning the checklist into an explicit
            // attention-owner escalation; the assignee queue already makes
            // this task actionable.
            None
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && task_approvals::qa_agent_deferred_capability_extension_complete(task) =>
        {
            Some("Ash".to_string())
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && task_approvals::qa_agent_blocked_after_latest_delivery(task) =>
        {
            // Ordinary evidence failures belong to the delivery owner. A
            // blocked QA verdict is not an OpenClaw capability handoff and
            // must not fall through to Ash/Quinn/Tom escalation.
            task.assignee.clone()
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && !task_approvals::qa_agent_verified(task)
                && !task_approvals::qa_agent_deferred_waiting_on_capability_extension(task)
                && !ash_was_last_commenter(task) =>
        {
            Some("Ash".to_string())
        }
        "doing"
            if !product_spec_parsing::implementer_pr_urls(task).is_empty()
                && task_approvals::qa_agent_verified(task) =>
        {
            task.assignee.clone()
        }
        "acceptance" if !task_approvals::accepted_structured(task) => Some("Tom".to_string()),
        _ => None,
    }
}

/// Retained as a small audit helper for existing routing tests. The reconciler
/// now routes explicit `[qa-agent-blocked]` verdicts by verdict type rather
/// than relying on comment adjacency.
pub(crate) fn ash_was_last_commenter(task: &Task) -> bool {
    task.comments
        .last()
        .and_then(|comment| comment.author.as_deref())
        .is_some_and(|author| author.trim().eq_ignore_ascii_case("Ash"))
}

/// True when the latest Lobster state still reports an unresolved delivery
/// checklist. This prevents a pre-verification sweep from routing the normal
/// `qa_agent` gate to Ash merely because an `[implementer-prs]` marker exists.
/// A later successful Lobster state clears the condition; a later delivery
/// marker after a failed state keeps Ash dormant until that delivery is checked.
fn latest_lobster_delivery_failure(task: &Task) -> bool {
    let Some((state_index, state_text)) =
        task.comments
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, comment)| {
                let text = comment
                    .text
                    .as_deref()
                    .or(comment.body.as_deref())
                    .unwrap_or_default();
                text.starts_with("[lobster-state]").then_some((index, text))
            })
    else {
        return false;
    };

    let Some(json_text) = state_text
        .split_once("```json")
        .and_then(|(_, rest)| rest.split_once("```").map(|(json, _)| json.trim()))
    else {
        return false;
    };
    let Ok(state) = serde_json::from_str::<Value>(json_text) else {
        return false;
    };
    let state_has_failure = state
        .get("failureFingerprint")
        .and_then(Value::as_str)
        .is_some_and(|failure| !failure.trim().is_empty());
    if !state_has_failure {
        return false;
    }

    // A delivery marker posted after a failed state represents a fresh
    // handoff that still needs this Lobster run's evidence check.
    if task.comments.iter().skip(state_index + 1).any(|comment| {
        let text = comment
            .text
            .as_deref()
            .or(comment.body.as_deref())
            .unwrap_or_default();
        text.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("[implementer-prs]") || line.starts_with("[rowan-prs]")
        })
    }) {
        return true;
    }

    task.comments[..=state_index]
        .iter()
        .rev()
        .find_map(|comment| {
            let text = comment
                .text
                .as_deref()
                .or(comment.body.as_deref())
                .unwrap_or_default();
            let has = |tag: &str| text.lines().any(|line| line.trim_start().starts_with(tag));
            if has("[qa-agent-blocked]") || has("[qa-agent-deferred]") {
                Some(false)
            } else if has("[feature-task-progress-checklist]")
                || has("[code-task-progress-checklist]")
                || has("[feature-task-blocked]")
                || has("[code-task-blocked]")
            {
                Some(true)
            } else {
                None
            }
        })
        .unwrap_or(false)
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
            task_approvals::qa_agent_deferred_waiting_on_capability_extension(task)
                || product_spec_parsing::tech_design_approved_structured(task)
                || product_spec_parsing::tech_design_waived(task)
        }
        "Ash" => task_approvals::qa_agent_verified(task),
        // Tom owns the accepted gate only once the task reaches acceptance.
        // During `doing`, an explicit Quinn -> Tom escalation is preserved by
        // `enforce_tom_acceptance_only`; Tom is never added automatically.
        "Tom" => task.status == "acceptance" && task_approvals::accepted_structured(task),
        _ => false,
    }
}

/// Reconcile only the workflow-owned head slot. Tail entries (including
/// duplicate names) are copied byte-for-byte; when an unrelated head is
/// present the managed owner is prepended rather than overwriting it.
///
/// The baseline `acceptance -> accepted` gate is a special case: when there
/// is no existing attention stack, `workflow_attention_owner` resolving to
/// Tom here means only "Tom's normal sign-off is outstanding" -- a state
/// already surfaced by the derived `workflowGates` fallback documented in
/// `docs/systems/tasks.md` ("acceptance -> accepted"). Writing an explicit
/// `attentionOwners = ["Tom"]` row for that baseline case duplicates the
/// signal and pages Tom for a state the system already treats as his normal
/// next action. A non-empty stack still gets Tom inserted/advanced
/// normally -- that case means a stale or unrelated owner is sitting at
/// acceptance and genuinely needs correcting to Tom.
pub(crate) fn reconciled_attention_owners(task: &Task) -> Vec<String> {
    let mut owners = task.attention_owners.clone();
    if let Some(desired) = workflow_attention_owner(task) {
        if owners
            .first()
            .is_some_and(|owner| owner.eq_ignore_ascii_case(&desired))
        {
            enforce_tom_acceptance_only(task, &mut owners);
            return owners;
        }
        if owners.first().is_some_and(|owner| {
            task.assignee
                .as_deref()
                .is_some_and(|assignee| owner.eq_ignore_ascii_case(assignee))
                || matches!(owner.as_str(), "Quinn" | "Ash")
        }) {
            owners[0] = desired.to_string();
        } else if !owners.is_empty() || !is_baseline_tom_acceptance_gate(task, &desired) {
            owners.insert(0, desired.to_string());
        }
        // An unresolved deferred QA verdict is an OpenClaw handoff to Quinn.
        // Once the original task is dependency-blocked on a capability
        // extension, `workflow_attention_owner` returns None and the managed
        // Quinn slot is removed instead of being re-added on every sweep.
    } else if owners.first().is_some_and(|owner| {
        managed_owner_reason_satisfied(task, owner)
            || automated_delivery_checklist_slot(task, owner)
    }) {
        owners.remove(0);
    }
    enforce_tom_acceptance_only(task, &mut owners);
    owners
}

/// Older sweeps represented an ordinary delivery checklist as a Rowan
/// attention row. Remove that row when it is recognisably workflow-generated,
/// but preserve a genuine Rowan escalation with a different task-specific
/// reason.
fn automated_delivery_checklist_slot(task: &Task, owner: &str) -> bool {
    let Some(assignee) = task.assignee.as_deref() else {
        return false;
    };
    if !owner.eq_ignore_ascii_case(assignee) {
        return false;
    }
    let expected_note = workflow_attention_reason(task, owner);
    task.attention_owner_details.iter().any(|detail| {
        detail.owner.eq_ignore_ascii_case(owner)
            && detail
                .note
                .as_deref()
                .is_some_and(|note| note == expected_note)
    })
}

/// True when the only reason `workflow_attention_owner` resolved to Tom is
/// the baseline, unescalated `acceptance -> accepted` gate (see
/// `reconciled_attention_owners`). Any other managed owner, or an acceptance
/// task whose stack is already non-empty, is unaffected.
fn is_baseline_tom_acceptance_gate(task: &Task, desired: &str) -> bool {
    task.status == "acceptance" && desired.eq_ignore_ascii_case("Tom")
}

/// Explain why the workflow is changing the actionable attention slot. This
/// note is persisted on any automated row created or repaired by Lobster so
/// an escalation is never a silent `addedBy = null, note = null` mutation.
pub(crate) fn workflow_attention_reason(task: &Task, owner: &str) -> String {
    match owner.to_ascii_lowercase().as_str() {
        "quinn" if task.status == "ready" => {
            "Tech design approval is required before delivery can proceed.".to_string()
        }
        "quinn" => {
            "QA verification was deferred and requires workflow capability resolution.".to_string()
        }
        "ash" => "QA verification is required for the delivered implementation.".to_string(),
        "tom" => "Final acceptance approval is required.".to_string(),
        "rowan" => {
            "The delivery owner must address the outstanding workflow evidence before QA can act."
                .to_string()
        }
        _ => format!("Workflow reconciliation requires attention from {owner}."),
    }
}

fn attention_owner_metadata_complete(task: &Task, desired: &[String]) -> bool {
    desired.iter().all(|owner| {
        task.attention_owner_details.iter().any(|detail| {
            detail.owner.eq_ignore_ascii_case(owner)
                && detail
                    .added_by
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                && detail
                    .note
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
        })
    })
}

/// Tom is only a workflow owner at `acceptance` for the structured `accepted`
/// gate. During implementation, remove Tom slots unless Quinn has explicitly
/// recorded a `[quinn-escalation]` marker in the task audit trail. This keeps
/// stale workflow-generated stacks from paging Tom while still allowing Quinn
/// to preserve a deliberate Quinn -> Tom escalation. If Quinn appears after
/// Tom, normalize the escalation order so Quinn gets the first chance to
/// resolve the blocker.
fn enforce_tom_acceptance_only(task: &Task, owners: &mut Vec<String>) {
    if task.status != "doing" {
        return;
    }
    if !has_explicit_quinn_tom_escalation(task) {
        owners.retain(|owner| !owner.eq_ignore_ascii_case("Tom"));
        return;
    }
    let Some(quinn_index) = owners
        .iter()
        .position(|owner| owner.eq_ignore_ascii_case("Quinn"))
    else {
        owners.retain(|owner| !owner.eq_ignore_ascii_case("Tom"));
        return;
    };
    let Some(tom_index) = owners
        .iter()
        .position(|owner| owner.eq_ignore_ascii_case("Tom"))
    else {
        return;
    };
    if quinn_index > tom_index {
        let quinn = owners.remove(quinn_index);
        owners.insert(tom_index, quinn);
    }
}

fn has_explicit_quinn_tom_escalation(task: &Task) -> bool {
    task.comments.iter().any(|comment| {
        comment
            .author
            .as_deref()
            .is_some_and(|author| author.trim().eq_ignore_ascii_case("Quinn"))
            && comment
                .text
                .as_deref()
                .or(comment.body.as_deref())
                .is_some_and(|text| text.contains("[quinn-escalation]"))
    })
}

pub(crate) fn reconcile_workflow_attention(args: &StageArgs, env: &mut Envelope) -> Result<()> {
    let desired = reconciled_attention_owners(&env.task);
    let metadata_needs_repair = !attention_owner_metadata_complete(&env.task, &desired);
    if desired == env.task.attention_owners && !metadata_needs_repair {
        return Ok(());
    }
    if args.dry_run {
        env.task.attention_owners = desired;
        return Ok(());
    }
    let owner_for_reason = workflow_attention_owner(&env.task)
        .or_else(|| desired.first().cloned())
        .unwrap_or_else(|| "workflow".to_string());
    api_client::api_reconcile_attention::<Task>(
        &args.base_url,
        &env.task.id,
        desired,
        &workflow_attention_reason(&env.task, &owner_for_reason),
    )?;
    env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
    Ok(())
}

fn latest_lobster_state_has_openclaw_needed(task: &Task) -> bool {
    task.comments
        .iter()
        .rev()
        .find_map(|comment| {
            let text = comment
                .text
                .as_deref()
                .or(comment.body.as_deref())
                .unwrap_or_default();
            text.starts_with("[lobster-state]")
                .then(|| text.contains("\"openclawNeeded\": true"))
        })
        .unwrap_or(false)
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
        // A successful retry must retire the previous blocker fingerprint;
        // otherwise the acceptance state carries stale failure diagnostics
        // and a later sweep can appear blocked even though the gate passed.
        env.lobster_state.failure_fingerprint = None;
        env.lobster_state.openclaw_needed = false;
        env.lobster_state.openclaw_done = false;
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
        let fingerprint_changed =
            env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint);
        let openclaw_state_changed = env.lobster_state.openclaw_needed
            && !latest_lobster_state_has_openclaw_needed(&env.task);
        if !args.dry_run {
            api_client::api_patch::<Task>(
                &args.base_url,
                &env.task.id,
                json!({"workflowHandoff": handoff_on_block}),
            )?;
            env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
        }
        if !args.dry_run && (fingerprint_changed || openclaw_state_changed) {
            env.lobster_state.failure_fingerprint = Some(fingerprint);
            let comment_tag = if env.lobster_state.openclaw_needed {
                format!("[openclaw-needed]\n{comment_tag}")
            } else {
                comment_tag.to_string()
            };
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
            if let Err(err) =
                lobster_state::write_state(&args.base_url, &env.task.id, &env.lobster_state, None)
            {
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

    use crate::{TaskApproval, TaskComment};
    use std::fs;
    use tempfile::tempdir;

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
    fn workflow_attention_reason_is_specific_to_the_managed_owner() {
        let ready = task_with_status("ready");
        assert_eq!(
            workflow_attention_reason(&ready, "Quinn"),
            "Tech design approval is required before delivery can proceed."
        );
        let doing = task_with_status("doing");
        assert_eq!(
            workflow_attention_reason(&doing, "Quinn"),
            "QA verification was deferred and requires workflow capability resolution."
        );
        assert_eq!(
            workflow_attention_reason(&doing, "Ash"),
            "QA verification is required for the delivered implementation."
        );
    }

    #[test]
    fn workflow_metadata_repair_is_needed_for_legacy_rows() {
        let mut task = task_with_status("doing");
        task.attention_owners = vec!["Quinn".to_string()];
        assert!(!attention_owner_metadata_complete(&task, &task.attention_owners));
        task.attention_owner_details = vec![crate::TaskAttentionOwner {
            owner: "Quinn".to_string(),
            added_by: Some("Rowan".to_string()),
            note: Some("QA is deferred".to_string()),
        }];
        assert!(attention_owner_metadata_complete(&task, &task.attention_owners));
    }

    #[test]
    fn reconciled_attention_owners_copies_stack_when_workflow_owner_absent() {
        let mut task = task_with_status("open");
        task.attention_owners = vec!["Rowan".to_string()];
        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan"]);
    }
    fn approval_row(kind: &str, state: &str) -> crate::TaskApproval {
        crate::TaskApproval {
            approval_type: kind.into(),
            state: state.into(),
            ..Default::default()
        }
    }

    fn routing_task(status: &str, owner: &[&str]) -> Task {
        Task {
            id: "task-1".to_string(),
            status: status.to_string(),
            assignee: Some("Rowan".to_string()),
            attention_owners: owner.iter().map(|value| (*value).to_string()).collect(),
            ..Task::default()
        }
    }
    #[test]
    fn routing_does_not_surface_ash_before_delivery_evidence() {
        let task = routing_task("doing", &["Rowan", "Tom"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Rowan"]
        );
    }

    #[test]
    fn routing_puts_quinn_before_explicit_tom_handoff_while_doing() {
        let task = routing_task("doing", &["Tom"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            Vec::<String>::new()
        );
    }
    #[test]
    fn routing_replaces_implementer_with_ash_after_delivery() {
        let mut task = routing_task("doing", &["Rowan", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            body: None,
            created_at: None,
        });
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Ash"]
        );
    }

    #[test]
    fn routing_keeps_delivery_work_with_assignee_while_lobster_evidence_is_open() {
        let mut task = routing_task("doing", &[]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("feature_task_lobster".to_string()),
            text: Some(
                "[feature-task-progress-checklist]\nDelivery evidence is incomplete.".to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("feature_task_lobster".to_string()),
            text: Some(
                "[lobster-state]\n```json\n{\"failureFingerprint\":\"delivery evidence missing\"}\n```"
                    .to_string(),
            ),
            ..Default::default()
        });

        assert_eq!(workflow_attention_owner(&task), None);
        assert_eq!(reconciled_attention_owners(&task), Vec::<String>::new());
    }

    #[test]
    fn routing_clears_legacy_checklist_attention_row_but_preserves_real_escalation() {
        let mut task = routing_task("doing", &["Rowan"]);
        task.attention_owner_details = vec![crate::TaskAttentionOwner {
            owner: "Rowan".to_string(),
            added_by: Some("Quinn".to_string()),
            note: Some(workflow_attention_reason(&task, "Rowan")),
        }];
        task.comments.push(TaskComment {
            text: Some(
                "[lobster-state]\n```json\n{\"failureFingerprint\":\"delivery evidence missing\"}\n```"
                    .to_string(),
            ),
            ..Default::default()
        });
        assert_eq!(reconciled_attention_owners(&task), Vec::<String>::new());

        task.attention_owner_details[0].note = Some(
            "Rowan must resolve a concrete external blocker before delivery can continue."
                .to_string(),
        );
        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan"]);
    }

    #[test]
    fn routing_sends_deferred_qa_to_quinn_without_implicit_tom_escalation() {
        let mut task = routing_task("doing", &["Rowan"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some(
                "[qa-agent-deferred] AC1: repository-admin setup is outstanding.".to_string(),
            ),
            ..Default::default()
        });
        task.approvals.push(approval_row("qa_agent", "approved"));

        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Quinn"]
        );
    }

    #[test]
    fn routing_sends_resolved_capability_deferral_to_ash_then_rowan() {
        let mut task = routing_task("doing", &["Quinn", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-deferred] AC1: external setup is outstanding.".to_string()),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Quinn".to_string()),
            text: Some(
                "[qa-agent-capability-resolved] External setup is now complete.".to_string(),
            ),
            ..Default::default()
        });

        assert_eq!(reconciled_attention_owners(&task), vec!["Ash"]);

        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-verified] AC1: mechanical checks pass.".to_string()),
            ..Default::default()
        });
        task.approvals.push(approval_row("qa_agent", "approved"));

        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan"]);
    }

    #[test]
    fn routing_accepts_legacy_quinn_resolved_capability_marker() {
        let mut task = routing_task("doing", &["Quinn"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-deferred] AC1: external setup is outstanding.".to_string()),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Quinn".to_string()),
            text: Some("[quinn-resolved] External setup is now complete.".to_string()),
            ..Default::default()
        });

        assert_eq!(reconciled_attention_owners(&task), vec!["Ash"]);
    }

    #[test]
    fn routing_sends_ordinary_qa_block_back_to_rowan_after_lobster_comment() {
        let mut task = routing_task("doing", &["Ash", "Quinn", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] AC2: cited test fails.".to_string()),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("feature_task_lobster".to_string()),
            text: Some("[lobster-state] {\"openclawNeeded\": false}".to_string()),
            ..Default::default()
        });

        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Rowan", "Quinn"]
        );
    }

    #[test]
    fn routing_never_surfaces_pending_acceptance_to_tom_while_doing() {
        let mut task = routing_task("doing", &["Tom"]);
        task.approvals.push(approval_row("accepted", "pending"));
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] AC1: missing regression evidence.".to_string()),
            ..Default::default()
        });

        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Rowan"]
        );
    }

    #[test]
    fn routing_preserves_explicit_tom_tail_when_deferred_qa_replaces_rowan() {
        let mut task = routing_task("doing", &["Rowan", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-deferred] AC1: pending admin action.".to_string()),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Quinn".to_string()),
            text: Some("[quinn-escalation] Tom must provision the external credential.".to_string()),
            ..Default::default()
        });

        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Quinn", "Tom"]
        );
    }

    #[test]
    fn routing_removes_quinn_after_capability_extension_dependency_is_linked() {
        let mut task = routing_task("doing", &["Quinn", "Tom"]);
        task.dependency_blocked = true;
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some(
                "[qa-agent-deferred] AC1: the required verifier capability is unavailable."
                    .to_string(),
            ),
            ..Default::default()
        });

        assert!(reconciled_attention_owners(&task).is_empty());
    }

    #[test]
    fn routing_returns_to_ash_after_capability_extension_completes() {
        let mut task = routing_task("doing", &["Quinn", "Tom"]);
        task.depends_on = vec![crate::TaskDependency {
            status: "done".to_string(),
        }];
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            ..Default::default()
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some(
                "[qa-agent-deferred] AC1: the required verifier capability is unavailable."
                    .to_string(),
            ),
            ..Default::default()
        });

        assert_eq!(
            reconciled_attention_owners(&task),
            vec!["Ash"]
        );
    }
    #[test]
    fn routing_preserves_rowan_handoff_when_ash_is_last_commenter() {
        let mut task = routing_task("doing", &["Rowan", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            body: None,
            created_at: None,
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] Route back to Rowan.".to_string()),
            body: None,
            created_at: None,
        });
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Rowan"]
        );
    }
    #[test]
    fn routing_resumes_ash_after_delivery_comments_again() {
        let mut task = routing_task("doing", &["Rowan", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] Route back to Rowan.".to_string()),
            body: None,
            created_at: None,
        });
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some("Collected the requested runtime evidence.".to_string()),
            body: None,
            created_at: None,
        });
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            body: None,
            created_at: None,
        });
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Ash"]
        );
    }
    #[test]
    fn routing_advances_stale_implementer_to_tom_at_acceptance() {
        let task = routing_task("acceptance", &["Rowan", "Ash", "Rowan", "Tom"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Tom", "Ash", "Rowan", "Tom"]
        );
    }
    #[test]
    fn routing_removes_satisfied_managed_owner_and_is_idempotent() {
        let mut task = routing_task("acceptance", &["Tom", "Rowan", "Tom"]);
        task.approvals.push(TaskApproval {
            approval_type: "accepted".to_string(),
            state: "approved".to_string(),
            ..TaskApproval::default()
        });
        let once = crate::spec_check_ready::reconciled_attention_owners(&task);
        assert_eq!(once, vec!["Rowan", "Tom"]);
        task.attention_owners = once.clone();
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            once
        );
    }
    #[test]
    fn routing_preserves_unrelated_head_and_duplicate_tail_slots() {
        let task = routing_task("acceptance", &["Lox", "Rowan", "Tom", "Tom"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Tom", "Lox", "Rowan", "Tom", "Tom"]
        );
    }
    /// A `doing`-status task whose `attentionOwners` is `[Tom, Quinn, Ash]`
    /// and whose `qa_agent` gate is closed should route back to the delivery
    /// assignee, while keeping an explicit Quinn -> Tom escalation path and
    /// without draining the remaining owner stack.
    #[test]
    fn routing_keeps_quinn_before_tom_without_draining_remaining_owners() {
        let mut task = routing_task("doing", &["Tom", "Quinn", "Ash"]);
        task.comments.push(TaskComment {
            author: Some("Quinn".to_string()),
            text: Some(
                "[quinn-escalation] Tom must provision the external credential."
                    .to_string(),
            ),
            body: None,
            ..TaskComment::default()
        });
        task.comments.push(TaskComment {
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            body: None,
            ..TaskComment::default()
        });
        task.approvals.push(TaskApproval {
            approval_type: "qa_agent".to_string(),
            state: "approved".to_string(),
            ..TaskApproval::default()
        });
        let once = crate::spec_check_ready::reconciled_attention_owners(&task);
        assert_eq!(once, vec!["Rowan", "Quinn", "Tom", "Ash"]);
        task.attention_owners = once.clone();
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            once
        );
    }
    /// Tom's accepted gate is only actionable in acceptance. A pending
    /// accepted approval must leave Quinn before Tom while a task is still
    /// doing.
    #[test]
    fn routing_moves_quinn_before_tom_head_before_acceptance() {
        let mut task = routing_task("doing", &["Tom", "Quinn", "Ash"]);
        task.comments.push(TaskComment {
            author: Some("Quinn".to_string()),
            text: Some("[quinn-escalation] Tom must provision the external credential.".to_string()),
            ..Default::default()
        });
        task.approvals.push(TaskApproval {
            approval_type: "tech_design".to_string(),
            state: "approved".to_string(),
            ..TaskApproval::default()
        });
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Quinn", "Tom", "Ash"]
        );
    }
    #[test]
    fn routing_keeps_tom_head_for_pending_acceptance() {
        let task = routing_task("acceptance", &["Tom", "Quinn", "Ash"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Tom", "Quinn", "Ash"]
        );
    }

    /// Tom reported (2026-10-09) that every task reaching `acceptance`
    /// picked up a redundant `attentionOwners = ["Tom"]` row with the reason
    /// "Final acceptance approval is required." -- even though a task with
    /// an empty attention stack already surfaces Tom as the normal next
    /// actor via the derived `workflowGates` fallback (see
    /// docs/systems/tasks.md, "acceptance -> accepted"). An explicit row for
    /// that baseline case duplicates the signal and pages Tom for a state
    /// he already expects.
    #[test]
    fn routing_does_not_page_tom_for_baseline_pending_acceptance() {
        let task = routing_task("acceptance", &[]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            Vec::<String>::new()
        );
    }

    /// A non-empty stack at acceptance headed by the delivery assignee is a
    /// genuine stale-owner correction (the previous QA/doing-stage managed
    /// owner left its reconciled slot at the head) -- the baseline-case
    /// suppression must not block that replacement.
    #[test]
    fn routing_still_advances_stale_assignee_head_to_tom_at_acceptance() {
        let task = routing_task("acceptance", &["Rowan"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Tom"]
        );
    }

    /// A non-empty stack headed by an unrelated owner (not the assignee, not
    /// a managed Quinn/Ash slot) at acceptance must still get Tom inserted
    /// at the front, preserving the existing tail -- this is a genuine
    /// stale/unrelated-owner correction, not the baseline case.
    #[test]
    fn routing_still_inserts_tom_ahead_of_unrelated_stale_owner_at_acceptance() {
        let task = routing_task("acceptance", &["Lox"]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Tom", "Lox"]
        );
    }

    /// The baseline-acceptance suppression is specific to Tom's gate; Quinn
    /// paging into an empty stack at `ready` (tech design) must be
    /// unaffected.
    #[test]
    fn routing_still_pages_quinn_into_empty_stack_at_ready() {
        let task = routing_task("ready", &[]);
        assert_eq!(
            crate::spec_check_ready::reconciled_attention_owners(&task),
            vec!["Quinn"]
        );
    }
    #[test]
    fn workflow_handoff_serializes_tasks_api_role_id_contract() {
        let value = serde_json::to_value(crate::spec_check_ready::workflow_handoff(
            "product_spec_approver",
            "spec",
            "Product spec approval is required",
        ))
        .unwrap();
        assert_eq!(value["roleId"], "product_spec_approver");
        assert!(value.get("role").is_none());
    }
    #[test]
    fn spec_check_skips_legacy_mutation_for_any_approved_spec_actor() {
        let task = Task {
            approvals: vec![TaskApproval {
                approval_type: "spec".to_string(),
                state: "approved".to_string(),
                owner: Some("Quinn".to_string()),
                ..TaskApproval::default()
            }],
            ..Task::default()
        };

        assert!(task_approvals::spec_check_should_skip_legacy_mutation(
            &task
        ));
    }
    #[test]
    fn spec_check_keeps_legacy_mutation_available_without_approved_spec() {
        let task = Task {
            approvals: vec![approval_row("spec", "revoked")],
            ..Task::default()
        };

        assert!(!task_approvals::spec_check_should_skip_legacy_mutation(
            &task
        ));
    }
    #[test]
    fn spec_gate_accepts_structured_approval_row() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let spec_path = workspace.path().join("brain/tasks/specs/example.md");
        fs::create_dir_all(spec_path.parent().unwrap()).unwrap();
        fs::write(
            &spec_path,
            "- [ ] **Approved by Tom**

## Acceptance Criteria
- [ ] Implementation-ready criteria",
        )
        .unwrap();

        let task = Task {
            description: Some(
                "**Spec:** brain/tasks/specs/example.md
- [x] **Approved by Tom**

## Acceptance Criteria
- [ ] Build it

## Workstreams
- Owner: Implementer
  ACs: AC1"
                    .to_string(),
            ),
            approvals: vec![approval_row("spec", "approved")],
            ..Task::default()
        };

        assert!(lobster_state::spec_failures(&task, repo.path(), workspace.path()).is_empty());
    }
    #[test]
    fn spec_check_detects_manually_advanced_task_without_checksum() {
        let task = Task {
            id: "task-manually-advanced".to_string(),
            status: "acceptance".to_string(),
            spec_checksum: None,
            description: Some("No spec line here".to_string()),
            ..Task::default()
        };
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let failures =
            lobster_state::missing_spec_checksum_failures(&task, repo.path(), workspace.path());
        assert!(
            !failures.is_empty(),
            "expected failures for manually-advanced task without checksum"
        );
        assert!(failures
            .iter()
            .any(|f| f.contains("no stored `specChecksum`")));
        assert!(failures.iter().any(|f| f.contains("**Spec:**")));
    }
    #[test]
    fn spec_check_allows_past_open_task_with_valid_checksum() {
        let task = Task {
            id: "task-legit-ready".to_string(),
            status: "acceptance".to_string(),
            spec_checksum: Some("abc123".to_string()),
            description: Some("## Acceptance Criteria\n- [ ] AC1".to_string()),
            ..Task::default()
        };
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        assert!(lobster_state::missing_spec_checksum_failures(
            &task,
            repo.path(),
            workspace.path()
        )
        .is_empty());

        // A task with a stored checksum is already past "open" legitimately — spec_checksum_failures
        // (not spec_failures) is the gate from here on, so we just confirm no spec drift.
        let failures = product_spec_parsing::spec_checksum_failures(&task);
        // checksum "abc123" won't match the real computed checksum, so drift is detected —
        // that's correct behaviour: the stored checksum must match current ACs.
        assert!(
            !failures.is_empty(),
            "expected drift for mismatched checksum"
        );
        assert!(failures[0].contains("Spec drift detected"));
    }
}
