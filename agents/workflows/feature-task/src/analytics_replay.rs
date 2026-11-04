//! Analytics-replay stage handler + helpers for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W38 audit follow-up, finding A3:
//! "Feature-task `main.rs` remains a god file after W37 A3 first tranche
//! — second tranche required to bring `main.rs` below ~3,000 lines").
//! This module hosts the `analytics replay` subcommand and the small
//! helpers it composes: the JSON envelope builder, the human-readable
//! replay printer, two pure formatting helpers (`format_seconds` /
//! `format_evidence`).
//!
//! `pub(crate)` surface (only `main.rs` and sibling modules consume
//! these):
//! - `analytics_replay(args)` — `analytics replay` subcommand handler;
//!   fetches `/feature-task-analytics/tasks/{id}/events`, prints a
//!   human-readable replay, and returns the JSON envelope.
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

use crate::{
    analytics::{analytics_events_url, chrono_like_now_iso, collect_paged_events},
    api_client::handle_api_result,
    AnalyticsAction, AnalyticsArgs, Envelope, LobsterState, Task,
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

    let events = fetch_replay_events(&base_url, &task_id)?;

    let envelope = replay_envelope(&task_id, &events);
    print_replay(&task_id, &events);
    Ok(envelope)
}

/// Fetch the task's complete lifecycle event history.
///
/// The per-task events endpoint is bounded: a response carries one page of
/// events plus a `pagination` envelope, so the fetch follows
/// `pagination.nextCursor` until `pagination.hasMore` is false and
/// concatenates the pages in order. Stopping after the first page would
/// silently truncate the replay, so a repeated cursor, a missing cursor
/// on a `hasMore` response, or an unbounded page count is an error.
pub(crate) fn fetch_replay_events(base_url: &str, task_id: &str) -> Result<Vec<Value>> {
    collect_paged_events(|cursor| {
        let url = analytics_events_url(base_url, task_id, cursor);
        let body: Value = handle_api_result(ureq::get(&url).call())?;
        Ok(body)
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::test_http::spawn_sequential_server;
    use serde_json::json;

    const TEST_TASK_ID: &str = "11111111-2222-3333-4444-555555555555";

    fn page(events: Vec<Value>, has_more: bool, next_cursor: Option<&str>) -> String {
        json!({
            "data": events,
            "pagination": {
                "limit": 500,
                "returned": events.len(),
                "hasMore": has_more,
                "nextCursor": next_cursor,
            }
        })
        .to_string()
    }

    #[test]
    fn fetch_replay_events_follows_pagination_over_http() {
        let page_one = page(
            vec![json!({"eventType": "gate_failure", "occurredAt": "2026-10-01T00:00:00Z"})],
            true,
            Some("cursor-1"),
        );
        let page_two = page(
            vec![json!({"eventType": "terminal_summary", "occurredAt": "2026-10-02T00:00:00Z"})],
            false,
            None,
        );
        let (base_url, server) = spawn_sequential_server(vec![page_one, page_two]);

        let events = fetch_replay_events(&base_url, TEST_TASK_ID).expect("fetch replay events");

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["eventType"], "gate_failure");
        assert_eq!(events[1]["eventType"], "terminal_summary");

        let paths = server.join().expect("test server thread");
        assert_eq!(paths.len(), 2);
        assert_eq!(
            paths[0],
            format!("/feature-task-analytics/tasks/{TEST_TASK_ID}/events")
        );
        assert_eq!(
            paths[1],
            format!("/feature-task-analytics/tasks/{TEST_TASK_ID}/events?cursor=cursor-1")
        );
    }

    #[test]
    fn fetch_replay_events_accepts_legacy_single_page_response() {
        let body = json!({"data": [{"eventType": "gate_failure"}]}).to_string();
        let (base_url, server) = spawn_sequential_server(vec![body]);

        let events = fetch_replay_events(&base_url, TEST_TASK_ID).expect("fetch replay events");

        assert_eq!(events.len(), 1);
        let paths = server.join().expect("test server thread");
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn fetch_replay_events_fails_on_repeated_cursor() {
        let body = page(
            vec![json!({"eventType": "gate_failure"})],
            true,
            Some("cursor-1"),
        );
        let (base_url, server) = spawn_sequential_server(vec![body.clone(), body]);

        let err = fetch_replay_events(&base_url, TEST_TASK_ID)
            .expect_err("repeated cursor must fail the replay");
        assert!(err.to_string().contains("repeated cursor"));

        let _ = server.join();
    }

    #[test]
    fn replay_envelope_counts_every_fetched_event() {
        let events = vec![
            json!({"eventType": "gate_failure"}),
            json!({"eventType": "gate_failure"}),
            json!({"eventType": "terminal_summary"}),
        ];
        let envelope = replay_envelope(TEST_TASK_ID, &events);
        assert_eq!(envelope.action_taken, "analytics_replay_returned_3_events");
        assert_eq!(envelope.task.id, TEST_TASK_ID);
    }
}
