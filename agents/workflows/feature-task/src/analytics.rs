// Feature-task lifecycle analytics emission for task f170e344.
//
// This module is the Rust side of the Post-Merge Feature Factory Analytics
// feature. It hooks the existing feature-task workflow (agents/workflows/
// feature-task) into the Tasks API analytics surface (POST /api/v1/
// feature-task-analytics/events).
//
// Event types emitted by this module:
//   - `gate_failure`        — emitted on every gate block via `emit_gate_failure_events`
//   - `terminal_summary`    — emitted on every done/accepted transition via `emit_terminal_summary_event`
//   - `evidence_mismatch`   — emitted when an AC's evidence annotation doesn't match verified
//                             state (e.g. cited test file does not exist, cited PR # is not
//                             merged). Stub emitter at `emit_evidence_mismatch_event`; full
//                             verification logic added in a follow-up PR.
//   - `mechanism_unwired`   — emitted by periodic audits (factory-retro's weekly pass, future
//                             schema/doc drift scans) when a built capability has no exercise
//                             signal. Stub emitter at `emit_mechanism_unwired_event`; the audit
//                             itself runs outside the lobster and calls into this module to
//                             persist the event.
//
// Responsibilities:
//   1. `classify_failure(gate, failure_text)` — capacity vs quality split.
//   2. `emit_gate_failure_events(args, task, gate, failures)` — best-effort
//      POST of one event per failure, called after the workflow writes its
//      blocked-comment. Analytics failures MUST NOT block task progression.
//   3. `emit_terminal_summary_event(args, task, terminal_status)` — POST
//      the single task-lifecycle completion event after the workflow
//      successfully transitions to `done` (or `accepted` if/when that
//      terminal state is introduced). The summary counts gate failures by
//      cause and computes PR cycle time + evidence distribution from
//      merged PRs.
//   4. `emit_evidence_mismatch_event(args, task_id, evidence_text, reason)` — stub
//      for the evidence-verification gap that Ash (Principal Quality Engineer) is built
//      to close. Emits one event per AC whose cited evidence doesn't match verified state.
//   5. `emit_mechanism_unwired_event(args, capability_slug, reason)` — stub for the
//      dead/unwired capability signal that surfaces "feature exists but no exercise" gaps.
//      Called from factory-retro's weekly audit (see agents/skills/ops/factory-retro/SKILL.md).
//
// Routing is best-effort: errors are logged to stderr and swallowed. The
// existing pattern (`add_comment` and `write_state`) treats analytics
// observability as a side-effect, not a workflow gate.
//
// Tech design: docs/specs/post-merge-feature-factory-analytics-tech-design.md
// API surface: services/tasks-api/src/routes/featureTaskAnalytics.ts

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::process::Command;

use crate::{Task, StageArgs};

/// Capacity vs quality classification for a single gate failure string.
///
/// Returns `&'static str` so callers can use the value directly in JSON
/// fields without lifetime gymnastics. The classifier is intentionally
/// permissive: unknown failures default to `quality` so dashboards do not
/// undercount quality gates when a new failure mode is added.
pub fn classify_failure(gate: &str, failure: &str) -> &'static str {
    let lower = failure.to_lowercase();

    // Capacity signals — implementer capacity, dependency capacity, and
    // explicit `blocked: true` task blockers. These are typically routing
    // / scheduling issues, not code/spec quality issues.
    if lower.contains("already has an active task in `doing`")
        || lower.contains("already has an active task in doing")
        || lower.contains("already has an unblocked doing task")
        || lower.contains("blocked: true")
        || lower.contains("manual_block")
        || lower.contains("manual block")
        || lower.contains("clear the block to allow progression")
        || lower.contains("dependency_blocked")
        || lower.contains("dependency blocked")
    {
        return "capacity";
    }

    // Quality signals — anything that should have been caught during task
    // prep, gate checks, review, or QA. Includes missing-spec, missing-
    // approval, missing-assignee, missing-evidence, CI/check failures,
    // review changes-requested, stale/missing system spec, spec drift,
    // malformed PR body, and so on.
    if lower.contains("missing")
        || lower.contains("uncheck")
        || lower.contains("does not include")
        || lower.contains("must include")
        || lower.contains("invalid")
        || lower.contains("not found")
        || lower.contains("could not")
        || lower.contains("failed")
        || lower.contains("error")
        || lower.contains("validation")
        || lower.contains("changes_requested")
        || lower.contains("changes requested")
        || lower.contains("not merged")
        || lower.contains("stale")
        || lower.contains("drift")
        || lower.contains("system spec")
        || lower.contains("evidence")
        || lower.contains("test id")
        || lower.contains("testid")
        || lower.contains("not code")
        || lower.contains("not tested")
        || lower.contains("approval")
        || lower.contains("checksum")
        || lower.contains("archived")
        || lower.contains("reverted")
    {
        return "quality";
    }

    // Default to quality so dashboards do not undercount quality gates
    // when a new failure mode is added without updating the classifier.
    let _ = gate; // gate reserved for future gate-specific heuristics.
    "quality"
}

