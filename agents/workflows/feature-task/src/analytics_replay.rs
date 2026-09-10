//! Analytics-replay stage handler + helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W38 audit follow-up, finding A3:
//! "Feature-task `main.rs` remains a god file after W37 A3 first tranche
//! — second tranche required to bring `main.rs` below ~3,000 lines").
//! This module hosts the `analytics replay` subcommand and the small
//! helpers it composes: the JSON envelope builder, the human-readable
//! replay printer, two pure formatting helpers (`format_seconds` /
//! `format_evidence`), and `load_dotenv_token` (the `.env`-file fallback
//! for `GH_TOKEN` / `GITHUB_TOKEN` that the cron/lobster invocation
//! chain repeatedly dropped, causing silent 401s).
//!
//! `pub(crate)` surface (only `main.rs` and sibling modules consume
//! these):
//! - `analytics_replay(args)` — `analytics replay` subcommand handler;
//!   fetches `/feature-task-analytics/tasks/{id}/events`, prints a
//!   human-readable replay, and returns the JSON envelope.
//! - `load_dotenv_token(key)` — read a key from `~/.openclaw/.env`.
//!   Also consumed by `main.rs`'s `gh_command` (which lives in
//!   `cli_utils.rs` after Slice 2 but currently stays in `main.rs`).
//!
//! Pure helpers (`format_seconds`, `format_evidence`, `replay_envelope`,
//! `print_replay`) are `pub(crate)` for testability and for the same
//! reason the W37 first-tranche carve PRs established: every extracted
//! function is reachable for sibling-module consumers without
//! re-exporting through `main.rs`.
//!
//! Tech design: `docs/specs/feature-task-main-rs-carve-w38-tech-design.md`
//! Slice 1 of the W38+ second tranche.

use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::{Map, Value};
use std::{fs, path::Path};

use crate::{
    analytics::chrono_like_now_iso, api_client::handle_api_result, AnalyticsAction, AnalyticsArgs,
    Envelope, LobsterState, Task,
};

/// Replay a task's lifecycle analytics events in chronological order
/// (AC5 of task f170e344). Prints one human-readable line per event and
/// exits non-zero only for invalid task IDs, unreachable API, or
/// malformed API response. "No events" is a successful empty replay.
pub(crate) fn analytics_replay(args: AnalyticsArgs) -> Result<Envelope> {
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
        lobster_state.last_orchestrated_at = Some(chrono_like_now_iso());
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

fn format_evidence(map: &Map<String, Value>) -> String {
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
pub(crate) fn load_dotenv_token(key: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
}
