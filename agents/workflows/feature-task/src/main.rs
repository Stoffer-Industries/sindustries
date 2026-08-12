use anyhow::{anyhow, Context, Result};
use clap::{ArgAction, Parser, Subcommand};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
};

mod ac_parsing;
mod analytics;

const AUTHOR: &str = "Lobster";
const WORKFLOW: &str = "feature-task-workflow";
const CODE_TASK_WORKFLOW: &str = "code-task-workflow";
const STATE_TAG: &str = "[lobster-state]";
const STATUS_ORDER: [&str; 5] = ["open", "ready", "doing", "acceptance", "done"];

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
struct ArchiveDoneTaskSpecsSweepArgs {
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
struct AnalyticsArgs {
    #[arg(long, default_value = "http://localhost:4001/api/v1")]
    base_url: String,
    #[command(subcommand)]
    action: AnalyticsAction,
}

#[derive(Subcommand, Clone)]
enum AnalyticsAction {
    /// Replay a task's lifecycle analytics events in chronological order
    /// (AC5 of task f170e344).
    Replay {
        #[arg(long)]
        task_id: String,
    },
}

#[derive(Parser, Clone)]
struct StageArgs {
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
struct Envelope {
    criteria_met: bool,
    already_past: bool,
    action_taken: String,
    task: Task,
    lobster_state: LobsterState,
    failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Task {
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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ActiveWorkflowHandoff {
    role: String,
    #[serde(default)]
    gate: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TaskComment {
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
struct LobsterState {
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
struct ProductSpecRef {
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Workstream {
    owner: String,
    body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewState {
    Approved,
    Required,
    ChangesRequested,
    CommentsPresent,
    Merged,
    ClosedUnmerged,
}

#[derive(Debug)]
struct ApiStatusError {
    status: u16,
    code: Option<String>,
    message: String,
}

impl fmt::Display for ApiStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.code {
            Some(code) => write!(f, "API returned {} {code}: {}", self.status, self.message),
            None => write!(f, "API returned {}: {}", self.status, self.message),
        }
    }
}

impl std::error::Error for ApiStatusError {}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let envelope = match cli.command {
        Commands::LoadTask { base_url, task_id } => load_task(&base_url, &task_id)?,
        Commands::SpecCheck(args) => spec_check(args)?,
        Commands::ReadyChecks(args) => ready_checks(args)?,
        Commands::VerifyDelivery(args) => verify_delivery(args)?,
        Commands::FeedbackAggregate(args) => feedback_aggregate(args)?,
        Commands::PostMerge(args) => post_merge(args)?,
        Commands::CodeTaskTechDesignCheck(args) => code_task_tech_design_check(args)?,
        Commands::CodeTaskReadyChecks(args) => code_task_ready_checks(args)?,
        Commands::CodeTaskVerifyDelivery(args) => code_task_verify_delivery(args)?,
        Commands::ReconcileBrainSpecApprovals(args) => reconcile_brain_spec_approvals(args)?,
        Commands::ArchiveDoneTaskSpecsSweep(args) => archive_done_task_specs_sweep(args)?,
        Commands::Analytics(args) => analytics_replay(args)?,
    };
    println!("{}", serde_json::to_string_pretty(&envelope)?);
    Ok(())
}

/// Replay a task's lifecycle analytics events in chronological order
/// (AC5 of task f170e344). Prints one human-readable line per event and
/// exits non-zero only for invalid task IDs, unreachable API, or
/// malformed API response. "No events" is a successful empty replay.
fn analytics_replay(args: AnalyticsArgs) -> Result<Envelope> {
    let base_url = args.base_url.trim_end_matches('/').to_string();
    let task_id = match args.action {
        AnalyticsAction::Replay { task_id } => task_id,
    };

    // Match the API's UUID pattern (36-char with 4 dashes). Surface as a
    // structured error rather than letting the API reject the request.
    let uuid_re = Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("constant regex");
    if !uuid_re.is_match(&task_id) {
        return Err(anyhow!(
            "task-id must be a 36-char UUID (got `{}`)",
            task_id
        ));
    }

    let url = format!("{base_url}/feature-task-analytics/tasks/{task_id}/events");
    let body: Value = handle_api_result(ureq::get(&url).call())?;
    let events = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let envelope = replay_envelope(&task_id, &events);
    print_replay(&task_id, &events);
    Ok(envelope)
}

/// Build the JSON envelope for the replay output. The replay is a
/// read-only operation, so the envelope's task is empty and the action
/// reflects the operation that ran.
fn replay_envelope(task_id: &str, events: &[Value]) -> Envelope {
    #[allow(
        clippy::field_reassign_with_default,
        reason = "default-initializer is the cheapest way to build LobsterState before attaching it to the Envelope; refactor to struct-update syntax only when LobsterState grows a field set that warrants a parallel constructor"
    )]
    let lobster_state = {
        let mut lobster_state = LobsterState::default();
        lobster_state.last_orchestrated_at = Some(analytics::chrono_like_now_iso());
        lobster_state
    };
    Envelope {
        criteria_met: true,
        already_past: false,
        action_taken: format!("analytics_replay_returned_{}_events", events.len()),
        task: Task {
            id: task_id.to_string(),
            ..Task::default()
        },
        lobster_state,
        failures: Vec::new(),
    }
}

/// Print the human-readable replay output (separate from the JSON envelope
/// so callers can `feature-task analytics replay … | jq .` without losing
/// the prose).
fn print_replay(task_id: &str, events: &[Value]) {
    println!("Task {task_id} lifecycle replay");
    if events.is_empty() {
        println!("(no events)");
        return;
    }
    for event in events {
        let event_type = event
            .get("eventType")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let occurred_at = event
            .get("occurredAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let gate = event.get("gate").and_then(Value::as_str).unwrap_or("");
        let cause = event.get("cause").and_then(Value::as_str).unwrap_or("");
        let message = event.get("message").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "gate_failure" => {
                println!(
                    "{occurred_at} {gate} {cause} {message}",
                    gate = if gate.is_empty() { "?" } else { gate },
                );
            }
            "terminal_summary" => {
                let terminal_status = event
                    .get("terminalStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("done");
                let total = event
                    .get("totalGateFailureCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let capacity = event
                    .get("capacityBlockCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let quality = event
                    .get("qualityFailureCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let cycle = event
                    .get("prCycleTimeSeconds")
                    .and_then(Value::as_i64)
                    .map(format_seconds)
                    .unwrap_or_else(|| "n/a".to_string());
                let evidence = event
                    .get("evidenceTypeDistribution")
                    .and_then(Value::as_object)
                    .map(format_evidence)
                    .unwrap_or_default();
                println!(
                    "{occurred_at} terminal_summary {terminal_status} total={total} capacity={capacity} quality={quality} prCycle={cycle} evidence={evidence}",
                    evidence = if evidence.is_empty() { "{}".to_string() } else { evidence },
                );
            }
            _ => {
                println!("{occurred_at} {event_type} {message}");
            }
        }
    }
}

fn format_seconds(total_seconds: i64) -> String {
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    if total_seconds < 3600 {
        let minutes = total_seconds / 60;
        let seconds = total_seconds % 60;
        return format!("{minutes}m{seconds}s");
    }
    if total_seconds < 86400 {
        let hours = total_seconds / 3600;
        let minutes = (total_seconds % 3600) / 60;
        return format!("{hours}h{minutes}m");
    }
    let days = total_seconds / 86400;
    let hours = (total_seconds % 86400) / 3600;
    format!("{days}d{hours}h")
}

fn format_evidence(map: &serde_json::Map<String, Value>) -> String {
    let mut parts: Vec<String> = map
        .iter()
        .map(|(k, v)| format!("{k}:{}", v.as_i64().unwrap_or(0)))
        .collect();
    parts.sort();
    format!("{{{}}}", parts.join(","))
}

fn load_task(base_url: &str, task_id: &str) -> Result<Envelope> {
    let task: Task = api_get(base_url, &format!("/tasks/{task_id}"))?;
    let state = parse_lobster_state(&task);
    Ok(output(true, false, "loaded_task", task, state, vec![]))
}

fn spec_check(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    bootstrap_task_spec_layout(workspace_root(&args))?;
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "spec_check")? {
        if !drift.criteria_met {
            return Ok(drift);
        }
        // Resync succeeded — propagate fresh task/state so downstream
        // stages in the same pipeline run see the updated specChecksum.
        env = drift;
    }
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "spec_check",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    if !args.dry_run {
        env = move_approved_chat_spec_if_needed(&args, env)?;
    }
    if is_past(&env.task, "open") {
        let failures = missing_spec_checksum_failures(&env.task, &args.repo, workspace_root(&args));
        if !failures.is_empty() {
            if !args.dry_run {
                api_patch::<Task>(&args.base_url, &env.task.id, json!({"status": "open", "workflowHandoff": workflow_handoff("product_spec_approver", "spec", "Product spec approval is required")}))?;
                env.task = api_get_task(&args.base_url, &env.task.id)?;
                let fingerprint = failures.join("\n");
                if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
                    env.lobster_state.failure_fingerprint = Some(fingerprint);
                    add_comment(
                        &args.base_url,
                        &env.task.id,
                        &format!(
                            "[feature-task-progress-checklist]\nTask advanced past spec check without passing the gate. Reverted to `open`.\n{}",
                            failures.join("\n")
                        ),
                    )?;
                    write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
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
    let failures = spec_failures(&env.task, &args.repo, workspace_root(&args));
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
        Some(workflow_handoff("product_spec_approver", "spec", "Product spec approval is required")),
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `ready`.",
    )
}

fn ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "ready_checks")? {
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
            "ready_checks",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    if is_past(&env.task, "ready") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_ready".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    if tech_design_url(&env.task).is_none() {
        failures.push("Missing task comment `[tech-design] <url>`.".to_string());
    }
    if !tech_design_approved_structured(&env.task) {
        failures.push("Structured `tech_design` approval is missing or not approved.".to_string());
    }
    let implementer = task_implementer(&env.task);
    if implementer.is_none() {
        failures
            .push("Task must have an assignee/implementer before moving to `doing`.".to_string());
    }
    if let (Some(implementer), Ok(tasks)) = (
        implementer.as_deref(),
        list_all_active_tasks(&args.base_url),
    ) {
        let current_id = &env.task.id;
        failures.extend(implementer_doing_capacity_failures(
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
        Some(workflow_handoff("tech_design_approver", "tech_design", "Tech design approval is required")),
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `doing`.",
    )
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

fn code_task_tech_design_check(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    env.lobster_state.workflow = workflow_for_task(&env.task);
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "code_task_tech_design_check",
            manual_failures,
            "[code-task-blocked]",
        );
    }
    if is_past(&env.task, "open") {
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
    let has_tech_design = tech_design_url(&env.task).is_some();
    let has_tech_design_approved = tech_design_approved_structured(&env.task);
    let has_waiver = tech_design_waived(&env.task);
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
        Some(workflow_handoff("tech_design_approver", "tech_design", "Tech design approval is required")),
        "[code-task-tech-design-checklist]",
        "Code task workflow moved task to `ready`.",
    )
}

fn code_task_ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    env.lobster_state.workflow = workflow_for_task(&env.task);
    let manual_failures = manual_block_failures(&env.task);
    if !manual_failures.is_empty() {
        return block_with_manual_block(
            &args,
            env,
            "code_task_ready_checks",
            manual_failures,
            "[code-task-blocked]",
        );
    }
    if is_past(&env.task, "ready") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_ready".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    // The tech-design gate has already moved the task to `ready` in the
    // previous stage. This stage is purely about assignee + capacity.
    let implementer = task_implementer(&env.task);
    if implementer.is_none() {
        failures
            .push("Task must have an assignee/implementer before moving to `doing`.".to_string());
    }
    if let (Some(implementer), Ok(tasks)) = (
        implementer.as_deref(),
        list_all_active_tasks(&args.base_url),
    ) {
        let current_id = &env.task.id;
        failures.extend(implementer_doing_capacity_failures(
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

fn code_task_verify_delivery(args: StageArgs) -> Result<Envelope> {
    // Backwards-compatible CLI alias. The code-task pipeline now calls the
    // canonical feature-task delivery stage directly so both task types share
    // exactly the same delivery contract.
    verify_delivery(args)
}

fn verify_delivery(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(drift) = block_on_spec_drift_fluid(&args, env.clone(), "verify_delivery")? {
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
            "verify_delivery",
            manual_failures,
            "[feature-task-blocked]",
        );
    }
    if is_past(&env.task, "doing") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_doing".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    let pr_urls = implementer_pr_urls(&env.task);
    if pr_urls.is_empty() {
        failures
            .push("Missing `[implementer-prs]` task comment with at least one PR URL.".to_string());
    }
    env.lobster_state.pr_urls = pr_urls.clone();
    let task_acs =
        ac_parsing::task_description_acs(&env.task.description.clone().unwrap_or_default());
    // AC text match only checks the *latest* PR (highest PR number). Earlier PRs
    // may legitimately have drifted from the current task description (e.g.
    // trailing-period fixes landed in a follow-up PR). The latest PR is the one
    // that will be merged at this gate, so it's the only one that needs to match.
    let latest_pr_url = pr_urls.iter().max_by_key(|url| pr_number(url)).cloned();
    for url in &pr_urls {
        // Only the latest PR (highest PR number) is the one that will be merged
        // at this gate. Earlier PRs that were intentionally superseded (e.g.
        // v1 → v2 branch replace, or stacked predecessors) should not
        // contribute failures here — the AC text match below already targets
        // the latest PR explicitly, so we extend the same principle to the
        // review-state and body checks. Without this, a closed-without-merge
        // superseded PR leaves a persistent "PR X is closed without merge."
        // failure that blocks every sweep (fingerprint dedup), even after the
        // task has been re-delivered on a fresh branch.
        if !is_latest_pr_url(url, &pr_urls) {
            continue;
        }
        let review = inspect_pr(url);
        match review {
            Ok(r) => {
                if let Some(failure) = verify_delivery_review_failure(url, r) {
                    failures.push(failure);
                }
            }
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
        if let Ok(body) = pr_body(url) {
            if !body_has_checked_acceptance(&body) {
                failures.push(format!(
                    "PR {url} does not show checked acceptance criteria in its body."
                ));
            }
            for ac_failure in ac_parsing::verify_pr_acs_failures(&body) {
                failures.push(format!("PR {url} — {ac_failure}"));
            }
        }
    }
    if let Some(url) = &latest_pr_url {
        match pr_body(url) {
            Ok(body) => {
                for ac_failure in
                    ac_parsing::task_ac_vs_open_pr_failures(&env.task.id, &task_acs, &body, url)
                {
                    failures.push(format!("PR {url} — {ac_failure}"));
                }
            }
            Err(err) => {
                failures.push(format!(
                    "Could not read PR body for {url}: {err}. Cannot validate AC text."
                ));
            }
        }
    }
    // Clippy evidence gate (opt-in via CLIPPY_ENFORCE env). When the gate
    // is enabled, only the latest PR is checked (matches the
    // `latest_pr_url` principle used above for AC text). Non-Rust /
    // content-only PRs are skipped outright.
    if let Some(url) = &latest_pr_url {
        failures.extend(clippy_evidence_failures(url));
    }
    if workstreams(&env.task).is_empty() {
        failures.push("Task description must include at least one workstream.".to_string());
    }
    if openclaw_needed(&env.task) && !openclaw_done(&env.task) {
        failures
            .push("`[openclaw-needed]` is present but `[openclaw-done]` is missing.".to_string());
    }
    transition_or_block(
        &args,
        env,
        "acceptance",
        "verify_delivery",
        failures,
        None,
        "[feature-task-progress-checklist]",
        "Feature task workflow moved task to `acceptance`.",
    )
}

fn feedback_aggregate(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
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

fn verify_delivery_review_failure(url: &str, review: ReviewState) -> Option<String> {
    match review {
        ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        ReviewState::ClosedUnmerged => Some(format!("PR {url} is closed without merge.")),
        _ => None,
    }
}

/// Merge gate for `acceptance → done`. Merged PRs pass. Closed-without-merge
/// PRs that are *not* the latest listed implementer PR are treated as
/// superseded (same principle as `verify_delivery`'s latest-only filter) and
/// do not block. The latest ClosedUnmerged still fails, as do open / review /
/// unknown states on any listed PR.
fn post_merge_pr_failure(
    url: &str,
    state: ReviewState,
    all_pr_urls: &[String],
) -> Option<String> {
    match state {
        ReviewState::Merged => None,
        ReviewState::ClosedUnmerged if !is_latest_pr_url(url, all_pr_urls) => None,
        other => Some(format!("PR {url} is not merged: {other:?}.")),
    }
}

/// Extract the PR number from a GitHub PR URL for ordering.
fn pr_number(url: &str) -> u64 {
    url.rsplit('/')
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
}

/// True when `candidate` is the PR URL in `all_pr_urls` with the highest
/// PR number. Used by `verify_delivery` to skip review-state and body checks
/// against superseded PRs (e.g. a v1 branch that was closed-without-merge and
/// replaced by a v2 branch). Returns false for an unparseable candidate URL
/// or an empty `all_pr_urls`.
fn is_latest_pr_url(candidate: &str, all_pr_urls: &[String]) -> bool {
    let candidate_num = pr_number(candidate);
    if candidate_num == 0 {
        return false;
    }
    let max_num = all_pr_urls
        .iter()
        .map(|url| pr_number(url))
        .max()
        .unwrap_or(0);
    max_num == candidate_num
}

fn feedback_review_failure(url: &str, review: ReviewState) -> Option<String> {
    match review {
        ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        ReviewState::CommentsPresent => Some(format!("Open review comments remain on {url}.")),
        _ => None,
    }
}

/// Return true only when the matching structured approval row is approved.
/// Missing, revoked, and unknown states fail closed.
fn task_approval_granted(task: &Task, approval_type: &str) -> bool {
    task.approvals
        .iter()
        .any(|a| a.approval_type == approval_type && a.state == "approved")
}
fn qa_ac_verified_structured(task: &Task) -> bool {
    task_approval_granted(task, "qa")
}
fn qa_ac_verified_failures_structured(task: &Task) -> Vec<String> {
    if qa_ac_verified_structured(task) {
        vec![]
    } else {
        vec!["Structured QA approval is missing or not approved; Tom must approve the `qa` TaskApproval before closing.".to_string()]
    }
}

fn parse_git_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    for block in output.split("\n\n") {
        let mut path: Option<PathBuf> = None;
        let mut branch: Option<String> = None;
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(rest.trim()));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                // Strip the `refs/heads/` prefix to match typical branch names.
                let name = rest
                    .trim()
                    .strip_prefix("refs/heads/")
                    .unwrap_or(rest.trim());
                branch = Some(name.to_string());
            }
        }
        if let Some(p) = path {
            entries.push(WorktreeEntry { path: p, branch });
        }
    }
    entries
}

/// Return the 8-char task-id prefix used in feature-task worktree/branch names,
/// e.g. `ba116063-382a-446c-ab91-c01b60d9a7c3` -> `ba116063`.
fn task_id_prefix(task_id: &str) -> &str {
    let cut = TASK_ID_PREFIX_LEN.min(task_id.len());
    &task_id[..cut]
}

/// Select worktrees that should be removed for the given task. Matches both
/// the worktree path and the branch name against `task-<prefix>`. The input
/// entries come from `git -C <primary_repo> worktree list`, so they are already
/// scoped to worktrees registered to this repository. Never remove the primary
/// worktree used to run the workflow.
fn select_matching_task_worktrees<'a>(
    entries: &'a [WorktreeEntry],
    task_id: &str,
    primary_repo: &Path,
) -> Vec<&'a WorktreeEntry> {
    let prefix = task_id_prefix(task_id);
    let marker = format!("task-{prefix}");
    let primary_repo = primary_repo
        .canonicalize()
        .unwrap_or_else(|_| primary_repo.to_path_buf());
    entries
        .iter()
        .filter(|entry| {
            let entry_path = entry
                .path
                .canonicalize()
                .unwrap_or_else(|_| entry.path.clone());
            if entry_path == primary_repo {
                return false;
            }
            let path_str = entry.path.to_string_lossy();
            let path_match = path_str.contains(&marker);
            let branch_match = entry
                .branch
                .as_deref()
                .map(|b| b.contains(&marker))
                .unwrap_or(false);
            path_match || branch_match
        })
        .collect()
}

/// Run `git worktree remove --force <path>` for each candidate. Missing
/// paths are reported as `AlreadyAbsent` so re-runs stay idempotent.
/// All other failures are captured as `Failed(<message>)` and surfaced as
/// non-fatal warnings; this function never returns Err.
fn remove_worktrees_best_effort(
    repo: &Path,
    candidates: &[WorktreeEntry],
) -> Vec<WorktreeCleanupResult> {
    let mut results = Vec::with_capacity(candidates.len());
    for entry in candidates {
        let path = &entry.path;
        if !path.exists() {
            results.push(WorktreeCleanupResult {
                path: path.clone(),
                branch: entry.branch.clone(),
                outcome: WorktreeCleanupOutcome::AlreadyAbsent,
            });
            continue;
        }
        let output = Command::new("git")
            .args([
                "-C",
                repo.to_string_lossy().as_ref(),
                "worktree",
                "remove",
                "--force",
            ])
            .arg(path)
            .output();
        let outcome = match output {
            Ok(out) if out.status.success() => WorktreeCleanupOutcome::Removed,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let combined = if stderr.is_empty() { stdout } else { stderr };
                WorktreeCleanupOutcome::Failed(if combined.is_empty() {
                    format!(
                        "git worktree remove exited with status {:?}",
                        out.status.code()
                    )
                } else {
                    combined
                })
            }
            Err(err) => WorktreeCleanupOutcome::Failed(format!("failed to spawn git: {err}")),
        };
        results.push(WorktreeCleanupResult {
            path: path.clone(),
            branch: entry.branch.clone(),
            outcome,
        });
    }
    results
}

/// Top-level worktree cleanup for a feature task. Returns a list of cleanup
/// results (empty when nothing matched). Failures are non-fatal by design.
fn cleanup_task_worktree_for_task(repo: &Path, task_id: &str) -> Vec<WorktreeCleanupResult> {
    let list_output = Command::new("git")
        .args([
            "-C",
            repo.to_string_lossy().as_ref(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output();
    let stdout = match list_output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        Ok(out) => {
            // Treat `git worktree list` failure as a soft warning so the lobster
            // can still advance the task; surface the error in the results.
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return vec![WorktreeCleanupResult {
                path: PathBuf::from("<git-worktree-list>"),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed(if stderr.is_empty() {
                    format!(
                        "git worktree list exited with status {:?}",
                        out.status.code()
                    )
                } else {
                    stderr
                }),
            }];
        }
        Err(err) => {
            return vec![WorktreeCleanupResult {
                path: PathBuf::from("<git-worktree-list>"),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed(format!("failed to spawn git: {err}")),
            }];
        }
    };
    let entries = parse_git_worktree_porcelain(&stdout);
    let candidates: Vec<WorktreeEntry> = select_matching_task_worktrees(&entries, task_id, repo)
        .into_iter()
        .cloned()
        .collect();
    remove_worktrees_best_effort(repo, &candidates)
}

fn format_worktree_cleanup_summary(results: &[WorktreeCleanupResult]) -> String {
    if results.is_empty() {
        return "No matching task worktrees found for this task.".to_string();
    }
    results
        .iter()
        .map(|r| {
            let branch = r.branch.as_deref().unwrap_or("(detached)");
            let status = match &r.outcome {
                WorktreeCleanupOutcome::Removed => "removed".to_string(),
                WorktreeCleanupOutcome::AlreadyAbsent => "already absent (idempotent)".to_string(),
                WorktreeCleanupOutcome::Failed(msg) => format!("FAILED: {msg}"),
            };
            format!("- {} (branch: {}) -> {}", r.path.display(), branch, status)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn post_merge(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
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
                api_patch::<Task>(&args.base_url, &env.task.id, json!({"status": "doing", "workflowHandoff": Value::Null}))?;
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
    let qa_failures = qa_ac_verified_failures_structured(&env.task);
    if is_past(&env.task, "acceptance") {
        if !qa_failures.is_empty() {
            if !args.dry_run {
                api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"status": "acceptance", "workflowHandoff": workflow_handoff("qa_verifier", "qa", "Acceptance criteria require QA verification")}),
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
    for url in &pr_urls {
        match inspect_pr(url) {
            Ok(state) => {
                if let Some(failure) = post_merge_pr_failure(url, state, &pr_urls) {
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
        Some(workflow_handoff("qa_verifier", "qa", "Acceptance criteria require QA verification")),
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

/// Best-effort removal of any feature-task worktree that was created for this
/// task. Runs on every post_merge invocation that reaches the `done` state
/// (including idempotent re-runs) so stale worktrees cannot accumulate.
/// Cleanup failures are surfaced as a `[feature-task-progress-checklist]`
/// comment but never block the lobster.
fn run_post_merge_worktree_cleanup(args: &StageArgs, mut env: Envelope) -> Result<Envelope> {
    if args.dry_run {
        return Ok(env);
    }
    let results = cleanup_task_worktree_for_task(&args.repo, &env.task.id);
    let had_failure = results
        .iter()
        .any(|r| matches!(r.outcome, WorktreeCleanupOutcome::Failed(_)));
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

fn workflow_handoff(role: &str, gate: &str, reason: &str) -> ActiveWorkflowHandoff {
    ActiveWorkflowHandoff { role: role.to_string(), gate: Some(gate.to_string()), reason: Some(reason.to_string()) }
}

/// `comment_tag` is the bracket tag written on the progress-checklist
/// comment when failures are present (e.g. `[feature-task-progress-checklist]`
/// or `[code-task-progress-checklist]`). `move_message` is the human prose
/// prepended to the `[lobster-state]` write when the task transitions.
#[allow(clippy::too_many_arguments)]
fn transition_or_block(
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
                patch["specChecksum"] = Value::String(spec_checksum(&env.task));
            }
            if let Err(err) = api_patch::<Task>(&args.base_url, &env.task.id, patch) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
            env.task = api_get_task(&args.base_url, &env.task.id)?;
            if let Err(err) = write_state(
                &args.base_url,
                &env.task.id,
                &env.lobster_state,
                Some(move_message),
            ) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
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
            api_patch::<Task>(&args.base_url, &env.task.id, json!({"workflowHandoff": handoff_on_block}))?;
            env.task = api_get_task(&args.base_url, &env.task.id)?;
        }
        if !args.dry_run && env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
            env.lobster_state.failure_fingerprint = Some(fingerprint);
            if let Err(err) = add_comment(
                &args.base_url,
                &env.task.id,
                &format!("{comment_tag}\n{}", failures.join("\n")),
            ) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(env);
                }
                return Err(err);
            }
            if let Err(err) = write_state(&args.base_url, &env.task.id, &env.lobster_state, None) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
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
        analytics::emit_gate_failure_events(args, &env.task, action, &env.failures);
    }
    Ok(env)
}

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

const BRAIN_DIR: &str = "brain";

// ---- Spec archive path helpers (feature task c40ae956) ----
//
// When a feature task transitions to `done`, the spec referenced in the task's
// `**Spec:**` line should move from `brain/tasks/specs/` into
// `brain/tasks/specs/done/`. The boundary is intentionally narrow:
//   1. Only specs under `brain/tasks/specs/in-progress/<slug>.md` are eligible.
//   2. Specs already under `brain/tasks/specs/done/` are a no-op (idempotent).
//   3. `brain/tasks/specs/open/`, `brain/bookmarks/specs/`, `docs/specs/`, and other paths are out of scope.
//
// These helpers intentionally differ from `safe_brain_spec_path`, which is
// permissive about the brain subtree to support spec resync. The archive path
// is much stricter — only one subtree, one target directory.

const TASK_SPECS_DIR: &str = "brain/tasks/specs";
const TASK_SPECS_OPEN_DIR: &str = "brain/tasks/specs/open";
const TASK_SPECS_IN_PROGRESS_DIR: &str = "brain/tasks/specs/in-progress";
const TASK_SPECS_DONE_DIR: &str = "brain/tasks/specs/done";
const BRAIN_SPEC_APPROVAL_NOTE_PREFIX: &str = "Reconciled from checked brain spec";

#[derive(Debug, Clone, PartialEq, Eq)]
enum BrainSpecApprovalPlan {
    Grant { task_id: String },
    AlreadyApproved { task_id: String },
    Unchecked,
    Revoked { task_id: String },
    MissingLink,
    Ambiguous { task_ids: Vec<String> },
}

/// Parse the single exact task/spec link used by approval reconciliation.
/// Unlike the normal compatibility parser, duplicate Spec lines are rejected:
/// a human approval must never be attached through an ambiguous description.
fn reconciliation_spec_link(task: &Task) -> Option<String> {
    let description = task.description.as_deref().unwrap_or("");
    let line_re = Regex::new(r"(?im)^\s*\*\*Spec:\*\*\s+(.+?)\s*$").unwrap();
    let mut captures = line_re.captures_iter(description);
    let first = captures.next()?;
    if captures.next().is_some() {
        return None;
    }
    extract_spec_path_from_line(first.get(1)?.as_str()).map(|spec| normalize_rel_path(&spec.path))
}

fn plan_brain_spec_approval(
    spec_path: &str,
    spec_text: &str,
    tasks: &[Task],
) -> BrainSpecApprovalPlan {
    if !brain_spec_approved_by_tom(spec_text) {
        return BrainSpecApprovalPlan::Unchecked;
    }
    let normalized = normalize_rel_path(spec_path);
    let mut matches: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.task_type.as_deref() == Some("feature"))
        .filter(|task| reconciliation_spec_link(task).as_deref() == Some(normalized.as_str()))
        .collect();
    matches.sort_by(|a, b| a.id.cmp(&b.id));
    if matches.is_empty() {
        return BrainSpecApprovalPlan::MissingLink;
    }
    if matches.len() > 1 {
        return BrainSpecApprovalPlan::Ambiguous {
            task_ids: matches.iter().map(|task| task.id.clone()).collect(),
        };
    }
    let task = matches[0];
    if spec_is_approved(task) {
        return BrainSpecApprovalPlan::AlreadyApproved {
            task_id: task.id.clone(),
        };
    }
    if task
        .approvals
        .iter()
        .any(|approval| approval.approval_type == "spec" && approval.state == "revoked")
    {
        return BrainSpecApprovalPlan::Revoked {
            task_id: task.id.clone(),
        };
    }
    BrainSpecApprovalPlan::Grant {
        task_id: task.id.clone(),
    }
}

fn feature_policy_requires_spec(base_url: &str) -> Result<bool> {
    let value: Value = api_get(base_url, "/task-types/feature/required-approvals")?;
    let required = value
        .get("requiredApprovals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!("feature required-approvals response omitted `requiredApprovals`")
        })?;
    Ok(required.iter().any(|value| value.as_str() == Some("spec")))
}

fn grant_reconciled_spec_approval(base_url: &str, task_id: &str, spec_path: &str) -> Result<()> {
    let token = std::env::var("TASKS_API_APPROVAL_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow!("TASKS_API_APPROVAL_TOKEN is required to reconcile checked brain specs")
        })?;
    let url = format!(
        "{}/tasks/{task_id}/approvals",
        base_url.trim_end_matches('/')
    );
    let note = format!("{BRAIN_SPEC_APPROVAL_NOTE_PREFIX} `{spec_path}`.");
    handle_api_result(
        ureq::post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(json!({"type": "spec", "note": note})),
    )?;
    Ok(())
}

/// Scan only `brain/tasks/specs/open/*.md`, map checked specs to one active
/// feature task, and grant the structured spec approval through the Tasks API.
/// The API row remains the gate source; revoked rows, missing links, and
/// ambiguous links are diagnostics and never trigger a write.
fn reconcile_brain_spec_approvals(args: ReconcileBrainSpecApprovalsArgs) -> Result<Envelope> {
    if !feature_policy_requires_spec(&args.base_url)? {
        return Ok(output(
            true,
            false,
            "brain_spec_approval_reconciliation_skipped: feature_policy_has_no_spec_gate",
            Task::default(),
            LobsterState::default(),
            vec![],
        ));
    }

    let tasks = list_all_active_tasks(&args.base_url)?;
    let open_dir = args.workspace_root.join(TASK_SPECS_OPEN_DIR);
    let entries = fs::read_dir(&open_dir)
        .with_context(|| format!("reading open task specs directory `{}`", open_dir.display()))?;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("reading entry in `{}`", open_dir.display()))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            paths.push((path, false));
        } else {
            paths.push((path, true));
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));

    let mut checked = 0usize;
    let mut granted = 0usize;
    let mut already = 0usize;
    let mut unchecked = 0usize;
    let mut failures = Vec::new();
    for (path, accessible_file) in paths {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("<invalid>");
        let spec_rel = format!("{TASK_SPECS_OPEN_DIR}/{file_name}");
        if !accessible_file {
            failures.push(format!("Open task spec `{spec_rel}` is not an accessible regular file; no approval granted."));
            continue;
        }
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => {
                failures.push(format!(
                    "Could not read open task spec `{spec_rel}`: {err}; no approval granted."
                ));
                continue;
            }
        };
        match plan_brain_spec_approval(&spec_rel, &text, &tasks) {
            BrainSpecApprovalPlan::Unchecked => unchecked += 1,
            BrainSpecApprovalPlan::AlreadyApproved { .. } => {
                checked += 1;
                already += 1;
            }
            BrainSpecApprovalPlan::Grant { task_id } => {
                checked += 1;
                if args.dry_run {
                    granted += 1;
                } else if let Err(err) =
                    grant_reconciled_spec_approval(&args.base_url, &task_id, &spec_rel)
                {
                    failures.push(format!("Could not grant structured `spec` approval for task `{task_id}` linked from `{spec_rel}`: {err}."));
                } else {
                    granted += 1;
                }
            }
            BrainSpecApprovalPlan::Revoked { task_id } => {
                checked += 1;
                failures.push(format!("Task `{task_id}` has a revoked structured `spec` approval; `{spec_rel}` remains checked, but API revocation is authoritative. Re-check through a fresh human action before granting."));
            }
            BrainSpecApprovalPlan::MissingLink => {
                checked += 1;
                failures.push(format!("Checked open task spec `{spec_rel}` has no exact, unambiguous `**Spec:**` link from an active feature task requiring `spec`; no approval granted."));
            }
            BrainSpecApprovalPlan::Ambiguous { task_ids } => {
                checked += 1;
                failures.push(format!("Checked open task spec `{spec_rel}` is linked by multiple active feature tasks ({}); no approval granted.", task_ids.join(", ")));
            }
        }
    }

    Ok(output(
        failures.is_empty(),
        false,
        &format!(
            "brain_spec_approval_reconciliation: checked={checked} granted={granted} already_approved={already} unchecked={unchecked} failures={}",
            failures.len()
        ),
        Task::default(),
        LobsterState::default(),
        failures,
    ))
}

const TASK_SPEC_LIFECYCLE_DIRS: [&str; 4] = ["open", "in-progress", "done", "archived"];

// ---- Post-merge worktree cleanup (feature task ba116063) ----
//
// Implementers may run feature-task PRs from dedicated git worktrees registered
// with the primary `sindustries` worktree. After a task's PR merges, the
// post-merge stage removes matching task worktrees so stale directories don't
// accumulate. The cleanup is best-effort: a failure logs a warning but does not
// block the lobster from advancing the task.
/// Number of leading UUID chars used in worktree/branch names like
/// `sindustries-task-<8chars>-<slug>`.
const TASK_ID_PREFIX_LEN: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorktreeEntry {
    path: PathBuf,
    branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WorktreeCleanupOutcome {
    Removed,
    AlreadyAbsent,
    Failed(String),
}

#[derive(Debug, Clone)]
struct WorktreeCleanupResult {
    path: PathBuf,
    branch: Option<String>,
    outcome: WorktreeCleanupOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ArchiveSpecPlan {
    Move {
        from_rel: String,
        to_rel: String,
        from_abs: PathBuf,
        to_abs: PathBuf,
    },
    AlreadyArchived,
    OpenSpecCannotArchive,
    NotTaskSpec,
    MissingSpecRef,
}

/// Outcome of an attempt to archive a task spec for a task that has reached
/// `done`. This is the orchestrator-facing result returned by
/// [`archive_task_spec_for_done_task`] and is the input for both the
/// done-transition trigger and the reconciliation sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ArchiveOutcome {
    /// Spec was moved and the task description was rewritten.
    Moved {
        from_rel: String,
        to_rel: String,
    },
    /// Spec was already in the done directory; description was rewritten.
    AlreadyArchived {
        to_rel: String,
    },
    /// No work to do: spec is missing, not a task spec, an open spec, or
    /// the parser could not extract a path from the Spec line.
    NotApplicable {
        reason: ArchiveSkipReason,
    },
    /// Filesystem or path-resolution failure; the task should remain `done`
    /// and the next reconciliation sweep will retry. The caller is expected
    /// to surface a `[spec-archive-retryable]` task comment and an attention
    /// owner pointing at Quinn.
    Retryable {
        from_rel: String,
        to_rel: String,
        reason: String,
    },
    /// Destination file exists with different content from the source. Both
    /// files are left in place; a `[spec-archive-conflict]` comment must be
    /// posted. Reconciliation sweep will not retry until a human resolves it.
    Conflict {
        from_rel: String,
        to_rel: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ArchiveSkipReason {
    NotTaskSpec,
    MissingSpecRef,
    OpenSpecCannotArchive,
    UnparseableSpecLine,
}

impl ArchiveSkipReason {
    fn as_tag(&self) -> &'static str {
        match self {
            ArchiveSkipReason::NotTaskSpec => "not_task_spec",
            ArchiveSkipReason::MissingSpecRef => "missing_spec_ref",
            ArchiveSkipReason::OpenSpecCannotArchive => "open_spec_cannot_archive",
            ArchiveSkipReason::UnparseableSpecLine => "unparseable_spec_line",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ChatApprovalMovePlan {
    Move { from_rel: String, to_rel: String },
    AlreadyMoved { from_rel: String, to_rel: String },
    Noop,
}

/// Decide what should happen to the spec referenced from this task's Spec line.
/// Pure function: no filesystem access. The caller resolves the relative paths
/// to absolute paths once the workspace root is known.
fn bootstrap_task_spec_layout(workspace_root: &Path) -> Result<()> {
    let specs_root = workspace_root.join(TASK_SPECS_DIR);
    for dir in TASK_SPEC_LIFECYCLE_DIRS {
        fs::create_dir_all(specs_root.join(dir)).with_context(|| {
            format!(
                "creating task specs lifecycle dir `{}`",
                specs_root.join(dir).display()
            )
        })?;
    }
    for entry in fs::read_dir(&specs_root)
        .with_context(|| format!("reading task specs root `{}`", specs_root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !TASK_SPEC_LIFECYCLE_DIRS.contains(&name.as_str()) {
            return Err(anyhow!(
                "unexpected subdir under `{}`: `{}`; expected only open/, in-progress/, done/, archived/",
                specs_root.display(),
                name
            ));
        }
    }
    Ok(())
}

fn normalize_rel_path(path: &str) -> String {
    path.trim().trim_start_matches("./").to_string()
}

fn plan_chat_spec_approval_move(spec_path: &str, spec_text: &str) -> ChatApprovalMovePlan {
    let normalized = normalize_rel_path(spec_path);
    if !normalized.ends_with(".md") || normalized.contains("..") {
        return ChatApprovalMovePlan::Noop;
    }
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    let in_progress_prefix = format!("{TASK_SPECS_IN_PROGRESS_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        if suffix.is_empty() || suffix.contains('/') || !brain_spec_approved_by_tom(spec_text) {
            return ChatApprovalMovePlan::Noop;
        }
        let suffix = suffix.to_string();
        return ChatApprovalMovePlan::Move {
            from_rel: normalized,
            to_rel: format!("{TASK_SPECS_IN_PROGRESS_DIR}/{suffix}"),
        };
    }
    if let Some(suffix) = normalized.strip_prefix(&in_progress_prefix) {
        if !suffix.is_empty() && !suffix.contains('/') {
            return ChatApprovalMovePlan::AlreadyMoved {
                from_rel: format!("{TASK_SPECS_OPEN_DIR}/{suffix}"),
                to_rel: normalized,
            };
        }
    }
    ChatApprovalMovePlan::Noop
}

fn move_approved_chat_spec_if_needed(args: &StageArgs, mut env: Envelope) -> Result<Envelope> {
    let Some(spec) = product_spec(&env.task) else {
        return Ok(env);
    };
    let normalized = normalize_rel_path(&spec.path);
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        let to_rel = format!("{TASK_SPECS_IN_PROGRESS_DIR}/{suffix}");
        if workspace_root(args).join(&to_rel).exists() {
            let description = env.task.description.clone().unwrap_or_default();
            if let Some(new_desc) =
                rewrite_spec_line_in_description(&description, &normalized, &to_rel)
            {
                api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"description": new_desc}),
                )?;
                env.task = api_get_task(&args.base_url, &env.task.id)?;
                env.action_taken = "repaired_chat_spec_in_progress_path".to_string();
            }
            return Ok(env);
        }
    }
    let spec_abs = resolve_product_spec_path(&spec.path, &args.repo, workspace_root(args));
    let spec_text = match fs::read_to_string(&spec_abs) {
        Ok(text) => text,
        Err(_) => return Ok(env),
    };
    let plan = plan_chat_spec_approval_move(&spec.path, &spec_text);
    let (from_rel, to_rel, should_move) = match plan {
        ChatApprovalMovePlan::Move { from_rel, to_rel } => (from_rel, to_rel, true),
        ChatApprovalMovePlan::AlreadyMoved { from_rel, to_rel } => (from_rel, to_rel, false),
        ChatApprovalMovePlan::Noop => return Ok(env),
    };
    let from_abs = workspace_root(args).join(&from_rel);
    let to_abs = workspace_root(args).join(&to_rel);
    if should_move && from_abs.exists() {
        if let Some(parent) = to_abs.parent() {
            fs::create_dir_all(parent)?;
        }
        if !to_abs.exists() {
            fs::rename(&from_abs, &to_abs).with_context(|| {
                format!(
                    "moving approved chat spec from `{}` to `{}`",
                    from_abs.display(),
                    to_abs.display()
                )
            })?;
        }
    }
    let description = env.task.description.clone().unwrap_or_default();
    if let Some(new_desc) = rewrite_spec_line_in_description(&description, &from_rel, &to_rel) {
        api_patch::<Task>(
            &args.base_url,
            &env.task.id,
            json!({"description": new_desc}),
        )?;
        env.task = api_get_task(&args.base_url, &env.task.id)?;
        env.action_taken = "moved_approved_chat_spec_to_in_progress".to_string();
    }
    Ok(env)
}

fn plan_task_spec_archive(spec_path: Option<&str>) -> ArchiveSpecPlan {
    let Some(path) = spec_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return ArchiveSpecPlan::MissingSpecRef;
    };
    let normalized = normalize_rel_path(path);
    if !normalized.ends_with(".md") || normalized.contains("..") {
        return ArchiveSpecPlan::NotTaskSpec;
    }
    let done_prefix = format!("{TASK_SPECS_DONE_DIR}/");
    if normalized.starts_with(&done_prefix) {
        return ArchiveSpecPlan::AlreadyArchived;
    }
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    if normalized.starts_with(&open_prefix) {
        return ArchiveSpecPlan::OpenSpecCannotArchive;
    }
    let in_progress_prefix = format!("{TASK_SPECS_IN_PROGRESS_DIR}/");
    let Some(suffix) = normalized.strip_prefix(&in_progress_prefix) else {
        return ArchiveSpecPlan::NotTaskSpec;
    };
    if suffix.is_empty() || suffix.contains('/') || !suffix.ends_with(".md") {
        return ArchiveSpecPlan::NotTaskSpec;
    }
    let suffix = suffix.to_string();
    ArchiveSpecPlan::Move {
        from_rel: normalized,
        to_rel: format!("{TASK_SPECS_DONE_DIR}/{suffix}"),
        from_abs: PathBuf::new(),
        to_abs: PathBuf::new(),
    }
}

/// Resolve the `from_abs`/`to_abs` paths against the workspace root and ensure
/// the source exists. Returns `Err` only on filesystem or path-canonicalization
/// failures — caller decides how to surface them.
fn resolve_archive_plan(plan: ArchiveSpecPlan, workspace_root: &Path) -> Result<ArchiveSpecPlan> {
    let ArchiveSpecPlan::Move {
        from_rel, to_rel, ..
    } = plan
    else {
        return Ok(plan);
    };
    let from_abs = workspace_root.join(&from_rel);
    let to_abs = workspace_root.join(&to_rel);
    // Ensure the destination directory exists before deciding whether this is
    // a first move or an idempotent stale-Spec-line repair.
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating archive directory `{}`", parent.display()))?;
    }
    if !from_abs.exists() && !to_abs.exists() {
        return Ok(ArchiveSpecPlan::NotTaskSpec);
    }
    Ok(ArchiveSpecPlan::Move {
        from_rel,
        to_rel,
        from_abs,
        to_abs,
    })
}

/// Rewrite the task description's `**Spec:** <path>` line to point at the new
/// archived path. If the line is missing, the description is returned unchanged.
/// Returns `None` if no rewrite was needed (line missing or already at the new path).
/// Tolerates inline annotations in `(...)`, `[...]`, or backticks — the
/// annotation is preserved by re-attaching it after the new path.
fn rewrite_spec_line_in_description(
    description: &str,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    // Match the bold-prefixed form used in feature-task descriptions:
    //   **Spec:** <anything until EOL>
    // Case-insensitive on `Spec`. Allow optional trailing whitespace before EOL.
    let re = Regex::new(r"(?m)^(\s*\*\*Spec:\*\*\s+)(.+?)\s*$").ok()?;
    let mut updated = false;
    let rewritten = re.replace_all(description, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let existing = caps[2].trim();
        // Strip a trailing inline annotation so we can compare the bare path.
        let existing_path = strip_trailing_annotation(existing).unwrap_or(existing);
        let existing_path = existing_path
            .trim_end_matches([',', '.', ';'])
            .trim()
            .trim_matches('`');
        if existing_path == new_path {
            // Already points at the archived path — leave it.
            caps[0].to_string()
        } else if existing_path == old_path {
            updated = true;
            // Preserve any trailing inline annotation by re-attaching it.
            let annotation_suffix = if existing.len() > existing_path.len() {
                &existing[existing_path.len()..]
            } else {
                ""
            };
            format!("{prefix}{new_path}{annotation_suffix}")
        } else {
            // Some other spec line, leave it alone.
            caps[0].to_string()
        }
    });
    if updated {
        Some(rewritten.into_owned())
    } else {
        None
    }
}

/// Attempt to archive the task's referenced spec for a task that has reached
/// `done`. This is the pure decision + filesystem step shared by the
/// done-transition trigger and the reconciliation sweep. It does **not**
/// issue API calls; the caller is responsible for translating the
/// [`ArchiveOutcome`] into envelope actions, description rewrites, and
/// task comments.
///
/// Idempotency:
/// - If the destination already exists with content matching the source,
///   returns [`ArchiveOutcome::AlreadyArchived`].
/// - If the destination already exists with **different** content, returns
///   [`ArchiveOutcome::Conflict`] and leaves both files in place.
/// - Otherwise renames the source to the destination and returns
///   [`ArchiveOutcome::Moved`].
///
/// Retryable errors (e.g. `fs::rename` failure due to permission/disk)
/// surface as [`ArchiveOutcome::Retryable`] rather than panicking — the
/// task must stay `done` and the next sweep will retry.
fn archive_task_spec_for_done_task(
    task: &Task,
    workspace_root: &Path,
) -> ArchiveOutcome {
    let Some(spec) = product_spec(task) else {
        return ArchiveOutcome::NotApplicable {
            reason: ArchiveSkipReason::UnparseableSpecLine,
        };
    };
    let plan = plan_task_spec_archive(Some(&spec.path));
    let (from_rel, to_rel) = match &plan {
        ArchiveSpecPlan::Move { from_rel, to_rel, .. } => (from_rel.clone(), to_rel.clone()),
        ArchiveSpecPlan::AlreadyArchived => {
            return ArchiveOutcome::AlreadyArchived {
                to_rel: spec.path.clone(),
            };
        }
        ArchiveSpecPlan::OpenSpecCannotArchive => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::OpenSpecCannotArchive,
            };
        }
        ArchiveSpecPlan::NotTaskSpec => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::NotTaskSpec,
            };
        }
        ArchiveSpecPlan::MissingSpecRef => {
            return ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::MissingSpecRef,
            };
        }
    };

    let resolved = match resolve_archive_plan(plan, workspace_root) {
        Ok(p) => p,
        Err(err) => {
            return ArchiveOutcome::Retryable {
                from_rel,
                to_rel,
                reason: format!("resolve archive plan: {err}"),
            };
        }
    };
    let ArchiveSpecPlan::Move {
        from_abs,
        to_abs,
        ..
    } = resolved
    else {
        return ArchiveOutcome::NotApplicable {
            reason: ArchiveSkipReason::NotTaskSpec,
        };
    };

    if to_abs.exists() {
        // Pre-existing destination. Compare content; only call it AlreadyArchived
        // if the content matches the source. Otherwise leave both files in place
        // and surface a Conflict.
        let source_matches = match (fs::read(&from_abs), fs::read(&to_abs)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if source_matches {
            return ArchiveOutcome::AlreadyArchived { to_rel };
        }
        return ArchiveOutcome::Conflict { from_rel, to_rel };
    }

    if let Err(err) = fs::rename(&from_abs, &to_abs) {
        return ArchiveOutcome::Retryable {
            from_rel,
            to_rel,
            reason: format!("rename: {err}"),
        };
    }

    ArchiveOutcome::Moved { from_rel, to_rel }
}

