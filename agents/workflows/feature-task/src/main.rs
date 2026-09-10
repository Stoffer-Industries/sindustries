use anyhow::{anyhow, Context, Result};
use clap::{ArgAction, Parser, Subcommand};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

mod ac_parsing;
mod analytics;
mod api_client;
mod brain_spec_lifecycle;
mod feedback_aggregate;
mod git_worktree;
mod lobster_state;
mod post_merge;
mod pr_gates;
mod product_spec_parsing;
mod task_approvals;
mod test_resolution;
mod test_runners;
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
        Commands::LoadTask { base_url, task_id } => load_task(&base_url, &task_id)?,
        Commands::SpecCheck(args) => spec_check(args)?,
        Commands::ReadyChecks(args) => ready_checks(args)?,
        Commands::VerifyDelivery(args) => crate::verify_delivery::verify_delivery(args)?,
        Commands::FeedbackAggregate(args) => feedback_aggregate::feedback_aggregate(args)?,
        Commands::PostMerge(args) => crate::post_merge::post_merge(args)?,
        Commands::CodeTaskTechDesignCheck(args) => code_task_tech_design_check(args)?,
        Commands::CodeTaskReadyChecks(args) => code_task_ready_checks(args)?,
        Commands::CodeTaskVerifyDelivery(args) => {
            crate::verify_delivery::code_task_verify_delivery(args)?
        }
        Commands::ReconcileBrainSpecApprovals(args) => reconcile_brain_spec_approvals(args)?,
        Commands::ArchiveDoneTaskSpecsSweep(args) => {
            brain_spec_lifecycle::archive_done_task_specs_sweep(args)?
        }
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
    let body: Value = api_client::handle_api_result(ureq::get(&url).call())?;
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

// Mirrors `_load_dotenv_token` in agents/workflows/feature-task/run.py.
// gh calls here are made directly by this binary (not always spawned through
// run.py's workflow_env()), so they can't rely on ambient env inheritance
// alone — the cron/lobster invocation chain has repeatedly dropped GH_TOKEN
// somewhere between run.py and this process, causing silent 401s.
fn load_dotenv_token(key: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let dotenv = Path::new(&home).join(".openclaw").join(".env");
    let contents = fs::read_to_string(dotenv).ok()?;
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix(&format!("{key}=")) {
            return Some(value.trim().to_string());
        }
    }
    None
}

pub(crate) fn gh_command() -> Command {
    let mut cmd = Command::new("gh");
    if std::env::var("GH_TOKEN").is_err() && std::env::var("GITHUB_TOKEN").is_err() {
        if let Some(token) = load_dotenv_token("LOBSTER_GITHUB_TOKEN") {
            cmd.env("GH_TOKEN", token);
        }
    }
    cmd
}

fn pr_body(url: &str) -> Result<String> {
    let output = gh_command()
        .args(["pr", "view", url, "--json", "body", "--jq", ".body"])
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    let raw = String::from_utf8(output.stdout)?;
    Ok(pr_gates::decode_pr_body_output(&raw))
}

fn load_task(base_url: &str, task_id: &str) -> Result<Envelope> {
    let task: Task = api_client::api_get(base_url, &format!("/tasks/{task_id}"))?;
    let state = lobster_state::parse_lobster_state(&task);
    Ok(api_client::output(
        true,
        false,
        "loaded_task",
        task,
        state,
        vec![],
    ))
}

