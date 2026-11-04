//! Cross-stage structured-approval predicates for the feature-task workflow.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module
//! hosts the source-of-truth readers for the `Task.approvals` table:
//! `task_approval_granted` (the matching-row predicate), the three
//! stage-bound predicates (`accepted_structured`,
//! `spec_check_should_skip_legacy_mutation`, `qa_agent_verified`) that
//! each gate a transition, and the user-facing failure-string helpers
//! (`accepted_structured_failures`, `qa_agent_verified_failures`).
//!
//! `pub(crate)` surface (consumed by `main.rs`, `verify_delivery.rs`,
//! `feedback_aggregate.rs`, and `post_merge.rs`):
//!
//! - `task_approval_granted` — predicate over a single approval row.
//! - `accepted_structured` — `accepted` approval is approved.
//! - `accepted_structured_failures` — failure strings for the
//!   `accepted` gate (consumed by `post_merge` and the cross-stage
//!   transition matrix in `main.rs::mod tests`).
//! - `spec_check_should_skip_legacy_mutation` — `spec` approval is
//!   approved (used by `block_on_spec_drift_fluid` and `mod tests`).
//! - `qa_agent_verified` — `qa_agent` approval is approved (Ash's
//!   mechanical-verification gate on the `doing → acceptance`
//!   transition; consumed by `verify_delivery` and the
//!   `reconcile_workflow_attention` matrix in `main.rs`).
//! - `qa_agent_verified_failures` — failure strings for the `qa_agent`
//!   gate (consumed by `verify_delivery`).
//!
//! Structured approvals are the primary gate source. The latest Ash QA
//! verdict is also consulted as a safety invariant: a stale approved row must
//! not survive a later `[qa-agent-deferred]` or `[qa-agent-blocked]` report.
//! A capability deferral can be explicitly resolved with
//! `[qa-agent-capability-resolved]`; the legacy `[quinn-resolved]` marker is
//! accepted as an alias so existing tasks can recover without manual routing.
//! Missing, revoked, and unknown states fail closed.
//!
//! QA marker ordering is owned by one rule (task `1e8a430a`): a marker
//! speaks only for the QA pass that follows the latest approved `qa_agent`
//! attestation. `latest_qa_verdict` (is QA verified?) and
//! `qa_agent_blocked_after_latest_delivery` (is a blocked report still
//! current?) previously read comment history with different staleness rules,
//! so a fresh attestation could clear the verdict path while a stale
//! `[qa-agent-blocked]` marker kept the routing path selecting the delivery
//! assignee on every sweep. Both now run on the shared primitives below.
//!
//! Spec drift is intentionally NOT blocked here. Tom owns the ACs
//! during QA and may legitimately refine them; the spec-resync flow
//! (unchecking "Approved by Tom" and requiring explicit re-approval)
//! handles drift tracking.

use crate::{Task, TaskComment};
use std::cmp::Ordering;

/// Return true only when the matching structured approval row is approved.
/// Missing, revoked, and unknown states fail closed.
pub(crate) fn task_approval_granted(task: &Task, approval_type: &str) -> bool {
    task.approvals
        .iter()
        .any(|a| a.approval_type == approval_type && a.state == "approved")
}

/// The structured approval row is the source of truth regardless of actor.
/// Legacy approval-marker and acceptance-criteria reconciliation must stop
/// after approval; lifecycle path movement remains allowed separately.
pub(crate) fn spec_check_should_skip_legacy_mutation(task: &Task) -> bool {
    task_approval_granted(task, "spec")
}

/// True when the structured `accepted` TaskApproval row is
/// `state: approved`. Gates the `acceptance -> done` transition in
/// `post_merge` and the cross-stage attention-owner matrix in
/// `reconcile_workflow_attention`.
pub(crate) fn accepted_structured(task: &Task) -> bool {
    task_approval_granted(task, "accepted")
}

/// Failure strings for the `accepted` gate. Empty when the gate is satisfied.
/// Used by `post_merge` to short-circuit the transition with a
/// `[feature-task-progress-checklist]` comment.
pub(crate) fn accepted_structured_failures(task: &Task) -> Vec<String> {
    if accepted_structured(task) {
        vec![]
    } else {
        vec!["Structured accepted approval is missing or not approved; Tom must approve the `accepted` TaskApproval before closing.".to_string()]
    }
}

// ---- qa_agent gate (AC1 of task f6a4d56a, "Add Ash: QA-verifier gate") ----
//
// The `qa_agent` workflow gate is Ash's mechanical verification gate. It is
// created when a task enters `doing` (or when its PR merges while in `doing`)
// and gates the `doing → acceptance` transition. The lobster reads the
// structured `TaskApproval` row via `task_approval_granted` and refuses to
// promote a task until Ash approves the gate.

/// True when the structured `qa_agent` TaskApproval row is `state: approved`.
/// Used to gate the `doing -> acceptance` transition in `verify_delivery`.
/// Distinct from `accepted_structured` above (Tom's human sign-off); both
/// rows must be approved before the task can reach `done`.
pub(crate) fn qa_agent_verified(task: &Task) -> bool {
    task_approval_granted(task, "qa_agent") && !qa_agent_deferred(task) && !qa_agent_blocked(task)
}

// ---- QA marker ordering primitives (task 1e8a430a) ----
//
// One approval-aware ordering rule for every QA marker reader. See the
// module docs for why the rule lives here rather than being re-derived by
// each predicate.

/// A QA marker comment: its position in the task's comment list, its
/// creation timestamp, and the account that authored it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QaMarker {
    index: usize,
    created_at: Option<String>,
    author: Option<String>,
}