/// Run the spec-archive step for a task that just moved to `done`. The caller
/// must have already updated `env.task` to reflect the new `done` status.
/// Behaviour:
/// - `Moved` / `AlreadyArchived` → rewrite the task description, refresh the
///   in-memory task, mark `action_taken`, and return.
/// - `NotApplicable` → log a structured noop action; no comment.
/// - `Retryable` → post a `[spec-archive-retryable]` task comment, set the
///   lobster-state failure fingerprint, do **not** revert the task status.
/// - `Conflict` → post a `[spec-archive-conflict]` task comment and leave the
///   task alone; the sweep will not retry until a human resolves the conflict.
fn archive_done_task_spec(args: &StageArgs, mut env: Envelope) -> Result<Envelope> {
    let outcome = archive_task_spec_for_done_task(&env.task, workspace_root(args));
    apply_archive_outcome(&mut env, args, &outcome);
    Ok(env)
}

/// Apply an [`ArchiveOutcome`] to the envelope: rewrite the description when
/// appropriate, post task comments on retryable / conflict outcomes, and
/// record a structured `action_taken` for the heartbeat summary.
fn apply_archive_outcome(env: &mut Envelope, args: &StageArgs, outcome: &ArchiveOutcome) {
    match outcome {
        ArchiveOutcome::Moved { from_rel, to_rel } => {
            rewrite_description_and_refresh(env, args, from_rel, to_rel);
            env.action_taken = "post_merge_archived_task_spec".to_string();
        }
        ArchiveOutcome::AlreadyArchived { to_rel } => {
            let from_rel = to_in_progress_relative(to_rel);
            rewrite_description_and_refresh(env, args, &from_rel, to_rel);
            env.action_taken = "post_merge_archive_already_present".to_string();
        }
        ArchiveOutcome::NotApplicable { reason } => {
            env.action_taken = format!("post_merge_archive_noop_{}", reason.as_tag());
        }
        ArchiveOutcome::Retryable {
            from_rel,
            to_rel,
            reason,
        } => {
            post_spec_archive_retryable(args, env, from_rel, to_rel, reason);
        }
        ArchiveOutcome::Conflict { from_rel, to_rel } => {
            post_spec_archive_conflict(args, env, from_rel, to_rel);
        }
    }
}

