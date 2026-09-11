use anyhow::Result;
use clap::{ArgAction, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

mod ac_parsing;
mod analytics;
mod analytics_replay;
mod api_client;
mod brain_spec_lifecycle;
mod brain_spec_reconcile;
mod cli_utils;
mod feedback_aggregate;
mod git_worktree;
mod lobster_state;
mod post_merge;
mod pr_gates;
mod product_spec_parsing;
mod spec_check_ready;
mod task_approvals;
mod test_resolution;
mod test_runners;
#[cfg(test)]
mod tests_integration;
mod verify_delivery;

// Comment author is derived from the authenticated actor at the API
// boundary (task 0719a8e3); this workflow no longer carries a literal
// "Lobster" author fallback.
pub(crate) const WORKFLOW: &str = "feature-task-workflow";
pub(crate) const CODE_TASK_WORKFLOW: &str = "code-task-workflow";
pub(crate) const STATE_TAG: &str = "[lobster-state]";
pub(crate) const STATUS_ORDER: [&str; 5] = ["open", "ready", "doing", "acceptance", "done"];

#[derive(Parser)]
#[command(name = "feature-task")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    LoadTask {
        #[arg(long)]
        base_url: String,
        #[arg(long)]
        task_id: String,
    },
    SpecCheck(StageArgs),
    ReadyChecks(StageArgs),
    VerifyDelivery(StageArgs),
    FeedbackAggregate(StageArgs),
    PostMerge(StageArgs),
    CodeTaskTechDesignCheck(StageArgs),
    CodeTaskReadyChecks(StageArgs),
    CodeTaskVerifyDelivery(StageArgs),
    /// Reconcile Tom's checked approval marker on open brain task specs into
    /// the authoritative structured `spec` TaskApproval row.
    ReconcileBrainSpecApprovals(ReconcileBrainSpecApprovalsArgs),
    /// Reconciliation sweep: visit every task with `status=done` (optionally
    /// filtered by `--assignee`) and archive any spec still under
    /// `brain/tasks/specs/in-progress/`. Used to close the historical backlog
    /// and to recover when a single post_merge run skipped the archive step
    /// (e.g. iCloud/TCC `Operation not permitted`).
    ArchiveDoneTaskSpecsSweep(ArchiveDoneTaskSpecsSweepArgs),
    Analytics(AnalyticsArgs),
}

#[derive(Parser, Clone)]
pub(crate) struct ArchiveDoneTaskSpecsSweepArgs {
    #[arg(long, default_value = "http://localhost:4001/api/v1")]
    base_url: String,
    #[arg(long, default_value_t = false, action = ArgAction::Set)]
    dry_run: bool,
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    workspace_root: Option<PathBuf>,
    #[arg(long)]
    assignee: Option<String>,
}

#[derive(Parser, Clone)]
struct ReconcileBrainSpecApprovalsArgs {
    #[arg(long, default_value = "http://localhost:4001/api/v1")]
    base_url: String,
    #[arg(long, default_value_t = false, action = ArgAction::Set)]
    dry_run: bool,
    #[arg(long)]
    workspace_root: PathBuf,
}

#[derive(Parser, Clone)]
pub(crate) struct AnalyticsArgs {
    #[arg(long, default_value = "http://localhost:4001/api/v1")]
    base_url: String,
    #[command(subcommand)]
    action: AnalyticsAction,
}

#[derive(Subcommand, Clone)]
pub(crate) enum AnalyticsAction {
    /// Replay a task's lifecycle analytics events in chronological order
    /// (AC5 of task f170e344).
    Replay {
        #[arg(long)]
        task_id: String,
    },
}