/// The comment body the workflow reads. The Tasks API exposes `text`; older
/// payloads used `body`.
fn comment_text(comment: &TaskComment) -> &str {
    comment
        .text
        .as_deref()
        .or(comment.body.as_deref())
        .unwrap_or_default()
}

/// True when `text` carries `tag` at the start of any line.
fn comment_carries_tag(text: &str, tag: &str) -> bool {
    text.lines().any(|line| line.trim_start().starts_with(tag))
}

/// Max `approved_at` over approved `qa_agent` rows. This is the attestation
/// of record: a comment can only speak for the QA pass that follows it.
fn latest_approved_qa_agent_at(task: &Task) -> Option<&str> {
    task.approvals
        .iter()
        .filter(|approval| approval.approval_type == "qa_agent" && approval.state == "approved")
        .filter_map(|approval| approval.approved_at.as_deref())
        .max()
}

/// Parse an RFC-3339 timestamp into `(epoch seconds, nanoseconds)`.
///
/// The Tasks API normalises `createdAt` to UTC RFC-3339, so a lexical
/// comparison already orders the normal case correctly. Parsing is the
/// robustness measure the design asks for: a timestamp carrying a non-UTC
/// offset would otherwise sort incorrectly against a UTC attestation.
/// Returns `None` for anything that is not RFC-3339.
fn parse_rfc3339(value: &str) -> Option<(i64, u32)> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b't' && bytes[10] != b' ' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut rest = &value[19..];
    let mut nanos: u32 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        let mut padded = digits.clone();
        padded.truncate(9);
        while padded.len() < 9 {
            padded.push('0');
        }
        nanos = padded.parse().ok()?;
        rest = &fraction[digits.len()..];
    }

    let offset_seconds = match rest.as_bytes().first() {
        Some(b'Z') | Some(b'z') => {
            if rest.len() != 1 {
                return None;
            }
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            if rest.len() != 6 || rest.as_bytes()[3] != b':' {
                return None;
            }
            let offset_hours: i64 = rest.get(1..3)?.parse().ok()?;
            let offset_minutes: i64 = rest.get(4..6)?.parse().ok()?;
            let magnitude = offset_hours * 3_600 + offset_minutes * 60;
            if *sign == b'+' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    Some((
        days * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds,
        nanos,
    ))
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = (if shifted_year >= 0 {
        shifted_year
    } else {
        shifted_year - 399
    }) / 400;
    let year_of_era = shifted_year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Order two timestamps. Parsed instants decide when both sides parse;
/// otherwise the raw strings decide, which is correct for the API's
/// normalised UTC RFC-3339 form.
fn compare_timestamps(left: &str, right: &str) -> Ordering {
    match (parse_rfc3339(left), parse_rfc3339(right)) {
        (Some(left_instant), Some(right_instant)) => left_instant.cmp(&right_instant),
        _ => left.cmp(right),
    }
}

/// Is `candidate_at` strictly newer than `reference_at`? A missing timestamp
/// can never be shown to be newer, so it is treated as stale (R3).
fn timestamp_is_newer(candidate_at: Option<&str>, reference_at: &str) -> bool {
    let Some(candidate_at) = candidate_at else {
        return false;
    };
    compare_timestamps(candidate_at, reference_at) == Ordering::Greater
}

/// Order two markers. Timestamps decide when both sides carry one;
/// otherwise the comment list order decides (R2), which preserves today's
/// behaviour for legacy undated comments.
fn compare_markers(left: &QaMarker, right: &QaMarker) -> Ordering {
    match (left.created_at.as_deref(), right.created_at.as_deref()) {
        (Some(left_at), Some(right_at)) => {
            let ordering = compare_timestamps(left_at, right_at);
            if ordering == Ordering::Equal {
                left.index.cmp(&right.index)
            } else {
                ordering
            }
        }
        _ => left.index.cmp(&right.index),
    }
}

/// Is `candidate` newer than `reference`?
fn marker_is_newer(candidate: &QaMarker, reference: &QaMarker) -> bool {
    compare_markers(candidate, reference) == Ordering::Greater
}

/// Is the marker current for the current QA pass?
///
/// A marker speaks only for the pass that follows the latest approved
/// `qa_agent` attestation. A marker that predates the attestation is stale
/// for routing, and a marker without a timestamp cannot be shown to be newer
/// than a timestamped attestation, so it is stale too (R3). With no
/// attestation at all the marker keeps whatever currency it had (R4).
fn marker_is_current_against_attestation(marker: &QaMarker, attestation_at: Option<&str>) -> bool {
    match attestation_at {
        None => true,
        Some(attestation_at) => timestamp_is_newer(marker.created_at.as_deref(), attestation_at),
    }
}

/// The newest comment carrying `tag` at the start of a line.
fn latest_qa_marker(task: &Task, tag: &str) -> Option<QaMarker> {
    task.comments
        .iter()
        .enumerate()
        .filter(|(_, comment)| comment_carries_tag(comment_text(comment), tag))
        .map(|(index, comment)| QaMarker {
            index,
            created_at: comment.created_at.clone(),
            author: comment.author.clone(),
        })
        .max_by(compare_markers)
}

/// The newest delivery handoff marker (`[implementer-prs]`, or the legacy
/// `[rowan-prs]` alias).
fn latest_delivery_marker(task: &Task) -> Option<QaMarker> {
    task.comments
        .iter()
        .enumerate()
        .filter(|(_, comment)| {
            let text = comment_text(comment);
            comment_carries_tag(text, "[implementer-prs]") || comment_carries_tag(text, "[rowan-prs]")
        })
        .map(|(index, comment)| QaMarker {
            index,
            created_at: comment.created_at.clone(),
            author: comment.author.clone(),
        })
        .max_by(compare_markers)
}

fn latest_qa_verdict(task: &Task) -> Option<&'static str> {
    // A structured approval is the start of the current QA pass. Ignore
    // verdict comments from an earlier pass; otherwise an old blocked report
    // can invalidate a later approval when the approval comment itself has no
    // verdict tag.
    let latest_approval_at = latest_approved_qa_agent_at(task);

    task.comments
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, comment)| {
            let marker = QaMarker {
                index,
                created_at: comment.created_at.clone(),
                author: comment.author.clone(),
            };
            // The same rule the blocked-arm predicate uses: a verdict comment
            // only speaks for the pass that follows the latest attestation.
            if !marker_is_current_against_attestation(&marker, latest_approval_at) {
                return None;
            }
            let text = comment_text(comment);
            let starts_with_tag = |tag: &str| comment_carries_tag(text, tag);
        if starts_with_tag("[qa-agent-deferred]") {
            Some("deferred")
        } else if starts_with_tag("[qa-agent-blocked]") {
            Some("blocked")
        } else if starts_with_tag("[qa-agent-capability-resolved]")
            || starts_with_tag("[quinn-resolved]")
        {
            Some("capability_resolved")
        } else if starts_with_tag("[qa-agent-verified]") {
            Some("verified")
        } else if starts_with_tag("[qa-agent-verification]") || starts_with_tag("[qa-verification]")
        {
            // Ash has historically used both verification tags. Treat a
            // later positive verification as closing the approval-note
            // fallback, but preserve an explicit deferred/blocked verdict
            // embedded in the same report.
            let lower = text.to_ascii_lowercase();
            if lower.contains("deferred") {
                Some("deferred")
            } else if lower.contains("blocked") {
                Some("blocked")
            } else {
                Some("verified")
            }
        } else {
            None
        }
    })
}