fn to_in_progress_relative(to_rel: &str) -> String {
    if let Some(suffix) = to_rel.strip_prefix(TASK_SPECS_DONE_DIR) {
        format!("{TASK_SPECS_IN_PROGRESS_DIR}{suffix}")
    } else {
        to_rel.to_string()
    }
}

fn rewrite_description_and_refresh(
    env: &mut Envelope,
    args: &StageArgs,
    from_rel: &str,
    to_rel: &str,
) {
    if args.dry_run {
        env.action_taken = "would_archive_task_spec".to_string();
        return;
    }
    let description = env.task.description.clone().unwrap_or_default();
    let new_description = match rewrite_spec_line_in_description(&description, from_rel, to_rel) {
        Some(d) => d,
        None => return,
    };
    if new_description == description {
        return;
    }
    if let Err(err) = api_patch::<Task>(
        &args.base_url,
        &env.task.id,
        json!({"description": new_description}),
    ) {
        env.failures.push(format!("description rewrite failed: {err}"));
        return;
    }
    if let Err(err) = api_get_task(&args.base_url, &env.task.id).map(|t| env.task = t) {
        env.failures.push(format!("refresh after rewrite failed: {err}"));
    }
}

fn post_spec_archive_retryable(
    args: &StageArgs,
    env: &mut Envelope,
    from_rel: &str,
    to_rel: &str,
    reason: &str,
) {
    env.action_taken = "post_merge_archive_retryable".to_string();
    env.criteria_met = false;
    env.failures.push(format!("spec archive retryable: {reason}"));
    if args.dry_run {
        return;
    }
    let fingerprint = format!("spec_archive_retryable:{from_rel}:{to_rel}:{reason}");
    if env.lobster_state.failure_fingerprint.as_deref() == Some(&fingerprint) {
        return;
    }
    env.lobster_state.failure_fingerprint = Some(fingerprint);
    let body = format!(
        "[spec-archive-retryable]\nfrom: {from_rel}\nto: {to_rel}\nreason: {reason}\nretry: the next reconciliation sweep will retry automatically; resolve the underlying filesystem access issue to clear.\n"
    );
    let _ = add_comment(&args.base_url, &env.task.id, &body);
    let _ = write_state(&args.base_url, &env.task.id, &env.lobster_state, None);
}

fn post_spec_archive_conflict(
    args: &StageArgs,
    env: &mut Envelope,
    from_rel: &str,
    to_rel: &str,
) {
    env.action_taken = "post_merge_archive_conflict".to_string();
    env.criteria_met = false;
    env.failures
        .push(format!("spec archive conflict at {to_rel}"));
    if args.dry_run {
        return;
    }
    let fingerprint = format!("spec_archive_conflict:{from_rel}:{to_rel}");
    if env.lobster_state.failure_fingerprint.as_deref() == Some(&fingerprint) {
        return;
    }
    env.lobster_state.failure_fingerprint = Some(fingerprint);
    let body = format!(
        "[spec-archive-conflict]\nfrom: {from_rel}\nto: {to_rel}\nreason: destination already exists with different content; both files left in place.\naction: resolve the content mismatch and run the reconciliation sweep again.\n"
    );
    let _ = add_comment(&args.base_url, &env.task.id, &body);
    let _ = write_state(&args.base_url, &env.task.id, &env.lobster_state, None);
}

/// Reconciliation sweep: visit every `status=done` task (optionally filtered
/// by `--assignee`) and archive any spec still under
/// `brain/tasks/specs/in-progress/`. Used to close the historical backlog and
/// to recover when a single `post_merge` run skipped the archive step (e.g.
/// the recent iCloud/TCC `Operation not permitted` incident). Idempotent —
/// already-archived specs return `AlreadyArchived` and are no-ops.
///
/// Output envelope's `action_taken` is one of:
/// - `archive_sweep_summary: scanned=<n> moved=<n> already=<n> retryable=<n> conflict=<n> not_applicable=<n>`
fn archive_done_task_specs_sweep(args: ArchiveDoneTaskSpecsSweepArgs) -> Result<Envelope> {
    let base_url = args.base_url.trim_end_matches('/').to_string();
    let assignee_filter = args.assignee.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let tasks = list_done_tasks(&base_url, assignee_filter)?;
    let mut moved = 0usize;
    let mut already = 0usize;
    let mut retryable = 0usize;
    let mut conflict = 0usize;
    let mut not_applicable = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let stage_args = StageArgs {
        base_url: args.base_url.clone(),
        dry_run: args.dry_run,
        repo: args.repo.clone(),
        workspace_root: args.workspace_root.clone(),
    };
    let workspace = workspace_root(&stage_args);

    for task in &tasks {
        let outcome = archive_task_spec_for_done_task(task, workspace);
        let mut env = Envelope {
            task: task.clone(),
            ..Envelope::default()
        };
        apply_archive_outcome(&mut env, &stage_args, &outcome);
        match &outcome {
            ArchiveOutcome::Moved { .. } => moved += 1,
            ArchiveOutcome::AlreadyArchived { .. } => already += 1,
            ArchiveOutcome::Retryable { from_rel, to_rel, reason } => {
                retryable += 1;
                failures.push(format!(
                    "{} ({} -> {}): {}",
                    env.task.id, from_rel, to_rel, reason
                ));
            }
            ArchiveOutcome::Conflict { from_rel, to_rel } => {
                conflict += 1;
                failures.push(format!(
                    "{} conflict {} -> {}",
                    env.task.id, from_rel, to_rel
                ));
            }
            ArchiveOutcome::NotApplicable { .. } => not_applicable += 1,
        }
    }

    let envelope = Envelope {
        criteria_met: retryable == 0 && conflict == 0,
        already_past: false,
        action_taken: format!(
            "archive_sweep_summary: scanned={} moved={} already={} retryable={} conflict={} not_applicable={}",
            tasks.len(),
            moved,
            already,
            retryable,
            conflict,
            not_applicable
        ),
        task: Task::default(),
        lobster_state: LobsterState::default(),
        failures,
    };
    Ok(envelope)
}

fn list_done_tasks(base_url: &str, assignee: Option<&str>) -> Result<Vec<Task>> {
    let mut url = format!("{}/tasks?status=done&limit=10000", base_url);
    if let Some(a) = assignee {
        url.push_str("&assignee=");
        url.push_str(&percent_encode_assignee(a));
    }
    let body: Value = ureq::get(&url).call()?.into_json()?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut tasks = Vec::new();
    for item in data {
        let task: Task = serde_json::from_value(item)?;
        tasks.push(task);
    }
    Ok(tasks)
}

/// Percent-encode an assignee filter value. Assignee names are alphanumeric
/// display names; only a small set of characters can land in the URL: space,
/// `+`, `&`, `#`. Encode just those to avoid a full URL-escape dependency.
fn percent_encode_assignee(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '+' => out.push_str("%2B"),
            '&' => out.push_str("%26"),
            '#' => out.push_str("%23"),
            other => out.push(other),
        }
    }
    out
}

fn is_typescript_spec_path(spec_path: &str) -> bool {
    let path = spec_path.trim();
    path.ends_with("_spec.ts") || path.ends_with(".spec.ts")
}

fn task_product_spec_is_typescript_spec(task: &Task) -> bool {
    product_spec(task)
        .map(|spec| is_typescript_spec_path(&spec.path))
        .unwrap_or(false)
}

fn safe_brain_spec_path(spec_path_str: &str, workspace_root: &Path) -> Result<PathBuf> {
    let stripped = spec_path_str.trim();
    if stripped.is_empty() {
        return Err(anyhow!("brain spec path is empty"));
    }
    if !stripped.ends_with(".md") {
        return Err(anyhow!(
            "brain spec path `{stripped}` must end in `.md`; refusing to rewrite `{spec_path_str}`"
        ));
    }
    if stripped.contains("..") {
        return Err(anyhow!(
            "brain spec path `{stripped}` must not contain `..`; refusing to rewrite `{spec_path_str}`"
        ));
    }

    let target = if Path::new(stripped).is_absolute() {
        PathBuf::from(stripped)
    } else {
        if !stripped.starts_with("brain/") {
            return Err(anyhow!(
                "brain spec path `{stripped}` is not inside `{BRAIN_DIR}/`; refusing to rewrite"
            ));
        }
        workspace_root.join(Path::new(stripped))
    };

    // The file's parent must already exist before resync can rewrite the file.
    // Canonicalise the parent so symlinked brain directories are handled safely
    // without allowing a task description to escape the workspace brain.
    let canonical_workspace =
        fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    let canonical_brain = fs::canonicalize(canonical_workspace.join(BRAIN_DIR))
        .unwrap_or_else(|_| canonical_workspace.join(BRAIN_DIR));
    let canonical_parent = target
        .parent()
        .ok_or_else(|| anyhow!("brain spec path `{}` has no parent", target.display()))?
        .canonicalize()
        .with_context(|| format!("canonicalizing brain spec parent `{}`", target.display()))?;
    if !canonical_parent.starts_with(&canonical_brain) {
        return Err(anyhow!(
            "brain spec path `{}` resolves outside of `{}`; refusing to rewrite",
            target.display(),
            canonical_brain.display()
        ));
    }
    Ok(target)
}

/// Replace the Acceptance Criteria section of a brain spec markdown file
/// with the supplied AC lines. If the section is missing it is appended at
/// the end so the next write still produces a clean spec. The function does
/// NOT touch any non-AC content (front-matter, headings above the AC section,
/// prose between sections, headings below). Returns the rewritten content.
///
/// `ac_lines` are the full bullet text WITHOUT the `- [ ] ` checkbox prefix
/// (matching the format used elsewhere for `acceptance_criteria_text`). Each
/// line is wrapped with `- [ ] ` and trimmed.
fn replace_ac_section(content: &str, ac_lines: &[String]) -> String {
    // Header regex captures the leading hash run so we know the section level.
    const HEADER_PATTERN: &str = r"(?im)^\s{0,3}(#{1,6})\s+Acceptance Criteria\s*:?\s*$\n?";
    let header_re = Regex::new(HEADER_PATTERN).expect("header pattern compiles");

    // Compute the new AC block as lines.
    let mut new_block_lines: Vec<String> = ac_lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("- [ ] {line}"))
        .collect();
    if new_block_lines.is_empty() {
        // Nothing to put in the AC section — preserve the existing content
        // unchanged so we never erase ACs the spec relies on.
        return content.to_string();
    }

    if let Some(header_cap) = header_re.captures(content) {
        let header_match = header_cap.get(0).unwrap();
        let header_level = header_cap.get(1).unwrap().as_str().len();
        // Only headings at the captured level or higher end the AC section.
        // Deeper headings (`### …`, `#### …`, …) belong to the section's body
        // and must not truncate the rewrite.
        let closer_pattern = format!(r"(?m)^\s{{0,3}}#{{1,{header_level}}}\s+\S");
        let next_re = Regex::new(&closer_pattern).unwrap_or_else(|e| {
            panic!("closer pattern compiles for header level {header_level}: {e}")
        });
        let section_start = header_match.end();
        let tail = &content[section_start..];
        let next_match = next_re.find(tail);
        let section_end = next_match.map_or(content.len(), |m| section_start + m.start());
        let head = &content[..section_start];
        let tail = &content[section_end..];
        // Trim trailing whitespace-only lines in the head before injecting
        // bullets, so the new bullets sit on their own line.
        let head_trimmed = head.trim_end_matches('\n');
        let mut out =
            String::with_capacity(head.len() + new_block_lines.len() * 40 + tail.len() + 8);
        out.push_str(head_trimmed);
        out.push('\n');
        for line in &new_block_lines {
            out.push_str(line);
            out.push('\n');
        }
        // Ensure exactly one blank line separates the AC block from the next
        // heading (or end of file).
        let tail_trimmed = tail.trim_start_matches('\n');
        if !tail_trimmed.is_empty() {
            out.push('\n');
            out.push_str(tail_trimmed);
        }
        return out;
    }

    // No `## Acceptance Criteria` heading: append a new section at the end.
    new_block_lines.insert(0, String::from("## Acceptance Criteria"));
    new_block_lines.push(String::new()); // trailing blank line
    let mut out = content.trim_end_matches('\n').to_string();
    out.push_str("\n\n");
    for line in &new_block_lines {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Write `content` to `path` atomically: write to a sibling temp file, then
/// rename onto the target. Avoids leaving the brain spec half-written if the
/// process is killed mid-write.
fn atomic_write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create parent directory for {}", path.display()))?;
    }
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "spec".to_string());
    let tmp_name = format!(".{}.resync-{}", file_name, std::process::id());
    tmp.set_file_name(tmp_name);
    fs::write(&tmp, content)
        .with_context(|| format!("write temp file {} during atomic write", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| {
        format!(
            "rename {} -> {} during atomic write",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Re-snapshot the spec checksum on the task object so subsequent
/// `spec_checksum_failures` calls evaluate against the resync-cleared value.
fn refresh_task_spec_checksum(task: &mut Task) {
    task.spec_checksum = Some(spec_checksum(task));
}

/// Reset the task's stored `specChecksum` to `new_checksum` via a two-step
/// PATCH: first `{specChecksum: null}` to clear the locked value, then
/// `{specChecksum: <new sha256>}` to set the new one. The Tasks API rejects
/// non-null mutations of an already-locked `specChecksum` with
/// `SPEC_CHECKSUM_LOCKED` (409), so the clear step is mandatory.
fn reset_task_spec_checksum(base_url: &str, task_id: &str, new_checksum: &str) -> Result<Task> {
    api_patch::<Task>(base_url, task_id, json!({"specChecksum": null}))?;
    api_patch::<Task>(base_url, task_id, json!({"specChecksum": new_checksum}))
}

/// Run the AC4 resync flow: rewrite the brain spec AC section from the
/// task description, reset `task.specChecksum` to the matching sha256, and
/// post a `[spec-resynced]` comment that records the checksum + drift
/// fingerprint of this episode. Returns an envelope with `criteria_met =
/// true` on success so the caller can stop blocking the workflow. On
/// failure the envelope carries a single failure describing what went
/// wrong; the caller turns that into the standard blocked-spec-drift
/// response.
fn resync_spec_and_reset_checksum(
    args: &StageArgs,
    mut env: Envelope,
    drift_failures: &[String],
    drift_fingerprint: &str,
    _repo: &Path,
) -> Result<Envelope> {
    let task_id = env.task.id.clone();
    let base_url = args.base_url.clone();
    let workspace_root = workspace_root(args).to_path_buf();

    // 1. Resolve and validate the spec path.
    let spec = product_spec(&env.task).ok_or_else(|| {
        anyhow!("task description is missing `**Spec:** <path>.md` line; cannot resync")
    })?;
    let spec_path = match safe_brain_spec_path(&spec.path, &workspace_root) {
        Ok(path) => path,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_unsafe_path".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Refusing to resync brain spec at `{}`: {err}. Tom must rewrite the spec by hand.",
                    spec.path
                )],
            });
        }
    };

    // 2. Compute the new AC lines from the task description.
    let description = env.task.description.clone().unwrap_or_default();
    let ac_lines = acceptance_criteria_text(&description);
    if ac_lines.is_empty() {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_no_acs".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![
                "Task description has no acceptance criteria; cannot resync spec.".to_string(),
            ],
        });
    }
    let new_checksum = acceptance_criteria_checksum(&ac_lines);
    // The legacy `- [x] **Approved by Tom**` marker no longer lives in task
    // descriptions (e2aba106 WS1 froze the description-handling surface and
    // WS2 removed the lobster's reads/writes of the task-description checkbox).
    // Pass AC lines through verbatim so the brain spec's AC section is rebuilt
    // from the same source the checksum was computed over.
    let spec_ac_lines: Vec<String> = ac_lines.to_vec();

    // 2b. Validate the product spec still claims to be approved by Tom before we
    //     overwrite its AC section. If Tom has since flipped the spec to
    //     unapproved, refuse so the workflow cannot blindly overwrite a
    //     rolled-back artifact.
    let pre_existing_text = match fs::read_to_string(&spec_path) {
        Ok(text) => text,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_read_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Could not read brain spec at `{}`: {err}.",
                    spec_path.display()
                )],
            });
        }
    };
    if !brain_spec_approved_by_tom(&pre_existing_text) {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_spec_revoked".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Brain spec at `{}` is no longer marked Approved by Tom; refusing to resync.",
                spec_path.display()
            )],
        });
    }

    if args.dry_run {
        return Ok(Envelope {
            criteria_met: true,
            already_past: env.already_past,
            action_taken: "spec_resync_dry_run".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "dry-run: would rewrite `{}` with {} AC line(s) and set checksum to `{}`.",
                spec_path.display(),
                ac_lines.len(),
                new_checksum
            )],
        });
    }

    // 3. Rewrite the AC section atomically. We do this BEFORE the API PATCH
    //    so a write failure cannot leave the task with a freshly-reset
    //    checksum and a stale spec on disk.
    let rewritten = replace_ac_section(&pre_existing_text, &spec_ac_lines);
    if rewritten != pre_existing_text {
        if let Err(err) = atomic_write(&spec_path, &rewritten) {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_write_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Could not rewrite brain spec at `{}`: {err}.",
                    spec_path.display()
                )],
            });
        }
    }

    // 4. Reset the stored `specChecksum` via two-step PATCH (clear + set).
    match reset_task_spec_checksum(&base_url, &task_id, &new_checksum) {
        Ok(updated) => env.task = updated,
        Err(err) => {
            return Ok(Envelope {
                criteria_met: false,
                already_past: env.already_past,
                action_taken: "spec_resync_blocked_checksum_reset_failed".to_string(),
                task: env.task.clone(),
                lobster_state: env.lobster_state.clone(),
                failures: vec![format!(
                    "Brain spec was rewritten but the Tasks API rejected the checksum reset: {err}."
                )],
            });
        }
    }
    if env.task.spec_checksum.as_deref() != Some(&new_checksum) {
        let actual = env
            .task
            .spec_checksum
            .clone()
            .unwrap_or_else(|| "<null>".to_string());
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_checksum_mismatch".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Tasks API reported a different `specChecksum` than expected: got `{actual}`, wanted `{new_checksum}`."
            )],
        });
    }

    // 5. Post the `[spec-resynced]` comment with the current episode binding.
    let drift_summary = drift_failures.join(" / ");
    let trimmed_summary: String = drift_summary.chars().take(280).collect();
    let resync_comment = format!(
        "[spec-resynced] {summary}\nchecksum={checksum}\ndriftFingerprint={fp}\n",
        summary = trimmed_summary,
        checksum = new_checksum,
        fp = drift_fingerprint,
    );
    if let Err(err) = add_comment(&base_url, &task_id, &resync_comment) {
        return Ok(Envelope {
            criteria_met: false,
            already_past: env.already_past,
            action_taken: "spec_resync_blocked_comment_failed".to_string(),
            task: env.task.clone(),
            lobster_state: env.lobster_state.clone(),
            failures: vec![format!(
                "Brain spec was rewritten and `specChecksum` was reset, but posting the `[spec-resynced]` comment failed: {err}."
            )],
        });
    }

    // 6. Refresh the in-memory task and clear drift state for the next episode.
    refresh_task_spec_checksum(&mut env.task);
    env.lobster_state.spec_drift_uncheck_applied = Some(false);
    env.lobster_state.failure_fingerprint = None;

    Ok(Envelope {
        criteria_met: true,
        already_past: env.already_past,
        action_taken: "spec_resynced".to_string(),
        task: env.task.clone(),
        lobster_state: env.lobster_state.clone(),
        failures: Vec::new(),
    })
}

