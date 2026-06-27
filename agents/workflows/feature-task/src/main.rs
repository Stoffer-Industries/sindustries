use anyhow::{anyhow, Context, Result};
use clap::{ArgAction, Parser, Subcommand};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
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
    if is_past(&env.task, "open") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_open".to_string();
        return Ok(env);
    }
    let failures = spec_failures(&env.task, &args.repo);
    transition_or_block(&args, env, "ready", "spec_check", failures)
}

fn ready_checks(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
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
        for state in ["ready", "doing", "acceptance"] {
            let active = tasks
                .iter()
                .filter(|task| {
                    task.id != *current_id
                        && task.status == state
                        && !task.blocked
                        && task.assignee.as_deref() == Some("Rowan")
                })
                .count();
            if active >= 1 {
                failures.push(format!(
                    "Rowan capacity is full for `{state}` feature tasks."
                ));
            }
        }
    }
    transition_or_block(&args, env, "doing", "ready_checks", failures)
}

fn verify_delivery(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if is_past(&env.task, "doing") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_doing".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
    let pr_urls = rowan_pr_urls(&env.task);
    if pr_urls.is_empty() {
        failures.push("Missing `[rowan-prs]` task comment with at least one PR URL.".to_string());
    }
    env.lobster_state.pr_urls = pr_urls.clone();
    for url in &pr_urls {
        match inspect_pr(url) {
            Ok(review) if matches!(review, ReviewState::Approved | ReviewState::Merged) => {}
            Ok(review) => failures.push(format!("PR {url} is not delivery-ready: {review:?}.")),
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
        if let Ok(body) = pr_body(url) {
            if !body_has_checked_acceptance(&body) {
                failures.push(format!(
                    "PR {url} does not show checked acceptance criteria in its body."
                ));
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
    let mut failures = Vec::new();
    for url in rowan_pr_urls(&env.task) {
        match inspect_pr(&url) {
            Ok(ReviewState::ChangesRequested) => {
                failures.push(format!("Changes requested on {url}."))
            }
            Ok(ReviewState::CommentsPresent) => {
                failures.push(format!("Open review comments remain on {url}."))
            }
            Ok(ReviewState::Required) => {
                failures.push(format!("Required review is missing on {url}."))
            }
            Ok(_) => {}
            Err(err) => failures.push(format!("Could not inspect PR {url}: {err}.")),
        }
    }
    if failures.is_empty() {
        env.criteria_met = true;
        env.action_taken = "feedback_clear".to_string();
        return Ok(env);
    }
    if !args.dry_run {
        add_comment(
            &args.base_url,
            &env.task.id,
            &format!("[rowan-feedback]\n{}", failures.join("\n")),
        )?;
        env.task = api_patch(&args.base_url, &env.task.id, json!({"status": "doing"}))?;
    }
    env.criteria_met = false;
    env.action_taken = "feedback_routed".to_string();
    env.failures = failures;
    Ok(env)
}

fn post_merge(args: StageArgs) -> Result<Envelope> {
    let mut env = read_envelope()?;
    if is_past(&env.task, "acceptance") {
        env.already_past = true;
        env.criteria_met = true;
        env.action_taken = "already_past_acceptance".to_string();
        return Ok(env);
    }
    let mut failures = Vec::new();
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
            env.task = api_patch(&args.base_url, &env.task.id, json!({"status": next_status}))?;
            write_state(
                &args.base_url,
                &env.task.id,
                &env.lobster_state,
                Some(&format!(
                    "Feature task workflow moved task to `{next_status}`."
                )),
            )?;
        }
    } else {
        env.action_taken = format!("{action}_blocked");
        let fingerprint = failures.join("\n");
        if !args.dry_run && env.lobster_state.failure_fingerprint.as_deref() != Some(&fingerprint) {
            env.lobster_state.failure_fingerprint = Some(fingerprint);
            add_comment(
                &args.base_url,
                &env.task.id,
                &format!("[feature-task-blocked]\n{}", failures.join("\n")),
            )?;
            write_state(&args.base_url, &env.task.id, &env.lobster_state, None)?;
        }
    }
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

fn api_patch<T: for<'de> Deserialize<'de>>(
    base_url: &str,
    task_id: &str,
    payload: Value,
) -> Result<T> {
    let url = format!("{}/tasks/{task_id}", base_url.trim_end_matches('/'));
    let value: Value = ureq::patch(&url).send_json(payload)?.into_json()?;
    serde_json::from_value(value.get("data").cloned().unwrap_or(value))
        .context("decode API patch response")
}

fn add_comment(base_url: &str, task_id: &str, text: &str) -> Result<()> {
    let url = format!(
        "{}/tasks/{task_id}/comments",
        base_url.trim_end_matches('/')
    );
    ureq::post(&url).send_json(json!({"author": AUTHOR, "text": text}))?;
    Ok(())
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

fn spec_failures(task: &Task, repo: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    match product_spec(task) {
        Some(spec) => {
            let path = repo.join(&spec.path);
            if !path.exists() {
                failures.push(format!("Product spec does not exist: `{}`.", spec.path));
            } else if let Ok(text) = fs::read_to_string(&path) {
                if acceptance_criteria_text(&text).is_empty()
                    && !text.to_lowercase().contains("acceptance")
                {
                    failures.push(
                        "Product spec does not include implementation-ready acceptance criteria."
                            .to_string(),
                    );
                }
            }
        }
        None => failures.push("Task must link a product spec.".to_string()),
    }
    if acceptance_criteria_text(&task.description.clone().unwrap_or_default()).is_empty() {
        failures.push("Task description must include acceptance criteria checkboxes.".to_string());
    }
    if workstreams(task).is_empty() {
        failures.push("Task description must include workstreams.".to_string());
    }
    failures
}

fn product_spec(task: &Task) -> Option<ProductSpecRef> {
    let text = format!(
        "{}\n{}",
        task.description.clone().unwrap_or_default(),
        task.comments
            .iter()
            .map(comment_text)
            .collect::<Vec<_>>()
            .join("\n")
    );
    parse_product_spec_ref(&text)
}

fn parse_product_spec_ref(text: &str) -> Option<ProductSpecRef> {
    let re = Regex::new(r"(?i)(?:product spec|spec):\s*`?([A-Za-z0-9_./-]*brain/bookmarks/specs/[A-Za-z0-9_.-]+\.md)`?").unwrap();
    re.captures(text)
        .and_then(|cap| cap.get(1))
        .map(|m| ProductSpecRef {
            path: m.as_str().trim_start_matches('/').to_string(),
        })
}

fn acceptance_criteria_text(text: &str) -> Vec<String> {
    let re = Regex::new(r"(?m)^\s*-\s*\[[ xX]\]\s+(.+)$").unwrap();
    re.captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
        .collect()
}

fn workstreams(task: &Task) -> Vec<Workstream> {
    parse_workstreams(&task.description.clone().unwrap_or_default())
}

fn parse_workstreams(text: &str) -> Vec<Workstream> {
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
        .any(|v| v.eq_ignore_ascii_case("true"))
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

fn openclaw_needed(task: &Task) -> bool {
    !tagged_values(task, "[openclaw-needed]").is_empty()
}

fn openclaw_done(task: &Task) -> bool {
    !tagged_values(task, "[openclaw-done]").is_empty()
}

fn system_spec_failures(task: &Task, repo: &Path) -> Vec<String> {
    let system_specs = tagged_values(task, "[system-spec]");
    if system_specs.is_empty() {
        let reasons = tagged_values(task, "[no-system-spec-change]");
        if reasons.iter().any(|reason| reason.len() >= 12) {
            return vec![];
        }
        return vec!["Missing `[system-spec] docs/systems/<file>.md` or substantive `[no-system-spec-change]` reason.".to_string()];
    }
    system_specs
        .into_iter()
        .filter_map(|path| {
            let full = repo.join(&path);
            if !full.exists() {
                return Some(format!("System spec does not exist: `{path}`."));
            }
            let text = fs::read_to_string(full).unwrap_or_default();
            let current = rowan_pr_urls(task)
                .into_iter()
                .any(|url| text.contains(&url))
                || text.contains(&task.id);
            (!current).then(|| format!("System spec `{path}` does not reference this task or PR."))
        })
        .collect()
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
    fn parses_multiple_workstreams() {
        let streams = parse_workstreams(&fixture("task_full.md"));
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].owner, "Rowan");
        assert_eq!(streams[1].owner, "Quinn");
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
        fs::create_dir_all(repo.path().join("docs/systems")).unwrap();
        fs::write(
            repo.path().join("docs/systems/feature-task.md"),
            "References task-1",
        )
        .unwrap();
        let task = Task {
            id: "task-1".to_string(),
            comments: vec![TaskComment {
                text: Some("[system-spec] docs/systems/feature-task.md".to_string()),
                body: None,
            }],
            ..Task::default()
        };
        assert!(system_spec_failures(&task, repo.path()).is_empty());
    }
}