/// True when Ash has reported an unresolved capability gap. This is distinct
/// from the approval row because older deployments allowed Ash to approve
/// while also posting `[qa-agent-deferred]`; the report must invalidate that
/// stale approval until a later all-verified report arrives.
pub(crate) fn qa_agent_deferred(task: &Task) -> bool {
    match latest_qa_verdict(task) {
        Some("deferred") => true,
        Some("verified") | Some("blocked") | Some("capability_resolved") => false,
        _ => task
            .approvals
            .iter()
            .find(|approval| approval.approval_type == "qa_agent" && approval.state == "approved")
            .and_then(|approval| approval.note.as_deref())
            .is_some_and(|note| note.lines().any(note_line_asserts_deferral)),
    }
}

/// True when one line of a QA approval note asserts that criteria were
/// deferred.
///
/// The approval note is the only evidence available when no verdict comment
/// follows the approval, so a mention of "deferred" in it has to be read
/// carefully. A negation that scopes over the mention — Ash's standard
/// closing sentence is "No blocked or deferred ACs." — is not an assertion
/// of a deferral, and reading it as one manufactures a capability handoff
/// that no verifier ever reported. A clause boundary between the negation
/// and the mention ("not approved; deferred criteria remain") ends the
/// negation's scope, so that mention still counts as an assertion.
fn note_line_asserts_deferral(line: &str) -> bool {
    const NEGATIONS: [&str; 8] = [
        "no", "not", "none", "never", "zero", "without", "neither", "nor",
    ];
    let lower = line.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(offset) = lower[cursor..].find("deferred") {
        let start = cursor + offset;
        if !deferral_mention_is_negated(&lower[..start], &NEGATIONS) {
            return true;
        }
        cursor = start + "deferred".len();
    }
    false
}

/// True when a negation in `prefix` scopes over the "deferred" mention that
/// follows it.
fn deferral_mention_is_negated(prefix: &str, negations: &[&str]) -> bool {
    // `non-deferred` negates the mention directly.
    if prefix.ends_with("non-") {
        return true;
    }
    for word in negations {
        let Some(pos) = prefix.rfind(word) else {
            continue;
        };
        // The negation has to stand alone, not be part of a larger token.
        let before_ok = prefix[..pos]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after = &prefix[pos + word.len()..];
        let after_ok = after.chars().next().is_none_or(|c| !c.is_alphanumeric());
        if !before_ok || !after_ok {
            continue;
        }
        // Only a nearby negation scopes over the mention.
        if after.split_whitespace().count() > 3 {
            continue;
        }
        // A clause boundary ends the negation's scope.
        if after.contains([',', ';', ':', '.']) {
            continue;
        }
        return true;
    }
    false
}

/// True when a deferred Ash capability gap has been captured as a real
/// capability-extension dependency. The original task must remain unapproved
/// until the extension lands, but Quinn is no longer the active owner once
/// the dependency edge exists.
pub(crate) fn qa_agent_deferred_waiting_on_capability_extension(task: &Task) -> bool {
    task.dependency_blocked && qa_agent_deferred(task)
}

/// True when the dependency that carried a deferred capability gap has
/// completed. The original task is ready for Ash to rerun; the stale Quinn
/// handoff must not survive the completed dependency.
pub(crate) fn qa_agent_deferred_capability_extension_complete(task: &Task) -> bool {
    qa_agent_deferred(task)
        && !task.dependency_blocked
        && task
            .depends_on
            .iter()
            .any(|dependency| dependency.status == "done")
}

/// What a `[qa-agent-blocked]` comment asserts (task `dbce028f`).
///
/// The tag is used for two different statements. The lobster's generic
/// marker says the structured `qa_agent` approval has not been granted and
/// names Ash as the actor. A verifier's marker says the delivered evidence
/// itself is unsupported and names the delivery owner as the actor. Only the
/// second kind is a delivery-evidence block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QaBlockKind {
    /// The lobster's generic QA-gate prompt: the `qa_agent` approval has not
    /// been granted yet. It says nothing about the delivery.
    QaGatePrompt,
    /// A verifier's per-AC blocked verdict: the delivery evidence itself is
    /// unsupported, so the delivery owner must act.
    EvidenceVerdict,
}