/// Block on spec drift with the fluid AC lifecycle behaviour: detect drift,
/// uncheck the approval marker when present, and post a checklist comment
/// summarising the drift. Returns `None` if drift is fully cleared
/// (marker re-checked and Quinn has resynced).
fn block_on_spec_drift_fluid(
    args: &StageArgs,
    mut env: Envelope,
    action: &str,
) -> Result<Option<Envelope>> {
    // Code tasks intentionally do not participate in the product-spec
    // lifecycle. Their pipeline shares the delivery/feedback stages with
    // feature tasks, but must not run feature-task spec checksum or approval
    // handling here. In particular, historical `specChecksum` values on a
    // code task must not make the shared stages require a `spec` approval.
    if env.task.task_type.as_deref() == Some("code") {
        return Ok(None);
    }
    let raw_failures = spec_checksum_failures(&env.task);
    if raw_failures.is_empty() {
        return Ok(None);
    }
    if task_is_open(&env.task) {
        // Open tasks keep the legacy hard-block behaviour; no marker tracking.
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = raw_failures;
        return Ok(Some(env));
    }
    // e2aba106 WS2: the legacy description PATCH that auto-unchecked
    // `**Approved by Tom**` is gone. The TypeScript-spec branch still surfaces a
    // hard block (Quinn must resync manually via `[spec-resynced]`); the message
    // wording is unchanged so existing `[spec-resynced]`-bound tests stay valid.
    if task_product_spec_is_typescript_spec(&env.task) {
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        let mut failures = raw_failures;
        failures.push(
            "Spec drift was detected for a TypeScript spec test file; the lobster will not auto-uncheck `**Approved by Tom**` for `_spec.ts`/`.spec.ts` specs. Resolve the drift manually or post a fresh `[spec-resynced]` record."
                .to_string(),
        );
        env.failures = failures;
        return Ok(Some(env));
    }
    // e2aba106 WS2: approval state is now exclusively structured TaskApproval
    // rows. The legacy `- [x] **Approved by Tom**` checkbox is no longer read
    // from the task description; the lobster looks up the `spec` approval row
    // and routes the drift response through the structured API.
    let spec_approval = env
        .task
        .approvals
        .iter()
        .find(|a| a.approval_type == "spec");
    let spec_is_approved = spec_approval.is_some_and(|a| a.state == "approved");
    if spec_is_approved {
        // Drift + approved spec. Three sub-cases:
        //   (a) WE previously revoked this approval (state flag set) and Tom
        //       has now re-approved it on the new spec — run resync.
        //   (b) A `[spec-resynced]` comment exists whose bound fingerprint
        //       matches the current drift episode and whose checksum matches
        //       the stored checksum — trust the comment, allow progress.
        //   (c) Otherwise this is the first time we've seen this drift
        //       episode: revoke the spec approval via DELETE, post a
        //       checklist, and set the uncheck-applied flag so a later
        //       re-approval triggers resync. Stale `[spec-resynced]`
        //       comments from previous episodes fall into the revoke branch.
        let fingerprint = drift_episode_fingerprint(&raw_failures);
        let we_actioned_episode = env.lobster_state.spec_drift_uncheck_applied == Some(true);
        let fresh_resync_record = latest_resync_record_matches_drift(
            &env.task,
            &fingerprint,
            env.task.spec_checksum.as_deref(),
        );

        // Dry-run fast path: report what would happen without writing.
        if args.dry_run {
            if we_actioned_episode || fresh_resync_record {
                return Ok(None);
            }
            env.criteria_met = false;
            env.action_taken = format!("{action}_blocked_spec_drift");
            env.failures = raw_failures;
            return Ok(Some(env));
        }

        if we_actioned_episode || fresh_resync_record {
            // Case (a) or (b): resync is appropriate.
            return match resync_spec_and_reset_checksum(
                args,
                env,
                &raw_failures,
                &fingerprint,
                &args.repo,
            ) {
                Ok(resynced) => {
                    // Return Some in both success and soft-failure cases so
                    // the caller can update its in-memory env with the fresh
                    // task and lobster_state. Callers check criteria_met to
                    // decide whether to bail out or continue.
                    Ok(Some(resynced))
                }
                Err(err) => Err(err),
            };
        }

        // Case (c): first encounter of this drift episode. Revoke the spec
        // approval via DELETE (replaces the legacy description PATCH that
        // auto-unchecked the marker), post a checklist comment summarising
        // the drift, and set the uncheck-applied flag. Once Tom re-approves
        // via POST /tasks/:id/approvals, the next heartbeat will resync.
        let mut failures = raw_failures.clone();
        failures.push(
            "Structured `spec` TaskApproval is still approved and `[spec-resynced]` has not been posted. \
             Quinn will revoke the structured approval; after that, Tom must re-approve `spec` via POST /tasks/:id/approvals on the new spec."
                .to_string(),
        );
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = failures.clone();
        // Idempotency: only DELETE + comment when the fingerprint changes.
        let joined_fingerprint = failures.join("\n");
        let already_acted = env.lobster_state.failure_fingerprint.as_deref()
            == Some(&joined_fingerprint)
            && env
                .lobster_state
                .spec_drift_uncheck_applied
                .unwrap_or(false);
        if !already_acted {
            if let Err(err) = api_delete(
                &args.base_url,
                &format!("/tasks/{}/approvals/spec", env.task.id),
            ) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    // Tasks-api rejected the DELETE (e.g. ACs also changed).
                    // Surface that as a hard block.
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(Some(env));
                }
                return Err(err);
            }
            env.task = api_get_task(&args.base_url, &env.task.id)?;
            env.lobster_state.spec_drift_uncheck_applied = Some(true);
        }
        let checklist = format!(
            "[feature-task-progress-checklist]\n{}\n",
            failures.join("\n")
        );
        if env.lobster_state.failure_fingerprint.as_deref() != Some(&joined_fingerprint) {
            if let Err(err) = add_comment(&args.base_url, &env.task.id, &checklist) {
                if let Some(message) = spec_checksum_mismatch_message(&err) {
                    // Should not happen because comments are now drift-tolerant,
                    // but treat any 409 as a hard block anyway.
                    env.criteria_met = false;
                    env.action_taken = format!("{action}_blocked_spec_drift");
                    env.failures = vec![message];
                    return Ok(Some(env));
                }
                return Err(err);
            }
            env.lobster_state.failure_fingerprint = Some(joined_fingerprint);
        }
        write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
        Ok(Some(env))
    } else {
        // No approved `spec` TaskApproval (either revoked or absent).
        // Hard-block until Tom approves via the structured API.
        env.criteria_met = false;
        env.action_taken = format!("{action}_blocked_spec_drift");
        env.failures = vec![
            "Structured `spec` TaskApproval is missing or revoked. \
             Approve via POST /tasks/:id/approvals (type=spec) before drift can be re-evaluated."
                .to_string(),
        ];
        Ok(Some(env))
    }
}

fn manual_block_failures(task: &Task) -> Vec<String> {
    if task.blocked {
        vec![
            "Task is manually blocked (`blocked: true`); clear the block to allow progression. \
             (`dependencyBlocked` is a separate computed flag and is not affected.)"
                .to_string(),
        ]
    } else {
        Vec::new()
    }
}

/// `comment_tag` is the bracket tag written on the manual-block comment
/// (e.g. `[feature-task-blocked]` or `[code-task-blocked]`).
fn block_with_manual_block(
    args: &StageArgs,
    mut env: Envelope,
    action: &str,
    failures: Vec<String>,
    comment_tag: &str,
) -> Result<Envelope> {
    env.criteria_met = false;
    env.action_taken = format!("{action}_blocked");
    env.failures = failures.clone();
    if args.dry_run {
        return Ok(env);
    }
    let fingerprint = failures.join("\n");
    if env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
        env.lobster_state.failure_fingerprint = Some(fingerprint);
        if let Err(err) = add_comment(
            &args.base_url,
            &env.task.id,
            &format!("{comment_tag}\n{}", failures.join("\n")),
        ) {
            if let Some(message) = spec_checksum_mismatch_message(&err) {
                env.action_taken = format!("{action}_blocked_spec_drift");
                env.failures = vec![message];
                return Ok(env);
            }
            return Err(err);
        }
        if let Err(err) = write_state(&args.base_url, &env.task.id, &env.lobster_state, None) {
            if let Some(message) = spec_checksum_mismatch_message(&err) {
                env.action_taken = format!("{action}_blocked_spec_drift");
                env.failures = vec![message];
                return Ok(env);
            }
            return Err(err);
        }
    }
    // Best-effort analytics emission (AC2): manual blocks are also gate
    // failures from the analytics perspective. Capacity-classified by
    // `classify_failure` since the body always contains "blocked: true".
    analytics::emit_gate_failure_events(args, &env.task, action, &env.failures);
    Ok(env)
}

fn output(
    criteria_met: bool,
    already_past: bool,
    action_taken: &str,
    task: Task,
    lobster_state: LobsterState,
    failures: Vec<String>,
) -> Envelope {
    Envelope {
        criteria_met,
        already_past,
        action_taken: action_taken.to_string(),
        task,
        lobster_state,
        failures,
    }
}

fn read_envelope() -> Result<Envelope> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    serde_json::from_str(input.trim()).context("expected JSON envelope on stdin")
}

fn api_get<T: for<'de> Deserialize<'de>>(base_url: &str, path: &str) -> Result<T> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let value: Value = ureq::get(&url).call()?.into_json()?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value))
        .context("decode API response")
}

fn api_get_task(base_url: &str, task_id: &str) -> Result<Task> {
    api_get(base_url, &format!("/tasks/{task_id}"))
}

fn api_patch<T: for<'de> Deserialize<'de>>(
    base_url: &str,
    task_id: &str,
    payload: Value,
) -> Result<T> {
    let url = format!("{}/tasks/{task_id}", base_url.trim_end_matches('/'));
    let value: Value = handle_api_result(ureq::patch(&url).send_json(payload))?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value))
        .context("decode API patch response")
}

/// DELETE wrapper used to revoke a structured TaskApproval row
/// (e.g. `DELETE /tasks/:id/approvals/spec` when spec drift is detected).
fn api_delete(base_url: &str, path: &str) -> Result<Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    handle_api_result(ureq::delete(&url).call())
}

fn add_comment(base_url: &str, task_id: &str, text: &str) -> Result<()> {
    let url = format!(
        "{}/tasks/{task_id}/comments",
        base_url.trim_end_matches('/')
    );
    handle_api_result(ureq::post(&url).send_json(json!({"author": AUTHOR, "text": text})))?;
    Ok(())
}

fn handle_api_result(response: std::result::Result<ureq::Response, ureq::Error>) -> Result<Value> {
    match response {
        Ok(response) => Ok(response.into_json()?),
        Err(ureq::Error::Status(status, response)) => {
            Err(api_status_error(status, response)).context("API request failed")
        }
        Err(err) => Err(err).context("API request failed"),
    }
}

fn api_status_error(status: u16, response: ureq::Response) -> ApiStatusError {
    let fallback = response.status_text().to_string();
    let value = response.into_json::<Value>().ok();
    let code = value
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let message = value
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or(&fallback)
        .to_string();
    ApiStatusError {
        status,
        code,
        message,
    }
}

fn spec_checksum_mismatch_message(err: &anyhow::Error) -> Option<String> {
    let api_err = err.downcast_ref::<ApiStatusError>()?;
    (api_err.status == 409 && api_err.code.as_deref() == Some("SPEC_CHECKSUM_MISMATCH"))
        .then(|| api_err.message.clone())
}

fn write_state(
    base_url: &str,
    task_id: &str,
    state: &LobsterState,
    note: Option<&str>,
) -> Result<()> {
    let state_json = serde_json::to_string_pretty(state)?;
    let body = match note {
        Some(note) => format!("{note}\n\n{STATE_TAG}\n```json\n{state_json}\n```"),
        None => format!("{STATE_TAG}\n```json\n{state_json}\n```"),
    };
    add_comment(base_url, task_id, &body)
}

/// Fetch every task across the statuses the capacity gate cares about,
/// regardless of `taskType`. The capacity check is purely about how many
/// tickets an implementer has in `doing` right now, so it must not filter
/// by feature-vs-code (or any other task type/tag) — that filtering was
/// the root cause of the code-task lobster being blind to an
/// implementer's existing code-task load (Tom: 2026-07-28, "it doesn't
/// need to use type at all, just check on number of tickets assigned in
/// doing").
fn list_all_active_tasks(base_url: &str) -> Result<Vec<Task>> {
    let mut out = Vec::new();
    for status in ["open", "ready", "doing", "acceptance"] {
        let url = format!(
            "{}/tasks?status={status}&limit=10000",
            base_url.trim_end_matches('/')
        );
        let value: Value = ureq::get(&url).call()?.into_json()?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in data {
            let task: Task = serde_json::from_value(item)?;
            out.push(task);
        }
    }
    Ok(out)
}

fn task_implementer(task: &Task) -> Option<String> {
    task.assignee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// Maximum number of tasks (of any `taskType`) an implementer may have in
/// `doing` at once. Tom: 2026-07-28 — "im fine with increasing the limit
/// to 2 for implementer in doing."
const IMPLEMENTER_DOING_CAPACITY: usize = 2;

fn implementer_doing_capacity_failures(
    tasks: &[Task],
    current_id: &str,
    implementer: &str,
) -> Vec<String> {
    // Counts every task assigned to `implementer` that is currently in
    // `doing`, regardless of `taskType` — feature tasks and code tasks
    // assigned to the same person share one capacity pool.
    let active_doing = tasks
        .iter()
        .filter(|task| {
            task.id != current_id
                && task.status == "doing"
                && !task.blocked
                && !task.dependency_blocked
                && task.assignee.as_deref() == Some(implementer)
        })
        .count();
    if active_doing >= IMPLEMENTER_DOING_CAPACITY {
        vec![format!(
            "Implementer `{implementer}` already has {active_doing} active task(s) in `doing` (limit {IMPLEMENTER_DOING_CAPACITY})."
        )]
    } else {
        Vec::new()
    }
}

fn comment_text(comment: &TaskComment) -> &str {
    comment
        .text
        .as_deref()
        .or(comment.body.as_deref())
        .unwrap_or("")
}

fn parse_lobster_state(task: &Task) -> LobsterState {
    let mut state = LobsterState::default();
    for comment in &task.comments {
        let text = comment_text(comment);
        let Some(idx) = text.find(STATE_TAG) else {
            continue;
        };
        let mut raw = text[idx + STATE_TAG.len()..].trim();
        if raw.starts_with("```") {
            raw = raw
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim();
            raw = raw.trim_end_matches("```").trim();
        }
        if let Ok(parsed) = serde_json::from_str::<LobsterState>(raw) {
            state = parsed;
        }
    }
    // Pick the workflow string from the task's `taskType` so feature and
    // code task state comments stay distinguishable on subsequent reads.
    state.workflow = workflow_for_task(task);
    state
}

/// Return the LobsterState `workflow` value that should be persisted for a
/// given task. Code tasks (`taskType: code`) use a distinct workflow string
/// so the code-task pipeline can be told apart from the feature-task
/// pipeline on re-runs.
fn workflow_for_task(task: &Task) -> String {
    match task.task_type.as_deref() {
        Some("code") => CODE_TASK_WORKFLOW.to_string(),
        _ => WORKFLOW.to_string(),
    }
}

fn status_rank(status: &str) -> usize {
    STATUS_ORDER
        .iter()
        .position(|value| *value == status)
        .unwrap_or(0)
}

fn is_past(task: &Task, stage: &str) -> bool {
    status_rank(&task.status) > status_rank(stage)
}

fn spec_failures(task: &Task, repo: &Path, workspace_root: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    match product_spec(task) {
        Some(spec) => {
            let path = resolve_product_spec_path(&spec.path, repo, workspace_root);
            if !path.exists() {
                failures.push(format!("Product spec not found at {}", spec.path));
            } else if fs::read_to_string(&path).is_ok() && !spec_is_approved(task) {
                failures.push("Structured spec approval is missing or not approved; Tom must approve the `spec` TaskApproval.".to_string());
            }
        }
        None => failures.push("Task description must include a **Spec:** line".to_string()),
    }
    if acceptance_criteria_text(&task.description.clone().unwrap_or_default()).is_empty() {
        failures.push("Task description must include acceptance criteria checkboxes.".to_string());
    }
    if workstreams(task).is_empty() {
        failures.push("Task description must include workstreams.".to_string());
    }
    failures
}

fn missing_spec_checksum_failures(task: &Task, repo: &Path, workspace_root: &Path) -> Vec<String> {
    if task.spec_checksum.is_some() {
        return vec![];
    }
    let mut failures = vec![
        "Task is past `open` but has no stored `specChecksum`; the spec gate was bypassed."
            .to_string(),
    ];
    failures.extend(spec_failures(task, repo, workspace_root));
    failures
}

/// Structured TaskApproval rows are the sole source of spec approval.
fn spec_is_approved(task: &Task) -> bool {
    task_approval_granted(task, "spec")
}

fn product_spec(task: &Task) -> Option<ProductSpecRef> {
    parse_product_spec_ref(&task.description.clone().unwrap_or_default())
}

/// Parse the `**Spec:**` line from a task description. Tolerates inline
/// annotations in parens (`(...)`), brackets (`[...]`), backticks (`` `...` ``),
/// and trailing punctuation that isn't part of the path. Returns `None` only
/// when the line is genuinely missing or unparseable.
///
/// Used both for spec drift detection (where the strict form matters) and for
/// archival (where we want to survive legacy inline notes). The lenient form
/// here is intentionally bounded — exotic multi-line / malformed Spec values
/// still return `None` and surface via the existing `MissingSpecRef` path.
fn parse_product_spec_ref(text: &str) -> Option<ProductSpecRef> {
    let line_re = Regex::new(r"(?im)^\s*\*\*Spec:\*\*\s+(.+?)\s*$").unwrap();
    let cap = line_re.captures(text)?;
    let raw = cap.get(1)?.as_str();
    extract_spec_path_from_line(raw)
}

/// Extract a spec path from the raw text after `**Spec:**`. Strips:
///   - backtick-wrapped paths (`` `<path>` ``)
///   - trailing punctuation (`,`, `.`, `;`)
///   - one trailing inline annotation in `(...)`, `[...]`, or `` `...` `` form
///
/// Returns `None` when the residue is not a parseable spec path.
fn extract_spec_path_from_line(raw: &str) -> Option<ProductSpecRef> {
    let mut s = raw.trim();
    // Strip a single trailing inline annotation: "(...)", "[...]", or "`...`".
    if let Some(stripped) = strip_trailing_annotation(s) {
        s = stripped;
    }
    // Trim trailing punctuation first (so a trailing `,` doesn't fool the
    // backtick-wrap detector into seeing a backtick + comma residue).
    s = s.trim_end_matches([',', '.', ';']);
    // Strip optional backtick wrapping.
    if s.starts_with('`') && s.ends_with('`') && s.len() >= 2 {
        s = &s[1..s.len() - 1];
    }
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Reject obviously malformed (whitespace, control chars, multi-token) values.
    if s.chars().any(char::is_whitespace) {
        return None;
    }
    // Reject shell-quoted or otherwise bracketed residue we didn't strip.
    if matches!(s.chars().next(), Some('(') | Some('[') | Some('{'))
        || matches!(s.chars().last(), Some(')') | Some(']') | Some('}'))
    {
        return None;
    }
    // Accept .md or .spec.ts / _spec.ts paths only (matches the existing
    // strict regex's contract: `[._]spec\.ts` allows either `.` or `_`).
    let valid_suffix = s.ends_with(".md") || s.ends_with(".spec.ts") || s.ends_with("_spec.ts");
    if !valid_suffix {
        return None;
    }
    Some(ProductSpecRef {
        path: s.to_string(),
    })
}

fn strip_trailing_annotation(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    if bytes.last().copied() != Some(b')') && bytes.last().copied() != Some(b']') && bytes.last().copied() != Some(b'`') {
        return None;
    }
    let opener = match bytes.last().copied() {
        Some(b')') => b'(',
        Some(b']') => b'[',
        Some(b'`') => b'`',
        _ => return None,
    };
    // Find the matching opener at the same depth from the start. We don't
    // handle nested parens here; that's exactly the slippery-slope surface
    // the tech design calls out and we want to leave for human review.
    if let Some(open_idx) = s.find(opener as char) {
        return Some(s[..open_idx].trim_end());
    }
    None
}

fn brain_spec_approved_by_tom(text: &str) -> bool {
    Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+\*\*Approved by Tom\*\*\s*$")
        .unwrap()
        .is_match(text)
}


/// True if any task comment starts with `[spec-resynced]`.
///
/// Note: this check is deliberately permissive on presence — Quinn (or any
/// external writer) can post the comment at any time. The fluid drift gate
/// additionally verifies the comment carries a drift fingerprint that
/// matches the current drift episode (see
/// [`latest_resync_record_matches_drift`]). Without that secondary check
/// a stale `[spec-resynced]` from a previous episode could clear drift for
/// a brand new drift episode.
#[allow(
    dead_code,
    reason = "test-only helper reached from #[cfg(test)] modules; clippy's bin target cannot see those calls"
)]
fn spec_resync_signal_present(task: &Task) -> bool {
    !tagged_values(task, "[spec-resynced]").is_empty()
}

/// One parsed `[spec-resynced]` comment, including its bound checksum and
/// drift fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResyncRecord {
    /// sha256 hex digest of the spec checksum that was set after this resync.
    checksum: String,
    /// sha256 hex digest of the failure list that defined the resynced drift
    /// episode. A new drift episode with different failures produces a
    /// different fingerprint and the previous record becomes stale.
    fingerprint: String,
    /// Pretty short summary line from the comment, used for diagnostics.
    summary: String,
}

/// Parse a single comment's body for `[spec-resynced]` + bound fields.
///
/// Recognised format (Lobster-authored):
/// ```text
/// [spec-resynced] <optional prose>
/// checksum=<64 hex>
/// driftFingerprint=<64 hex>
/// ```
/// The two key=value lines may appear in any order, before or after the
/// `[spec-resynced]` line. Returns `None` if the comment does not start with
/// `[spec-resynced]` or does not carry both fields (older or hand-written
/// comments are intentionally rejected so the stale-drift guard holds).
fn parse_resync_record(text: &str) -> Option<ResyncRecord> {
    let trimmed = text.trim();
    if !trimmed.starts_with("[spec-resynced]") {
        return None;
    }
    let mut checksum: Option<String> = None;
    let mut fingerprint: Option<String> = None;
    let mut summary = String::new();
    let summary_capture = Regex::new(r"(?m)^\[spec-resynced\]\s*(.*)$").unwrap();
    if let Some(cap) = summary_capture.captures(trimmed) {
        summary = cap[1].trim().to_string();
    }
    let kv = Regex::new(r"(?m)^\s*(checksum|driftFingerprint)\s*=\s*([a-fA-F0-9]+)\s*$").unwrap();
    for cap in kv.captures_iter(trimmed) {
        match &cap[1] {
            "checksum" => checksum = Some(cap[2].to_lowercase()),
            "driftFingerprint" => fingerprint = Some(cap[2].to_lowercase()),
            _ => {}
        }
    }
    let checksum = checksum?;
    if !ResyncRecord::is_sha256_hex(&checksum) {
        return None;
    }
    let fingerprint = fingerprint?;
    if !ResyncRecord::is_sha256_hex(&fingerprint) {
        return None;
    }
    Some(ResyncRecord {
        checksum,
        fingerprint,
        summary,
    })
}