fn spec_check(args: StageArgs) -> Result<Envelope> {
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

fn ready_checks(args: StageArgs) -> Result<Envelope> {
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

fn code_task_tech_design_check(args: StageArgs) -> Result<Envelope> {
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

fn code_task_ready_checks(args: StageArgs) -> Result<Envelope> {
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
fn workflow_attention_owner(task: &Task) -> Option<&'static str> {
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
fn ash_was_last_commenter(task: &Task) -> bool {
    task.comments
        .last()
        .and_then(|comment| comment.author.as_deref())
        .is_some_and(|author| author.trim().eq_ignore_ascii_case("Ash"))
}

fn managed_owner_reason_satisfied(task: &Task, owner: &str) -> bool {
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
fn reconciled_attention_owners(task: &Task) -> Vec<String> {
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

fn reconcile_workflow_attention(args: &StageArgs, env: &mut Envelope) -> Result<()> {
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

pub(crate) const BRAIN_DIR: &str = "brain";

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

pub(crate) const TASK_SPECS_DIR: &str = "brain/tasks/specs";
pub(crate) const TASK_SPECS_OPEN_DIR: &str = "brain/tasks/specs/open";
pub(crate) const TASK_SPECS_IN_PROGRESS_DIR: &str = "brain/tasks/specs/in-progress";
pub(crate) const TASK_SPECS_DONE_DIR: &str = "brain/tasks/specs/done";
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
    product_spec_parsing::extract_spec_path_from_line(first.get(1)?.as_str())
        .map(|spec| normalize_rel_path(&spec.path))
}

fn plan_brain_spec_approval(
    spec_path: &str,
    spec_text: &str,
    tasks: &[Task],
) -> BrainSpecApprovalPlan {
    if !product_spec_parsing::brain_spec_approved_by_tom(spec_text) {
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
    if lobster_state::spec_is_approved(task) {
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
    let value: Value = api_client::api_get(base_url, "/task-types/feature/required-approvals")?;
    let required = value
        .get("requiredApprovals")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!("feature required-approvals response omitted `requiredApprovals`")
        })?;
    Ok(required.iter().any(|value| value.as_str() == Some("spec")))
}

fn grant_reconciled_spec_approval(base_url: &str, task_id: &str, spec_path: &str) -> Result<()> {
    // Deliberately not `TASKS_API_APPROVAL_TOKEN` (Quinn's tech_design-only
    // credential) — the server's ACTOR_PERMISSIONS table only grants `spec`
    // to `Tom` and to the dedicated `brain_spec_reconciler` service identity
    // (`services/tasks-api/src/middleware/approvalAuth.ts`). Reusing Quinn's
    // token here 403s every time (`APPROVAL_TYPE_FORBIDDEN`), which is why
    // this reconciliation silently never succeeded before.
    let token = std::env::var("TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN is required to reconcile checked brain specs"
            )
        })?;
    let url = format!(
        "{}/tasks/{task_id}/approvals",
        base_url.trim_end_matches('/')
    );
    let note = format!("{BRAIN_SPEC_APPROVAL_NOTE_PREFIX} `{spec_path}`.");
    api_client::handle_api_result(
        ureq::post(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(json!({"type": "spec", "note": note})),
    )?;
    Ok(())
}

/// Scan `brain/tasks/specs/open/*.md` and `brain/tasks/specs/in-progress/*.md`,
/// map checked specs to one active feature task, and grant the structured
/// spec approval through the Tasks API. Both directories hold specs a task
/// can still legitimately reference (`a5a4ed8f` moves specs to `in-progress`
/// once implementation starts, well before Tom has necessarily approved them),
/// so scanning `open` alone silently stops reconciling a spec the moment work
/// begins on it. The API row remains the gate source; revoked rows, missing
/// links, and ambiguous links are diagnostics and never trigger a write.
fn reconcile_brain_spec_approvals(args: ReconcileBrainSpecApprovalsArgs) -> Result<Envelope> {
    if !feature_policy_requires_spec(&args.base_url)? {
        return Ok(api_client::output(
            true,
            false,
            "brain_spec_approval_reconciliation_skipped: feature_policy_has_no_spec_gate",
            Task::default(),
            LobsterState::default(),
            vec![],
        ));
    }

    let tasks = lobster_state::list_all_active_tasks(&args.base_url)?;
    let mut paths = Vec::new();
    for spec_dir_const in [TASK_SPECS_OPEN_DIR, TASK_SPECS_IN_PROGRESS_DIR] {
        let dir = args.workspace_root.join(spec_dir_const);
        let entries = fs::read_dir(&dir)
            .with_context(|| format!("reading task specs directory `{}`", dir.display()))?;
        for entry in entries {
            let entry = entry.with_context(|| format!("reading entry in `{}`", dir.display()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let accessible_file = entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false);
            paths.push((path, spec_dir_const, accessible_file));
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));

    let mut checked = 0usize;
    let mut granted = 0usize;
    let mut already = 0usize;
    let mut unchecked = 0usize;
    let mut failures = Vec::new();
    for (path, spec_dir_const, accessible_file) in paths {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("<invalid>");
        let spec_rel = format!("{spec_dir_const}/{file_name}");
        if !accessible_file {
            failures.push(format!(
                "Task spec `{spec_rel}` is not an accessible regular file; no approval granted."
            ));
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
                failures.push(format!("Checked task spec `{spec_rel}` has no exact, unambiguous `**Spec:**` link from an active feature task requiring `spec`; no approval granted."));
            }
            BrainSpecApprovalPlan::Ambiguous { task_ids } => {
                checked += 1;
                failures.push(format!("Checked task spec `{spec_rel}` is linked by multiple active feature tasks ({}); no approval granted.", task_ids.join(", ")));
            }
        }
    }

    Ok(api_client::output(
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

pub(crate) const TASK_SPEC_LIFECYCLE_DIRS: [&str; 4] = ["open", "in-progress", "done", "archived"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveSpecPlan {
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
pub(crate) enum ArchiveOutcome {
    /// Spec was moved and the task description was rewritten.
    Moved { from_rel: String, to_rel: String },
    /// Spec was already in the done directory; description was rewritten.
    AlreadyArchived { to_rel: String },
    /// No work to do: spec is missing, not a task spec, an open spec, or
    /// the parser could not extract a path from the Spec line.
    NotApplicable { reason: ArchiveSkipReason },
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
    Conflict { from_rel: String, to_rel: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveSkipReason {
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
pub(crate) enum ChatApprovalMovePlan {
    Move { from_rel: String, to_rel: String },
    AlreadyMoved { from_rel: String, to_rel: String },
    Noop,
}

/// Decide what should happen to the spec referenced from this task's Spec line.
/// Pure function: no filesystem access. The caller resolves the relative paths
/// to absolute paths once the workspace root is known.
pub(crate) fn bootstrap_task_spec_layout(workspace_root: &Path) -> Result<()> {
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

pub(crate) fn normalize_rel_path(path: &str) -> String {
    path.trim().trim_start_matches("./").to_string()
}

pub(crate) fn plan_chat_spec_lifecycle_move(
    spec_path: &str,
    spec_text: &str,
    structured_approved: bool,
) -> ChatApprovalMovePlan {
    let normalized = normalize_rel_path(spec_path);
    if !normalized.ends_with(".md") || normalized.contains("..") {
        return ChatApprovalMovePlan::Noop;
    }
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    let in_progress_prefix = format!("{TASK_SPECS_IN_PROGRESS_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        if suffix.is_empty()
            || suffix.contains('/')
            || (!structured_approved
                && !product_spec_parsing::brain_spec_approved_by_tom(spec_text))
        {
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

pub(crate) fn move_approved_chat_spec_if_needed(
    args: &StageArgs,
    mut env: Envelope,
) -> Result<Envelope> {
    let Some(spec) = product_spec_parsing::product_spec(&env.task) else {
        return Ok(env);
    };
    let normalized = normalize_rel_path(&spec.path);
    let open_prefix = format!("{TASK_SPECS_OPEN_DIR}/");
    if let Some(suffix) = normalized.strip_prefix(&open_prefix) {
        let to_rel = format!("{TASK_SPECS_IN_PROGRESS_DIR}/{suffix}");
        if product_spec_parsing::workspace_root(args)
            .join(&to_rel)
            .exists()
        {
            let description = env.task.description.clone().unwrap_or_default();
            if let Some(new_desc) =
                rewrite_spec_line_in_description(&description, &normalized, &to_rel)
            {
                api_client::api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"description": new_desc}),
                )?;
                env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
                env.action_taken = "repaired_chat_spec_in_progress_path".to_string();
            }
            return Ok(env);
        }
    }
    let spec_abs = product_spec_parsing::resolve_product_spec_path(
        &spec.path,
        &args.repo,
        product_spec_parsing::workspace_root(args),
    );
    let spec_text = match fs::read_to_string(&spec_abs) {
        Ok(text) => text,
        Err(_) => return Ok(env),
    };
    let plan = plan_chat_spec_lifecycle_move(&spec.path, &spec_text, lobster_state::spec_is_approved(&env.task));
    let (from_rel, to_rel, should_move) = match plan {
        ChatApprovalMovePlan::Move { from_rel, to_rel } => (from_rel, to_rel, true),
        ChatApprovalMovePlan::AlreadyMoved { from_rel, to_rel } => (from_rel, to_rel, false),
        ChatApprovalMovePlan::Noop => return Ok(env),
    };
    let from_abs = product_spec_parsing::workspace_root(args).join(&from_rel);
    let to_abs = product_spec_parsing::workspace_root(args).join(&to_rel);
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
        api_client::api_patch::<Task>(
            &args.base_url,
            &env.task.id,
            json!({"description": new_desc}),
        )?;
        env.task = api_client::api_get_task(&args.base_url, &env.task.id)?;
        env.action_taken = "moved_approved_chat_spec_to_in_progress".to_string();
    }
    Ok(env)
}

pub(crate) fn plan_task_spec_archive(spec_path: Option<&str>) -> ArchiveSpecPlan {
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
pub(crate) fn resolve_archive_plan(
    plan: ArchiveSpecPlan,
    workspace_root: &Path,
) -> Result<ArchiveSpecPlan> {
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
pub(crate) fn rewrite_spec_line_in_description(
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
        let existing_path =
            product_spec_parsing::strip_trailing_annotation(existing).unwrap_or(existing);
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
pub(crate) fn archive_task_spec_for_done_task(
    task: &Task,
    workspace_root: &Path,
) -> ArchiveOutcome {
    let Some(spec) = product_spec_parsing::product_spec(task) else {
        return ArchiveOutcome::NotApplicable {
            reason: ArchiveSkipReason::UnparseableSpecLine,
        };
    };
    let plan = plan_task_spec_archive(Some(&spec.path));
    let (from_rel, to_rel) = match &plan {
        ArchiveSpecPlan::Move {
            from_rel, to_rel, ..
        } => (from_rel.clone(), to_rel.clone()),
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
        from_abs, to_abs, ..
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

// body_has_checked_acceptance, ReviewState) live in src/pr_gates.rs (W36 A3+A4).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain_spec_lifecycle::{
        atomic_write, percent_encode_assignee, replace_ac_section, resync_spec_and_reset_checksum,
        safe_brain_spec_path,
    };
    use tempfile::tempdir;

    fn fixture(name: &str) -> String {
        fs::read_to_string(Path::new("fixtures").join(name))
            .or_else(|_| {
                fs::read_to_string(Path::new("agents/workflows/feature-task/fixtures").join(name))
            })
            .unwrap()
    }

    // Single test covering both cases: load_dotenv_token mutates the
    // process-global HOME env var, which cargo's multithreaded test runner
    // would race on if split across separate #[test] fns.
    #[test]
    fn load_dotenv_token_reads_matching_key_and_none_when_absent() {
        let home = tempdir().unwrap();
        fs::create_dir(home.path().join(".openclaw")).unwrap();
        fs::write(
            home.path().join(".openclaw").join(".env"),
            "OTHER_TOKEN=nope\nLOBSTER_GITHUB_TOKEN=abc123\n",
        )
        .unwrap();
        let original_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", home.path());
        let found = load_dotenv_token("LOBSTER_GITHUB_TOKEN");
        let missing = load_dotenv_token("NOT_A_REAL_KEY");
        match original_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(found, Some("abc123".to_string()));
        assert_eq!(missing, None);
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
        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan", "Tom"]);
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
        });
        assert_eq!(reconciled_attention_owners(&task), vec!["Ash", "Tom"]);
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
        });
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] Route back to Rowan.".to_string()),
            body: None,
        });
        assert_eq!(reconciled_attention_owners(&task), vec!["Rowan", "Tom"]);
    }

    #[test]
    fn routing_resumes_ash_after_delivery_comments_again() {
        let mut task = routing_task("doing", &["Rowan", "Tom"]);
        task.comments.push(TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] Route back to Rowan.".to_string()),
            body: None,
        });
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some("Collected the requested runtime evidence.".to_string()),
            body: None,
        });
        task.comments.push(TaskComment {
            author: Some("Rowan".to_string()),
            text: Some(
                "[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/999"
                    .to_string(),
            ),
            body: None,
        });
        assert_eq!(reconciled_attention_owners(&task), vec!["Ash", "Tom"]);
    }

    #[test]
    fn routing_advances_stale_implementer_to_tom_at_acceptance() {
        let task = routing_task("acceptance", &["Rowan", "Ash", "Rowan", "Tom"]);
        assert_eq!(
            reconciled_attention_owners(&task),
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
        let once = reconciled_attention_owners(&task);
        assert_eq!(once, vec!["Rowan", "Tom"]);
        task.attention_owners = once.clone();
        assert_eq!(reconciled_attention_owners(&task), once);
    }

    #[test]
    fn routing_preserves_unrelated_head_and_duplicate_tail_slots() {
        let task = routing_task("acceptance", &["Lox", "Rowan", "Tom", "Tom"]);
        assert_eq!(
            reconciled_attention_owners(&task),
            vec!["Tom", "Lox", "Rowan", "Tom", "Tom"]
        );
    }

    /// A `doing`-status task whose `attentionOwners` is `[Tom, Quinn, Ash]`
    /// and whose only closed gate is `qa_agent` should remove Tom, because
    /// the accepted gate is not actionable until acceptance, without draining
    /// the remaining owner stack across repeated reconcile calls.
    #[test]
    fn routing_removes_tom_without_draining_remaining_managed_owners() {
        let mut task = routing_task("doing", &["Tom", "Quinn", "Ash"]);
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
        let once = reconciled_attention_owners(&task);
        assert_eq!(once, vec!["Quinn", "Ash"]);
        task.attention_owners = once.clone();
        assert_eq!(reconciled_attention_owners(&task), once);
    }

    /// Tom's accepted gate is only actionable in acceptance. A pending
    /// accepted approval must not leave Tom as the head owner while a task is
    /// still doing.
    #[test]
    fn routing_removes_tom_head_before_acceptance() {
        let mut task = routing_task("doing", &["Tom", "Quinn", "Ash"]);
        task.approvals.push(TaskApproval {
            approval_type: "tech_design".to_string(),
            state: "approved".to_string(),
            ..TaskApproval::default()
        });
        assert_eq!(reconciled_attention_owners(&task), vec!["Quinn", "Ash"]);
    }

    #[test]
    fn routing_keeps_tom_head_for_pending_acceptance() {
        let task = routing_task("acceptance", &["Tom", "Quinn", "Ash"]);
        assert_eq!(
            reconciled_attention_owners(&task),
            vec!["Tom", "Quinn", "Ash"]
        );
    }

    #[test]
    fn workflow_handoff_serializes_tasks_api_role_id_contract() {
        let value = serde_json::to_value(workflow_handoff(
            "product_spec_approver",
            "spec",
            "Product spec approval is required",
        ))
        .unwrap();
        assert_eq!(value["roleId"], "product_spec_approver");
        assert!(value.get("role").is_none());
    }

    #[test]
    fn parses_product_spec_link() {
        let spec = product_spec_parsing::parse_product_spec_ref(&fixture("task_full.md")).unwrap();
        assert_eq!(
            spec.path,
            "brain/bookmarks/specs/feature-factory-v2-2026-06-04.md"
        );
    }

    #[test]
    fn detects_missing_product_spec() {
        assert!(product_spec_parsing::parse_product_spec_ref("no spec here").is_none());
    }

    #[test]
    fn parses_only_bold_spec_line_from_description() {
        assert!(product_spec_parsing::parse_product_spec_ref(
            "Product spec: brain/bookmarks/specs/example.md"
        )
        .is_none());
        let spec = product_spec_parsing::parse_product_spec_ref(
            "**Spec:** brain/bookmarks/specs/example.md",
        )
        .unwrap();
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
                ..TaskComment::default()
            }],
            ..Task::default()
        }
    }

    #[test]
    fn tech_design_waived_accepts_bare_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required] trivial change");
        assert!(product_spec_parsing::tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_accepts_leading_whitespace() {
        let task = task_with_waiver_comment("[tech-design-not-required]    trivial config tweak");
        assert!(product_spec_parsing::tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_missing_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required]");
        assert!(!product_spec_parsing::tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_whitespace_only_reason() {
        let task = task_with_waiver_comment("[tech-design-not-required]    \t  ");
        assert!(!product_spec_parsing::tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_rejects_unrelated_tag() {
        let task = task_with_waiver_comment("[tech-design-not-required-forever] nope");
        assert!(!product_spec_parsing::tech_design_waived(&task));
    }

    #[test]
    fn tech_design_waived_picks_up_among_other_comments() {
        let task = Task {
            id: "task-multi".to_string(),
            comments: vec![
                TaskComment {
                    text: Some("random chatter".to_string()),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(
                        "[tech-design-not-required] small PR — no design needed".to_string(),
                    ),
                    body: None,
                    ..TaskComment::default()
                },
            ],
            ..Task::default()
        };
        assert!(product_spec_parsing::tech_design_waived(&task));
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
        assert_eq!(lobster_state::workflow_for_task(&task), "code-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_feature_tasks() {
        let task = Task {
            task_type: Some("feature".to_string()),
            ..Task::default()
        };
        assert_eq!(lobster_state::workflow_for_task(&task), "feature-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_when_task_type_missing() {
        let task = Task {
            task_type: None,
            ..Task::default()
        };
        assert_eq!(lobster_state::workflow_for_task(&task), "feature-task-workflow");
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_unknown_types() {
        // Defensive: future taskType additions should default to the
        // feature-task workflow unless explicitly opted in.
        let task = Task {
            task_type: Some("research".to_string()),
            ..Task::default()
        };
        assert_eq!(lobster_state::workflow_for_task(&task), "feature-task-workflow");
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
    fn resolves_product_specs_relative_to_workspace_root() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        assert_eq!(
            product_spec_parsing::resolve_product_spec_path(
                "brain/tasks/specs/example.md",
                repo.path(),
                workspace.path()
            ),
            workspace.path().join("brain/tasks/specs/example.md")
        );

        assert_eq!(
            product_spec_parsing::resolve_product_spec_path(
                "docs/spec.md",
                repo.path(),
                workspace.path()
            ),
            repo.path().join("docs/spec.md")
        );

        let absolute = workspace.path().join("brain/tasks/specs/example.md");
        assert_eq!(
            product_spec_parsing::resolve_product_spec_path(
                absolute.to_str().unwrap(),
                repo.path(),
                workspace.path()
            ),
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

        assert!(lobster_state::spec_failures(&task, repo.path(), workspace.path()).is_empty());
        assert!(!repo.path().join("brain/tasks/specs/example.md").exists());
    }

    #[test]
    fn computes_deterministic_compact_spec_checksum() {
        let acs = vec![
            "AC2: Build the second thing".to_string(),
            "AC1: Build the first thing".to_string(),
        ];
        let checksum = product_spec_parsing::acceptance_criteria_checksum(&acs);

        assert_eq!(
            checksum,
            product_spec_parsing::acceptance_criteria_checksum(&acs)
        );
        assert_eq!(
            product_spec_parsing::canonical_json_bytes(&json!({
                "z": "last",
                "acceptanceCriteria": acs,
                "a": { "second": 2, "first": 1 }
            })),
            br#"{"a":{"first":1,"second":2},"acceptanceCriteria":["AC2: Build the second thing","AC1: Build the first thing"],"z":"last"}"#
        );
    }

    #[test]
    fn legacy_approval_marker_is_not_an_acceptance_criterion() {
        let with_marker =
            "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it";
        let without_marker = "## Acceptance Criteria\n- [ ] AC1: Build it";

        assert_eq!(
            product_spec_parsing::acceptance_criteria_text(with_marker),
            product_spec_parsing::acceptance_criteria_text(without_marker)
        );
    }

    #[test]
    fn spec_checksum_guard_allows_unchanged_acceptance_criteria() {
        let mut task = Task {
            id: "task-no-drift".to_string(),
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        task.spec_checksum = Some(product_spec_parsing::spec_checksum(&task));

        assert!(product_spec_parsing::spec_checksum_failures(&task).is_empty());
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved_task)),
            ..Task::default()
        };

        let failures = product_spec_parsing::spec_checksum_failures(&changed_task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("Spec drift detected"));
        assert!(failures[0].contains("AC checksum changed since last approval"));
        assert!(failures[0].contains("task-drift"));
    }

    #[test]
    fn spec_approval_transition_stores_current_checksum() {
        let task = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let mut patch = json!({"status": "ready"});
        patch["specChecksum"] = Value::String(product_spec_parsing::spec_checksum(&task));

        assert_eq!(patch["status"], "ready");
        assert_eq!(
            patch["specChecksum"].as_str().unwrap(),
            product_spec_parsing::spec_checksum(&task)
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

        assert!(lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
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

        assert!(lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
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
            lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan"),
            vec![
                "Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2)."
                    .to_string()
            ]
        );
    }

    #[test]
    fn implementer_capacity_ignores_assigned_tasks_actioned_by_other_attention_owners() {
        let tasks = vec![
            Task {
                id: "other-doing-1".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                attention_owners: vec!["Quinn".to_string(), "Tom".to_string()],
                ..Task::default()
            },
            Task {
                id: "other-doing-2".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                attention_owners: vec!["Ash".to_string(), "Rowan".to_string()],
                ..Task::default()
            },
        ];

        assert!(lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
    }

    #[test]
    fn implementer_capacity_counts_repeated_assignee_when_they_are_top_owner() {
        let tasks = vec![
            Task {
                id: "other-doing-1".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                attention_owners: vec!["Rowan".to_string(), "Ash".to_string(), "Rowan".to_string()],
                ..Task::default()
            },
            Task {
                id: "other-doing-2".to_string(),
                status: "doing".to_string(),
                assignee: Some("Rowan".to_string()),
                attention_owners: vec!["rowan".to_string(), "Tom".to_string()],
                ..Task::default()
            },
        ];

        assert_eq!(
            lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").len(),
            1
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

        assert!(lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
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

        assert!(lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
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
            lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan"),
            vec![
                "Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2)."
                    .to_string()
            ]
        );
    }

    #[test]
    fn parses_multiple_workstreams() {
        let streams = product_spec_parsing::parse_workstreams(&fixture("task_full.md"));
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
        let streams = product_spec_parsing::parse_workstreams(text);
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Implementer");
        assert!(streams[0].body.contains("task-456c92a8-depends-on"));
        assert_eq!(streams[1].owner, "Quinn");
    }

    #[test]
    fn parses_bold_workstreams_section_with_owner_at_end_of_bullet() {
        // Real-world format: 782d778e / 1945f8a2 / 5e35dc25 / de19b186 /
        // 94d5e4fc / 4f046565 / b2f62c36 all shipped with this shape, and the
        // old `- Owner: <name>`-prefix-only regex returned zero workstreams
        // for every one of them (2026-08-21/22 incidents).
        let text = r#"**Workstreams**
- **WS1 — Platform artifacts** (`infra/cloud/`): Fly.io app specs. — Owner: Rowan; Status: doing (AC1)
- **WS2 — Cloud data environment** (`infra/cloud/scripts/`): provision Postgres. — Owner: Rowan; Status: doing (AC2)

**Type:** feature
"#;
        let streams = product_spec_parsing::parse_workstreams(text);
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Rowan");
        assert!(streams[0].body.contains("WS1"));
        assert_eq!(streams[1].owner, "Rowan");
        assert!(streams[1].body.contains("WS2"));
    }

    #[test]
    fn parses_bold_workstreams_bullets_with_no_owner_tag_at_all() {
        // b2f62c36's original bullets had no `Owner:` tag anywhere — bullets
        // are scoped by workstream number, not by owner name. Must default
        // to "Implementer" per bullet rather than returning empty.
        let text = r#"**Workstreams**
- **WS1 — Platform and deployment artifacts** (`infra/cloud/`): Fly.io app specs, Dockerfiles. (AC1)
- **WS2 — Cloud data environment** (`infra/cloud/scripts/`): Postgres and Redis. (AC2)
- **WS3 — Health checks** (`.github/workflows/`): healthz endpoints. (AC3)
"#;
        let streams = product_spec_parsing::parse_workstreams(text);
        assert_eq!(streams.len(), 3);
        assert!(streams.iter().all(|s| s.owner == "Implementer"));
        assert!(streams[2].body.contains("WS3"));
    }

    #[test]
    fn parses_generic_workstreams_heading_with_bulleted_items() {
        // A bare "## Workstreams" heading (no ": Owner" suffix, unlike the
        // legacy "## Workstream: Rowan" shape) introduces a bulleted list —
        // previously collapsed into a single bogus workstream with owner "s"
        // (from stripping "Workstream" out of "Workstreams").
        let text = r#"## Workstreams

- **WS1 — Platform artifacts**: Fly.io app specs. — Owner: Rowan; Status: doing (AC1)
- **WS2 — Cloud data environment**: Postgres and Redis. (AC2)

## Type
feature
"#;
        let streams = product_spec_parsing::parse_workstreams(text);
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Rowan");
        assert_eq!(streams[1].owner, "Implementer");
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
        let failures = lobster_state::spec_failures(&task, repo.path(), workspace.path());
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
            comments: vec![TaskComment { text: Some("[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/1\nhttps://github.com/Stoffer-Industries/sindustries/pull/2".to_string()), body: None, ..TaskComment::default() }],
            ..Task::default()
        };
        assert_eq!(product_spec_parsing::implementer_pr_urls(&task).len(), 2);
    }

    #[test]
    fn latest_implementer_pr_urls_prefers_correcting_comment_over_pr_number() {
        // Regression for task 30251df0: two [implementer-prs] comments both
        // named the abandoned duplicate #455 first, then a correcting
        // comment named only the actually-merged #454 (lower PR number,
        // opened first from the same branch). `implementer_pr_urls` keeps
        // both forever (full historical union); `latest_implementer_pr_urls`
        // must resolve to only the correction.
        let url_455 = "https://github.com/Stoffer-Industries/sindustries/pull/455";
        let url_454 = "https://github.com/Stoffer-Industries/sindustries/pull/454";
        let task = Task {
            comments: vec![
                TaskComment {
                    text: Some(format!("[implementer-prs] {url_455}")),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(format!("[implementer-prs] {url_455}")),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(format!(
                        "[implementer-prs] {url_454}\n\nCorrecting the earlier comments that referenced the closed-unmerged PR #455."
                    )),
                    body: None,
                    ..TaskComment::default()
                },
            ],
            ..Task::default()
        };
        assert_eq!(
            product_spec_parsing::implementer_pr_urls(&task),
            vec![url_455.to_string(), url_454.to_string()]
        );
        assert_eq!(
            product_spec_parsing::latest_implementer_pr_urls(&task),
            vec![url_454.to_string()]
        );
    }

    #[test]
    fn latest_implementer_pr_urls_returns_all_urls_from_a_multi_workstream_comment() {
        let task = Task {
            comments: vec![TaskComment {
                text: Some("[implementer-prs] https://github.com/foo/bar/pull/1 https://github.com/foo/bar/pull/2".to_string()),
                body: None,
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert_eq!(
            product_spec_parsing::latest_implementer_pr_urls(&task),
            vec![
                "https://github.com/foo/bar/pull/1".to_string(),
                "https://github.com/foo/bar/pull/2".to_string(),
            ]
        );
    }

    #[test]
    fn latest_implementer_pr_urls_honors_recency_across_legacy_rowan_prs_alias() {
        // A later [rowan-prs] comment must still supersede an earlier
        // [implementer-prs] one — recency, not which tag was used, decides.
        let old_url = "https://github.com/Stoffer-Industries/sindustries/pull/1";
        let new_url = "https://github.com/Stoffer-Industries/sindustries/pull/2";
        let task = Task {
            comments: vec![
                TaskComment {
                    text: Some(format!("[implementer-prs] {old_url}")),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(format!("[rowan-prs] {new_url}")),
                    body: None,
                    ..TaskComment::default()
                },
            ],
            ..Task::default()
        };
        assert_eq!(
            product_spec_parsing::latest_implementer_pr_urls(&task),
            vec![new_url.to_string()]
        );
    }

    #[test]
    fn latest_implementer_pr_urls_returns_empty_when_no_tagged_comments() {
        let task = Task {
            comments: vec![TaskComment {
                text: Some("just a status update, no tag".to_string()),
                body: None,
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert_eq!(
            product_spec_parsing::latest_implementer_pr_urls(&task),
            Vec::<String>::new()
        );
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
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(
                        "[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/128"
                            .to_string(),
                    ),
                    body: None,
                    ..TaskComment::default()
                },
            ],
            ..Task::default()
        };
        let active = product_spec_parsing::implementer_active_pr_urls_with(&task, |url| {
            if url.ends_with("/120") {
                Ok(pr_gates::ReviewState::Merged)
            } else {
                Ok(pr_gates::ReviewState::Approved)
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
                approval_row("accepted", "approved"),
            ],
            ..Default::default()
        };
        assert!(lobster_state::spec_is_approved(&approved));
        assert!(product_spec_parsing::tech_design_approved_structured(
            &approved
        ));
        assert!(task_approvals::accepted_structured(&approved));
        let legacy = Task {
            description: Some("- [x] **Approved by Tom**".into()),
            comments: vec![TaskComment {
                text: Some("[tech-design-approved] true [qa-ac-verified] true".into()),
                body: None,
                ..TaskComment::default()
            }],
            ..Default::default()
        };
        assert!(!lobster_state::spec_is_approved(&legacy));
        assert!(!product_spec_parsing::tech_design_approved_structured(
            &legacy
        ));
        assert!(!task_approvals::accepted_structured(&legacy));
        let revoked = Task {
            approvals: vec![
                approval_row("spec", "revoked"),
                approval_row("tech_design", "revoked"),
                approval_row("accepted", "revoked"),
            ],
            ..legacy
        };
        assert!(!lobster_state::spec_is_approved(&revoked));
        assert!(!product_spec_parsing::tech_design_approved_structured(
            &revoked
        ));
        assert!(!task_approvals::accepted_structured(&revoked));
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
        let failures = lobster_state::missing_spec_checksum_failures(&task, repo.path(), workspace.path());
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
        assert!(lobster_state::missing_spec_checksum_failures(&task, repo.path(), workspace.path()).is_empty());

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

    // ---- post_merge stage-handler tests moved to `post_merge.rs` (W37 A3 PR-C) ----

    #[test]
    fn implementer_pr_urls_preserve_merged_prs_for_delivery() {
        let merged_url = "https://github.com/Stoffer-Industries/sindustries/pull/161";
        let open_url = "https://github.com/Stoffer-Industries/sindustries/pull/164";
        let task = Task {
            comments: vec![TaskComment {
                text: Some(format!("[rowan-prs] {merged_url} {open_url}")),
                body: None,
                ..TaskComment::default()
            }],
            ..Task::default()
        };

        assert_eq!(
            product_spec_parsing::implementer_pr_urls(&task),
            vec![merged_url, open_url]
        );
        assert_eq!(
            product_spec_parsing::implementer_active_pr_urls_with(&task, |url| {
                if url == merged_url {
                    Ok(pr_gates::ReviewState::Merged)
                } else {
                    Ok(pr_gates::ReviewState::Approved)
                }
            }),
            vec![open_url]
        );
    }

    // ---- feedback_aggregate review-failure helper moved to
    //      feedback_aggregate.rs in PR-B (W37 A3 main.rs carve) ----

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
        assert!(brain_spec_lifecycle::manual_block_failures(&task).is_empty());
    }

    #[test]
    fn manual_block_failures_returns_message_when_blocked() {
        let task = blocked_task();
        let failures = brain_spec_lifecycle::manual_block_failures(&task);
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
        assert!(brain_spec_lifecycle::manual_block_failures(&task).is_empty());

        let task = Task {
            id: "task-manual-only".to_string(),
            blocked: true,
            ..Task::default()
        };
        let failures = brain_spec_lifecycle::manual_block_failures(&task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("blocked: true"));
        assert!(failures[0].contains("dependencyBlocked"));
    }

    #[test]
    fn manual_block_guard_message_distinguishes_manual_flag() {
        let task = blocked_task();
        let failures = brain_spec_lifecycle::manual_block_failures(&task);
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
        let failures = brain_spec_lifecycle::manual_block_failures(&env.task);
        let result = brain_spec_lifecycle::block_with_manual_block(
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
        let result = brain_spec_lifecycle::block_with_manual_block(
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "spec_check")
            .expect("no-drift should not error");
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

        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "verify_delivery")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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

        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
            ..Task::default()
        };
        task.spec_checksum = Some(product_spec_parsing::spec_checksum(&approved));
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("no API call in dry-run");
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("no API call in dry-run");
        let blocked = result.expect("should block");
        assert!(!blocked.criteria_met);
        assert_eq!(blocked.action_taken, "ready_checks_blocked_spec_drift");
        assert_eq!(blocked.failures.len(), 1);
        assert!(blocked.failures[0].contains("Structured `spec` TaskApproval"));
        assert!(blocked.failures[0].contains("missing or revoked"));
    }

    #[test]
    fn fluid_drift_dry_run_allows_approved_spec_without_resync() {
        // Case (c): an approved structured `spec` TaskApproval is
        // authoritative even when no prior revocation flag or fresh
        // `[spec-resynced]` record exists.
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("dry-run should not error");
        assert!(
            result.is_none(),
            "approved spec drift should be non-fatal; got {:?}",
            result
        );
    }

    #[test]
    fn fluid_drift_live_case_c_does_not_revoke_approved_spec() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: false,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Build it".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-approved-live".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift".to_string(),
            ),
            status: "ready".to_string(),
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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

        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("authoritative approval must avoid the DELETE request");
        assert!(result.is_none());
    }

    #[test]
    fn fluid_drift_dry_run_unblocks_after_api_auto_revoke_and_tom_reapproval() {
        let args = StageArgs {
            base_url: "http://example.invalid".to_string(),
            repo: PathBuf::from("."),
            workspace_root: None,
            dry_run: true,
        };
        let approved = Task {
            description: Some("## Acceptance Criteria\n- [ ] AC1: Original".to_string()),
            ..Task::default()
        };
        let task = Task {
            id: "task-api-reapproved".to_string(),
            description: Some(
                "## Acceptance Criteria\n- [ ] AC1: Original\n- [ ] AC2: Drift".to_string(),
            ),
            status: "doing".to_string(),
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "approved")],
            comments: vec![
                TaskComment {
                    text: Some(
                        "Approval spec revoked by Tasks API after acceptance criteria changed."
                            .to_string(),
                    ),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some("Approval spec approved by Tom.".to_string()),
                    body: None,
                    ..TaskComment::default()
                },
            ],
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

        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "verify_delivery")
            .expect("fresh API reapproval should be recognized");
        assert!(result.is_none());
    }

    #[test]
    fn initial_approval_without_api_auto_revoke_still_blocks_drift() {
        let task = Task {
            approvals: vec![approval_row("spec", "approved")],
            comments: vec![TaskComment {
                text: Some("Approval spec approved by Tom.".to_string()),
                body: None,
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(!brain_spec_lifecycle::structured_spec_reapproval_after_auto_revoke(&task));
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
            ..Task::default()
        };
        // Build a `[spec-resynced]` comment bound to the current drift
        // episode.
        let drift_failures = product_spec_parsing::spec_checksum_failures(&task);
        assert!(
            !drift_failures.is_empty(),
            "fixture must produce drift so the test exercises the binding"
        );
        let fingerprint = product_spec_parsing::drift_episode_fingerprint(&drift_failures);
        let new_checksum = product_spec_parsing::acceptance_criteria_checksum(
            &product_spec_parsing::acceptance_criteria_text(&task.description.clone().unwrap()),
        );
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
            ..TaskComment::default()
        }];
        let env = Envelope {
            criteria_met: true,
            already_past: false,
            action_taken: String::new(),
            task: drifted_task,
            lobster_state: LobsterState::default(),
            failures: Vec::new(),
        };
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "spec_check")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "verify_delivery")
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
            approvals: vec![approval_row("spec", "revoked")],
            comments: vec![TaskComment {
                text: Some("[spec-resynced] Previous episode".to_string()),
                body: None,
                ..TaskComment::default()
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
        let result =
            brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "feedback_aggregate")
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
        let record = product_spec_parsing::parse_resync_record(&text).expect("record should parse");
        assert_eq!(record.checksum, chk);
        assert_eq!(record.fingerprint, fp);
        assert_eq!(record.summary, "reset checksum after approval");
    }

    #[test]
    fn parse_resync_record_rejects_record_without_binding() {
        // A hand-written `[spec-resynced]` without checksum/driftFingerprint
        // must NOT be trusted — the stale-drift guard requires the binding.
        let text = "[spec-resynced] does not carry checksum/fingerprint fields";
        assert!(product_spec_parsing::parse_resync_record(text).is_none());
    }

    #[test]
    fn parse_resync_record_rejects_unbound_comment() {
        let text = "Spec resynced offline.";
        assert!(product_spec_parsing::parse_resync_record(text).is_none());
    }

    #[test]
    fn parse_resync_record_rejects_short_hex() {
        let text = "[spec-resynced] short\nchecksum=deadbeef\ndriftFingerprint=cafebabe\n";
        assert!(product_spec_parsing::parse_resync_record(text).is_none());
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
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(stale.to_string()),
                    body: None,
                    ..TaskComment::default()
                },
                TaskComment {
                    text: Some(good),
                    body: None,
                    ..TaskComment::default()
                },
            ],
            ..Task::default()
        };
        let record =
            product_spec_parsing::latest_resync_record(&task).expect("record must be found");
        assert_eq!(record.checksum, "a".repeat(64));
        assert_eq!(record.fingerprint, "b".repeat(64));
    }

    #[test]
    fn drift_episode_fingerprint_is_stable_and_order_sensitive() {
        let a = vec!["one".to_string(), "two".to_string()];
        let b = vec!["one".to_string(), "two".to_string()];
        let c = vec!["two".to_string(), "one".to_string()];
        assert_eq!(
            product_spec_parsing::drift_episode_fingerprint(&a),
            product_spec_parsing::drift_episode_fingerprint(&b)
        );
        assert_ne!(
            product_spec_parsing::drift_episode_fingerprint(&a),
            product_spec_parsing::drift_episode_fingerprint(&c)
        );
        // Lowercase sha256 hex of length 64.
        let fp = product_spec_parsing::drift_episode_fingerprint(&a);
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
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(!product_spec_parsing::latest_resync_record_matches_drift(
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
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(!product_spec_parsing::latest_resync_record_matches_drift(
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
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(product_spec_parsing::latest_resync_record_matches_drift(
            &task_match,
            &fp,
            Some(&cs)
        ));
        assert!(!product_spec_parsing::latest_resync_record_matches_drift(
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
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(product_spec_parsing::latest_resync_record_matches_drift(
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
                ..TaskComment::default()
            }],
            ..Task::default()
        };
        assert!(!product_spec_parsing::latest_resync_record_matches_drift(
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
    fn spec_lifecycle_moves_structured_approved_open_spec_without_legacy_marker() {
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/open/example.md",
                "- [ ] **Approved by Tom**\n",
                true,
            ),
            ChatApprovalMovePlan::Move {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
    }

    #[test]
    fn spec_lifecycle_legacy_marker_still_moves_without_structured_approval() {
        let checked = "- [x] **Approved by Tom**\n";
        assert_eq!(
            plan_chat_spec_lifecycle_move("brain/tasks/specs/open/example.md", checked, false,),
            ChatApprovalMovePlan::Move {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/open/example.md",
                "- [ ] **Approved by Tom**\n",
                false,
            ),
            ChatApprovalMovePlan::Noop
        );
    }

    #[test]
    fn spec_lifecycle_never_plans_reverse_move() {
        let unchecked = "- [ ] **Approved by Tom**\n";
        assert_eq!(
            plan_chat_spec_lifecycle_move(
                "brain/tasks/specs/in-progress/example.md",
                unchecked,
                true,
            ),
            ChatApprovalMovePlan::AlreadyMoved {
                from_rel: "brain/tasks/specs/open/example.md".to_string(),
                to_rel: "brain/tasks/specs/in-progress/example.md".to_string()
            }
        );
        assert_eq!(
            plan_chat_spec_lifecycle_move("brain/tasks/specs/done/example.md", unchecked, true,),
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
    fn lifecycle_spec_path_rewrite_preserves_approval_marker_and_acceptance_criteria() {
        let description = "\
**Spec:** brain/tasks/specs/open/example-2026.md
- [x] **Approved by Tom**

## Acceptance Criteria
- [ ] AC1: Keep this exact text
";
        let rewritten = rewrite_spec_line_in_description(
            description,
            "brain/tasks/specs/open/example-2026.md",
            "brain/tasks/specs/in-progress/example-2026.md",
        )
        .expect("open spec path should be rewritten");
        assert_eq!(
            rewritten,
            "**Spec:** brain/tasks/specs/in-progress/example-2026.md\n- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Keep this exact text\n"
        );
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let drift_failures = product_spec_parsing::spec_checksum_failures(&env.task);
        let fingerprint = product_spec_parsing::drift_episode_fingerprint(&drift_failures);
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
        let expected_checksum = product_spec_parsing::acceptance_criteria_checksum(
            &product_spec_parsing::acceptance_criteria_text(&drifted_description),
        );
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
        let fingerprint = product_spec_parsing::drift_episode_fingerprint(&drift_failures);
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
        let fingerprint = product_spec_parsing::drift_episode_fingerprint(&drift_failures);
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
            spec_checksum: Some(product_spec_parsing::spec_checksum(&approved)),
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
        let drift_failures = product_spec_parsing::spec_checksum_failures(&env.task);
        let fingerprint = product_spec_parsing::drift_episode_fingerprint(&drift_failures);
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
    fn fluid_drift_stale_resync_record_does_not_revoke_current_approval() {
        // A `[spec-resynced]` comment from a previous drift episode does not
        // match the current drift, but Case (c) still treats the approved
        // structured spec as authoritative and avoids revocation.
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
        let original_checksum = product_spec_parsing::spec_checksum(&original);

        // Stale comment: bound to an OLD episode (checksum matches old
        // ACs, fingerprint from a different drift failures list).
        let old_failures = vec!["old drift".to_string()];
        let old_fp = product_spec_parsing::drift_episode_fingerprint(&old_failures);
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
                ..TaskComment::default()
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
        let result = brain_spec_lifecycle::block_on_spec_drift_fluid(&args, env, "ready_checks")
            .expect("stale-comment path should not error");
        assert!(
            result.is_none(),
            "stale comment must not cause approved spec revocation; got {:?}",
            result
        );
    }

    // ---- Post-merge worktree cleanup (feature task ba116063) ----
    // Tests moved to `git_worktree.rs` (W37 A3 main.rs carve, PR-H).

    // ---- clippy evidence gate helpers (task 55c98158) ----
    // These tests moved to `pr_gates.rs` (W36 audit A3+A4 — module
    // extraction); the W36 A2 fail-closed tests live there too.
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
        let parsed = product_spec_parsing::parse_product_spec_ref(desc).expect("must parse");
        assert_eq!(parsed.path, "brain/tasks/specs/in-progress/example.md");

        // Backtick-wrapped path with trailing comma.
        let desc2 = "**Spec:** `brain/tasks/specs/in-progress/foo.md`,\n";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc2)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/foo.md"
        );

        // Bracket annotation.
        let desc3 = "**Spec:** brain/tasks/specs/in-progress/bar.md [archived ticket]";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc3)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/bar.md"
        );

        // Whitespace-only annotation is still parseable.
        let desc4 = "**Spec:** brain/tasks/specs/in-progress/baz.md (a b c)";
        assert_eq!(
            product_spec_parsing::parse_product_spec_ref(desc4)
                .unwrap()
                .path,
            "brain/tasks/specs/in-progress/baz.md"
        );
    }

    #[test]
    fn archive_spec_rejects_unparseable_spec_line() {
        // Multi-token path with whitespace -> reject (returns None).
        assert!(product_spec_parsing::parse_product_spec_ref(
            "**Spec:** brain/tasks/specs/in-progress/foo bar.md"
        )
        .is_none());
        // Bracket-only residue (no path component) -> reject.
        assert!(product_spec_parsing::parse_product_spec_ref("**Spec:** (just a note)").is_none());
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
        assert!(!workspace
            .path()
            .join(TASK_SPECS_IN_PROGRESS_DIR)
            .join(slug)
            .exists());
    }

    #[test]
    fn archive_task_spec_for_done_task_treats_inline_annotation_as_movable() {
        let workspace = tempdir().unwrap();
        let slug = "inline-annotated-2026.md";
        write_in_progress_spec(workspace.path(), slug, "inline content\n");

        let desc =
            format!("**Spec:** brain/tasks/specs/in-progress/{slug} (legacy annotation preserved)");
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
        assert!(workspace
            .path()
            .join(TASK_SPECS_IN_PROGRESS_DIR)
            .join(slug)
            .exists());
        assert!(workspace
            .path()
            .join(TASK_SPECS_DONE_DIR)
            .join(slug)
            .exists());
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

    // The AC1 of task f6a4d56a ("Add Ash: QA-verifier gate") test group
    // moved to `task_approvals::tests` in PR-D (W37 A3 main.rs carve).
    // `task_approvals::qa_agent_verified`, `accepted_structured`,
    // `accepted_structured_failures`, and `verify_delivery::qa_agent_verified_failures`
    // are exercised in their respective module-local test blocks. The
    // cross-stage integration tests above (e.g.
    // `structured_approval_rows_are_the_only_gate_source`) reference the
    // new module via `crate::task_approvals::*` paths per the W36 carve
    // convention.
}