/// The QA verifier account. A blocked marker from this author is always an
/// evidence verdict.
const QA_VERIFIER_AUTHOR: &str = "Ash";

/// The lobster service account. A blocked marker from this author is always
/// the generic QA-gate prompt it posts when the `qa_agent` gate is open.
const LOBSTER_AUTHOR: &str = "feature_task_lobster";

/// Classify what a `[qa-agent-blocked]` marker asserts.
///
/// Precedence (task `dbce028f`, gate decision Q1):
///
/// 1. A known verifier author is always an `EvidenceVerdict`. The structured
///    row state never overrides it: a blocked task has no approved
///    attestation, so letting the row state decide would silently reclassify
///    Ash's own per-AC verdict as a gate prompt and strand the delivery
///    owner with nobody to act on it.
/// 2. A known lobster service account is always a `QaGatePrompt`.
/// 3. An unknown author falls back to the structured `qa_agent` row state:
///    a gate prompt when no attestation has been approved (the QA gate is
///    open), and an `EvidenceVerdict` otherwise. Unclassified shapes fail
///    closed, so today's routing is preserved for anything this classifier
///    has not explicitly recognised.
fn classify_qa_block(task: &Task, marker: &QaMarker) -> QaBlockKind {
    let author = marker.author.as_deref().unwrap_or_default().trim();
    if author.eq_ignore_ascii_case(QA_VERIFIER_AUTHOR) {
        return QaBlockKind::EvidenceVerdict;
    }
    if author.eq_ignore_ascii_case(LOBSTER_AUTHOR) {
        return QaBlockKind::QaGatePrompt;
    }
    qa_block_kind_from_row_state(task)
}

/// The structured-state fallback for a marker whose author is neither a
/// known verifier nor the known lobster service account.
fn qa_block_kind_from_row_state(task: &Task) -> QaBlockKind {
    // A `qa_agent` row in a state other than pending/approved is a shape
    // this classifier does not recognise: fail closed and keep the routing
    // that exists today.
    if task.approvals.iter().any(|approval| {
        approval.approval_type == "qa_agent"
            && approval.state != "pending"
            && approval.state != "approved"
    }) {
        return QaBlockKind::EvidenceVerdict;
    }
    // No approved attestation means the QA gate is open, so a blocked marker
    // is a prompt to the gate owner rather than a verdict on a delivery.
    if latest_approved_qa_agent_at(task).is_none() {
        QaBlockKind::QaGatePrompt
    } else {
        QaBlockKind::EvidenceVerdict
    }
}

/// True when Ash has reported an evidence blocker after an older approval.
pub(crate) fn qa_agent_blocked(task: &Task) -> bool {
    matches!(latest_qa_verdict(task), Some("blocked"))
}