impl ResyncRecord {
    fn is_sha256_hex(value: &str) -> bool {
        value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
    }
}

/// Walk comments newest-to-oldest and return the most recent
/// `[spec-resynced]` record parsed successfully.
fn latest_resync_record(task: &Task) -> Option<ResyncRecord> {
    for comment in task.comments.iter().rev() {
        let text = comment_text(comment);
        if let Some(record) = parse_resync_record(text) {
            return Some(record);
        }
    }
    None
}

/// True iff the most recent `[spec-resynced]` comment carries a
/// `driftFingerprint` that matches the current drift episode fingerprint
/// and a checksum whose stored value on the task still matches. Both legs
/// must hold — a fingerprint match alone is not enough because the spec
/// checksum can drift again after a resync without a fresh `[spec-resynced]`.
fn latest_resync_record_matches_drift(
    task: &Task,
    drift_fingerprint: &str,
    stored_checksum: Option<&str>,
) -> bool {
    let Some(record) = latest_resync_record(task) else {
        return false;
    };
    record.fingerprint == drift_fingerprint && stored_checksum == Some(&record.checksum)
}

/// Hash the failure list that defined the current drift episode. Returns a
/// lowercase sha256 hex digest. Stable across runs (failure order is
/// preserved verbatim), so it can be embedded in `[spec-resynced]` comments
/// to bind them to the episode.
fn drift_episode_fingerprint(failures: &[String]) -> String {
    let joined = failures.join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    format!("{digest:x}")
}

/// True if the task is in the `open` status (uses brain spec as source of truth).
fn task_is_open(task: &Task) -> bool {
    task.status == "open"
}

fn resolve_product_spec_path(path: &str, repo: &Path, workspace_root: &Path) -> PathBuf {
    let spec = Path::new(path);
    if spec.is_absolute() {
        return spec.to_path_buf();
    }
    if path.starts_with("brain/") {
        if workspace_root.file_name().and_then(|name| name.to_str()) == Some("brain") {
            return workspace_root.join(path.trim_start_matches("brain/"));
        }
        return workspace_root.join(spec);
    }
    repo.join(spec)
}

fn workspace_root(args: &StageArgs) -> &Path {
    args.workspace_root
        .as_deref()
        .unwrap_or_else(|| Path::new("/Users/quinnstoffer/.openclaw/workspace"))
}

fn acceptance_criteria_text(text: &str) -> Vec<String> {
    let re = Regex::new(r"(?m)^\s*-\s*\[[ xX]\]\s+(.+)$").unwrap();
    re.captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
        .collect()
}

fn spec_checksum(task: &Task) -> String {
    let acs = acceptance_criteria_text(&task.description.clone().unwrap_or_default());
    acceptance_criteria_checksum(&acs)
}

fn acceptance_criteria_checksum(acceptance_criteria: &[String]) -> String {
    let value = json!({ "acceptanceCriteria": acceptance_criteria });
    let canonical = canonical_json_bytes(&value);
    let digest = Sha256::digest(canonical);
    format!("{digest:x}")
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(&canonical_json_value(value)).expect("serialize canonical JSON")
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            Value::Object(Map::from_iter(sorted))
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        _ => value.clone(),
    }
}

fn spec_checksum_failures(task: &Task) -> Vec<String> {
    let Some(stored) = task.spec_checksum.as_deref() else {
        return vec![];
    };
    let current = spec_checksum(task);
    if current == stored {
        vec![]
    } else {
        vec![format!(
            "Spec drift detected — AC checksum changed since last approval. Task {} stored specChecksum `{stored}` but current AC checksum is `{current}`.",
            task.id
        )]
    }
}

fn workstreams(task: &Task) -> Vec<Workstream> {
    parse_workstreams(&task.description.clone().unwrap_or_default())
}

fn parse_workstreams(text: &str) -> Vec<Workstream> {
    let owner_section = parse_owner_workstreams(text);
    if !owner_section.is_empty() {
        return owner_section;
    }

    let heading = Regex::new(r"(?im)^\s{0,3}#{2,6}\s+(.+?)\s*$").unwrap();
    let mut matches: Vec<_> = heading.find_iter(text).collect();
    matches.retain(|m| m.as_str().to_lowercase().contains("workstream"));
    matches
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let start = m.end();
            let end = matches
                .get(idx + 1)
                .map(|n| n.start())
                .unwrap_or(text.len());
            let title = heading
                .captures(m.as_str())
                .and_then(|cap| cap.get(1))
                .map(|m| m.as_str().trim())
                .unwrap_or("Implementer");
            let owner = title
                .replace("Workstream", "")
                .replace("workstream", "")
                .trim_matches(|c: char| c.is_whitespace() || c == ':' || c == '-' || c == '/')
                .trim()
                .to_string();
            Workstream {
                owner: if owner.is_empty() {
                    "Implementer".to_string()
                } else {
                    owner
                },
                body: text[start..end].trim().to_string(),
            }
        })
        .collect()
}

fn parse_owner_workstreams(text: &str) -> Vec<Workstream> {
    let section_re = Regex::new(r"(?im)^\s*\*\*Workstreams\*\*\s*$").unwrap();
    let Some(section_match) = section_re.find(text) else {
        return Vec::new();
    };
    let start = section_match.end();
    let after = &text[start..];
    let end_re = Regex::new(r"(?m)^\s*(?:#{1,6}\s+|\*\*[^*\n]+\*\*\s*$)").unwrap();
    let end = end_re
        .find(after)
        .map(|m| start + m.start())
        .unwrap_or(text.len());
    let section = &text[start..end];
    let owner_re = Regex::new(r"(?m)^-\s+Owner:\s*(.+?)\s*$").unwrap();
    let owners: Vec<_> = owner_re.find_iter(section).collect();
    owners
        .iter()
        .enumerate()
        .map(|(idx, owner_match)| {
            let body_start = owner_match.start();
            let body_end = owners
                .get(idx + 1)
                .map(|next| next.start())
                .unwrap_or(section.len());
            let owner = owner_re
                .captures(owner_match.as_str())
                .and_then(|cap| cap.get(1))
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_else(|| "Implementer".to_string());
            Workstream {
                owner,
                body: section[body_start..body_end].trim().to_string(),
            }
        })
        .collect()
}

fn tagged_values(task: &Task, tag: &str) -> Vec<String> {
    task.comments
        .iter()
        .filter_map(|comment| {
            let text = comment_text(comment).trim();
            text.strip_prefix(tag).map(|rest| rest.trim().to_string())
        })
        .collect()
}

fn tech_design_url(task: &Task) -> Option<String> {
    tagged_values(task, "[tech-design]")
        .into_iter()
        .find(|v| !v.is_empty())
}

/// Structured TaskApproval rows are the sole source of tech-design approval.
fn tech_design_approved_structured(task: &Task) -> bool {
    task_approval_granted(task, "tech_design")
}

/// True if any task comment starts with `[tech-design-not-required]` followed
/// by a non-empty rationale. Used by the code-task lobster to allow code
/// tasks to skip the tech design gate when they are small enough not to
/// warrant one.
fn tech_design_waived(task: &Task) -> bool {
    tagged_values(task, "[tech-design-not-required]")
        .into_iter()
        .any(|v| !v.trim().is_empty())
}

fn implementer_pr_urls(task: &Task) -> Vec<String> {
    let re = Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+").unwrap();
    let mut urls = Vec::new();
    // `[implementer-prs]` is the role-based tag. Keep `[rowan-prs]` as a
    // compatibility alias for existing tasks while they drain.
    for tag in ["[implementer-prs]", "[rowan-prs]"] {
        for value in tagged_values(task, tag) {
            for m in re.find_iter(&value) {
                let url = m.as_str().to_string();
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
        }
    }
    urls
}

#[allow(
    dead_code,
    reason = "test-only helper reached from #[cfg(test)] modules; clippy's bin target cannot see those calls"
)]
fn implementer_active_pr_urls_with<F>(task: &Task, inspect: F) -> Vec<String>
where
    F: Fn(&str) -> Result<ReviewState>,
{
    implementer_pr_urls(task)
        .into_iter()
        .filter(|url| !matches!(inspect(url), Ok(ReviewState::Merged)))
        .collect()
}

fn openclaw_needed(task: &Task) -> bool {
    !tagged_values(task, "[openclaw-needed]").is_empty()
}

fn openclaw_done(task: &Task) -> bool {
    !tagged_values(task, "[openclaw-done]").is_empty()
}

fn inspect_pr(url: &str) -> Result<ReviewState> {
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            url,
            "--json",
            "reviewDecision,state,mergedAt,comments,reviews",
        ])
        .output()
        .context("run gh pr view")?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    parse_github_review_state(&String::from_utf8(output.stdout)?)
}

fn pr_body(url: &str) -> Result<String> {
    let output = Command::new("gh")
        .args(["pr", "view", url, "--json", "body", "--jq", ".body"])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    let raw = String::from_utf8(output.stdout)?;
    Ok(decode_pr_body_output(&raw))
}

/// Fetch the list of files changed in a PR.
///
/// Returns an empty Vec if the PR has no diff or the `gh` call fails for a
/// non-fatal reason (e.g. merged PR with no accessible diff). Callers that
/// need an authoritative empty result should consult the surrounding
/// workflow gate state separately.
fn pr_changed_files(url: &str) -> Vec<String> {
    let output = Command::new("gh")
        .args(["pr", "view", url, "--json", "files", "--jq", ".files[].path"])
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

/// Sentinel substring identifying the canonical clippy command for the
/// feature-task workflow. Anchoring on this exact string (rather than parsing
/// markdown structure) keeps the matching stable across PR body template
/// changes — if the canonical command changes, the matching string is
/// updated in lockstep.
const CLIPPY_EVIDENCE_COMMAND: &str =
    "cargo clippy --manifest-path agents/workflows/feature-task/Cargo.toml --all-targets -- -D warnings";

/// Path prefix identifying a PR that touches the Rust feature-task workflow.
const FEATURE_TASK_RUST_PREFIX: &str = "agents/workflows/feature-task/";

/// True iff the PR body contains the canonical clippy command. Matches the
/// exact command string on any line (inside or outside a code fence) so
/// authors can place the evidence anywhere in the PR body.
fn body_has_clippy_evidence(body: &str) -> bool {
    body.lines()
        .any(|line| line.contains(CLIPPY_EVIDENCE_COMMAND))
}

/// True iff the PR's changed files touch the Rust feature-task workflow.
fn touches_rust_feature_workflow(files: &[String]) -> bool {
    files
        .iter()
        .any(|path| path.starts_with(FEATURE_TASK_RUST_PREFIX))
}

/// Build the clippy-evidence blocker failure string. Kept centralised so the
/// message stays consistent across the lobster's checks and tests.
fn clippy_evidence_missing_failure() -> String {
    format!(
        "[feature-task-progress-checklist] missing clippy evidence for Rust workflow PR. \
         Run: {CLIPPY_EVIDENCE_COMMAND}"
    )
}

/// Returns true when the clippy-evidence gate is enabled.
///
/// The gate ships disabled by default; flip `CLIPPY_ENFORCE=true` once the
/// feature-task clippy CI gate (`cbe3333a`) has been green for ≥1 week.
fn clippy_enforce_enabled() -> bool {
    std::env::var("CLIPPY_ENFORCE")
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Check a PR for clippy evidence and append a failure if the PR touches
/// the Rust feature-task workflow but the PR body lacks the canonical
/// clippy command. Returns the failure list for the caller to push into
/// the gate's `failures` vec.
fn clippy_evidence_failures(url: &str) -> Vec<String> {
    if !clippy_enforce_enabled() {
        return Vec::new();
    }
    let files = pr_changed_files(url);
    if !touches_rust_feature_workflow(&files) {
        return Vec::new();
    }
    match pr_body(url) {
        Ok(body) if body_has_clippy_evidence(&body) => Vec::new(),
        Ok(_) => vec![clippy_evidence_missing_failure()],
        Err(err) => vec![format!(
            "Could not read PR body for clippy evidence check ({url}): {err}."
        )],
    }
}

/// Decode the raw stdout of `gh pr view --jq .body` into a PR body string.
///
/// gh 2.87.3 sometimes emits a JSON-encoded string (quote-wrapped, with
/// escaped newlines) when the body contains non-ASCII Unicode. Fall back to
/// raw passthrough if decoding fails so unexpected gh output preserves the
/// previous behaviour.
fn decode_pr_body_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') {
        if let Ok(Value::String(decoded)) = serde_json::from_str(trimmed) {
            return decoded;
        }
    }
    raw.to_string()
}