#[derive(Parser, Clone)]
pub(crate) struct StageArgs {
    #[arg(long, default_value = "http://localhost:4001/api/v1")]
    base_url: String,
    #[arg(long, default_value_t = false, action = ArgAction::Set)]
    dry_run: bool,
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    #[arg(long)]
    workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    criteria_met: bool,
    already_past: bool,
    action_taken: String,
    task: Task,
    lobster_state: LobsterState,
    failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Task {
    id: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    status: String,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    blocked: bool,
    #[serde(default)]
    dependency_blocked: bool,
    #[serde(default)]
    task_type: Option<String>,
    #[serde(default)]
    spec_checksum: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    comments: Vec<TaskComment>,
    /// Structured approvals embedded in the task payload by the Tasks API
    /// after PR #370. Empty when the task has no rows yet or the API
    /// response predates PR #370. The lobster reads from this collection
    /// as the sole approval gate source.
    #[serde(default)]
    approvals: Vec<TaskApproval>,
    /// Ordered blocker/handoff stack. Position 0 is the next actionable owner;
    /// later entries are escalation targets and repeated people are valid.
    #[serde(default)]
    attention_owners: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveWorkflowHandoff {
    role_id: String,
    #[serde(default)]
    gate: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct TaskComment {
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

/// Structured approval row embedded in the Tasks API task payload after
/// PR #370 (task `ffa30da7` WS1). Mirrors `TaskApproval` in
/// `services/tasks-api/prisma/schema.prisma`. The `type` field is named
/// `approval_type` in Rust because `type` is a reserved keyword; serde
/// uses `rename` so the JSON field stays `type`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TaskApproval {
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "type", default)]
    approval_type: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    approved_at: Option<String>,
    #[serde(default)]
    revoked_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LobsterState {
    version: u8,
    workflow: String,
    #[serde(default)]
    last_orchestrated_at: Option<String>,
    #[serde(default)]
    pr_urls: Vec<String>,
    #[serde(default)]
    review_feedback_routed_at: Option<String>,
    #[serde(default)]
    openclaw_needed: bool,
    #[serde(default)]
    openclaw_done: bool,
    #[serde(default)]
    system_spec_path: Option<String>,
    #[serde(default)]
    no_system_spec_change_reason: Option<String>,
    #[serde(default)]
    failure_fingerprint: Option<String>,
    /// True when the lobster has already PATCHed the task description to
    /// uncheck the `Approved by Tom` marker for the current drift episode.
    /// Used for idempotent re-runs.
    #[serde(default)]
    spec_drift_uncheck_applied: Option<bool>,
}

impl Default for LobsterState {
    fn default() -> Self {
        Self {
            version: 1,
            workflow: WORKFLOW.to_string(),
            last_orchestrated_at: None,
            pr_urls: Vec::new(),
            review_feedback_routed_at: None,
            openclaw_needed: false,
            openclaw_done: false,
            system_spec_path: None,
            no_system_spec_change_reason: None,
            failure_fingerprint: None,
            spec_drift_uncheck_applied: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProductSpecRef {
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Workstream {
    owner: String,
    body: String,
}

// `ApiStatusError` + `Display` + `Error` moved to `api_client.rs` in
// PR-G (W37 A3 main.rs carve).

fn main() -> Result<()> {
    let cli = Cli::parse();
    let envelope = match cli.command {
        Commands::LoadTask { base_url, task_id } => cli_utils::load_task(&base_url, &task_id)?,
        Commands::SpecCheck(args) => spec_check_ready::spec_check(args)?,
        Commands::ReadyChecks(args) => spec_check_ready::ready_checks(args)?,
        Commands::VerifyDelivery(args) => crate::verify_delivery::verify_delivery(args)?,
        Commands::FeedbackAggregate(args) => feedback_aggregate::feedback_aggregate(args)?,
        Commands::PostMerge(args) => crate::post_merge::post_merge(args)?,
        Commands::CodeTaskTechDesignCheck(args) => {
            spec_check_ready::code_task_tech_design_check(args)?
        }
        Commands::CodeTaskReadyChecks(args) => spec_check_ready::code_task_ready_checks(args)?,
        Commands::CodeTaskVerifyDelivery(args) => {
            crate::verify_delivery::code_task_verify_delivery(args)?
        }
        Commands::ReconcileBrainSpecApprovals(args) => reconcile_brain_spec_approvals(args)?,
        Commands::ArchiveDoneTaskSpecsSweep(args) => {
            brain_spec_lifecycle::archive_done_task_specs_sweep(args)?
        }
        Commands::Analytics(args) => analytics_replay::analytics_replay(args)?,
    };
    println!("{}", serde_json::to_string_pretty(&envelope)?);
    Ok(())
}

// `gh_command` / `pr_body` / `load_task` moved to `cli_utils.rs` in
// Slice 2 (W38+ second tranche main.rs carve). Cross-module consumers
// reference these helpers via `crate::cli_utils::{gh_command, pr_body,
// load_task}` — same `pub(crate)` shape as the W37 first-tranche carve.

// `open -> ready` / `ready -> doing` stage handlers (`spec_check`,
// `ready_checks`, `code_task_tech_design_check`, `code_task_ready_checks`)
// and the workflow-attention reconcile cluster (`workflow_attention_owner`,
// `ash_was_last_commenter`, `managed_owner_reason_satisfied`,
// `reconciled_attention_owners`, `reconcile_workflow_attention`,
// `workflow_handoff`, `transition_or_block`) — moved to
// `spec_check_ready.rs` in PR-J (W37 A3 main.rs carve). Imported here as
// `crate::spec_check_ready::{spec_check, ready_checks,
// code_task_tech_design_check, code_task_ready_checks,
// workflow_handoff, reconcile_workflow_attention,
// transition_or_block}`. Cross-module consumers (`feedback_aggregate.rs`,
// `post_merge.rs`, `verify_delivery.rs`) reference the helpers via
// `crate::spec_check_ready::*` paths per the W37 carve convention.

// ---- Spec resync path helpers (AC4) ----
//
// The lobster resync writes back to the brain spec file referenced from the
// task description. The task's `**Spec:** <path>` is trusted as the intended
// spec target, but resync should still never write outside the workspace brain.
// Safety gates:
//
//   1. The resolved path must live under `<workspace_root>/brain/`.
//   2. The resolved path's extension must be `.md`.
//   3. Relative paths must begin with `brain/` and may not contain `..`.
//
// This deliberately allows both `brain/bookmarks/specs/*.md` and
// `brain/tasks/specs/*.md`, plus future brain subtrees.

// `BRAIN_DIR`, `TASK_SPECS_DIR`, `TASK_SPECS_OPEN_DIR`,
// `TASK_SPECS_IN_PROGRESS_DIR`, `TASK_SPECS_DONE_DIR`,
// `BRAIN_SPEC_APPROVAL_NOTE_PREFIX`, `TASK_SPEC_LIFECYCLE_DIRS`, and the
// brain-spec reconciliation + chat-spec lifecycle move planning + the
// spec-archive planning cluster (`reconciliation_spec_link`,
// `plan_brain_spec_approval`, `feature_policy_requires_spec`,
// `grant_reconciled_spec_approval`, `reconcile_brain_spec_approvals`,
// `BrainSpecApprovalPlan`, `bootstrap_task_spec_layout`,
// `normalize_rel_path`, `plan_chat_spec_lifecycle_move`,
// `move_approved_chat_spec_if_needed`, `ArchiveSpecPlan`,
// `ArchiveOutcome`, `ArchiveSkipReason`, `ChatApprovalMovePlan`,
// `plan_task_spec_archive`, `resolve_archive_plan`,
// `rewrite_spec_line_in_description`, `archive_task_spec_for_done_task`)
// moved to `brain_spec_reconcile.rs` in Slice 3 (W38+ second tranche).
//
// The CLI-dispatch entry (`reconcile_brain_spec_approvals`) reaches the
// function via a non-test re-export below; the rest are in `use` form so
// `main.rs::tests` resolves them via `use super::*;` without widening
// visibility. The test-block split is planned for Slice 4
// (`tests_integration.rs` + per-module test blocks).
#[cfg(test)]
use crate::brain_spec_reconcile::plan_brain_spec_approval;
pub(crate) use crate::brain_spec_reconcile::reconcile_brain_spec_approvals;

// `output`, `read_envelope`, `api_get`, `api_get_task`,
// `authenticated_api_patch_request`, `api_client::api_patch`, `api_delete`,
// `lobster_service_token`, `add_comment`, `handle_api_result`,
// `api_status_error`, and `spec_checksum_mismatch_message` moved to
// `api_client.rs` in PR-G (W37 A3 main.rs carve).
//
// `write_state`, `list_all_active_tasks`, `task_implementer`,
// `IMPLEMENTER_DOING_CAPACITY`, `is_actionable_for`,
// `implementer_doing_capacity_failures`, `comment_text`,
// `parse_lobster_state`, `workflow_for_task`, `status_rank`, `is_past`,
// `spec_failures`, `missing_spec_checksum_failures`, and `spec_is_approved`
// moved to `lobster_state.rs` in PR-I (W37 A3 main.rs carve).

// Cross-cutting integration tests live in `tests_integration.rs`; module-owned
// tests stay colocated with their production modules.
#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    #[test]
    fn cli_help_remains_available() {
        let error = match Cli::try_parse_from(["feature-task", "--help"]) {
            Ok(_) => panic!("--help should exit through clap's display-help path"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
    }
}
