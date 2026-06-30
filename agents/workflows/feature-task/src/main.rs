use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose, Engine as _};
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

const AUTHOR: &str = "Lobster";
const WORKFLOW: &str = "feature-task-workflow";
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
    task_type: Option<String>,
    #[serde(default)]
    spec_checksum: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    comments: Vec<TaskComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TaskComment {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    body: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
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
    };
    println!("{}", serde_json::to_string_pretty(&envelope)?);
    Ok(())
}

fn load_task(base_url: &str, task_id: &str) -> Result<Envelope> {
    let task: Task = api_get(base_url, &format!("/tasks/{task_id}"))?;
    let state = parse_lobster_state(&task);
    Ok(output(true, false, "loaded_task", task, state, vec![]))
}

fn spec_check(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "spec_check") {
        return Ok(blocked);
    }
    if is_past(&env.task, "open") {
        let failures = missing_spec_checksum_failures(&env.task, &args.repo, workspace_root(&args));
        if !failures.is_empty() {
            if !args.dry_run {
                api_patch::<Task>(&args.base_url, &env.task.id, json!({"status": "open"}))?;
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
    transition_or_block(&args, env, "ready", "spec_check", failures)
}

fn ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "ready_checks") {
        return Ok(blocked);
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
    if !tech_design_approved(&env.task) {
        failures.push("Missing task comment `[tech-design-approved] true`.".to_string());
    }
    if env.task.assignee.as_deref() != Some("Rowan") {
        failures.push("Task must be assigned to Rowan.".to_string());
    }
    if let Ok(tasks) = list_active_feature_tasks(&args.base_url) {
        let current_id = &env.task.id;
        failures.extend(rowan_doing_capacity_failures(&tasks, current_id));
    }
    transition_or_block(&args, env, "doing", "ready_checks", failures)
}

fn verify_delivery(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "verify_delivery") {
        return Ok(blocked);
    }
    if is_past(&env.task, "doing") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_doing".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    let pr_urls = rowan_active_pr_urls(&env.task);
    if pr_urls.is_empty() {
        failures.push("Missing `[rowan-prs]` task comment with at least one PR URL.".to_string());
    }
    env.lobster_state.pr_urls = pr_urls.clone();
    for url in &pr_urls {
        match inspect_pr(url) {
            Ok(review) => {
                if let Some(failure) = verify_delivery_review_failure(url, review) {
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
            for ac_failure in verify_pr_acs_failures(&body) {
                failures.push(format!("PR {url} — {ac_failure}"));
            }
        }
    }
    if workstreams(&env.task).is_empty() {
        failures.push("Task description must include at least one workstream.".to_string());
    }
    failures.extend(system_spec_failures(&env.task, &args.repo));
    if openclaw_needed(&env.task) && !openclaw_done(&env.task) {
        failures
            .push("`[openclaw-needed]` is present but `[openclaw-done]` is missing.".to_string());
    }
    transition_or_block(&args, env, "acceptance", "verify_delivery", failures)
}

fn feedback_aggregate(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "feedback_aggregate") {
        return Ok(blocked);
    }
    let mut failures = Vec::new();
    for url in rowan_pr_urls(&env.task) {
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
            &format!("[rowan-feedback]\n{}", failures.join("\n")),
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

fn feedback_review_failure(url: &str, review: ReviewState) -> Option<String> {
    match review {
        ReviewState::ChangesRequested => Some(format!("Changes requested on {url}.")),
        ReviewState::CommentsPresent => Some(format!("Open review comments remain on {url}.")),
        _ => None,
    }
}

fn qa_ac_verified(task: &Task) -> bool {
    tagged_values(task, "[qa-ac-verified]")
        .into_iter()
        .any(|v| v.eq_ignore_ascii_case("true"))
}

fn qa_ac_verified_failures(task: &Task) -> Vec<String> {
    if qa_ac_verified(task) {
        vec![]
    } else {
        vec!["Missing task comment `[qa-ac-verified] true` -- Tom must verify all task ACs are met before closing.".to_string()]
    }
}

fn post_merge(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if let Some(blocked) = block_on_spec_drift(env.clone(), "post_merge") {
        return Ok(blocked);
    }
    let qa_failures = qa_ac_verified_failures(&env.task);
    if is_past(&env.task, "acceptance") {
        if !qa_failures.is_empty() {
            if !args.dry_run {
                api_patch::<Task>(
                    &args.base_url,
                    &env.task.id,
                    json!({"status": "acceptance"}),
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
            return Ok(env);
        }
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_acceptance".to_string();
        return Ok(env);
    }
    let mut failures = qa_failures;
    for url in rowan_pr_urls(&env.task) {
        match inspect_pr(&url) {
            Ok(ReviewState::Merged) => {}
            Ok(state) => failures.push(format!("PR {url} is not merged: {state:?}.")),
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
    }
    transition_or_block(&args, env, "done", "post_merge", failures)
}

fn transition_or_block(
    args: &StageArgs,
    mut env: Envelope,
    next_status: &str,
    action: &str,
    failures: Vec<String>,
) -> Result<Envelope> {
    env.failures = failures.clone();
    env.criteria_met = failures.is_empty();
    if failures.is_empty() {
        env.action_taken = if args.dry_run {
            format!("would_move_to_{next_status}")
        } else {
            format!("moved_to_{next_status}")
        };
        if !args.dry_run && env.task.status != next_status {
            let mut patch = json!({"status": next_status});
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
                Some(&format!(
                    "Feature task workflow moved task to `{next_status}`."
                )),
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
        if !args.dry_run && env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
            env.lobster_state.failure_fingerprint = Some(fingerprint);
            if let Err(err) = add_comment(
                &args.base_url,
                &env.task.id,
                &format!("[feature-task-progress-checklist]\n{}", failures.join("\n")),
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
    }
    Ok(env)
}

fn block_on_spec_drift(mut env: Envelope, action: &str) -> Option<Envelope> {
    let failures = spec_checksum_failures(&env.task);
    if failures.is_empty() {
        return None;
    }
    env.criteria_met = false;
    env.action_taken = format!("{action}_blocked_spec_drift");
    env.failures = failures.clone();
    Some(env)
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

fn list_active_feature_tasks(base_url: &str) -> Result<Vec<Task>> {
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
            if task.task_type.as_deref() == Some("feature")
                || task.tags.iter().any(|tag| tag == "feature-factory")
            {
                out.push(task);
            }
        }
    }
    Ok(out)
}

fn rowan_doing_capacity_failures(tasks: &[Task], current_id: &str) -> Vec<String> {
    let active_doing = tasks
        .iter()
        .filter(|task| {
            task.id != current_id
                && task.status == "doing"
                && !task.blocked
                && task.assignee.as_deref() == Some("Rowan")
        })
        .count();
    if active_doing >= 1 {
        vec!["Rowan already has an active task in `doing`.".to_string()]
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
    state.workflow = WORKFLOW.to_string();
    state
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
            } else if let Ok(text) = fs::read_to_string(&path) {
                if !product_spec_approved_by_tom(&text) {
                    failures.push("Product spec not approved by Tom".to_string());
                }
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

fn product_spec(task: &Task) -> Option<ProductSpecRef> {
    parse_product_spec_ref(&task.description.clone().unwrap_or_default())
}

fn parse_product_spec_ref(text: &str) -> Option<ProductSpecRef> {
    let re = Regex::new(r"(?im)^\s*\*\*Spec:\*\*\s*`?([^`\s]+\.md)`?\s*$").unwrap();
    re.captures(text)
        .and_then(|cap| cap.get(1))
        .map(|m| ProductSpecRef {
            path: m.as_str().to_string(),
        })
}

fn product_spec_approved_by_tom(text: &str) -> bool {
    Regex::new(r"(?m)^\s*-\s*\[[xX]\]\s+\*\*Approved by Tom\*\*\s*$")
        .unwrap()
        .is_match(text)
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
            "ACs modified after spec approval -- write a new spec to change scope. Task {} stored specChecksum `{stored}` but current AC checksum is `{current}`.",
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

    let heading =
        Regex::new(r"(?im)^\s{0,3}#{2,6}\s+(?:workstream\s*[:/-]?\s*)?(.+?)\s*$").unwrap();
    let mut matches: Vec<_> = heading.find_iter(text).collect();
    matches.retain(|m| {
        m.as_str().to_lowercase().contains("workstream")
            || ["rowan", "quinn", "tom", "lox", "ivy"]
                .iter()
                .any(|name| m.as_str().to_lowercase().contains(name))
    });
    matches
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let start = m.end();
            let end = matches
                .get(idx + 1)
                .map(|n| n.start())
                .unwrap_or(text.len());
            let title = m.as_str();
            let owner = ["Rowan", "Quinn", "Tom", "Lox", "Ivy"]
                .iter()
                .find(|name| title.contains(*name))
                .unwrap_or(&"Rowan")
                .to_string();
            Workstream {
                owner,
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
                .unwrap_or_else(|| "Rowan".to_string());
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

fn tech_design_approved(task: &Task) -> bool {
    tagged_values(task, "[tech-design-approved]")
        .into_iter()
        .any(|v| {
            // Match a leading "true" token (case-insensitive). Rationale text
            // after the token is allowed and ignored.
            let token = v.trim_start().split_whitespace().next().unwrap_or("");
            token.eq_ignore_ascii_case("true")
        })
}

fn rowan_pr_urls(task: &Task) -> Vec<String> {
    let re = Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+").unwrap();
    let mut urls = Vec::new();
    for value in tagged_values(task, "[rowan-prs]") {
        for m in re.find_iter(&value) {
            let url = m.as_str().to_string();
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    urls
}

fn rowan_active_pr_urls(task: &Task) -> Vec<String> {
    rowan_active_pr_urls_with(task, inspect_pr)
}

fn rowan_active_pr_urls_with<F>(task: &Task, inspect: F) -> Vec<String>
where
    F: Fn(&str) -> Result<ReviewState>,
{
    rowan_pr_urls(task)
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

trait SystemSpecFetcher {
    fn read(&self, owner: &str, repo: &str, path: &str, branch: &str) -> Result<String>;
}

struct GhSystemSpecFetcher;

impl SystemSpecFetcher for GhSystemSpecFetcher {
    fn read(&self, owner: &str, repo: &str, path: &str, branch: &str) -> Result<String> {
        fetch_github_contents(owner, repo, path, branch)
    }
}

fn system_spec_failures(task: &Task, repo: &Path) -> Vec<String> {
    system_spec_failures_with(task, repo, inspect_pr, pr_head_branch, &GhSystemSpecFetcher)
}

fn system_spec_failures_with<I, B>(
    task: &Task,
    _repo: &Path,
    inspect: I,
    branch_for_pr: B,
    fetcher: &dyn SystemSpecFetcher,
) -> Vec<String>
where
    I: Fn(&str) -> Result<ReviewState> + Copy,
    B: Fn(&str) -> Result<String> + Copy,
{
    let system_specs = tagged_values(task, "[system-spec]");
    if system_specs.is_empty() {
        let reasons = tagged_values(task, "[no-system-spec-change]");
        if reasons.iter().any(|reason| reason.len() >= 12) {
            return vec![];
        }
        return vec!["Missing `[system-spec] docs/systems/<file>.md` or substantive `[no-system-spec-change]` reason.".to_string()];
    }
    let active_prs = rowan_active_pr_urls_with(task, inspect);
    let Some(active_pr_url) = active_prs.first() else {
        return vec![
            "Missing active `[rowan-prs]` PR URL to read system specs from a PR branch."
                .to_string(),
        ];
    };
    let (owner, repo_name) = match parse_pr_repo(active_pr_url) {
        Ok(parts) => parts,
        Err(err) => {
            return vec![format!(
                "Could not parse active PR URL `{active_pr_url}`: {err}."
            )]
        }
    };
    let branch = match branch_for_pr(active_pr_url) {
        Ok(branch) => branch,
        Err(err) => {
            return vec![format!(
                "Could not determine head branch for active PR `{active_pr_url}`: {err}."
            )]
        }
    };
    system_specs
        .into_iter()
        .filter_map(|path| {
            let text = match fetcher.read(&owner, &repo_name, &path, &branch) {
                Ok(text) => text,
                Err(err) if is_github_404(&err) => {
                    return Some(format!(
                        "System spec `{path}` is missing on PR branch `{branch}`."
                    ))
                }
                Err(err) => {
                    return Some(format!(
                        "Could not read system spec `{path}` from PR branch `{branch}`: {err}."
                    ))
                }
            };
            let current = rowan_pr_urls(task)
                .into_iter()
                .any(|url| text.contains(&url))
                || text.contains(&task.id);
            (!current).then(|| format!("System spec `{path}` does not reference this task or PR."))
        })
        .collect()
}

fn parse_pr_repo(url: &str) -> Result<(String, String)> {
    let re = Regex::new(r"^https://github\.com/([^/]+)/([^/]+)/pull/\d+$").unwrap();
    let caps = re
        .captures(url)
        .ok_or_else(|| anyhow!("expected GitHub PR URL"))?;
    Ok((caps[1].to_string(), caps[2].to_string()))
}

fn pr_head_branch(url: &str) -> Result<String> {
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            url,
            "--json",
            "headRefName",
            "--jq",
            ".headRefName",
        ])
        .output()
        .context("run gh pr view for head branch")?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    let branch = String::from_utf8(output.stdout)?.trim().to_string();
    if branch.is_empty() {
        return Err(anyhow!("empty PR head branch"));
    }
    Ok(branch)
}

fn fetch_github_contents(owner: &str, repo: &str, path: &str, branch: &str) -> Result<String> {
    let endpoint = format!("repos/{owner}/{repo}/contents/{path}?ref={branch}");
    let output = Command::new("gh")
        .args(["api", &endpoint])
        .output()
        .context("run gh api for contents")?;
    if !output.status.success() {
        return Err(anyhow!(String::from_utf8_lossy(&output.stderr)
            .trim()
            .to_string()));
    }
    decode_github_contents_response(&String::from_utf8(output.stdout)?)
}

fn decode_github_contents_response(raw: &str) -> Result<String> {
    let value: Value = serde_json::from_str(raw)?;
    let encoding = value
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if encoding != "base64" {
        return Err(anyhow!("unsupported GitHub contents encoding `{encoding}`"));
    }
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("GitHub contents response missing `content`"))?;
    let compact: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = general_purpose::STANDARD
        .decode(compact)
        .context("decode GitHub contents base64")?;
    String::from_utf8(decoded).context("GitHub contents file is not UTF-8")
}

fn is_github_404(err: &anyhow::Error) -> bool {
    let message = err.to_string();
    message.contains("HTTP 404") || message.contains("Not Found")
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
    Ok(String::from_utf8(output.stdout)?)
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
                    review
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .len()
                        > 0
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

/// Evidence annotation recognised on a feature-task PR AC line.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Evidence {
    /// Playwright test ID reference, e.g. `(testID: 1234)`
    TestId(String),
    /// File path and line reference, e.g. `(file: apps/tasks/src/App.jsx:42)`
    FileRef { path: String, line: u64 },
    /// Explicit reason for not adding a test, e.g. `(not tested: design tokens)`
    NotTested { reason: String },
}

/// One parsed AC line from a PR body.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AcEvidence {
    ac_label: String,
    description: String,
    evidence: Option<Evidence>,
}

/// Extract the Acceptance Criteria section from a PR body.
///
/// Recognises `## Acceptance Criteria` and `## ACs` / `## AC` headings. When
/// no header is found, the whole body is returned so PRs without a section
/// still get validated.
fn extract_ac_section(body: &str) -> &str {
    let header_re =
        Regex::new(r"(?im)^\s{0,3}#{2,6}\s+(?:Acceptance Criteria|ACs?)\s*:?\s*$").unwrap();
    let Some(header) = header_re.find(body) else {
        return body;
    };
    let start = header.end();
    let tail = &body[start..];
    // Same-or-higher heading ends the section.
    let next_re = Regex::new(r"(?im)^\s{0,3}#{2,6}\s+\S").unwrap();
    match next_re.find(tail) {
        Some(next) => &tail[..next.start()],
        None => tail,
    }
}

/// Recognise an evidence annotation that anchors the end of a string.
fn parse_evidence(text: &str) -> Option<Evidence> {
    // (not tested: <reason>) comes first so the reason may contain colons.
    let not_tested = Regex::new(r"\(not tested:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = not_tested.captures(text) {
        return Some(Evidence::NotTested {
            reason: cap[1].trim().to_string(),
        });
    }
    // (file: <path>:<line>)
    let file_ref = Regex::new(r"\(file:\s*([^)]+?):(\d+)\)\s*$").unwrap();
    if let Some(cap) = file_ref.captures(text) {
        return Some(Evidence::FileRef {
            path: cap[1].trim().to_string(),
            line: cap[2].parse().unwrap_or(0),
        });
    }
    // (testID: <value>)
    let test_id = Regex::new(r"\(testID:\s*([^)]+)\)\s*$").unwrap();
    if let Some(cap) = test_id.captures(text) {
        return Some(Evidence::TestId(cap[1].trim().to_string()));
    }
    None
}

/// Strip a trailing evidence annotation from a description string.
/// Returns the description with the trailing `(...)` evidence removed.
fn strip_trailing_evidence(text: &str) -> String {
    let re =
        Regex::new(r"\s+\((testID|file|not tested):\s*[^)]+\)\s*$").unwrap();
    match re.find(text) {
        Some(m) => text[..m.start()].trim_end().to_string(),
        None => text.to_string(),
    }
}

/// Parse a single AC line. Returns `None` if the line isn't a checked AC.
fn parse_ac_line(line: &str) -> Option<AcEvidence> {
    let ac_re = Regex::new(r"^\s*-\s*\[[xX]\]\s+(AC\d+):\s*(.+)$").unwrap();
    let cap = ac_re.captures(line.trim())?;
    let ac_label = cap[1].to_string();
    let rest = cap[2].to_string();
    if let Some(ev) = parse_evidence(&rest) {
        let description = strip_trailing_evidence(&rest);
        Some(AcEvidence {
            ac_label,
            description,
            evidence: Some(ev),
        })
    } else {
        Some(AcEvidence {
            ac_label,
            description: rest,
            evidence: None,
        })
    }
}

/// Build failure messages for ACs that lack evidence. Empty list = all ACs
/// in the section carry `(testID: ...)`, `(file: path:line)`, or
/// `(not tested: reason)` annotations.
fn verify_pr_acs_failures(body: &str) -> Vec<String> {
    let section = extract_ac_section(body);
    let mut failures = Vec::new();
    for line in section.lines() {
        if let Some(ac) = parse_ac_line(line) {
            if ac.evidence.is_none() {
                failures.push(format!(
                    "AC {} — missing evidence. Append `(testID: <id>)`, `(file: <path>:<line>)`, or `(not tested: <reason>)`.",
                    ac.ac_label
                ));
            }
        }
    }
    failures
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

    // ---- tech_design_approved parser relaxation (task 44f5ed65) ----

    fn task_with_approval_comment(comment: &str) -> Task {
        Task {
            id: "task-44f5ed65".to_string(),
            comments: vec![TaskComment {
                text: Some(comment.to_string()),
                body: None,
            }],
            ..Task::default()
        }
    }

    #[test]
    fn tech_design_approved_accepts_bare_true() {
        let task = task_with_approval_comment("[tech-design-approved] true");
        assert!(tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_accepts_rationale_after_true() {
        let task = task_with_approval_comment(
            "[tech-design-approved] true \u{2014} Approved by Quinn on behalf of Tom 2026-06-30",
        );
        assert!(tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_accepts_uppercase_true() {
        let task = task_with_approval_comment("[tech-design-approved] TRUE");
        assert!(tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_accepts_leading_whitespace() {
        let task = task_with_approval_comment("[tech-design-approved]    true with rationale");
        assert!(tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_rejects_false() {
        let task = task_with_approval_comment("[tech-design-approved] false \u{2014} pending review");
        assert!(!tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_rejects_missing_value() {
        let task = task_with_approval_comment("[tech-design-approved]");
        assert!(!tech_design_approved(&task));
    }

    #[test]
    fn tech_design_approved_rejects_unrelated_token() {
        let task = task_with_approval_comment("[tech-design-approved] maybe");
        assert!(!tech_design_approved(&task));
    }

    // ---- AC evidence parsing (task 6e70deb8) ----

    #[test]
    fn parse_evidence_recognises_test_id() {
        assert_eq!(
            parse_evidence("foo (testID: 1234)"),
            Some(Evidence::TestId("1234".to_string()))
        );
    }

    #[test]
    fn parse_evidence_recognises_file_ref() {
        assert_eq!(
            parse_evidence("bar (file: apps/tasks/src/X.jsx:42)"),
            Some(Evidence::FileRef {
                path: "apps/tasks/src/X.jsx".to_string(),
                line: 42,
            })
        );
    }

    #[test]
    fn parse_evidence_recognises_not_tested_reason() {
        assert_eq!(
            parse_evidence("baz (not tested: requires manual click flow)"),
            Some(Evidence::NotTested {
                reason: "requires manual click flow".to_string()
            })
        );
    }

    #[test]
    fn parse_evidence_rejects_bare_not_tested() {
        assert_eq!(parse_evidence("qux (not tested)"), None);
        assert_eq!(parse_evidence("quux"), None);
    }

    #[test]
    fn parse_ac_line_extracts_label_description_evidence() {
        let ac = parse_ac_line("- [x] AC1: Build it (testID: 7)").unwrap();
        assert_eq!(ac.ac_label, "AC1");
        assert_eq!(ac.description, "Build it");
        assert_eq!(ac.evidence, Some(Evidence::TestId("7".to_string())));
    }

    #[test]
    fn parse_ac_line_ignores_unchecked_lines() {
        assert!(parse_ac_line("- [ ] AC2: Unchecked (testID: 1)").is_none());
    }

    #[test]
    fn parse_ac_line_ignores_non_ac_bullets() {
        assert!(parse_ac_line("- [x] `npm test`").is_none());
        assert!(parse_ac_line("- [x] Some other bullet").is_none());
    }

    #[test]
    fn parse_ac_line_handles_description_with_parens() {
        let ac = parse_ac_line("- [x] AC1: Allow (paren) text (testID: 1)").unwrap();
        assert_eq!(ac.ac_label, "AC1");
        assert_eq!(ac.description, "Allow (paren) text");
        assert_eq!(ac.evidence, Some(Evidence::TestId("1".to_string())));
    }

    #[test]
    fn extract_ac_section_returns_section_when_header_present() {
        let body = "## Summary\nFoo.\n\n## Acceptance Criteria\n- [x] AC1: First\n- [x] AC2: Second (testID: 1)\n\n## Test plan\n- [x] run tests\n";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
        assert!(section.contains("AC2: Second"));
        assert!(!section.contains("Test plan"));
        assert!(!section.contains("run tests"));
    }

    #[test]
    fn extract_ac_section_falls_back_to_whole_body() {
        let body = "- [x] AC1: First (testID: 1)";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
    }

    #[test]
    fn extract_ac_section_handles_acs_header() {
        let body = "## ACs\n- [x] AC1: First (testID: 1)\n";
        let section = extract_ac_section(body);
        assert!(section.contains("AC1: First"));
    }

    #[test]
    fn verify_pr_acs_passes_when_all_have_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo (testID: 1)\n- [x] AC2: Bar (file: src/x.js:2)\n- [x] AC3: Baz (not tested: design tokens)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn verify_pr_acs_blocks_one_missing_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo (testID: 1)\n- [x] AC2: Bar\n- [x] AC3: Baz (testID: 3)\n";
        let failures = verify_pr_acs_failures(body);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("AC2"));
        assert!(failures[0].contains("missing evidence"));
    }

    #[test]
    fn verify_pr_acs_blocks_all_missing_evidence() {
        let body = "## Acceptance Criteria\n- [x] AC1: Foo\n- [x] AC2: Bar\n";
        let failures = verify_pr_acs_failures(body);
        assert_eq!(failures.len(), 2);
        assert!(failures[0].contains("AC1"));
        assert!(failures[1].contains("AC2"));
    }

    #[test]
    fn verify_pr_acs_ignores_unchecked_lines() {
        let body = "## Acceptance Criteria\n- [ ] AC1: Pending\n- [x] AC2: Done (testID: 1)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn verify_pr_acs_skips_other_sections() {
        let body = "## Test plan\n- [x] AC1: Not really an AC\n\n## Acceptance Criteria\n- [x] AC1: Real AC (testID: 1)\n";
        assert!(verify_pr_acs_failures(body).is_empty());
    }

    #[test]
    fn detects_tom_product_spec_approval_marker() {
        assert!(product_spec_approved_by_tom("- [x] **Approved by Tom**"));
        assert!(!product_spec_approved_by_tom("- [ ] **Approved by Tom**"));
    }

    #[test]
    fn resolves_product_specs_relative_to_workspace_root() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        assert_eq!(
            resolve_product_spec_path(
                "brain/bookmarks/specs/example.md",
                repo.path(),
                workspace.path()
            ),
            workspace.path().join("brain/bookmarks/specs/example.md")
        );

        assert_eq!(
            resolve_product_spec_path("docs/spec.md", repo.path(), workspace.path()),
            repo.path().join("docs/spec.md")
        );

        let absolute = workspace.path().join("brain/bookmarks/specs/example.md");
        assert_eq!(
            resolve_product_spec_path(absolute.to_str().unwrap(), repo.path(), workspace.path()),
            absolute
        );
    }

    #[test]
    fn validates_existing_product_spec_under_workspace_root() {
        let repo = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let spec_path = workspace.path().join("brain/bookmarks/specs/example.md");
        fs::create_dir_all(spec_path.parent().unwrap()).unwrap();
        fs::write(
            &spec_path,
            "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] Implementation-ready criteria",
        )
        .unwrap();

        let task = Task {
            description: Some(
                "**Spec:** brain/bookmarks/specs/example.md\n\n## Acceptance Criteria\n- [ ] Build it\n\n## Rowan Workstream\n- [ ] Build it"
                    .to_string(),
            ),
            ..Task::default()
        };

        assert!(spec_failures(&task, repo.path(), workspace.path()).is_empty());
        assert!(!repo
            .path()
            .join("brain/bookmarks/specs/example.md")
            .exists());
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
        assert!(failures[0].contains("ACs modified after spec approval"));
        assert!(failures[0].contains("write a new spec to change scope"));
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
    fn rowan_capacity_allows_other_ready_and_acceptance_tasks() {
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

        assert!(rowan_doing_capacity_failures(&tasks, "current-task").is_empty());
    }

    #[test]
    fn rowan_capacity_blocks_existing_doing_task() {
        let tasks = vec![Task {
            id: "other-doing".to_string(),
            status: "doing".to_string(),
            assignee: Some("Rowan".to_string()),
            ..Task::default()
        }];

        assert_eq!(
            rowan_doing_capacity_failures(&tasks, "current-task"),
            vec!["Rowan already has an active task in `doing`.".to_string()]
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
- Owner: Rowan
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
        assert_eq!(streams[0].owner, "Rowan");
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
- Owner: Rowan
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
    fn extracts_multiple_rowan_pr_urls() {
        let task = Task {
            comments: vec![TaskComment { text: Some("[rowan-prs]\nhttps://github.com/Stoffer-Industries/sindustries/pull/1\nhttps://github.com/Stoffer-Industries/sindustries/pull/2".to_string()), body: None }],
            ..Task::default()
        };
        assert_eq!(rowan_pr_urls(&task).len(), 2);
    }

    #[test]
    fn active_rowan_pr_urls_skip_merged_prs() {
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
        let active = rowan_active_pr_urls_with(&task, |url| {
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

    #[test]
    fn post_merge_requires_qa_ac_verified() {
        let task_without = Task::default();
        assert!(!qa_ac_verified(&task_without));
        assert_eq!(
            qa_ac_verified_failures(&task_without),
            vec!["Missing task comment `[qa-ac-verified] true` -- Tom must verify all task ACs are met before closing.".to_string()]
        );

        let task_with = Task {
            comments: vec![TaskComment {
                text: Some("[qa-ac-verified] true".to_string()),
                body: None,
            }],
            ..Task::default()
        };
        assert!(qa_ac_verified(&task_with));
        assert!(qa_ac_verified_failures(&task_with).is_empty());

        let task_false = Task {
            comments: vec![TaskComment {
                text: Some("[qa-ac-verified] false".to_string()),
                body: None,
            }],
            ..Task::default()
        };
        assert!(!qa_ac_verified(&task_false));
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
        assert!(failures[0].contains("ACs modified after spec approval"));
    }

    #[test]
    fn verify_delivery_review_gate_allows_pending_review() {
        let url = "https://github.com/Stoffer-Industries/sindustries/pull/117";
        assert!(verify_delivery_review_failure(url, ReviewState::Required).is_none());
        assert!(verify_delivery_review_failure(url, ReviewState::CommentsPresent).is_none());
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

    #[test]
    fn enforces_system_spec_or_reason() {
        let repo = tempdir().unwrap();
        let mut task = Task {
            id: "task-1".to_string(),
            comments: vec![],
            ..Task::default()
        };
        assert!(!system_spec_failures(&task, repo.path()).is_empty());
        task.comments.push(TaskComment { text: Some("[no-system-spec-change] CLI-only parser test coverage; no system behavior changes.".to_string()), body: None });
        assert!(system_spec_failures(&task, repo.path()).is_empty());
    }

    #[test]
    fn validates_existing_current_system_spec() {
        let repo = tempdir().unwrap();
        let task = Task {
            id: "task-1".to_string(),
            comments: vec![
                TaskComment {
                    text: Some("[system-spec] docs/systems/feature-task.md".to_string()),
                    body: None,
                },
                TaskComment {
                    text: Some(
                        "[rowan-prs] https://github.com/Stoffer-Industries/sindustries/pull/128"
                            .to_string(),
                    ),
                    body: None,
                },
            ],
            ..Task::default()
        };
        let fetcher = StubFetcher {
            body: "References task-1".to_string(),
            error: None,
        };
        assert!(system_spec_failures_with(
            &task,
            repo.path(),
            |_| Ok(ReviewState::Approved),
            |_| Ok("task-456c92a8-depends-on".to_string()),
            &fetcher,
        )
        .is_empty());
    }

    #[test]
    fn reports_system_spec_missing_on_pr_branch() {
        let repo = tempdir().unwrap();
        let task = Task {
            id: "task-1".to_string(),
            comments: vec![
                TaskComment {
                    text: Some("[system-spec] docs/systems/feature-task.md".to_string()),
                    body: None,
                },
                TaskComment {
                    text: Some(
                        "[rowan-prs] https://github.com/Stoffer-Industries/sindustries/pull/128"
                            .to_string(),
                    ),
                    body: None,
                },
            ],
            ..Task::default()
        };
        let fetcher = StubFetcher {
            body: String::new(),
            error: Some("gh: Not Found (HTTP 404)".to_string()),
        };
        assert_eq!(
            system_spec_failures_with(
                &task,
                repo.path(),
                |_| Ok(ReviewState::Approved),
                |_| Ok("task-456c92a8-depends-on".to_string()),
                &fetcher,
            ),
            vec![
                "System spec `docs/systems/feature-task.md` is missing on PR branch `task-456c92a8-depends-on`."
                    .to_string()
            ]
        );
    }

    #[test]
    fn decodes_github_contents_response() {
        let raw = json!({
            "encoding": "base64",
            "content": "UmVmZXJlbmNlcyB0YXNrLTE=\n"
        })
        .to_string();
        assert_eq!(
            decode_github_contents_response(&raw).unwrap(),
            "References task-1"
        );
    }

    struct StubFetcher {
        body: String,
        error: Option<String>,
    }

    impl SystemSpecFetcher for StubFetcher {
        fn read(&self, _owner: &str, _repo: &str, _path: &str, _branch: &str) -> Result<String> {
            match &self.error {
                Some(error) => Err(anyhow!(error.clone())),
                None => Ok(self.body.clone()),
            }
        }
    }
}