/// True when the latest blocked QA report is still current for routing AND
/// it is an evidence verdict rather than the lobster's generic QA-gate
/// prompt.
///
/// A blocked report is stale when a later delivery handoff replaced it
/// (AC3), and stale when it predates the current `qa_agent` attestation
/// (AC1) — Ash's fresh approval closes the stale blocked history. A blocked
/// report that is newer than both still routes to the delivery assignee
/// (AC2).
///
/// With no approved attestation the blocked arm behaves exactly as before
/// (R4): the delivery comparison alone decides. A revoked or pending
/// `qa_agent` row is not an attestation, so it never weakens this route.
///
/// Task `dbce028f`: the kind of the marker decides who owns it. The
/// lobster's generic QA-gate prompt (its own `[qa-agent-blocked]` comment
/// carrying the `qa_agent` gate fingerprint) is a prompt to the QA gate
/// owner, not a statement about the delivery, so it must not route to the
/// delivery assignee. A verifier's per-AC verdict is a real evidence failure
/// and keeps its owner.
pub(crate) fn qa_agent_blocked_after_latest_delivery(task: &Task) -> bool {
    let Some(blocked) = latest_qa_marker(task, "[qa-agent-blocked]") else {
        return false;
    };

    // Task `dbce028f` AC1/AC2: only an evidence verdict is a delivery block.
    if classify_qa_block(task, &blocked) != QaBlockKind::EvidenceVerdict {
        return false;
    }

    // AC3: a replacement delivery marker newer than the blocked comment
    // makes the block stale.
    if let Some(delivery) = latest_delivery_marker(task) {
        if !marker_is_newer(&blocked, &delivery) {
            return false;
        }
    }

    // AC1: a block that predates the current attestation is stale.
    marker_is_current_against_attestation(&blocked, latest_approved_qa_agent_at(task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TaskApproval;

    fn approval_row(approval_type: &str, state: &str) -> TaskApproval {
        TaskApproval {
            approval_type: approval_type.to_string(),
            state: state.to_string(),
            ..TaskApproval::default()
        }
    }

    #[test]
    fn task_approval_granted_returns_true_only_for_approved_row() {
        let approved = Task {
            approvals: vec![approval_row("qa_agent", "approved")],
            ..Default::default()
        };
        assert!(task_approval_granted(&approved, "qa_agent"));

        let revoked = Task {
            approvals: vec![approval_row("qa_agent", "revoked")],
            ..Default::default()
        };
        assert!(!task_approval_granted(&revoked, "qa_agent"));

        let pending = Task {
            approvals: vec![approval_row("qa_agent", "pending")],
            ..Default::default()
        };
        assert!(!task_approval_granted(&pending, "qa_agent"));

        let mismatch = Task {
            approvals: vec![approval_row("accepted", "approved")],
            ..Default::default()
        };
        assert!(!task_approval_granted(&mismatch, "qa_agent"));

        let empty = Task::default();
        assert!(!task_approval_granted(&empty, "qa_agent"));
    }

    #[test]
    fn spec_check_skips_legacy_mutation_for_any_approved_spec_actor() {
        let task = Task {
            approvals: vec![approval_row("spec", "approved")],
            ..Default::default()
        };
        assert!(spec_check_should_skip_legacy_mutation(&task));
    }

    #[test]
    fn spec_check_keeps_legacy_mutation_available_without_approved_spec() {
        let task = Task {
            approvals: vec![approval_row("spec", "revoked")],
            ..Default::default()
        };
        assert!(!spec_check_should_skip_legacy_mutation(&task));
    }

    #[test]
    fn accepted_structured_returns_true_only_for_approved_accepted_row() {
        let approved = Task {
            approvals: vec![approval_row("accepted", "approved")],
            ..Default::default()
        };
        assert!(accepted_structured(&approved));
        assert!(accepted_structured_failures(&approved).is_empty());

        let revoked = Task {
            approvals: vec![approval_row("accepted", "revoked")],
            ..Default::default()
        };
        assert!(!accepted_structured(&revoked));
        let failures = accepted_structured_failures(&revoked);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("`accepted`"));
    }

    // ---- AC1 of task f6a4d56a ("Add Ash: QA-verifier gate") ----
    // The qa_agent predicate is the source-of-truth gate on the
    // `doing → acceptance` transition. These tests pin the contract:
    //   * absent row / revoked row / pending row -> predicate false, transition blocked
    //   * approved row                          -> predicate true, transition allowed
    //   * cross-check with the (existing) accepted_structured predicate
    //     so PR #1's rename is regression-protected.
    // The transition itself is exercised end-to-end in a follow-up PR
    // (services/tasks-api integration test, see tech-design §10 AC4).

    fn qa_test_task_with_approvals(rows: Vec<(&str, &str)>) -> Task {
        Task {
            id: "f6a4d56a-fdd0-41fe-b5c0-6c042cb53f47".to_string(),
            title: "AC1 unit test fixture".to_string(),
            description: None,
            status: "doing".to_string(),
            assignee: Some("Rowan".to_string()),
            blocked: false,
            dependency_blocked: false,
            depends_on: Vec::new(),
            task_type: Some("code".to_string()),
            spec_checksum: None,
            tags: Vec::new(),
            comments: Vec::new(),
            approvals: rows
                .into_iter()
                .map(|(approval_type, state)| TaskApproval {
                    approval_type: approval_type.to_string(),
                    state: state.to_string(),
                    ..TaskApproval::default()
                })
                .collect(),
            attention_owners: Vec::new(),
            attention_owner_details: Vec::new(),
        }
    }

    #[test]
    fn ac1_qa_agent_verified_returns_false_with_no_approval_row() {
        let task = qa_test_task_with_approvals(vec![]);
        assert!(!qa_agent_verified(&task));
        let failures = crate::verify_delivery::qa_agent_verified_failures(&task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("`qa_agent`"));
    }

    #[test]
    fn ac1_qa_agent_verified_returns_false_when_approval_revoked() {
        // A revoked row is the revoke-as-outstanding proxy (per tech-design
        // open-question #1): predicate must read it as "not satisfied".
        let task = qa_test_task_with_approvals(vec![("qa_agent", "revoked")]);
        assert!(!qa_agent_verified(&task));
        assert_eq!(
            crate::verify_delivery::qa_agent_verified_failures(&task).len(),
            1
        );
    }

    #[test]
    fn ac1_qa_agent_verified_returns_true_when_approval_approved() {
        let task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        assert!(qa_agent_verified(&task));
        assert!(crate::verify_delivery::qa_agent_verified_failures(&task).is_empty());
    }

    #[test]
    fn qa_agent_deferred_report_invalidates_a_stale_approval() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some(
                "[qa-agent-deferred] AC1: repository-admin setup is still outstanding.".to_string(),
            ),
            ..Default::default()
        });

        assert!(qa_agent_deferred(&task));
        assert!(!qa_agent_verified(&task));
        assert!(crate::verify_delivery::qa_agent_verified_failures(&task)[0].contains("deferred"));
    }

    #[test]
    fn old_blocked_report_does_not_override_later_qa_approval() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.approvals[0].approved_at = Some("2026-09-23T01:16:00.000Z".to_string());
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-blocked] AC1: old evidence was missing.".to_string()),
            created_at: Some("2026-09-22T20:52:00.000Z".to_string()),
            ..Default::default()
        });
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some("Approval qa_agent approved by Ash.".to_string()),
            created_at: Some("2026-09-23T01:16:01.000Z".to_string()),
            ..Default::default()
        });

        assert!(qa_agent_verified(&task));
        assert!(crate::verify_delivery::qa_agent_verified_failures(&task).is_empty());
    }

    #[test]
    fn later_verified_report_reopens_a_previously_deferred_approval() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-deferred] AC1: pending admin action.".to_string()),
            ..Default::default()
        });
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-verified] All ACs verified.".to_string()),
            ..Default::default()
        });

        assert!(!qa_agent_deferred(&task));
        assert!(qa_agent_verified(&task));
    }

    #[test]
    fn later_qa_agent_verification_clears_deferred_approval_note_fallback() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.approvals[0].note = Some("AC1 deferred to the W38 follow-up task.".to_string());
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some("[qa-agent-verification] All ACs verified.".to_string()),
            ..Default::default()
        });

        assert!(!qa_agent_deferred(&task));
        assert!(qa_agent_verified(&task));
    }

    /// The production shape of task `75032fad`: the approval row carries an
    /// `approved_at`, and a later capability-resolution comment must be able
    /// to clear the deferral that the stale fingerprint claimed.
    #[test]
    fn a_capability_resolution_after_the_approval_clears_the_deferral() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.approvals[0].approved_at = Some("2026-10-27T14:16:02.315Z".to_string());
        task.approvals[0].note = Some(
            "Verified AC1-AC5 mechanically: PR #893 (merged 6a5d1bb8). No blocked or deferred ACs."
                .to_string(),
        );
        task.comments.push(crate::TaskComment {
            author: Some("Quinn".to_string()),
            text: Some(
                "[qa-agent-capability-resolved] The deferred-capability handoff was stale."
                    .to_string(),
            ),
            created_at: Some("2026-10-28T01:50:25.074Z".to_string()),
            ..Default::default()
        });

        assert!(!qa_agent_deferred(&task));
        assert!(!qa_agent_blocked(&task));
        assert!(qa_agent_verified(&task));
        assert!(crate::verify_delivery::qa_agent_verified_failures(&task).is_empty());
    }

    /// Ash's standard closing sentence negates the deferral it mentions.
    /// Reading it as an assertion of a deferral manufactures a capability
    /// handoff that no verifier ever reported.
    #[test]
    fn an_approval_note_that_negates_deferral_is_not_a_deferral_assertion() {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", "approved")]);
        task.approvals[0].note = Some(
            "Verified AC1-AC5 mechanically: PR #893 (merged 6a5d1bb8). No blocked or deferred ACs."
                .to_string(),
        );

        assert!(!note_line_asserts_deferral("no blocked or deferred acs."));
        assert!(!qa_agent_deferred(&task));
        assert!(qa_agent_verified(&task));
    }

    #[test]
    fn an_approval_note_that_asserts_deferral_is_still_detected() {
        assert!(note_line_asserts_deferral(
            "ac1 deferred to the w38 follow-up task."
        ));
        assert!(note_line_asserts_deferral(
            "ash reported deferred acceptance criteria"
        ));
    }

    #[test]
    fn a_clause_boundary_breaks_the_negation_scope() {
        // The negation governs the approval, not the deferral that follows
        // the semicolon, so the mention still asserts a deferral.
        assert!(note_line_asserts_deferral(
            "ash has not approved; deferred criteria remain outstanding"
        ));
        assert!(note_line_asserts_deferral(
            "not blocked, deferred pending capability"
        ));
    }

    #[test]
    fn ac1_qa_agent_verified_returns_false_when_approval_pending() {
        // Task d9cd8a83: `POST /tasks` materialises required gates as
        // `state: pending` rows. The predicate must read them as
        // "not satisfied" identically to a missing/revoked row — no
        // observable change to any gate pass/fail outcome.
        let task = qa_test_task_with_approvals(vec![("qa_agent", "pending")]);
        assert!(!qa_agent_verified(&task));
        let failures = crate::verify_delivery::qa_agent_verified_failures(&task);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("`qa_agent`"));
    }

    #[test]
    fn ac1_qa_agent_state_does_not_affect_accepted_structured() {
        // Cross-check the predicates that PR #1 already shipped
        // (renamed from qa_ac_verified_structured). They read distinct
        // approval types so a qa_agent row should never short-circuit
        // Tom's `accepted` gate and vice-versa.
        let task =
            qa_test_task_with_approvals(vec![("qa_agent", "approved"), ("accepted", "revoked")]);
        assert!(qa_agent_verified(&task));
        assert!(!accepted_structured(&task));
        assert!(!accepted_structured_failures(&task).is_empty());
    }

    // ---- task 1e8a430a: stale QA blocked markers ----

    /// Build a task whose comments carry the marker timeline the QA
    /// predicates read. `comments` are `(created_at, text)` pairs in
    /// chronological order.
    fn qa_marker_task(
        comments: Vec<(&str, &str)>,
        approval_state: &str,
        approved_at: Option<&str>,
    ) -> Task {
        let mut task = qa_test_task_with_approvals(vec![("qa_agent", approval_state)]);
        task.approvals[0].approved_at = approved_at.map(str::to_string);
        task.comments = comments
            .into_iter()
            .map(|(created_at, text)| crate::TaskComment {
                author: Some("Ash".to_string()),
                text: Some(text.to_string()),
                created_at: Some(created_at.to_string()),
                ..Default::default()
            })
            .collect();
        task
    }

    /// The same timeline as `qa_marker_task`, with every comment authored by
    /// `author`. Task `dbce028f` needs both marker shapes on one payload, so
    /// the author is the only thing that differs between them.
    fn qa_marker_task_authored(
        comments: Vec<(&str, &str)>,
        author: &str,
        approval_state: &str,
        approved_at: Option<&str>,
    ) -> Task {
        let mut task = qa_marker_task(comments, approval_state, approved_at);
        for comment in task.comments.iter_mut() {
            comment.author = Some(author.to_string());
        }
        task
    }

    const DELIVERY_MARKER: &str =
        "[implementer-prs] https://github.com/example/example/pull/1";
    const BLOCKED_MARKER: &str = "[qa-agent-blocked] The cited test fails.";

    /// AC1: a blocked marker that predates the current attestation is stale
    /// for routing. The live incident shape: blocked at 03:54:44.518Z,
    /// attestation at 05:03:03.520Z.
    #[test]
    fn blocked_marker_predating_current_attestation_is_stale() {
        let task = qa_marker_task(
            vec![
                ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                ("2026-10-28T03:54:44.518Z", BLOCKED_MARKER),
                ("2026-10-28T05:03:03.528Z", "Approval qa_agent approved by Ash."),
            ],
            "approved",
            Some("2026-10-28T05:03:03.520Z"),
        );

        assert!(!qa_agent_blocked_after_latest_delivery(&task));
        // The verdict reader applies the same rule, so the stale block does
        // not invalidate the fresh attestation either.
        assert!(!qa_agent_blocked(&task));
        assert!(qa_agent_verified(&task));
    }

    /// AC2: a blocked marker newer than both the delivery marker and the
    /// attestation is still current and still routes to the delivery
    /// assignee.
    #[test]
    fn blocked_marker_newer_than_delivery_and_attestation_is_current() {
        let task = qa_marker_task(
            vec![
                ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                ("2026-10-28T05:03:03.528Z", "Approval qa_agent approved by Ash."),
                ("2026-10-28T06:00:00.000Z", BLOCKED_MARKER),
            ],
            "approved",
            Some("2026-10-28T05:03:03.520Z"),
        );

        assert!(qa_agent_blocked_after_latest_delivery(&task));
        assert!(qa_agent_blocked(&task));
        assert!(!qa_agent_verified(&task));
    }

    /// AC3: a replacement delivery marker newer than the blocked comment
    /// makes the block stale, exactly as before this change.
    #[test]
    fn replacement_delivery_marker_makes_block_stale() {
        let task = qa_marker_task(
            vec![
                ("2026-10-28T03:54:44.518Z", BLOCKED_MARKER),
                (
                    "2026-10-28T04:00:00.000Z",
                    "[implementer-prs] https://github.com/example/example/pull/2",
                ),
            ],
            "approved",
            Some("2026-10-28T03:00:00.000Z"),
        );

        assert!(!qa_agent_blocked_after_latest_delivery(&task));
    }

    /// R4: with no approved attestation the blocked arm keeps its previous
    /// behaviour — the delivery comparison alone decides.
    #[test]
    fn blocked_marker_without_an_attestation_keeps_its_route() {
        for state in ["pending", "revoked"] {
            let task = qa_marker_task(
                vec![
                    ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                    ("2026-10-28T03:54:44.518Z", BLOCKED_MARKER),
                ],
                state,
                Some("2026-10-28T05:03:03.520Z"),
            );

            assert!(
                qa_agent_blocked_after_latest_delivery(&task),
                "a {state} qa_agent row is not an attestation"
            );
        }
    }

    /// R3: an undated blocked marker cannot be shown to be newer than a
    /// timestamped attestation, so it is stale for routing.
    #[test]
    fn an_undated_blocked_marker_is_stale_against_a_timestamped_attestation() {
        let mut task = qa_marker_task(
            vec![("2026-10-12T03:32:55.039Z", DELIVERY_MARKER)],
            "approved",
            Some("2026-10-28T05:03:03.520Z"),
        );
        task.comments.push(crate::TaskComment {
            author: Some("Ash".to_string()),
            text: Some(BLOCKED_MARKER.to_string()),
            created_at: None,
            ..Default::default()
        });

        assert!(!qa_agent_blocked_after_latest_delivery(&task));
    }

    /// R1/R-2: timestamps decide the order when both sides carry one, and
    /// the list order decides when either side does not.
    #[test]
    fn marker_ordering_prefers_timestamps_and_falls_back_to_list_order() {
        let older = QaMarker {
            index: 0,
            created_at: Some("2026-10-28T03:54:44.518Z".to_string()),
            author: None,
        };
        let newer = QaMarker {
            index: 1,
            created_at: Some("2026-10-28T05:03:03.520Z".to_string()),
            author: None,
        };
        assert!(marker_is_newer(&newer, &older));
        assert!(!marker_is_newer(&older, &newer));

        // A non-UTC offset is ordered as an instant, not as a string:
        // 06:03:03.520+01:00 is the same instant as 05:03:03.520Z.
        let offset = QaMarker {
            index: 2,
            created_at: Some("2026-10-28T06:03:03.520+01:00".to_string()),
            author: None,
        };
        assert_eq!(
            compare_timestamps(
                "2026-10-28T06:03:03.520+01:00",
                "2026-10-28T05:03:03.520Z"
            ),
            Ordering::Equal
        );
        // Markers at the same instant fall back to the list order.
        assert_eq!(compare_markers(&offset, &newer), Ordering::Greater);

        // Without a timestamp on one side the list order decides.
        let undated = QaMarker {
            index: 3,
            created_at: None,
            author: None,
        };
        assert!(marker_is_newer(&undated, &older));
        assert!(!marker_is_newer(&older, &undated));
    }

    #[test]
    fn rfc3339_parsing_handles_utc_offsets_and_rejects_junk() {
        assert_eq!(
            parse_rfc3339("1970-01-01T00:00:00Z"),
            Some((0, 0))
        );
        assert_eq!(
            parse_rfc3339("2026-10-28T05:03:03.520Z"),
            parse_rfc3339("2026-10-28T06:03:03.520+01:00")
        );
        assert_eq!(parse_rfc3339("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339("2026-10-28"), None);
    }

    /// AC5: both QA predicates are derived from one ordering rule. The
    /// corpus is the live-shaped fixture pair; the blocked arm's answer must
    /// equal the shared primitive's answer, and the verdict reader must
    /// agree that the stale block is not current. Re-implementing either
    /// predicate with its own comparison breaks this test.
    #[test]
    fn both_qa_predicates_share_one_ordering_rule() {
        let corpus = [
            (
                "de9d8594",
                include_str!("../fixtures/qa_routing/de9d8594-stale-qa-block.json"),
            ),
            (
                "0a803329",
                include_str!("../fixtures/qa_routing/0a803329-stale-qa-block.json"),
            ),
        ];

        for (name, raw) in corpus {
            let task: Task = serde_json::from_str(raw)
                .unwrap_or_else(|error| panic!("{name} fixture must deserialize: {error}"));

            let blocked = latest_qa_marker(&task, "[qa-agent-blocked]")
                .unwrap_or_else(|| panic!("{name} fixture must carry a blocked marker"));
            let attestation_at = latest_approved_qa_agent_at(&task);
            let expected = marker_is_current_against_attestation(&blocked, attestation_at);

            assert_eq!(
                qa_agent_blocked_after_latest_delivery(&task),
                expected,
                "{name}: the blocked arm must use the shared ordering rule"
            );
            assert!(
                !qa_agent_blocked(&task),
                "{name}: the verdict reader must agree the stale block is not current"
            );
        }
    }

    // ---- task dbce028f: QA-gate prompt vs evidence verdict ----

    /// AC1: the lobster's generic QA-gate prompt is not an evidence verdict.
    /// The marker carries the same tag as a verifier's verdict, so only the
    /// author and the body distinguish the two.
    #[test]
    fn qa_gate_prompt_is_not_an_evidence_verdict() {
        let task = qa_marker_task_authored(
            vec![
                ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                ("2026-10-28T03:55:19.852Z", BLOCKED_MARKER),
            ],
            LOBSTER_AUTHOR,
            "pending",
            None,
        );

        let marker = latest_qa_marker(&task, "[qa-agent-blocked]").expect("marker must exist");
        assert_eq!(
            classify_qa_block(&task, &marker),
            QaBlockKind::QaGatePrompt
        );
    }

    /// AC2: a verifier's per-AC verdict is an evidence verdict. The
    /// structured row state must not override a known verifier author: a
    /// blocked task has no approved attestation, so a row-state override
    /// would reclassify Ash's verdict as a gate prompt and strand the
    /// delivery owner.
    #[test]
    fn evidence_verdict_is_an_evidence_verdict() {
        for state in ["pending", "approved", "revoked"] {
            let task = qa_marker_task_authored(
                vec![
                    ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                    ("2026-10-28T06:00:00.000Z", BLOCKED_MARKER),
                ],
                QA_VERIFIER_AUTHOR,
                state,
                None,
            );

            let marker = latest_qa_marker(&task, "[qa-agent-blocked]").expect("marker must exist");
            assert_eq!(
                classify_qa_block(&task, &marker),
                QaBlockKind::EvidenceVerdict,
                "a {state} qa_agent row must not reclassify a verifier verdict"
            );
        }
    }

    /// AC3: an unknown author falls back to the structured `qa_agent` row
    /// state. No approved attestation means the QA gate is open, so the
    /// marker is a gate prompt; anything else fails closed to a verdict.
    #[test]
    fn unknown_author_falls_back_to_the_structured_row_state() {
        let open_gate = qa_marker_task_authored(
            vec![("2026-10-28T03:55:19.852Z", BLOCKED_MARKER)],
            "some_other_service_account",
            "pending",
            None,
        );
        let marker = latest_qa_marker(&open_gate, "[qa-agent-blocked]").expect("marker must exist");
        assert_eq!(
            classify_qa_block(&open_gate, &marker),
            QaBlockKind::QaGatePrompt,
            "an open QA gate with an unknown author is a gate prompt"
        );

        let attested = qa_marker_task_authored(
            vec![("2026-10-28T03:55:19.852Z", BLOCKED_MARKER)],
            "some_other_service_account",
            "approved",
            Some("2026-10-28T04:00:00.000Z"),
        );
        let marker = latest_qa_marker(&attested, "[qa-agent-blocked]").expect("marker must exist");
        assert_eq!(
            classify_qa_block(&attested, &marker),
            QaBlockKind::EvidenceVerdict,
            "an approved attestation with an unknown author fails closed to a verdict"
        );

        let unrecognised_row = qa_marker_task_authored(
            vec![("2026-10-28T03:55:19.852Z", BLOCKED_MARKER)],
            "some_other_service_account",
            "revoked",
            None,
        );
        let marker =
            latest_qa_marker(&unrecognised_row, "[qa-agent-blocked]").expect("marker must exist");
        assert_eq!(
            classify_qa_block(&unrecognised_row, &marker),
            QaBlockKind::EvidenceVerdict,
            "an unrecognised approval row state fails closed to a verdict"
        );
    }

    /// AC1/AC2: the same payload, the same marker tag, the same timestamps —
    /// only the author differs — and the predicate answers differently. The
    /// generic QA-gate prompt is not a delivery block; a verifier's verdict
    /// is.
    #[test]
    fn a_qa_gate_prompt_is_not_a_delivery_block() {
        let prompt = qa_marker_task_authored(
            vec![
                ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                ("2026-10-28T06:00:00.000Z", BLOCKED_MARKER),
            ],
            LOBSTER_AUTHOR,
            "pending",
            None,
        );
        assert!(
            !qa_agent_blocked_after_latest_delivery(&prompt),
            "the generic QA-gate prompt must not block the delivery assignee"
        );

        let verdict = qa_marker_task_authored(
            vec![
                ("2026-10-12T03:32:55.039Z", DELIVERY_MARKER),
                ("2026-10-28T06:00:00.000Z", BLOCKED_MARKER),
            ],
            QA_VERIFIER_AUTHOR,
            "pending",
            None,
        );
        assert!(
            qa_agent_blocked_after_latest_delivery(&verdict),
            "a verifier's evidence verdict must still block the delivery assignee"
        );
    }
}