/// SHA-256 hex digest of a failure string, used to build stable event keys
/// for idempotent upserts on the analytics endpoint.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// POST a single analytics event to the Tasks API. Best-effort: errors are
/// logged to stderr and swallowed so analytics observability never blocks
/// task progression.
///
/// Auth (task 0719a8e3): the analytics-events endpoint is now gated by the
/// general-mutation auth middleware. We authenticate with
/// FEATURE_TASK_LOBSTER_TOKEN (preferred) and fall back to
/// TASKS_API_APPROVAL_TOKEN (Quinn actor) so this continues to work
/// before Quinn provisions the per-agent token. When both env vars are
/// unset we still attempt the POST so that locally-developed flows
/// without secrets can iterate (the API will 401 in that case and we
/// log+swallow, matching the existing best-effort posture).
fn post_event_best_effort(args: &StageArgs, payload: Value) {
    let url = format!(
        "{}/feature-task-analytics/events",
        args.base_url.trim_end_matches('/')
    );
    let token = std::env::var("FEATURE_TASK_LOBSTER_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("TASKS_API_APPROVAL_TOKEN")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let mut request = ureq::post(&url);
    if let Some(ref token) = token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    match request.send_json(payload) {
        Ok(_) => {}
        Err(err) => {
            eprintln!("warning: analytics POST failed for {url}: {err}");
        }
    }
}

/// Emit one `gate_failure` event per failure string. Called after the
/// workflow writes its blocked-comment so the failures recorded in the
/// terminal summary can be cross-referenced against the raw events.
///
/// Failures are emitted in the order they appear in the input. The ordinal
/// in the event key is unique within a single (task, gate, failure_text)
/// tuple, so identical failure strings within one gate emit distinct events
/// — that mirrors the workflow's existing fail-fast semantics, where the
/// same failure appearing twice in one gate run is a distinct observation.
pub fn emit_gate_failure_events(args: &StageArgs, task: &Task, gate: &str, failures: &[String]) {
    for (idx, failure) in failures.iter().enumerate() {
        let cause = classify_failure(gate, failure);
        let failure_hash = sha256_hex(failure.as_bytes());
        let event_key = format!(
            "feature-task:{}:{}:{}:{}",
            task.id,
            gate,
            failure_hash,
            idx + 1
        );
        let payload = json!({
            "taskId": task.id,
            "eventKey": event_key,
            "eventType": "gate_failure",
            "gate": gate,
            "cause": cause,
            "message": failure,
        });
        post_event_best_effort(args, payload);
    }
}

#[derive(Debug, Default)]
struct GateFailureCounts {
    total: u64,
    capacity: u64,
    quality: u64,
}

#[derive(Debug, Default)]
struct EvidenceDistribution {
    counts: std::collections::BTreeMap<String, u64>,
}

impl EvidenceDistribution {
    fn from_bodies(bodies: &[String]) -> Self {
        let mut counts = std::collections::BTreeMap::new();
        // Known evidence labels per tech design. Match case-insensitively.
        let labels = [
            "e2e",
            "integration",
            "component",
            "unit",
            "file",
            "manual",
            "screenshot",
            "logs",
            "ci",
            "system-spec",
            "no-system-spec-change",
        ];
        for body in bodies {
            let lower = body.to_lowercase();
            let mut matched = false;
            for label in labels {
                if lower.contains(&format!("({label}")) || lower.contains(&format!(":{label}")) {
                    *counts.entry(label.to_string()).or_insert(0) += 1;
                    matched = true;
                }
            }
            if !matched {
                // Check if the AC is checked at all (i.e., `- [x] AC…`) —
                // if so, count as unspecified so we know there was coverage
                // without an explicit label.
                if lower.contains("- [x]") || lower.contains("- [X]") {
                    *counts.entry("unspecified".to_string()).or_insert(0) += 1;
                }
            }
        }
        Self { counts }
    }

    fn into_json(self) -> Option<Value> {
        if self.counts.is_empty() {
            None
        } else {
            Some(
                self.counts
                    .into_iter()
                    .map(|(k, v)| (k, Value::from(v)))
                    .collect::<serde_json::Map<_, _>>()
                    .into(),
            )
        }
    }
}

/// Query the analytics endpoint for the task's raw events. Returns an
/// empty Vec if the task has no events yet (e.g., first run) or if the
/// GET fails (we do not want to block task close on analytics lookup).
fn fetch_task_events(args: &StageArgs, task_id: &str) -> Vec<Value> {
    let url = format!(
        "{}/feature-task-analytics/tasks/{task_id}/events",
        args.base_url.trim_end_matches('/')
    );
    let response = ureq::get(&url).call();
    match response {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(value) => value
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

fn count_gate_failures(events: &[Value]) -> GateFailureCounts {
    let mut counts = GateFailureCounts::default();
    for event in events {
        if event.get("eventType").and_then(Value::as_str) != Some("gate_failure") {
            continue;
        }
        counts.total += 1;
        match event.get("cause").and_then(Value::as_str) {
            Some("capacity") => counts.capacity += 1,
            Some("quality") => counts.quality += 1,
            _ => counts.quality += 1, // unknown cause == quality (matches classify_failure default)
        }
    }
    counts
}

/// Fetch PR cycle time (in seconds) for the task's implementer PRs. Uses
/// `gh pr view` like the existing `inspect_pr` / `pr_body` helpers. Cycle
/// time is defined as `latest mergedAt - earliest createdAt` across all
/// merged PRs. Returns `None` if no PRs are merged or `gh` metadata is
/// unavailable.
fn fetch_pr_cycle_time_seconds(prs: &[String]) -> Option<u64> {
    let mut earliest_created: Option<i64> = None;
    let mut latest_merged: Option<i64> = None;
    for pr in prs {
        let output = Command::new("gh")
            .args([
                "pr",
                "view",
                pr,
                "--json",
                "state,createdAt,mergedAt",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let value: Value = serde_json::from_slice(&output.stdout).ok()?;
        let state = value.get("state").and_then(Value::as_str);
        if state != Some("MERGED") {
            continue;
        }
        let created = value
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(chrono_like_parse_to_unix);
        let merged = value
            .get("mergedAt")
            .and_then(Value::as_str)
            .and_then(chrono_like_parse_to_unix);
        if let (Some(c), Some(m)) = (created, merged) {
            earliest_created = Some(earliest_created.map_or(c, |v| v.min(c)));
            latest_merged = Some(latest_merged.map_or(m, |v| v.max(m)));
        }
    }
    match (earliest_created, latest_merged) {
        (Some(c), Some(m)) if m >= c => Some((m - c) as u64),
        _ => None,
    }
}

/// Minimal ISO-8601 parser accepting the `YYYY-MM-DDTHH:MM:SSZ` shape that
/// GitHub returns. Keeps us off the `chrono` dependency tree for what is
/// a single datetime subtraction.
fn chrono_like_parse_to_unix(s: &str) -> Option<i64> {
    // GitHub's ISO timestamps are always UTC and always in the form
    // `2026-07-25T08:00:00Z`. We do not need sub-second precision for
    // PR cycle time so we truncate to seconds.
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let parse_component = |start: usize, end: usize| -> Option<i64> {
        std::str::from_utf8(&bytes[start..end])
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
    };
    let year = parse_component(0, 4)?;
    let month = parse_component(5, 7)?;
    let day = parse_component(8, 10)?;
    let hour = parse_component(11, 13)?;
    let minute = parse_component(14, 16)?;
    let second = parse_component(17, 19)?;
    // Days from civil (Howard Hinnant's algorithm) — UTC, no leap seconds.
    let (year, month) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let m = month;
    let d = day;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + hour) * 60 + minute) * 60 + second)
}

/// Emit an `evidence_mismatch` event when an AC's cited evidence doesn't
/// match verified state (e.g. the cited test file doesn't exist, the cited
/// PR # is not merged, the cited commit isn't in the repo). Called from
/// Ash's QA verification step (per task f6a4d56a) and from any future
/// lobster check that does independent verification of evidence claims.
/// One event per AC whose cited evidence doesn't match.
///
/// Best-effort: errors are logged and swallowed. This is observability,
/// not a workflow gate — the actual gate (blocking vs passing) lives in
/// the caller's verification logic, which uses this event as one of its
/// inputs.
pub fn emit_evidence_mismatch_event(
    args: &StageArgs,
    task_id: &str,
    ac_label: &str,
    evidence_text: &str,
    reason: &str,
) {
    let evidence_hash = sha256_hex(evidence_text.as_bytes());
    let event_key = format!(
        "feature-task:{}:evidence-mismatch:{}:{}",
        task_id,
        ac_label,
        evidence_hash
    );
    let payload = json!({
        "taskId": task_id,
        "eventKey": event_key,
        "eventType": "evidence_mismatch",
        "ac": ac_label,
        "evidenceText": evidence_text,
        "reason": reason,
    });
    post_event_best_effort(args, payload);
}

/// Emit a `mechanism_unwired` event when a built capability has no exercise
/// signal. Called from periodic audits (factory-retro's weekly pass — see
/// `agents/skills/ops/factory-retro/SKILL.md`, Quinn's heartbeat sweep).
/// One event per (capability, observation) pair — re-emits of the same
/// observation are deduplicated by the (capability, reason-hash) key.
///
/// Best-effort: errors are logged and swallowed. This is observability,
/// not a workflow gate. The capability slug should be a stable kebab-case
/// identifier so observations across time and agents can be grouped.
pub fn emit_mechanism_unwired_event(
    args: &StageArgs,
    capability_slug: &str,
    reason: &str,
) {
    let slug_hash = sha256_hex(capability_slug.as_bytes());
    let reason_hash = sha256_hex(reason.as_bytes());
    let event_key = format!(
        "mechanism-unwired:{}:{}:{}",
        capability_slug,
        slug_hash,
        reason_hash
    );
    let payload = json!({
        "eventKey": event_key,
        "eventType": "mechanism_unwired",
        "capability": capability_slug,
        "reason": reason,
        "observedAt": chrono_like_now_iso(),
    });
    post_event_best_effort(args, payload);
}

/// Emit the terminal summary event. Called after the workflow successfully
/// transitions to `done` (or `accepted`).
///
/// Best-effort: if the analytic-events GET fails, we still emit a summary
/// with zero counts. If the POST itself fails, we log and swallow so the
/// task close is never blocked by analytics observability.
pub fn emit_terminal_summary_event(args: &StageArgs, task: &Task, terminal_status: &str) {
    let events = fetch_task_events(args, &task.id);
    let counts = count_gate_failures(&events);

    // Best-effort PR metadata: skip the call entirely if the task has no
    // implementer PRs to avoid spawning `gh` gratuitously.
    let pr_urls = extract_implementer_pr_urls(task);
    let pr_cycle_time_seconds = if pr_urls.is_empty() {
        None
    } else {
        fetch_pr_cycle_time_seconds(&pr_urls)
    };

    let pr_bodies: Vec<String> = pr_urls
        .iter()
        .filter_map(|url| gh_pr_body(url).ok())
        .collect();
    let evidence = EvidenceDistribution::from_bodies(&pr_bodies).into_json();

    let payload = json!({
        "taskId": task.id,
        "eventKey": format!("feature-task:{}:terminal:{}", task.id, terminal_status),
        "eventType": "terminal_summary",
        "terminalStatus": terminal_status,
        "completionTimestamp": chrono_like_now_iso(),
        "totalGateFailureCount": counts.total,
        "capacityBlockCount": counts.capacity,
        "qualityFailureCount": counts.quality,
        "prCycleTimeSeconds": pr_cycle_time_seconds,
        "evidenceTypeDistribution": evidence,
    });
    post_event_best_effort(args, payload);
}

/// Same shape as `pr_body` in main.rs but local to this module so we do
/// not have to expose the helper to the module boundary. The output may
/// be JSON-encoded by gh 2.87.3 when the body contains non-ASCII — we
/// decode here too.
fn gh_pr_body(url: &str) -> Result<String> {
    let output = Command::new("gh")
        .args(["pr", "view", url, "--json", "body", "--jq", ".body"])
        .output()
        .context("run gh pr view --json body")?;
    if !output.status.success() {
        return Err(anyhow!(
            "{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = String::from_utf8(output.stdout)?;
    let trimmed = raw.trim();
    if trimmed.starts_with('"') {
        if let Ok(Value::String(decoded)) = serde_json::from_str(trimmed) {
            return Ok(decoded);
        }
    }
    Ok(raw)
}

/// Extract implementer PR URLs from the task's `[implementer-prs]` comment
/// or from the lobster-state. Same convention as the workflow's existing
/// `implementer_pr_urls` helper — we duplicate the small parser here so
/// this module stays self-contained.
fn extract_implementer_pr_urls(task: &Task) -> Vec<String> {
    let mut urls = Vec::new();
    for comment in &task.comments {
        let body = comment
            .text
            .as_deref()
            .or(comment.body.as_deref())
            .unwrap_or("");
        for line in body.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("[implementer-prs]") {
                for token in rest.split_whitespace() {
                    if token.starts_with("https://") && token.contains("/pull/") {
                        urls.push(token.to_string());
                    }
                }
            }
        }
    }
    urls.sort();
    urls.dedup();
    urls
}

/// RFC-3339-style UTC timestamp for `completionTimestamp`. Mirrors the
/// `chrono::Utc::now().to_rfc3339()` shape from the API perspective.
pub fn chrono_like_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = unix_to_civil(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

fn unix_to_civil(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let time_of_day = secs.rem_euclid(86400) as u32;
    let hour = time_of_day / 3600;
    let minute = (time_of_day % 3600) / 60;
    let second = time_of_day % 60;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hour, minute, second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TaskComment;

    fn make_task(id: &str) -> Task {
        Task {
            id: id.to_string(),
            ..Task::default()
        }
    }

    #[test]
    fn classify_capacity_block_patterns() {
        assert_eq!(classify_failure("ready_checks", "Implementer `Rowan` already has an active task in `doing`."), "capacity");
        assert_eq!(classify_failure("ready_checks", "Task is manually blocked (`blocked: true`); clear the block to allow progression."), "capacity");
        assert_eq!(classify_failure("ready_checks", "Dependency blocked; clear the block to allow progression."), "capacity");
    }

    #[test]
    fn classify_quality_missing_patterns() {
        assert_eq!(classify_failure("ready_checks", "Missing task comment `[tech-design] <url>`."), "quality");
        assert_eq!(classify_failure("ready_checks", "AC2 missing evidence."), "quality");
        assert_eq!(classify_failure("verify_delivery", "PR https://example.com/pull/1 is not merged: ChangesRequested."), "quality");
        assert_eq!(classify_failure("post_merge", "AC text altered — copy the AC text verbatim from the task description."), "quality");
    }

    #[test]
    fn classify_unknown_defaults_to_quality() {
        assert_eq!(classify_failure("ready_checks", "Some new failure mode we haven't seen before"), "quality");
    }

    #[test]
    fn classify_is_case_insensitive() {
        assert_eq!(classify_failure("ready_checks", "MISSING `[tech-design] <url>`"), "quality");
        assert_eq!(classify_failure("ready_checks", "Implementer RowAN ALREADY HAS AN ACTIVE TASK IN `doing`."), "capacity");
    }

    #[test]
    fn sha256_hex_is_stable_for_same_input() {
        let a = sha256_hex(b"missing tech design");
        let b = sha256_hex(b"missing tech design");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn chrono_like_parse_unix_round_trip() {
        // 2026-07-25T08:00:00Z
        let secs = chrono_like_parse_to_unix("2026-07-25T08:00:00Z").unwrap();
        let (y, m, d, h, mi, s) = unix_to_civil(secs);
        assert_eq!((y, m, d, h, mi, s), (2026, 7, 25, 8, 0, 0));
    }

    #[test]
    fn chrono_like_parse_unix_handles_known_dates() {
        // 1970-01-01T00:00:00Z should be 0
        assert_eq!(chrono_like_parse_to_unix("1970-01-01T00:00:00Z"), Some(0));
        // 2026-07-25T08:00:00Z — sane positive value
        assert!(chrono_like_parse_to_unix("2026-07-25T08:00:00Z").unwrap() > 0);
    }

    #[test]
    fn evidence_distribution_counts_known_labels() {
        let bodies = vec![
            "- [x] AC1: Foo (unit: 1)".to_string(),
            "- [x] AC2: Bar (manual: smoke test)".to_string(),
            "- [x] AC3: Baz (integration: +1)".to_string(),
        ];
        let dist = EvidenceDistribution::from_bodies(&bodies).into_json();
        let obj = dist.unwrap();
        assert_eq!(obj.get("unit").cloned().unwrap_or(Value::Null), Value::from(1u64));
        assert_eq!(obj.get("manual").cloned().unwrap_or(Value::Null), Value::from(1u64));
        assert_eq!(obj.get("integration").cloned().unwrap_or(Value::Null), Value::from(1u64));
    }

    #[test]
    fn evidence_distribution_counts_unknown_label_as_unspecified() {
        // (testID: 1) is a common lobster convention but is not in the
        // recognised label list, so a checked AC with this evidence
        // should fall into the "unspecified" bucket so the dashboard
        // still shows coverage without inventing a label.
        let bodies = vec![
            "- [x] AC1: Foo (testID: 1)".to_string(),
        ];
        let dist = EvidenceDistribution::from_bodies(&bodies).into_json();
        let obj = dist.unwrap();
        assert_eq!(obj.get("unspecified").cloned().unwrap_or(Value::Null), Value::from(1u64));
    }

    #[test]
    fn evidence_distribution_counts_unchecked_as_unspecified() {
        let bodies = vec!["- [x] AC1: Foo no label here".to_string()];
        let dist = EvidenceDistribution::from_bodies(&bodies).into_json();
        let obj = dist.unwrap();
        assert_eq!(obj.get("unspecified"), Some(&Value::from(1u64)));
    }

    #[test]
    fn evidence_distribution_empty_returns_none() {
        let dist = EvidenceDistribution::from_bodies(&[]).into_json();
        assert!(dist.is_none());
    }

    #[test]
    fn count_gate_failures_splits_by_cause() {
        let events = vec![
            json!({"eventType": "gate_failure", "cause": "capacity"}),
            json!({"eventType": "gate_failure", "cause": "quality"}),
            json!({"eventType": "gate_failure", "cause": "quality"}),
            json!({"eventType": "terminal_summary"}),
        ];
        let counts = count_gate_failures(&events);
        assert_eq!(counts.total, 3);
        assert_eq!(counts.capacity, 1);
        assert_eq!(counts.quality, 2);
    }

    #[test]
    fn extract_implementer_pr_urls_parses_comment_block() {
        let mut task = make_task("task-1");
        task.comments = vec![
            TaskComment {
                text: Some("[implementer-prs] https://github.com/foo/bar/pull/1".to_string()),
                body: None,
            },
            TaskComment {
                text: Some("[implementer-prs] https://github.com/foo/bar/pull/2 https://github.com/foo/bar/pull/1".to_string()),
                body: None,
            },
        ];
        let urls = extract_implementer_pr_urls(&task);
        assert_eq!(urls, vec![
            "https://github.com/foo/bar/pull/1".to_string(),
            "https://github.com/foo/bar/pull/2".to_string(),
        ]);
    }
}