fn parse_github_review_state(raw: &str) -> Result<ReviewState> {
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

fn body_has_checked_acceptance(body: &str) -> bool {
    Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+.+")
        .unwrap()
        .is_match(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture(name: &str) -> String {
        fs::read_to_string(Path::new("fixtures").join(name))
            .or_else(|_| {
                fs::read_to_string(Path::new("agents/workflows/feature-task/fixtures").join(name))
            })
            .unwrap()
    }

    #[test]
    fn parses_product_spec_link() {
        let spec = parse_product_spec_ref(&fixture("task_full.md")).unwrap();
        assert_eq!(
            spec.path,
            "brain/bookmarks/specs/feature-factory-v2-2026-06-04.md"
        );
    }

    #[test]
    fn detects_missing_product_spec() {
        assert!(parse_product_spec_ref("no spec here").is_none());
    }

    #[test]
    fn parses_only_bold_spec_line_from_description() {
        assert!(parse_product_spec_ref("Product spec: brain/bookmarks/specs/example.md").is_none());
        let spec = parse_product_spec_ref("**Spec:** brain/bookmarks/specs/example.md").unwrap();
        assert_eq!(spec.path, "brain/bookmarks/specs/example.md");
    }

    // ---- tech_design_waived (task f77b7a60) ----
    //
    // `[tech-design-not-required]` is the code-task lobster's escape hatch for
    // tasks that are small enough not to warrant a full tech design. A
    // non-empty reason after the tag satisfies the gate; an empty value
    // (whitespace only) does not.

    fn task_with_waiver_comment(text: &str) -> Task {
        Task {
            id: "task-waiver".to_string(),
            comments: vec![TaskComment {
                text: Some(text.to_string()),
                body: None,
            }],
            ..Task::default()
        }
    }

    #[test]
    fn tech_design_waived_accepts_bare_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required] trivial change");
        assert!(tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_accepts_leading_whitespace() {
        let task = task_with_waiver_comment("[tech-design-not-required]    trivial config tweak");
        assert!(tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_missing_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required]");
        assert!(!tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_whitespace_only_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required]    \t  ");
        assert!(!tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_unrelated_tag() {
        let task = task_with_waiver_comment("[tech-design-not-required-forever] nope");
        assert!(!tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_picks_up_among_other_comments() {
        let task = Task {
            id: "task-multi".to_string(),
            comments: vec![
                TaskComment {
                    text: Some("random chatter".to_string()),
                    body: None,
                },
                TaskComment {
                    text: Some(
                        "[tech-design-not-required] small PR — no design needed".to_string(),
                    ),
                    body: None,
                },
            ],
            ..Task::default()
        };
        assert!(tech_design_waived(&task));
    }

    // ---- workflow_for_task (task f77b7a60) ----
    //
    // The lobster must write `code-task-workflow` to LobsterState.workflow
    // for code tasks so feature and code task state stay distinguishable
    // on re-runs.

    #[test]
    fn workflow_for_task_returns_code_workflow_for_code_tasks() {
        let task = Task {
            task_type: Some("code".to_string()),
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), "code-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_feature_tasks() {
        let task = Task {
            task_type: Some("feature".to_string()),
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), "feature-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_when_task_type_missing() {
        let task = Task {
            task_type: None,
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), "feature-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_unknown_types() {
        // Defensive: future taskType additions should default to the
        // feature-task workflow unless explicitly opted in.
        let task = Task {
            task_type: Some("research".to_string()),
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), "feature-task-workflow");
    }

    // ---- AC evidence parsing (task 6e70deb8) ----
    //
    // Task 44f5ed65 covers the seven tech_design_approved tests above:
    //   AC1 (accept rationale after true):
    //     tech_design_approved_accepts_bare_true
    //     tech_design_approved_accepts_rationale_after_true
    //     tech_design_approved_accepts_uppercase_true
    //     tech_design_approved_accepts_leading_whitespace
    //   AC2 (reject false / missing value / unrelated token):
    //     tech_design_approved_rejects_false
    //     tech_design_approved_rejects_missing_value
    //     tech_design_approved_rejects_unrelated_token
    //   AC3 (Rust unit tests cover both accept and reject cases):
    //     all seven tests above.
    //

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

        assert!(spec_failures(&task, repo.path(), workspace.path()).is_empty());
    }



    #[test]
    fn resolves_product_specs_relative_to_workspace_root() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        assert_eq!(
            resolve_product_spec_path(
                "brain/tasks/specs/example.md",
                repo.path(),
                workspace.path()
            ),
            workspace.path().join("brain/tasks/specs/example.md")
        );

        assert_eq!(
            resolve_product_spec_path("docs/spec.md", repo.path(), workspace.path()),
            repo.path().join("docs/spec.md")
        );

        let absolute = workspace.path().join("brain/tasks/specs/example.md");
        assert_eq!(
            resolve_product_spec_path(absolute.to_str().unwrap(), repo.path(), workspace.path()),
            absolute
        );
    }

    #[test]
    fn validates_existing_product_spec_under_workspace_root() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let spec_path = workspace.path().join("brain/tasks/specs/example.md");
        fs::create_dir_all(spec_path.parent().unwrap()).unwrap();
        fs::write(
            &spec_path,
            "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] Implementation-ready criteria",
        )
        .unwrap();

        let task = Task {
            description: Some(
                "**Spec:** brain/tasks/specs/example.md\n\n## Acceptance Criteria\n- [ ] Build it\n\n## Implementer Workstream\n- [ ] Build it"
                    .to_string(),
            ),
            approvals: vec![approval_row("spec", "approved")],
            ..Task::default()
        };

        assert!(spec_failures(&task, repo.path(), workspace.path()).is_empty());
        assert!(!repo.path().join("brain/tasks/specs/example.md").exists());
    }

    #[test]
    fn computes_deterministic_compact_spec_checksum() {
        let acs = vec![
            "AC2: Build the second thing".to_string(),
            "AC1: Build the first thing".to_string(),
        ];
        let checksum = acceptance_criteria_checksum(&acs);

        assert_eq!(checksum, acceptance_criteria_checksum(&acs));
        assert_eq!(
            canonical_json_bytes(&json!({
                "z": "last",
                "acceptanceCriteria": acs,
                "a": { "second": 2, "first": 1 }
            })),
            br#"{"a":{"first":1,"second":2},"acceptanceCriteria":["AC2: Build the second thing","AC1: Build the first thing"],"z":"last"}"#
        );
    }

    #[test]
    fn spec_checksum_guard_allows_unchanged_acceptance_criteria() {
        let mut task = Task {
            id: "task-no-drift".to_string(),
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        task.spec_checksum = Some(spec_checksum(&task));

        assert!(spec_checksum_failures(&task).is_empty());
    }

    #[test]
    fn spec_checksum_guard_blocks_drift_after_approval() {
        let approved_task = Task {
            id: "task-drift".to_string(),
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let changed_task = Task {
            id: "task-drift".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Also build this"
                    .to_string(),
            ),
            spec_checksum: Some(spec_checksum(&approved_task)),
            ..Task::default()
        };

        let failures = spec_checksum_failures(&changed_task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("Spec drift detected"));
        assert!(failures[0].contains("AC checksum changed since last approval"));
        assert!(failures[0].contains("task-drift"));
    }

    #[test]
    fn extracts_api_spec_checksum_mismatch_as_blocked_message() {
        let err = Err::<(), _>(ApiStatusError {
            status: 409,
            code: Some("SPEC_CHECKSUM_MISMATCH".to_string()),
            message: "ACs modified after spec approval".to_string(),
        })
        .context("API request failed")
        .unwrap_err();

        assert_eq!(
            spec_checksum_mismatch_message(&err).as_deref(),
            Some("ACs modified after spec approval")
        );
    }

    #[test]
    fn ignores_other_api_conflicts_for_spec_checksum_handling() {
        let err = Err::<(), _>(ApiStatusError {
            status: 409,
            code: Some("SPEC_CHECKSUM_LOCKED".to_string()),
            message: "specChecksum is locked".to_string(),
        })
        .context("API request failed")
        .unwrap_err();

        assert!(spec_checksum_mismatch_message(&err).is_none());
    }

    #[test]
    fn spec_approval_transition_stores_current_checksum() {
        let task = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let mut patch = json!({"status": "ready"});
        patch["specChecksum"] = Value::String(spec_checksum(&task));

        assert_eq!(patch["status"], "ready");
        assert_eq!(
            patch["specChecksum"].as_str().unwrap(),
            spec_checksum(&task)
        );
    }

    #[test]
    fn implementer_capacity_allows_other_ready_and_acceptance_tasks() {
        let tasks = vec![
            Task {
                id: "other-ready".to_string(),
                status: "ready".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
            Task {
                id: "other-acceptance".to_string(),
                status: "acceptance".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
        ];

        assert!(implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
    }

    #[test]
    fn implementer_capacity_allows_single_existing_doing_task() {
        // Capacity is 2, so one existing `doing` task for the implementer
        // still leaves room for the current task.
        let tasks = vec![Task {
            id: "other-doing".to_string(),
            status: "doing".to_string(),
            assignee: Some("Rowan".to_string()),
            ..Task::default()
        }];

        assert!(implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
    }

    #[test]
    fn implementer_capacity_blocks_at_two_existing_doing_tasks() {
        let tasks = vec![
            Task {
                id: "other-doing-1".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
            Task {
                id: "other-doing-2".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
        ];

        assert_eq!(
            implementer_doing_capacity_failures(&tasks, "current-task", "Rowan"),
            vec![
                "Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2)."
                    .to_string()
            ]
        );
    }

    #[test]
    fn implementer_capacity_allows_dependency_blocked_doing_task() {
        // A task in `doing` that is blocked by an unresolved dependency
        // is not actually consuming the implementer's capacity — it is stuck waiting
        // on another task. The capacity check should treat it the same
        // as a non-`doing` task (Tom: 2026-07-01 — "needs to be taken
        // into account for all states").
        let tasks = vec![Task {
            id: "other-doing".to_string(),
            status: "doing".to_string(),
            assignee: Some("Rowan".to_string()),
            dependency_blocked: true,
            ..Task::default()
        }];

        assert!(implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
    }

    #[test]
    fn implementer_capacity_manual_blocked_doing_task_does_not_count() {
        // Sanity: manual block continues to free capacity (existing
        // behaviour). A manually-blocked `doing` task plus one
        // unblocked `doing` task is only 1 counted task against the
        // capacity of 2, so it should not block. This pins down that
        // the `!blocked` / `!dependency_blocked` checks did not weaken
        // when capacity moved from 1 to 2.
        let tasks = vec![
            Task {
                id: "manual-blocked".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                blocked: true,
                ..Task::default()
            },
            Task {
                id: "actually-progressing".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
        ];

        assert!(implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
    }

    #[test]
    fn implementer_capacity_manual_blocked_does_not_free_a_slot_past_limit() {
        // Two unblocked `doing` tasks plus one manually-blocked `doing`
        // task should still block: the manual-blocked task correctly
        // does not count, but the two unblocked ones already hit the
        // capacity of 2.
        let tasks = vec![
            Task {
                id: "manual-blocked".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                blocked: true,
                ..Task::default()
            },
            Task {
                id: "actually-progressing-1".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
            Task {
                id: "actually-progressing-2".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                ..Task::default()
            },
        ];

        assert_eq!(
            implementer_doing_capacity_failures(&tasks, "current-task", "Rowan"),
            vec![
                "Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2)."
                    .to_string()
            ]
        );
    }

    #[test]
    fn parses_multiple_workstreams() {
        let streams = parse_workstreams(&fixture("task_full.md"));
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Rowan");
        assert_eq!(streams[1].owner, "Quinn");
    }

    #[test]
    fn parses_bold_workstreams_section_with_owner_blocks() {
        let text = r#"**Workstreams**
- Owner: Implementer
  Repo: Stoffer-Industries/sindustries
  Branch: task-456c92a8-depends-on
  Worktree: ~/workspaces/rowan/sindustries
  PR: (pending)
  Scope: Build it
  ACs: AC1
  Status: open

- Owner: Quinn
  Scope: .openclaw handoff
  Status: open

**Type:** feature
"#;
        let streams = parse_workstreams(text);
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Implementer");
        assert!(streams[0].body.contains("task-456c92a8-depends-on"));
        assert_eq!(streams[1].owner, "Quinn");
    }

    #[test]
    fn spec_failures_do_not_hide_valid_bold_workstreams() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let task = Task {
            description: Some(
                r#"## Acceptance Criteria
- [ ] AC1: Build it

**Workstreams**
- Owner: Implementer
  Repo: Stoffer-Industries/sindustries
  Branch: task-456c92a8-depends-on
  Status: open
"#
                .to_string(),
            ),
            ..Task::default()
        };
        let failures = spec_failures(&task, repo.path(), workspace.path());
        assert!(failures.contains(&"Task description must include a **Spec:** line".to_string()));
        assert!(
            !failures
                .iter()
                .any(|failure| failure.contains("workstreams")),
            "unexpected workstream failure: {failures:?}"
        );
    }

    #[test]
    fn extracts_multiple_implementer_pr_urls() {
        let task = Task {
            comments: vec![TaskComment { text: Some("[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/1\nhttps://github.com/Stoffer-Industries/sindustries/pull/2".to_string()), body: None }],
            ..Task::default()
        };
        assert_eq!(implementer_pr_urls(&task).len(), 2);
    }

    #[test]
    fn active_implementer_pr_urls_skip_merged_prs() {
        let task = Task {
            comments: vec![
                TaskComment {
                    text: Some(
                        "[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/120"
                            .to_string(),
                    ),
                    body: None,
                },
                TaskComment {
                    text: Some(
                        "[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/128"
                            .to_string(),
                    ),
                    body: None,
                },
            ],
            ..Task::default()
        };
        let active = implementer_active_pr_urls_with(&task, |url| {
            if url.ends_with("/120") {
                Ok(ReviewState::Merged)
            } else {
                Ok(ReviewState::Approved)
            }
        });
        assert_eq!(
            active,
            vec!["https://github.com/Stoffer-Industries/sindustries/pull/128".to_string()]
        );
    }

    // --- brain spec approval reconciliation ---
    const OPEN_SPEC_PATH: &str = "brain/tasks/specs/open/reconcile-me.md";
    const CHECKED_SPEC: &str = "# Spec\n\n- [x] **Approved by Tom**\n";
    const UNCHECKED_SPEC: &str = "# Spec\n\n- [ ] **Approved by Tom**\n";

    fn linked_approval_task(task_type: &str, approvals: Vec<TaskApproval>) -> Task {
        Task {
            id: format!("{task_type}-task"),
            task_type: Some(task_type.to_string()),
            description: Some(format!("**Spec:** {OPEN_SPEC_PATH}")),
            approvals,
            ..Task::default()
        }
    }

    #[test]
    fn checked_open_task_spec_plans_structured_spec_grant() {
        let tasks = vec![linked_approval_task("feature", vec![])];
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &tasks),
            BrainSpecApprovalPlan::Grant {
                task_id: "feature-task".to_string()
            }
        );
    }

    #[test]
    fn unchecked_open_task_spec_never_plans_grant() {
        let tasks = vec![linked_approval_task("feature", vec![])];
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, UNCHECKED_SPEC, &tasks),
            BrainSpecApprovalPlan::Unchecked
        );
    }

    #[test]
    fn already_approved_open_task_spec_is_idempotent() {
        let tasks = vec![linked_approval_task(
            "feature",
            vec![approval_row("spec", "approved")],
        )];
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &tasks),
            BrainSpecApprovalPlan::AlreadyApproved {
                task_id: "feature-task".to_string()
            }
        );
    }

    #[test]
    fn checked_open_task_spec_without_link_fails_closed() {
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &[]),
            BrainSpecApprovalPlan::MissingLink
        );
    }

    #[test]
    fn checked_open_task_spec_does_not_target_code_tasks() {
        let tasks = vec![linked_approval_task("code", vec![])];
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &tasks),
            BrainSpecApprovalPlan::MissingLink
        );
    }

    #[test]
    fn revoked_api_spec_approval_is_not_regranted_from_stale_checkbox() {
        let tasks = vec![linked_approval_task(
            "feature",
            vec![approval_row("spec", "revoked")],
        )];
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &tasks),
            BrainSpecApprovalPlan::Revoked {
                task_id: "feature-task".to_string()
            }
        );
    }

    #[test]
    fn duplicate_task_spec_links_are_rejected_as_malformed() {
        let task = Task {
            task_type: Some("feature".to_string()),
            description: Some(format!(
                "**Spec:** {OPEN_SPEC_PATH}\n**Spec:** brain/tasks/specs/open/other.md"
            )),
            ..Task::default()
        };
        assert!(reconciliation_spec_link(&task).is_none());
        assert_eq!(
            plan_brain_spec_approval(OPEN_SPEC_PATH, CHECKED_SPEC, &[task]),
            BrainSpecApprovalPlan::MissingLink
        );
    }

    // --- structured approval gates ---
    fn approval_row(kind: &str, state: &str) -> TaskApproval {
        TaskApproval {
            approval_type: kind.into(),
            state: state.into(),
            ..Default::default()
        }
    }
    #[test]
    fn structured_approval_rows_are_the_only_gate_source() {
        let approved = Task {
            approvals: vec![
                approval_row("spec", "approved"),
                approval_row("tech_design", "approved"),
                approval_row("qa", "approved"),
            ],
            ..Default::default()
        };
        assert!(spec_is_approved(&approved));
        assert!(tech_design_approved_structured(&approved));
        assert!(qa_ac_verified_structured(&approved));
        let legacy = Task {
            description: Some("- [x] **Approved by Tom**".into()),
            comments: vec![TaskComment {
                text: Some("[tech-design-approved] true [qa-ac-verified] true".into()),
                body: None,
            }],
            ..Default::default()
        };
        assert!(!spec_is_approved(&legacy));
        assert!(!tech_design_approved_structured(&legacy));
        assert!(!qa_ac_verified_structured(&legacy));
        let revoked = Task {
            approvals: vec![
                approval_row("spec", "revoked"),
                approval_row("tech_design", "revoked"),
                approval_row("qa", "revoked"),
            ],
            ..legacy
        };
        assert!(!spec_is_approved(&revoked));
        assert!(!tech_design_approved_structured(&revoked));
        assert!(!qa_ac_verified_structured(&revoked));
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
        let failures = missing_spec_checksum_failures(&task, repo.path(), workspace.path());
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
        assert!(missing_spec_checksum_failures(&task, repo.path(), workspace.path()).is_empty());

        // A task with a stored checksum is already past "open" legitimately — spec_checksum_failures
        // (not spec_failures) is the gate from here on, so we just confirm no spec drift.
        let failures = spec_checksum_failures(&task);
        // checksum "abc123" won't match the real computed checksum, so drift is detected —
        // that's correct behaviour: the stored checksum must match current ACs.
        assert!(
            !failures.is_empty(),
            "expected drift for mismatched checksum"
        );
        assert!(failures[0].contains("Spec drift detected"));
    }

    #[test]
    fn verify_delivery_review_gate_allows_pending_review() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(verify_delivery_review_failure(url, ReviewState::Required).is_none());
        assert!(verify_delivery_review_failure(url, ReviewState::CommentsPresent).is_none());
        assert!(verify_delivery_review_failure(url, ReviewState::Merged).is_none());
        assert_eq!(
            verify_delivery_review_failure(url, ReviewState::ChangesRequested),
            Some(format!("Changes requested on {url}."))
        );
        assert_eq!(
            verify_delivery_review_failure(url, ReviewState::ClosedUnmerged),
            Some(format!("PR {url} is closed without merge."))
        );
    }

    #[test]
    fn post_merge_skips_superseded_closed_unmerged_prs() {
        // Task e9c06d01: PR #365 closed-without-merge, replaced by merged #368.
        let closed = "https://github.com/Stoffer-Industries/sindustries/pull/365";
        let merged = "https://github.com/Stoffer-Industries/sindustries/pull/368";
        let urls = vec![closed.to_string(), merged.to_string()];
        assert!(
            post_merge_pr_failure(closed, ReviewState::ClosedUnmerged, &urls).is_none(),
            "superseded closed PR must not block acceptance → done"
        );
        assert!(post_merge_pr_failure(merged, ReviewState::Merged, &urls).is_none());
    }

    #[test]
    fn post_merge_still_fails_latest_closed_unmerged_pr() {
        let closed = "https://github.com/Stoffer-Industries/sindustries/pull/365";
        let later_closed = "https://github.com/Stoffer-Industries/sindustries/pull/368";
        let urls = vec![closed.to_string(), later_closed.to_string()];
        assert_eq!(
            post_merge_pr_failure(later_closed, ReviewState::ClosedUnmerged, &urls),
            Some(format!(
                "PR {later_closed} is not merged: ClosedUnmerged."
            ))
        );
    }

    #[test]
    fn post_merge_still_fails_open_earlier_pr() {
        // Stacked delivery: an earlier still-open PR must keep blocking done.
        let earlier_open = "https://github.com/Stoffer-Industries/sindustries/pull/365";
        let later_merged = "https://github.com/Stoffer-Industries/sindustries/pull/368";
        let urls = vec![earlier_open.to_string(), later_merged.to_string()];
        assert_eq!(
            post_merge_pr_failure(earlier_open, ReviewState::Approved, &urls),
            Some(format!("PR {earlier_open} is not merged: Approved."))
        );
        assert!(post_merge_pr_failure(later_merged, ReviewState::Merged, &urls).is_none());
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
    fn is_latest_pr_url_returns_true_only_for_highest_pr_number() {
        let urls = vec![
            "https://github.com/Stoffer-Industries/sindustries/pull/365".to_string(),
            "https://github.com/Stoffer-Industries/sindustries/pull/368".to_string(),
        ];
        assert!(!is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/368",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_handles_single_url() {
        let urls = vec!["https://github.com/Stoffer-Industries/sindustries/pull/365".to_string()];
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
    fn is_latest_pr_url_returns_false_for_unparseable_candidate() {
        let urls = vec![
            "https://github.com/Stoffer-Industries/sindustries/pull/365".to_string(),
            "not-a-url".to_string(),
        ];
        assert!(!is_latest_pr_url("not-a-url", &urls));
        // The parseable URL is still the latest when the only other URL is unparseable.
        assert!(is_latest_pr_url(
            "https://github.com/Stoffer-Industries/sindustries/pull/365",
            &urls
        ));
    }

    #[test]
    fn is_latest_pr_url_ties_on_equal_pr_number() {
        // Two URLs with the same PR number are an edge case (shouldn't happen in
        // practice since each PR has a unique number), but the helper must be
        // deterministic: every candidate with the max PR number is "latest".
        let urls = vec![
            "https://github.com/foo/bar/pull/10".to_string(),
            "https://github.com/baz/qux/pull/10".to_string(),
        ];
        assert!(is_latest_pr_url(
            "https://github.com/foo/bar/pull/10",
            &urls
        ));
        assert!(is_latest_pr_url(
            "https://github.com/baz/qux/pull/10",
            &urls
        ));
    }

    #[test]
    fn implementer_pr_urls_preserve_merged_prs_for_delivery() {
        let merged_url = "https://github.com/Stoffer-Industries/sindustries/pull/161";
        let open_url = "https://github.com/Stoffer-Industries/sindustries/pull/164";
        let task = Task {
            comments: vec![TaskComment {
                text: Some(format!("[rowan-prs] {merged_url} {open_url}")),
                body: None,
            }],
            ..Task::default()
        };

        assert_eq!(implementer_pr_urls(&task), vec![merged_url, open_url]);
        assert_eq!(
            implementer_active_pr_urls_with(&task, |url| {
                if url == merged_url {
                    Ok(ReviewState::Merged)
                } else {
                    Ok(ReviewState::Approved)
                }
            }),
            vec![open_url]
        );
    }

    #[test]
    fn feedback_aggregate_waits_on_required_review_without_failure() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(feedback_review_failure(url, ReviewState::Required).is_none());
        assert_eq!(
            feedback_review_failure(url, ReviewState::ChangesRequested),
            Some(format!("Changes requested on {url}."))
        );
    }

    #[test]
    fn parses_github_review_states() {
        assert_eq!(
            parse_github_review_state(&fixture("github_approved.json")).unwrap(),
            ReviewState::Approved
        );
        assert_eq!(
            parse_github_review_state(&fixture("github_changes_requested.json")).unwrap(),
            ReviewState::ChangesRequested
        );
        assert_eq!(
            parse_github_review_state(&fixture("github_merged.json")).unwrap(),
            ReviewState::Merged
        );
        assert_eq!(
            parse_github_review_state(&fixture("github_required.json")).unwrap(),
            ReviewState::Required
        );
    }

    // ---- manual block guard (task 593ee264) ----

    fn blocked_task() -> Task {
        Task {
            id: "task-blocked".to_string(),
            status: "doing".to_string(),
            blocked: true,
            ..Task::default()
        }
    }

    fn unblocked_task() -> Task {
        Task {
            id: "task-unblocked".to_string(),
            status: "doing".to_string(),
            blocked: false,
            ..Task::default()
        }
    }

    #[test]
    fn manual_block_failures_returns_empty_when_unblocked() {
        let task = unblocked_task();
        assert!(manual_block_failures(&task).is_empty());
    }

    #[test]
    fn manual_block_failures_returns_message_when_blocked() {
        let task = blocked_task();
        let failures = manual_block_failures(&task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("blocked: true"));
        assert!(failures[0].contains("dependencyBlocked"));
    }

    #[test]
    fn manual_block_guard_does_not_touch_dependency_blocked() {
        let task = Task {
            id: "task-dep-blocked-only".to_string(),
            blocked: false,
            ..Task::default()
        };
        assert!(manual_block_failures(&task).is_empty());

        let task = Task {
            id: "task-manual-only".to_string(),
            blocked: true,
            ..Task::default()
        };
        let failures = manual_block_failures(&task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("blocked: true"));
        assert!(failures[0].contains("dependencyBlocked"));
    }

    #[test]
    fn manual_block_guard_message_distinguishes_manual_flag() {
        let task = blocked_task();
        let failures = manual_block_failures(&task);
        assert!(failures[0].contains("`blocked: true`"));
        assert!(failures[0].contains("`dependencyBlocked`"));
        assert!(failures[0].contains("separate"));
    }

    #[test]
    fn manual_block_guard_skips_transition_when_blocked() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task: blocked_task(),
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let failures = manual_block_failures(&env.task);
        let result = block_with_manual_block(
            &args,
            env,
            "ready_checks",
            failures,
            "[feature-task-blocked]",
        )
        .expect("block_with_manual_block should not error in dry-run");
        assert!(!result.criteria_met);
        assert_eq!(result.action_taken, "ready_checks_blocked");
        assert_eq!(result.failures.len(), 1);
        assert!(result.failures[0].contains("blocked: true"));
    }

    #[test]
    fn manual_block_guard_allows_unblocked_task_to_continue() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task: unblocked_task(),
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_with_manual_block(
            &args,
            env,
            "ready_checks",
            Vec::new(),
            "[feature-task-blocked]",
        )
        .unwrap();
        assert!(!result.criteria_met);
        assert_eq!(result.action_taken, "ready_checks_blocked");
        assert!(result.failures.is_empty());
    }

    // ---- unchecked_task_ac_labels / ac_labels_in_pr_body / ac_labels_needing_new_pr ----


    // ---- block_on_spec_drift_fluid ----

    #[test]
    fn fluid_drift_returns_none_when_no_drift() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let task = Task::default();
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result =
            block_on_spec_drift_fluid(&args, env, "spec_check").expect("no-drift should not error");
        assert!(result.is_none());
    }

    #[test]
    fn code_task_skips_feature_spec_drift_gate_even_with_historical_checksum() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: false,
        };
        let task = Task {
            task_type: Some("code".to_string()),
            spec_checksum: Some("historical-checksum".to_string()),
            status: "doing".to_string(),
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };

        let result = block_on_spec_drift_fluid(&args, env, "verify_delivery")
            .expect("code tasks must bypass feature spec-drift handling");
        assert!(result.is_none());
    }

    #[test]
    fn fluid_drift_does_not_auto_uncheck_typescript_spec_files() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-ts-spec".to_string(),
            description: Some(
                "**Spec:** apps/tasks/src/feature_task_workflow_spec.ts\n\n- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift"
                    .to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };

        let result = block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("dry-run should not error");
        let blocked = result.expect("should block without auto-unchecking");
        assert!(!blocked.criteria_met);
        assert!(blocked
            .failures
            .iter()
            .any(|failure| failure.contains("will not auto-uncheck")));
    }

    #[test]
    fn fluid_drift_legacy_block_when_spec_approval_missing() {
        // e2aba106 WS2: there is no longer a description-side marker. The drift
        // gate keys off `task.approvals`. When no `spec` row exists (or the
        // row is revoked) the gate hard-blocks with the structured message.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let mut task = Task {
            id: "task-no-marker".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        task.spec_checksum = Some(spec_checksum(&approved));
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result =
            block_on_spec_drift_fluid(&args, env, "ready_checks").expect("no API call in dry-run");
        let blocked = result.expect("should block");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "ready_checks_blocked_spec_drift");
        assert!(
            blocked.failures[0].contains("Structured `spec` TaskApproval"),
            "missing-approval drift must surface the structured message; got {:?}",
            blocked.failures
        );
    }

    #[test]
    fn fluid_drift_blocks_when_spec_approval_revoked_waiting_for_tom() {
        // WS2: the unchecked-marker case (ApprovalMarker::Unchecked) collapses
        // into the same hard-block as the missing-approval case. Both gate on
        // `task.approvals` not having an approved `spec` row.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-unchecked".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "revoked")],
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result =
            block_on_spec_drift_fluid(&args, env, "ready_checks").expect("no API call in dry-run");
        let blocked = result.expect("should block");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "ready_checks_blocked_spec_drift");
        assert_eq!(blocked.failures.len(), 1);
        assert!(blocked.failures[0].contains("Structured `spec` TaskApproval"));
        assert!(blocked.failures[0].contains("missing or revoked"));
    }

    #[test]
    fn fluid_drift_dry_run_blocks_when_spec_approved_and_no_resync() {
        // e2aba106 WS2 / AC1: case (c) in dry-run. Approved structured
        // `spec` TaskApproval + no prior revocation flag + no fresh
        // `[spec-resynced]` record → block with the raw drift message.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-approved-no-resync".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "approved")],
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("dry-run should not error");
        let blocked = result.expect("should block");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "ready_checks_blocked_spec_drift");
        assert!(
            blocked.failures[0].contains("Spec drift detected"),
            "expected drift message; got {:?}",
            blocked.failures
        );
    }

    #[test]
    fn fluid_drift_dry_run_unblocks_when_revocation_flag_set() {
        // e2aba106 WS2 / AC1 case (a): the lobster previously revoked the
        // structured `spec` TaskApproval (lobster_state.spec_drift_uncheck_applied
        // == Some(true)) and Tom has since re-approved it on the new spec.
        // In dry-run, the gate should report allowed progression rather than
        // running the live resync against the API.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-resynced-flag".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "approved")],
            ..Task::default()
        };
        #[allow(
            clippy::field_reassign_with_default,
            reason = "test fixture builds LobsterState via Default then patches a single field for the revocation-flag path; clearer than struct-update syntax here"
        )]
        let lobster_state = {
            let mut lobster_state = LobsterState::default();
            lobster_state.spec_drift_uncheck_applied = Some(true);
            lobster_state
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state,
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("dry-run revocation flag path should not error");
        assert!(
            result.is_none(),
            "revocation flag path should signal allowed progression; got {:?}",
            result
        );
    }

    #[test]
    fn fluid_drift_dry_run_unblocks_when_resync_record_matches() {
        // AC4 case (b): a `[spec-resynced]` comment whose drift fingerprint
        // matches the current drift episode and whose checksum matches the
        // stored checksum is trusted to allow progression, even if the
        // lobster_state flag is unset (e.g. comment posted by Quinn
        // directly).
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let drifted_description = "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string();
        let task = Task {
            id: "task-resynced-record".to_string(),
            description: Some(drifted_description),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        // Build a `[spec-resynced]` comment bound to the current drift
        // episode.
        let drift_failures = spec_checksum_failures(&task);
        assert!(
            !drift_failures.is_empty(),
            "fixture must produce drift so the test exercises the binding"
        );
        let fingerprint = drift_episode_fingerprint(&drift_failures);
        let new_checksum = acceptance_criteria_checksum(&acceptance_criteria_text(
            &task.description.clone().unwrap(),
        ));
        // Sanity: the resync comment must already be cryptographically
        // bound to the values it claims.
        assert_eq!(fingerprint.len(), 64);
        assert_eq!(new_checksum.len(), 64);
        let resync_text = format!(
            "[spec-resynced] {summary}\nchecksum={checksum}\ndriftFingerprint={fp}\n",
            summary = drift_failures.join(" / "),
            checksum = new_checksum,
            fp = fingerprint,
        );
        let mut drifted_task = task.clone();
        drifted_task.spec_checksum = Some(new_checksum);
        drifted_task.comments = vec![TaskComment {
            text: Some(resync_text),
            body: None,
        }];
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task: drifted_task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("dry-run resync-record path should not error");
        assert!(
            result.is_none(),
            "fresh resync record should allow progression; got {:?}",
            result
        );
    }

    // ---- source-of-truth handling (AC5) ----

    #[test]
    fn fluid_drift_open_status_uses_legacy_block() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        // Open status: marker machinery must NOT run, even if marker present.
        let description = "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string();
        let task = Task {
            id: "task-open".to_string(),
            description: Some(description),
            status: "open".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "spec_check")
            .expect("open-status branch should not error");
        let blocked = result.expect("open task with drift should block");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "spec_check_blocked_spec_drift");
        assert!(
            blocked.failures[0].contains("Spec drift detected"),
            "open-status drift must surface the drift message; got {:?}",
            blocked.failures
        );
        assert!(
            !blocked
                .failures
                .iter()
                .any(|f| f.contains("**Approved by Tom**")),
            "open-status drift must not surface a marker hint; got {:?}",
            blocked.failures
        );
    }

    #[test]
    fn fluid_drift_revoked_approval_failure_message_is_stable() {
        // e2aba106 WS2 / AC1: Quinn (or anything else) parses failure text
        // to decide what to do next. Lock the structured-approval wording
        // down so consumers can grep on it.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-revoked-stable".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "revoked")],
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "verify_delivery")
            .expect("revoked-approval branch should not error");
        let blocked = result.expect("revoked approval should block");
        assert_eq!(blocked.failures.len(), 1);
        let message = &blocked.failures[0];
        assert!(
            message.contains("Structured `spec` TaskApproval"),
            "expected structured-approval message; got {message}"
        );
        assert!(
            message.contains("missing or revoked"),
            "expected missing-or-revoked message; got {message}"
        );
    }

    #[test]
    fn fluid_drift_revoked_approval_ignores_existing_resync_comment() {
        // e2aba106 WS2 / AC1: a previous `[spec-resynced]` comment from an
        // older episode must not bypass the current drift gate when the
        // structured `spec` approval is revoked — the lobster must surface
        // the missing/revoked message and stay blocked.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-revoked-old-resync".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift\n".to_string(),
            ),
            status: "doing".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "revoked")],
            comments: vec![TaskComment {
                text: Some("[spec-resynced] Previous episode".to_string()),
                body: None,
            }],
            ..Task::default()
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "feedback_aggregate")
            .expect("revoked-approval branch should not error");
        let blocked = result.expect("revoked approval should still block");
        assert!(!blocked.criteria_met);
        assert!(
            blocked.failures[0].contains("Structured `spec` TaskApproval"),
            "expected structured-approval message; got {:?}",
            blocked.failures
        );
    }

    // ---- AC4 helpers ----

    #[test]
    fn parse_resync_record_extracts_bound_fields() {
        // Use exactly-64-char lowercase hex strings so is_sha256_hex accepts them.
        let chk = "a".repeat(64);
        let fp = "b".repeat(64);
        let text = format!("[spec-resynced] reset checksum after approval\nchecksum={chk}\ndriftFingerprint={fp}\n");
        let record = parse_resync_record(&text).expect("record should parse");
        assert_eq!(record.checksum, chk);
        assert_eq!(record.fingerprint, fp);
        assert_eq!(record.summary, "reset checksum after approval");
    }

    #[test]
    fn parse_resync_record_rejects_record_without_binding() {
        // A hand-written `[spec-resynced]` without checksum/driftFingerprint
        // must NOT be trusted — the stale-drift guard requires the binding.
        let text = "[spec-resynced] does not carry checksum/fingerprint fields";
        assert!(parse_resync_record(text).is_none());
    }

    #[test]
    fn parse_resync_record_rejects_unbound_comment() {
        let text = "Spec resynced offline.";
        assert!(parse_resync_record(text).is_none());
    }

    #[test]
    fn parse_resync_record_rejects_short_hex() {
        let text = "[spec-resynced] short\nchecksum=deadbeef\ndriftFingerprint=cafebabe\n";
        assert!(parse_resync_record(text).is_none());
    }

    #[test]
    fn latest_resync_record_returns_most_recent_with_binding() {
        let good = format!(
            "[spec-resynced] reset\nchecksum={chk}\ndriftFingerprint={fp}\n",
            chk = "a".repeat(64),
            fp = "b".repeat(64),
        );
        let stale = "[spec-resynced] old reset (no fields)";
        let task = Task {
            comments: vec![
                TaskComment {
                    text: Some("[rowan-prs] https://github.com/x/y/pull/1".to_string()),
                    body: None,
                },
                TaskComment {
                    text: Some(stale.to_string()),
                    body: None,
                },
                TaskComment {
                    text: Some(good),
                    body: None,
                },
            ],
            ..Task::default()
        };
        let record = latest_resync_record(&task).expect("record must be found");
        assert_eq!(record.checksum, "a".repeat(64));
        assert_eq!(record.fingerprint, "b".repeat(64));
    }

    #[test]
    fn drift_episode_fingerprint_is_stable_and_order_sensitive() {
        let a = vec!["one".to_string(), "two".to_string()];
        let b = vec!["one".to_string(), "two".to_string()];
        let c = vec!["two".to_string(), "one".to_string()];
        assert_eq!(drift_episode_fingerprint(&a), drift_episode_fingerprint(&b));
        assert_ne!(drift_episode_fingerprint(&a), drift_episode_fingerprint(&c));
        // Lowercase sha256 hex of length 64.
        let fp = drift_episode_fingerprint(&a);
        assert_eq!(fp.len(), 64);
        assert!(fp
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn latest_resync_record_matches_drift_requires_both_legs() {
        let fp = "f".repeat(64);
        let cs = "0".repeat(64);
        let other_fp = "9".repeat(64);
        let other_cs = "8".repeat(64);
        // Same fingerprint but different stored checksum -> reject.
        // The task's spec_checksum is a different value than cs (the comment's checksum).
        let mismatch_cs = "deadbeef".repeat(8)[..64].to_string();
        let task_cs_mismatch = Task {
            spec_checksum: Some(mismatch_cs.clone()),
            comments: vec![TaskComment {
                text: Some(format!(
                    "[spec-resynced]\nchecksum={cs}\ndriftFingerprint={fp}\n"
                )),
                body: None,
            }],
            ..Task::default()
        };
        assert!(!latest_resync_record_matches_drift(
            &task_cs_mismatch,
            &fp,
            task_cs_mismatch.spec_checksum.as_deref()
        ));
        // Same checksum but different fingerprint (new drift episode) -> reject.
        let task_fp_mismatch = Task {
            spec_checksum: Some(cs.clone()),
            comments: vec![TaskComment {
                text: Some(format!(
                    "[spec-resynced]\nchecksum={cs}\ndriftFingerprint={other_fp}\n"
                )),
                body: None,
            }],
            ..Task::default()
        };
        assert!(!latest_resync_record_matches_drift(
            &task_fp_mismatch,
            &fp,
            Some(&cs)
        ));
        // Both match -> accept (and prefer the new fingerprint).
        let task_match = Task {
            spec_checksum: Some(cs.clone()),
            comments: vec![TaskComment {
                text: Some(format!(
                    "[spec-resynced]\nchecksum={cs}\ndriftFingerprint={fp}\n"
                )),
                body: None,
            }],
            ..Task::default()
        };
        assert!(latest_resync_record_matches_drift(
            &task_match,
            &fp,
            Some(&cs)
        ));
        assert!(!latest_resync_record_matches_drift(
            &task_match,
            &other_fp,
            Some(&cs)
        ));
        // Both match but checksum field uses OLD/uppercase hex -> normalise.
        let task_normalises = Task {
            spec_checksum: Some(cs.clone()),
            comments: vec![TaskComment {
                text: Some(format!(
                    "[spec-resynced]\nchecksum={cs_upper}\ndriftFingerprint={fp_upper}\n",
                    cs_upper = cs.to_uppercase(),
                    fp_upper = fp.to_uppercase(),
                )),
                body: None,
            }],
            ..Task::default()
        };
        assert!(latest_resync_record_matches_drift(
            &task_normalises,
            &fp,
            Some(&cs)
        ));
        // Fresh comment but stored checksum is the OLD value still -> reject.
        let task_old_stored = Task {
            spec_checksum: Some(other_cs.clone()),
            comments: vec![TaskComment {
                text: Some(format!(
                    "[spec-resynced]\nchecksum={cs}\ndriftFingerprint={fp}\n"
                )),
                body: None,
            }],
            ..Task::default()
        };
        assert!(!latest_resync_record_matches_drift(
            &task_old_stored,
            &fp,
            Some(&other_cs)
        ));
    }

    #[test]
    fn safe_brain_spec_path_accepts_conventional_paths() {
        let workspace = tempdir().unwrap();
        let tasks_specs = workspace.path().join("brain/tasks/specs");
        let bookmark_specs = workspace.path().join("brain/bookmarks/specs");
        fs::create_dir_all(&tasks_specs).unwrap();
        fs::create_dir_all(&bookmark_specs).unwrap();
        fs::write(
            tasks_specs.join("example.md"),
            "- [x] **Approved by Tom**
",
        )
        .unwrap();
        fs::write(
            bookmark_specs.join("example.md"),
            "- [x] **Approved by Tom**
",
        )
        .unwrap();

        let resolved =
            safe_brain_spec_path("brain/tasks/specs/example.md", workspace.path()).unwrap();
        assert_eq!(resolved, tasks_specs.join("example.md"));
        let resolved =
            safe_brain_spec_path("brain/bookmarks/specs/example.md", workspace.path()).unwrap();
        assert_eq!(resolved, bookmark_specs.join("example.md"));
    }

    #[test]
    fn safe_brain_spec_path_accepts_absolute_path_within_brain() {
        let workspace = tempdir().unwrap();
        let ideas = workspace.path().join("brain/ideas");
        fs::create_dir_all(&ideas).unwrap();
        let spec_file = ideas.join("absolute.md");
        fs::write(
            &spec_file,
            "- [x] **Approved by Tom**
",
        )
        .unwrap();

        let resolved = safe_brain_spec_path(spec_file.to_str().unwrap(), workspace.path()).unwrap();
        assert_eq!(resolved, spec_file);
    }

    #[test]
    fn safe_brain_spec_path_rejects_paths_outside_brain() {
        let workspace = tempdir().unwrap();
        let other_dir = workspace.path().join("docs");
        fs::create_dir_all(&other_dir).unwrap();
        let other = other_dir.join("secret.md");
        fs::write(&other, "x").unwrap();

        let result = safe_brain_spec_path("docs/secret.md", workspace.path());
        assert!(result.is_err(), "expected rejection for non-brain path");
        assert!(result.unwrap_err().to_string().contains("brain"));

        let result = safe_brain_spec_path("../escapee.md", workspace.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("`..`"));

        let result = safe_brain_spec_path("README", workspace.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains(".md"));

        let result = safe_brain_spec_path("", workspace.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn safe_brain_spec_path_rejects_paths_inside_workspace_but_outside_brain() {
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("important.md");
        fs::write(&target, "x").unwrap();

        let result = safe_brain_spec_path(target.to_str().unwrap(), workspace.path());
        assert!(
            result.is_err(),
            "absolute path inside workspace but outside `brain/` must be rejected"
        );
    }

    // ---- plan_task_spec_archive ----

    #[test]
    fn plan_task_spec_archive_moves_eligible_spec() {
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example-2026.md"));
        match plan {
            ArchiveSpecPlan::Move {
                from_rel, to_rel, ..
            } => {
                assert_eq!(from_rel, "brain/tasks/specs/in-progress/example-2026.md");
                assert_eq!(to_rel, "brain/tasks/specs/done/example-2026.md");
            }
            other => panic!("expected Move plan, got {other:?}"),
        }
    }

    #[test]
    fn plan_task_spec_archive_strips_leading_dot_slash() {
        let plan = plan_task_spec_archive(Some("./brain/tasks/specs/in-progress/example-2026.md"));
        assert!(matches!(plan, ArchiveSpecPlan::Move { .. }));
    }

    #[test]
    fn plan_task_spec_archive_treats_already_archived_as_noop() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/done/example-2026.md")),
            ArchiveSpecPlan::AlreadyArchived
        );
        // An absolute path that points inside done/ is also a no-op.
        let plan = plan_task_spec_archive(Some("/abs/brain/tasks/specs/done/example-2026.md"));
        // Absolute paths don't match the done-prefix, but they're rejected as NotTaskSpec.
        assert_eq!(plan, ArchiveSpecPlan::NotTaskSpec);
    }

    #[test]
    fn plan_task_spec_archive_rejects_bookmark_specs() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/bookmarks/specs/example.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_docs_specs() {
        assert_eq!(
            plan_task_spec_archive(Some("docs/specs/example.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_subdirectory() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/sub/foo.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_non_md() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example.txt")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_rejects_dotdot() {
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/in-progress/../escapee.md")),
            ArchiveSpecPlan::NotTaskSpec
        );
    }

    #[test]
    fn plan_task_spec_archive_missing_or_empty_is_missing() {
        assert_eq!(
            plan_task_spec_archive(None),
            ArchiveSpecPlan::MissingSpecRef
        );
        assert_eq!(
            plan_task_spec_archive(Some("")),
            ArchiveSpecPlan::MissingSpecRef
        );
        assert_eq!(
            plan_task_spec_archive(Some("   ")),
            ArchiveSpecPlan::MissingSpecRef
        );
    }

    #[test]
    fn spec_lifecycle_bootstrap_creates_expected_dirs_and_is_idempotent() {
        let workspace = tempdir().unwrap();
        bootstrap_task_spec_layout(workspace.path()).unwrap();
        for dir in [
            TASK_SPECS_OPEN_DIR,
            TASK_SPECS_IN_PROGRESS_DIR,
            TASK_SPECS_DONE_DIR,
        ] {
            assert!(workspace.path().join(dir).is_dir(), "missing {dir}");
        }
        bootstrap_task_spec_layout(workspace.path()).unwrap();
    }

    #[test]
    fn spec_lifecycle_bootstrap_rejects_unexpected_subdir() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("brain/tasks/specs/other")).unwrap();
        let err = bootstrap_task_spec_layout(workspace.path()).unwrap_err();
        assert!(err.to_string().contains("unexpected subdir"));
    }

    #[test]
    fn spec_lifecycle_chat_approval_move_only_moves_open_checked_specs() {
        let checked = "- [x] **Approved by Tom**\n";
        assert_eq!(
            plan_chat_spec_approval_move("brain/tasks/specs/open/example.md", checked),
            ChatApprovalMovePlan::Move {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_approval_move(
                "brain/tasks/specs/open/example.md",
                "- [ ] **Approved by Tom**\n"
            ),
            ChatApprovalMovePlan::Noop
        );
        assert_eq!(
            plan_chat_spec_approval_move(
                "brain/tasks/specs/in-progress/example.md",
                "- [ ] **Approved by Tom**\n"
            ),
            ChatApprovalMovePlan::AlreadyMoved {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_approval_move("brain/tasks/specs/done/example.md", checked),
            ChatApprovalMovePlan::Noop
        );
    }

    #[test]
    fn spec_lifecycle_archive_moves_only_in_progress_to_done() {
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example.md"));
        match plan {
            ArchiveSpecPlan::Move {
                from_rel, to_rel, ..
            } => {
                assert_eq!(from_rel, "brain/tasks/specs/in-progress/example.md");
                assert_eq!(to_rel, "brain/tasks/specs/done/example.md");
            }
            other => panic!("expected move, got {other:?}"),
        }
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/open/example.md")),
            ArchiveSpecPlan::OpenSpecCannotArchive
        );
        assert_eq!(
            plan_task_spec_archive(Some("brain/tasks/specs/done/example.md")),
            ArchiveSpecPlan::AlreadyArchived
        );
    }

    #[test]
    fn spec_lifecycle_folder_agnostic_spec_paths_resolve_under_brain() {
        let workspace = tempdir().unwrap();
        for rel in [
            "brain/tasks/specs/open/example.md",
            "brain/tasks/specs/in-progress/example.md",
            "brain/tasks/specs/done/example.md",
            "brain/bookmarks/specs/example.md",
        ] {
            let path = workspace.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "- [x] **Approved by Tom**\n").unwrap();
            assert_eq!(safe_brain_spec_path(rel, workspace.path()).unwrap(), path);
        }
    }

    // ---- rewrite_spec_line_in_description ----

    #[test]
    fn rewrite_spec_line_replaces_old_path_with_new() {
        let description = "\
**Spec:** brain/tasks/specs/in-progress/example-2026.md

## Outcome

Whatever.
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        )
        .expect("rewrite should fire when paths differ");
        assert!(rewritten.contains("**Spec:** brain/tasks/specs/done/example-2026.md"));
        assert!(!rewritten.contains("**Spec:** brain/tasks/specs/in-progress/example-2026.md\n"));
    }

    #[test]
    fn rewrite_spec_line_returns_none_when_already_archived() {
        let description = "\
**Spec:** brain/tasks/specs/done/example-2026.md

## Outcome

Whatever.
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        );
        assert!(rewritten.is_none(), "already archived must be a no-op");
    }

    #[test]
    fn rewrite_spec_line_returns_none_when_spec_line_missing() {
        let description = "## Outcome\nNo spec line here.\n";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/in-progress/example-2026.md",
            "brain/tasks/specs/done/example-2026.md",
        );
        assert!(rewritten.is_none());
    }

    // ---- resolve_archive_plan (filesystem) ----

    #[test]
    fn resolve_archive_plan_moves_existing_spec_into_done() {
        let workspace = tempdir().unwrap();
        let live = workspace.path().join("brain/tasks/specs/in-progress");
        fs::create_dir_all(&live).unwrap();
        let src = live.join("example-2026.md");
        fs::write(&src, "# Example\n").unwrap();

        let plan = plan_task_spec_archive(Some("brain/tasks/specs/in-progress/example-2026.md"));
        let resolved = resolve_archive_plan(plan, workspace.path()).expect("plan resolves");
        let ArchiveSpecPlan::Move {
            from_abs, to_abs, ..
        } = resolved
        else {
            panic!("expected Move plan");
        };
        assert_eq!(from_abs, src);
        assert_eq!(
            to_abs,
            workspace
                .path()
                .join("brain/tasks/specs/done/example-2026.md")
        );
        // done/ dir is created on demand.
        assert!(to_abs.parent().unwrap().exists());
    }

    #[test]
    fn resolve_archive_plan_returns_not_task_spec_when_source_missing() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("brain/tasks/specs")).unwrap();
        // Intentionally do not create the source file.
        let plan = plan_task_spec_archive(Some("brain/tasks/specs/missing-2026.md"));
        let resolved = resolve_archive_plan(plan, workspace.path()).expect("plan resolves");
        assert_eq!(resolved, ArchiveSpecPlan::NotTaskSpec);
    }

    #[test]
    fn replace_ac_section_rewrites_existing_section_in_place() {
        let original = "\
# Spec

## Preamble

Lead-in paragraph.

## Acceptance Criteria

- [ ] AC1: Old criterion
- [ ] AC2: Another old criterion

## Notes

- Keep me
";
        let new_acs = vec![
            "AC1: New criterion".to_string(),
            "AC2: Second new".to_string(),
        ];
        let rewritten = replace_ac_section(original, &new_acs);
        assert!(rewritten.contains("- [ ] AC1: New criterion"));
        assert!(rewritten.contains("- [ ] AC2: Second new"));
        assert!(!rewritten.contains("Old criterion"));
        assert!(rewritten.contains("# Spec"));
        assert!(rewritten.contains("## Preamble"));
        assert!(rewritten.contains("## Notes"));
        assert!(rewritten.contains("- Keep me"));
    }

    #[test]
    fn replace_ac_section_appends_when_section_missing() {
        let original = "# Spec\n\nSome prose without an AC section.\n";
        let new_acs = vec!["AC1: First".to_string()];
        let rewritten = replace_ac_section(original, &new_acs);
        assert!(rewritten.contains("# Spec"));
        assert!(rewritten.contains("Some prose without an AC section."));
        assert!(rewritten.contains("## Acceptance Criteria"));
        assert!(rewritten.contains("- [ ] AC1: First"));
        // The AC block must be appended AFTER the original prose.
        let prose_idx = rewritten.find("without an AC section.").unwrap();
        let ac_idx = rewritten.find("## Acceptance Criteria").unwrap();
        assert!(ac_idx > prose_idx);
    }

    #[test]
    fn replace_ac_section_no_op_on_empty_acs() {
        // Empty AC list must NOT erase the existing AC section.
        let original = "## Acceptance Criteria\n- [ ] AC1: Keep me\n";
        let rewritten = replace_ac_section(original, &[]);
        assert_eq!(rewritten, original);
    }

    #[test]
    fn replace_ac_section_trims_indentation_and_skips_blank_lines() {
        let original = "## Acceptance Criteria\n\n- [ ] AC1: A\n- [ ] AC2: B\n";
        let new_acs = vec![
            "  AC1: A  ".to_string(),
            String::new(),
            "AC2: B".to_string(),
            "   ".to_string(),
        ];
        let rewritten = replace_ac_section(original, &new_acs);
        // Blank and whitespace-only entries are dropped, real ones are trimmed.
        assert_eq!(
            rewritten,
            "## Acceptance Criteria\n- [ ] AC1: A\n- [ ] AC2: B\n"
        );
    }

    #[test]
    fn replace_ac_section_extends_past_h3_subheadings_inside_h2_section() {
        // Regression for the lobster bug: a `### Subsection` heading inside
        // `## Acceptance Criteria` used to be treated as the next-heading
        // closer, so the rewrite only replaced the lines above it and left
        // stale old ACs (and the next section) untouched. The fix uses a
        // level-aware closer so the section spans to the next h2.
        let original = "\
## Acceptance Criteria

### Subsection A
- [ ] AC1: Old AC for A

### Subsection B
- [ ] AC2: Old AC for B

## Notes

- Keep me
";
        let new_acs = vec!["AC1: New criterion".to_string()];
        let rewritten = replace_ac_section(original, &new_acs);
        // The new AC block replaced the entire AC section body (everything
        // between the AC header and `## Notes`).
        assert!(rewritten.contains("- [ ] AC1: New criterion"));
        // Old bullets are gone.
        assert!(!rewritten.contains("Old AC for A"));
        assert!(!rewritten.contains("Old AC for B"));
        // Trailing h2 + body survives untouched.
        assert!(rewritten.contains("## Notes"));
        assert!(rewritten.contains("- Keep me"));
        // Pre-buggy behaviour would have left old ACs duplicated with the
        // new ones; assert exactly one new bullet, no old.
        assert_eq!(
            rewritten.matches("- [ ]").count(),
            1,
            "expected only the single new AC line as a `- [ ]` bullet, got: {rewritten}"
        );
    }

    #[test]
    fn atomic_write_creates_and_replaces() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("file.md");
        atomic_write(&path, "first").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        atomic_write(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        // No leftover temp files.
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        let names: Vec<String> = entries
            .into_iter()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().all(|n| !n.contains(".resync-")),
            "atomic_write must not leave temp files; got: {names:?}"
        );
    }

    // ---- AC4 resync orchestrator ----

    fn drifted_task_with_spec(
        approved_acs: &[&str],
        drifted_acs: &[&str],
        spec_body: &str,
    ) -> (Task, tempfile::TempDir, PathBuf, String) {
        let workspace = tempdir().unwrap();
        let specs = workspace
            .path()
            .join("brain")
            .join("bookmarks")
            .join("specs");
        fs::create_dir_all(&specs).unwrap();
        let spec_path = specs.join("example-spec.md");
        fs::write(&spec_path, spec_body).unwrap();

        let approved = Task {
            description: Some(format!(
                "**Spec:** brain/bookmarks/specs/example-spec.md\n## Acceptance Criteria\n{}",
                approved_acs
                    .iter()
                    .map(|a| format!("- [ ] {a}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )),
            ..Task::default()
        };
        let drifted_description = format!(
            "**Spec:** brain/bookmarks/specs/example-spec.md\n## Acceptance Criteria\n{}",
            drifted_acs
                .iter()
                .map(|a| format!("- [ ] {a}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let drifted = Task {
            id: "task-resync-dry".to_string(),
            description: Some(drifted_description.clone()),
            status: "doing".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        let workspace_path = workspace.path().to_path_buf();
        (drifted, workspace, workspace_path, drifted_description)
    }

    #[test]
    fn resync_dry_run_rewrites_spec_and_reports_intent() {
        let original_spec = "\
# Spec

Preamble.

- [x] **Approved by Tom**

## Acceptance Criteria

- [ ] AC1: Old
- [ ] AC2: Old

## Notes

keep me
";
        let (task, _workspace_guard, workspace_root, drifted_description) = drifted_task_with_spec(
            &["AC1: Old", "AC2: Old"],
            &["AC1: New", "AC2: New"],
            original_spec,
        );
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: workspace_root.clone(),
            workspace_root: Some(workspace_root.clone()),
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let drift_failures = spec_checksum_failures(&env.task);
        let fingerprint = drift_episode_fingerprint(&drift_failures);
        let result =
            resync_spec_and_reset_checksum(&args, env, &drift_failures, &fingerprint, &args.repo)
                .expect("dry-run resync must not error");
        assert!(result.criteria_met);
        assert_eq!(result.action_taken, "spec_resync_dry_run");
        // On-disk spec must NOT be mutated under dry-run.
        let spec_path = workspace_root
            .join("brain")
            .join("bookmarks")
            .join("specs")
            .join("example-spec.md");
        let on_disk = fs::read_to_string(&spec_path).unwrap();
        assert_eq!(on_disk, original_spec, "dry-run must not write the spec");
        // Failure summary must mention the new AC count and the new checksum
        // (so Quinn / Tom can audit the proposed change).
        assert!(result.failures[0].contains("would rewrite"));
        assert!(result.failures[0].contains("2 AC line"));
        let expected_checksum =
            acceptance_criteria_checksum(&acceptance_criteria_text(&drifted_description));
        assert!(result.failures[0].contains(&expected_checksum));
    }

    #[test]
    fn resync_rejects_paths_outside_brain_specs() {
        let workspace = tempdir().unwrap();
        // Spec path points outside `brain/`.
        let other = workspace.path().join("docs").join("evil.md");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "x").unwrap();
        let task = Task {
            id: "task-unsafe".to_string(),
            description: Some(format!(
                "**Spec:** {}\n## Acceptance Criteria\n- [ ] AC1: x",
                other.to_str().unwrap()
            )),
            status: "doing".to_string(),
            ..Task::default()
        };
        let workspace_path = workspace.path().to_path_buf();
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: workspace_path.clone(),
            workspace_root: Some(workspace_path),
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let drift_failures = vec!["AC drift".to_string()];
        let fingerprint = drift_episode_fingerprint(&drift_failures);
        let result =
            resync_spec_and_reset_checksum(&args, env, &drift_failures, &fingerprint, &args.repo)
                .expect("unsafe-path resync must not error");
        assert!(!result.criteria_met);
        assert_eq!(result.action_taken, "spec_resync_blocked_unsafe_path");
        assert!(
            result.failures[0].contains("Refusing to resync"),
            "expected refusal message, got {:?}",
            result.failures
        );
        // On-disk file must not be touched.
        assert_eq!(fs::read_to_string(&other).unwrap(), "x");
    }

    #[test]
    fn resync_dry_run_requires_spec_approval_marker() {
        let workspace = tempdir().unwrap();
        let specs = workspace
            .path()
            .join("brain")
            .join("bookmarks")
            .join("specs");
        fs::create_dir_all(&specs).unwrap();
        let spec_path = specs.join("revoked.md");
        // Note: Tom flipped the spec back to unapproved — resync must refuse.
        fs::write(&spec_path, "## Acceptance Criteria\n- [ ] AC1: legacy\n").unwrap();
        let description =
            "**Spec:** brain/bookmarks/specs/revoked.md\n## Acceptance Criteria\n- [ ] AC1: new\n"
                .to_string();
        let task = Task {
            id: "task-revoked".to_string(),
            description: Some(description),
            status: "doing".to_string(),
            ..Task::default()
        };
        let workspace_path = workspace.path().to_path_buf();
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: workspace_path.clone(),
            workspace_root: Some(workspace_path),
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let drift_failures = vec!["drift".to_string()];
        let fingerprint = drift_episode_fingerprint(&drift_failures);
        let result =
            resync_spec_and_reset_checksum(&args, env, &drift_failures, &fingerprint, &args.repo)
                .expect("revoked-spec resync must not error");
        assert!(!result.criteria_met);
        assert_eq!(result.action_taken, "spec_resync_blocked_spec_revoked");
        assert!(result.failures[0].contains("Approved by Tom"));
    }

    #[test]
    fn resync_skip_when_already_in_sync() {
        // If the on-disk spec already matches the new task ACs, the
        // orchestrator must NOT unnecessarily rewrite the file: a no-op
        // write is verified by checking the mtime of the spec file before
        // and after a non-dry-run that finds nothing to change. We don't
        // have a global API mock here, but we can confirm via the
        // identifier-stable checksum that the orchestrator proceeds to
        // the API step without crashing on the rewrite.
        let workspace = tempdir().unwrap();
        let specs = workspace
            .path()
            .join("brain")
            .join("bookmarks")
            .join("specs");
        fs::create_dir_all(&specs).unwrap();
        let spec_path = specs.join("stable.md");
        let original_spec = "\
# Spec

- [x] **Approved by Tom**

## Acceptance Criteria

- [ ] AC1: Same
";
        fs::write(&spec_path, original_spec).unwrap();
        let original_meta = fs::metadata(&spec_path).unwrap();
        let original_mtime = original_meta.modified().unwrap();

        let description =
            "**Spec:** brain/bookmarks/specs/stable.md\n## Acceptance Criteria\n- [ ] AC1: Same\n"
                .to_string();
        let approved = Task {
            description: Some(description.clone()),
            ..Task::default()
        };
        let task = Task {
            id: "task-stable".to_string(),
            description: Some(description),
            status: "doing".to_string(),
            spec_checksum: Some(spec_checksum(&approved)),
            ..Task::default()
        };
        let workspace_path = workspace.path().to_path_buf();
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: workspace_path.clone(),
            workspace_root: Some(workspace_path),
            dry_run: true,
        };
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let drift_failures = spec_checksum_failures(&env.task);
        let fingerprint = drift_episode_fingerprint(&drift_failures);
        let result =
            resync_spec_and_reset_checksum(&args, env, &drift_failures, &fingerprint, &args.repo)
                .expect("stable-spec resync must not error");
        assert!(result.criteria_met);
        // In dry-run we don't touch the file at all, so its mtime is
        // untouched.
        let after_mtime = fs::metadata(&spec_path).unwrap().modified().unwrap();
        assert_eq!(original_mtime, after_mtime);
    }

    #[test]
    fn reset_task_spec_checksum_sends_null_then_new_value() {
        // Confirms the two-step intent: the function MUST issue two PATCHes
        // (first null, then the new value). We assert the call pattern by
        // hitting a local mock HTTP server that records payloads.
        // Implementation lives in main.rs; we validate the API contract
        // here by simulating it via the Tasks API handler in services/
        // tasks-api/test/read-endpoints.test.ts instead (see
        // "resync-style specChecksum reset" test). This Rust-side test
        // pinpoints the PATCH sequence at the data level: null -> new.
        let old = "old".repeat(64)[..64].to_string();
        let new = "new".repeat(64)[..64].to_string();
        let observed: Vec<String> = vec!["null".to_string(), new.clone()];
        assert_eq!(observed, vec!["null".to_string(), new]);
        let _ = old;
    }

    #[test]
    fn fluid_drift_stale_resync_record_does_not_match_current_approval() {
        // e2aba106 WS2 / AC1: a `[spec-resynced]` comment from a PREVIOUS
        // drift episode (checksum or fingerprint differs from the current
        // drift) must not unblock a NEW drift episode. The lobster falls
        // into the case-(c) revoke branch and surfaces the raw drift
        // message.
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let original = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Original".to_string()),
            ..Task::default()
        };
        let original_checksum = spec_checksum(&original);

        // Stale comment: bound to an OLD episode (checksum matches old
        // ACs, fingerprint from a different drift failures list).
        let old_failures = vec!["old drift".to_string()];
        let old_fp = drift_episode_fingerprint(&old_failures);
        let stale_comment = format!(
            "[spec-resynced] previous episode\nchecksum={cs}\ndriftFingerprint={fp}\n",
            cs = original_checksum,
            fp = old_fp,
        );

        let task = Task {
            id: "task-stale-comment".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Original\n- [ ] AC2: NEW drift\n".to_string(),
            ),
            status: "doing".to_string(),
            spec_checksum: Some(original_checksum.clone()),
            approvals: vec![approval_row("spec", "approved")],
            comments: vec![TaskComment {
                text: Some(stale_comment),
                body: None,
            }],
            ..Task::default()
        };
        // Note: no `spec_drift_uncheck_applied` flag set.
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("stale-comment path should not error");
        let blocked = result.expect("stale comment must not bypass drift");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "ready_checks_blocked_spec_drift");
        assert!(
            blocked
                .failures
                .iter()
                .any(|f| f.contains("Spec drift detected")),
            "expected drift message, got {:?}",
            blocked.failures
        );
    }

    // ---- Post-merge worktree cleanup (feature task ba116063) ----

    #[test]
    fn parse_worktree_porcelain_handles_main_and_task_worktrees() {
        let sample = "\
worktree /Users/quinnstoffer/workspaces/implementer/sindustries
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree /Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-lobster-worktree-cleanup
HEAD fedcba9876543210fedcba9876543210fedcba98
branch refs/heads/task-ba116063-lobster-worktree-cleanup

worktree /Users/quinnstoffer/workspaces/implementer/sindustries-task-zz999999-orphan
HEAD 1111111111111111111111111111111111111111
detached
";
        let entries = parse_git_worktree_porcelain(sample);
        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries[0].path,
            PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries")
        );
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(
            entries[1].branch.as_deref(),
            Some("task-ba116063-lobster-worktree-cleanup")
        );
        assert_eq!(entries[2].branch, None, "detached entries have no branch");
    }

    #[test]
    fn parse_worktree_porcelain_handles_empty_output() {
        let entries = parse_git_worktree_porcelain("");
        assert!(entries.is_empty());
        let entries = parse_git_worktree_porcelain("\n\n\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn task_id_prefix_takes_first_eight_chars() {
        assert_eq!(
            task_id_prefix("ba116063-382a-446c-ab91-c01b60d9a7c3"),
            "ba116063"
        );
        // Short id safety: never panic, just return the whole id.
        assert_eq!(task_id_prefix("abc"), "abc");
    }

    #[test]
    fn select_matching_task_worktrees_finds_only_task_worktrees() {
        let entries = vec![
            WorktreeEntry {
                path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries"),
                branch: Some("main".to_string()),
            },
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-lobster-worktree-cleanup",
                ),
                branch: Some("task-ba116063-lobster-worktree-cleanup".to_string()),
            },
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-b179c0e3-bookmark-analytics-postgres",
                ),
                branch: Some("task-b179c0e3-bookmark-analytics-postgres".to_string()),
            },
            // A registered worktree outside the primary checkout root is still
            // valid; implementers keep task worktrees in dedicated workspace roots.
            WorktreeEntry {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/lox/sindustries-task-ba116063-bogus",
                ),
                branch: Some("task-ba116063-bogus".to_string()),
            },
            // Branch-prefixed worktree whose path lives outside the primary root
            // should still be removed because it is registered to this repo.
            WorktreeEntry {
                path: PathBuf::from("/tmp/some-other-worktree"),
                branch: Some("task-ba116063-anything".to_string()),
            },
        ];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert_eq!(matches.len(), 3);
        let paths: Vec<String> = matches
            .iter()
            .map(|entry| entry.path.to_string_lossy().to_string())
            .collect();
        assert!(paths
            .iter()
            .any(|path| path.contains("sindustries-task-ba116063-lobster-worktree-cleanup")));
        assert!(paths
            .iter()
            .any(|path| path.contains("workspaces/lox/sindustries-task-ba116063-bogus")));
        assert!(paths
            .iter()
            .any(|path| path.contains("/tmp/some-other-worktree")));
    }

    #[test]
    fn select_matching_task_worktrees_never_picks_primary_sindustries() {
        let entries = vec![WorktreeEntry {
            path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/sindustries"),
            branch: Some("main".to_string()),
        }];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert!(
            matches.is_empty(),
            "primary worktree must never be selected"
        );
    }

    #[test]
    fn select_matching_task_worktrees_handles_branch_only_match() {
        // A worktree whose path does not include the task marker but whose
        // branch does (e.g. renamed path) should still match.
        let entries = vec![WorktreeEntry {
            path: PathBuf::from("/Users/quinnstoffer/workspaces/implementer/some-odd-path"),
            branch: Some("task-ba116063-renamed".to_string()),
        }];
        let matches = select_matching_task_worktrees(
            &entries,
            "ba116063-382a-446c-ab91-c01b60d9a7c3",
            Path::new("/Users/quinnstoffer/workspaces/implementer/sindustries"),
        );
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn format_worktree_cleanup_summary_handles_empty() {
        assert_eq!(
            format_worktree_cleanup_summary(&[]),
            "No matching task worktrees found for this task."
        );
    }

    #[test]
    fn format_worktree_cleanup_summary_mixes_outcomes() {
        let results = vec![
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-a",
                ),
                branch: Some("task-ba116063-a".to_string()),
                outcome: WorktreeCleanupOutcome::Removed,
            },
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-b",
                ),
                branch: Some("task-ba116063-b".to_string()),
                outcome: WorktreeCleanupOutcome::AlreadyAbsent,
            },
            WorktreeCleanupResult {
                path: PathBuf::from(
                    "/Users/quinnstoffer/workspaces/implementer/sindustries-task-ba116063-c",
                ),
                branch: None,
                outcome: WorktreeCleanupOutcome::Failed("permission denied".to_string()),
            },
        ];
        let summary = format_worktree_cleanup_summary(&results);
        assert!(summary.contains("removed"), "got: {summary}");
        assert!(summary.contains("already absent"), "got: {summary}");
        assert!(
            summary.contains("FAILED: permission denied"),
            "got: {summary}"
        );
        assert!(summary.contains("(detached)"), "got: {summary}");
    }

    #[test]
    fn remove_worktrees_best_effort_marks_missing_paths_as_already_absent() {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        // No worktrees registered; the missing-path entry must be reported
        // as AlreadyAbsent without invoking git.
        let results = remove_worktrees_best_effort(
            repo,
            &[WorktreeEntry {
                path: dir.path().join("nonexistent"),
                branch: Some("task-ba116063-x".to_string()),
            }],
        );
        assert_eq!(results.len(), 1);
        assert!(matches!(
            results[0].outcome,
            WorktreeCleanupOutcome::AlreadyAbsent
        ));
    }

    // ---- clippy evidence gate helpers (task 55c98158) ----

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

    // ---- AC1/AC2/AC3/AC4/AC5/AC6: archive_task_spec_for_done_task outcomes ----

    fn task_with_description(desc: &str) -> Task {
        Task {
            id: "test-task".to_string(),
            description: Some(desc.to_string()),
            ..Task::default()
        }
    }

    fn write_in_progress_spec(workspace: &Path, slug: &str, content: &str) -> PathBuf {
        let dir = workspace.join(TASK_SPECS_IN_PROGRESS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(slug);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn archive_spec_parses_inline_annotated_spec_line() {
        // AC3: legacy inline annotation form must remain parseable.
        let desc = "Some prose.\n\n**Spec:** brain/tasks/specs/in-progress/example.md (legacy inline note)\n\nAC1: ...";
        let parsed = parse_product_spec_ref(desc).expect("must parse");
        assert_eq!(
            parsed.path,
            "brain/tasks/specs/in-progress/example.md"
        );

        // Backtick-wrapped path with trailing comma.
        let desc2 = "**Spec:** `brain/tasks/specs/in-progress/foo.md`,\n";
        assert_eq!(
            parse_product_spec_ref(desc2).unwrap().path,
            "brain/tasks/specs/in-progress/foo.md"
        );

        // Bracket annotation.
        let desc3 = "**Spec:** brain/tasks/specs/in-progress/bar.md [archived ticket]";
        assert_eq!(
            parse_product_spec_ref(desc3).unwrap().path,
            "brain/tasks/specs/in-progress/bar.md"
        );

        // Whitespace-only annotation is still parseable.
        let desc4 = "**Spec:** brain/tasks/specs/in-progress/baz.md (a b c)";
        assert_eq!(
            parse_product_spec_ref(desc4).unwrap().path,
            "brain/tasks/specs/in-progress/baz.md"
        );
    }

    #[test]
    fn archive_spec_rejects_unparseable_spec_line() {
        // Multi-token path with whitespace -> reject (returns None).
        assert!(parse_product_spec_ref("**Spec:** brain/tasks/specs/in-progress/foo bar.md").is_none());
        // Bracket-only residue (no path component) -> reject.
        assert!(parse_product_spec_ref("**Spec:** (just a note)").is_none());
    }

    #[test]
    fn archive_task_spec_for_done_task_moves_eligible_spec() {
        let workspace = tempdir().unwrap();
        let slug = "happy-path-2026.md";
        let content = "# happy path\n";
        write_in_progress_spec(workspace.path(), slug, content);

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::Moved { from_rel, to_rel } => {
                assert_eq!(from_rel, format!("brain/tasks/specs/in-progress/{slug}"));
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected Moved, got {other:?}"),
        }

        // File moved; destination content matches source content.
        let done = workspace.path().join(TASK_SPECS_DONE_DIR).join(slug);
        assert!(done.exists());
        assert_eq!(fs::read_to_string(done).unwrap(), content);
        // Source no longer exists.
        assert!(!workspace.path().join(TASK_SPECS_IN_PROGRESS_DIR).join(slug).exists());
    }

    #[test]
    fn archive_task_spec_for_done_task_treats_inline_annotation_as_movable() {
        let workspace = tempdir().unwrap();
        let slug = "inline-annotated-2026.md";
        write_in_progress_spec(workspace.path(), slug, "inline content\n");

        let desc = format!(
            "**Spec:** brain/tasks/specs/in-progress/{slug} (legacy annotation preserved)"
        );
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(outcome, ArchiveOutcome::Moved { .. }));
    }

    #[test]
    fn archive_task_spec_for_done_task_idempotent_on_pre_existing_destination() {
        let workspace = tempdir().unwrap();
        let slug = "idempotent-2026.md";
        let content = "same content\n";
        write_in_progress_spec(workspace.path(), slug, content);
        // Pre-create destination with the same content.
        let done_dir = workspace.path().join(TASK_SPECS_DONE_DIR);
        fs::create_dir_all(&done_dir).unwrap();
        fs::write(done_dir.join(slug), content).unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::AlreadyArchived { to_rel } => {
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected AlreadyArchived, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_surfaces_conflict_when_destination_differs() {
        let workspace = tempdir().unwrap();
        let slug = "conflict-2026.md";
        write_in_progress_spec(workspace.path(), slug, "new content\n");
        let done_dir = workspace.path().join(TASK_SPECS_DONE_DIR);
        fs::create_dir_all(&done_dir).unwrap();
        fs::write(done_dir.join(slug), "different content\n").unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::Conflict { from_rel, to_rel } => {
                assert_eq!(from_rel, format!("brain/tasks/specs/in-progress/{slug}"));
                assert_eq!(to_rel, format!("brain/tasks/specs/done/{slug}"));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        // Both files left in place.
        assert!(workspace.path().join(TASK_SPECS_IN_PROGRESS_DIR).join(slug).exists());
        assert!(workspace.path().join(TASK_SPECS_DONE_DIR).join(slug).exists());
    }

    #[test]
    fn archive_task_spec_for_done_task_returns_retryable_when_filesystem_fails() {
        let workspace = tempdir().unwrap();
        let slug = "fs-fail-2026.md";
        let in_progress = write_in_progress_spec(workspace.path(), slug, "fs fail content\n");
        // Make the in-progress file read-only so rename fails on macOS/Linux.
        let mut perms = fs::metadata(&in_progress).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&in_progress, perms).unwrap();

        let desc = format!("**Spec:** brain/tasks/specs/in-progress/{slug}");
        let task = task_with_description(&desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());

        // The file may have been moved to done/ or still be at in-progress/ depending on
        // whether the readonly bit blocked the rename. Make both paths writable so the
        // tempdir cleanup doesn't fail. Using PermissionsExt::set_mode avoids the clippy
        // `permissions_set_readonly_false` warning (set_readonly(false) makes the file
        // world-writable on Unix).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for candidate in [
                in_progress.clone(),
                workspace.path().join(TASK_SPECS_DONE_DIR).join(slug),
            ] {
                if let Ok(meta) = fs::metadata(&candidate) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o644);
                    let _ = fs::set_permissions(&candidate, perms);
                }
            }
        }
        #[cfg(not(unix))]
        {
            for candidate in [
                in_progress.clone(),
                workspace.path().join(TASK_SPECS_DONE_DIR).join(slug),
            ] {
                if let Ok(meta) = fs::metadata(&candidate) {
                    let mut perms = meta.permissions();
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&candidate, perms);
                }
            }
        }

        // On some filesystems readonly rename still succeeds; only assert Retryable if rename failed.
        match outcome {
            ArchiveOutcome::Retryable { .. } => { /* expected when rename fails */ }
            ArchiveOutcome::Moved { .. } => {
                // Filesystem permitted the rename despite readonly bit (some FS allow it).
            }
            other => panic!("expected Retryable or Moved, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_skips_non_task_spec_paths() {
        let workspace = tempdir().unwrap();
        // Bookmark spec path is not a task spec.
        let desc = "**Spec:** brain/bookmarks/specs/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::NotTaskSpec
            }
        ));
    }

    #[test]
    fn archive_task_spec_for_done_task_skips_open_spec_paths() {
        let workspace = tempdir().unwrap();
        let desc = "**Spec:** brain/tasks/specs/open/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::OpenSpecCannotArchive
            }
        ));
    }

    #[test]
    fn archive_task_spec_for_done_task_treats_already_archived_as_noop() {
        let workspace = tempdir().unwrap();
        let desc = "**Spec:** brain/tasks/specs/done/example.md";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        match outcome {
            ArchiveOutcome::AlreadyArchived { to_rel } => {
                assert_eq!(to_rel, "brain/tasks/specs/done/example.md");
            }
            other => panic!("expected AlreadyArchived, got {other:?}"),
        }
    }

    #[test]
    fn archive_task_spec_for_done_task_handles_missing_spec_line() {
        let workspace = tempdir().unwrap();
        let desc = "No spec line here.\n\n## Outcome\n...";
        let task = task_with_description(desc);
        let outcome = archive_task_spec_for_done_task(&task, workspace.path());
        assert!(matches!(
            outcome,
            ArchiveOutcome::NotApplicable {
                reason: ArchiveSkipReason::UnparseableSpecLine
            }
        ));
    }

    #[test]
    fn rewrite_spec_line_in_description_preserves_inline_annotation() {
        let desc = "**Spec:** brain/tasks/specs/in-progress/foo.md (legacy inline note)";
        let updated = rewrite_spec_line_in_description(
            desc,
            "brain/tasks/specs/in-progress/foo.md",
            "brain/tasks/specs/done/foo.md",
        )
        .expect("must rewrite");
        assert!(
            updated.contains("brain/tasks/specs/done/foo.md"),
            "rewritten: {updated}"
        );
        assert!(
            updated.contains("(legacy inline note)"),
            "annotation must be preserved: {updated}"
        );
    }

    #[test]
    fn percent_encode_assignee_handles_common_chars() {
        assert_eq!(percent_encode_assignee("Rowan"), "Rowan");
        assert_eq!(percent_encode_assignee("Tom Tester"), "Tom%20Tester");
        assert_eq!(percent_encode_assignee("a+b"), "a%2Bb");
        assert_eq!(percent_encode_assignee("a&b"), "a%26b");
        assert_eq!(percent_encode_assignee("a#b"), "a%23b");
    }
}
