//! AC3 invalidation for `qa_agent` approvals — task `ad8346ee`.
//!
//! Slice 1 minted the attestation, Slice 2 enforced it at the Tasks API
//! choke point. Neither re-checks a *granted* approval against the PR's
//! current state, which is the exact gap task `39667e62` fell through: PR
//! #803's AC-evidence section was blanked to `"test body update"` *after*
//! Ash's approval was granted, and nothing noticed for ~10 days.
//!
//! This module is the **detect** half. It is deliberately pure — no I/O,
//! no clock, no API — so the failure mode that cost ten days is testable
//! without a live PR, a live Tasks API, or a GitHub token. The effectful
//! half (revoke + route) lives in `verify_delivery::invalidate_stale_qa_approval`.
//!
//! ## Three pins, because the incident was a body edit on a swappable PR
//!
//! A PR head SHA pins the *code*. PR #803's incident moved no code at all —
//! the head SHA was unchanged when the body was blanked. Pinning only the
//! SHA would leave AC3 unable to fire for the precise shape it exists to
//! catch. So drift is detected on either of those pins diverging (design D2).
//!
//! The third pin is the PR *number*. The SHA pins what was checked on a PR;
//! it says nothing about *which* PR that was. A task whose delivery PR is
//! swapped (#803 -> a replacement PR) keeps pins that still match, because the
//! replacement PR was verified too — so the swap is only detectable by
//! comparing the attested number against the task's current delivery set.
//!
//! ## Legacy rows are stale, never trusted
//!
//! `verifiedPrNumber` / `verifiedPrHeadSha` / `verifiedAcSectionDigest` are
//! NULL on any row written before the migration. A NULL pin means "nothing was
//! verified", which is exactly the state the incident left behind — so NULL
//! reads as [`EvidenceDrift::Unpinned`] and re-routes rather than passing. It
//! never panics and never blocks: the caller decides, and the design records
//! that treating NULL as stale is the fail-safe direction.

use crate::Task;

/// Which pin diverged between the granted approval and the live PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DriftField {
    /// The task's currently-linked PR is no longer the PR that was attested —
    /// the #803 -> replacement-PR swap. Detected by comparing the pinned PR
    /// *number* against the live delivery set, not by ordering: a grant minted
    /// against the second of two delivery PRs is valid, and comparing it
    /// against the first would be a false positive.
    PrNumber,
    /// The PR's code moved: `headRefOid` differs from the pinned SHA.
    HeadSha,
    /// The PR's AC-evidence section was rewritten under the approval.
    AcSectionDigest,
}

impl DriftField {
    /// Human-readable label used in the reconcile reason (AC3 requires the
    /// reason to cite *which* field diverged, not merely that something did).
    pub(crate) fn label(self) -> &'static str {
        match self {
            DriftField::PrNumber => "the attested PR number",
            DriftField::HeadSha => "PR head SHA",
            DriftField::AcSectionDigest => "PR AC-evidence section digest",
        }
    }
}

/// What a granted `qa_agent` approval looks like when re-checked against the
/// PR's current state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EvidenceDrift {
    /// The approval still describes the PR it verified. No action.
    Current,
    /// Pre-migration row with no pins recorded. Treated as stale — the grant
    /// certified nothing, which is the state `39667e62` produced.
    Unpinned,
    /// The attested PR is no longer among the task's current delivery PRs.
    /// Carries both sides so the reconcile note can name the swap rather than
    /// reporting an arbitrary sibling PR's head SHA as the divergence.
    PrSwapped {
        attested: Option<i64>,
        current: Vec<i64>,
    },
    /// At least one pin diverged. Carries every diverging field so the
    /// reconcile reason can name them all.
    Drifted(Vec<DriftField>),
}

impl EvidenceDrift {
    /// True when the approval can no longer be trusted and AC3's
    /// invalidate-and-route path must run.
    pub(crate) fn is_stale(&self) -> bool {
        !matches!(self, EvidenceDrift::Current)
    }

    /// The reconcile-note sentence for this drift, per AC3's "explicit reason
    /// citing the detected regression".
    pub(crate) fn reason(self) -> String {
        match self {
            EvidenceDrift::Current => "AC-evidence pins still match the PR".to_string(),
            EvidenceDrift::Unpinned => "this `qa_agent` approval records no verified PR number, head SHA or AC-section digest (pre-migration row), so it certified nothing and cannot be trusted without re-verification".to_string(),
            EvidenceDrift::PrSwapped { attested, current } => {
                let attested_label = attested
                    .map(|n| format!("PR #{n}"))
                    .unwrap_or_else(|| "an unrecorded PR".to_string());
                let current_label = if current.is_empty() {
                    "none".to_string()
                } else {
                    current
                        .iter()
                        .map(|n| format!("PR #{n}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                format!(
                    "this approval attested {attested_label}, which is no longer one of this task's delivery PRs ({current_label}) — the task has moved to a replacement PR, so the evidence this grant verified was verified against a PR that no longer carries it"
                )
            }
            EvidenceDrift::Drifted(fields) => {
                let cited = fields
                    .iter()
                    .map(|field| field.label())
                    .collect::<Vec<_>>()
                    .join(" and ");
                format!(
                    "the PR changed under this approval after it was granted ({cited} diverged), so the evidence it verified is no longer the evidence on the PR"
                )
            }
        }
    }
}

/// The live PR state an approval is re-checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveEvidence {
    /// The PR number this live state was read from. Used to match the live
    /// entry against the attested PR rather than relying on list order.
    pub(crate) pr_number: i64,
    pub(crate) head_sha: String,
    pub(crate) ac_section_digest: String,
}

/// The pins stored on a granted `qa_agent` approval row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordedPins {
    pub(crate) pr_number: Option<i64>,
    pub(crate) head_sha: Option<String>,
    pub(crate) ac_section_digest: Option<String>,
}

impl RecordedPins {
    /// Read the pins off the approved `qa_agent` row for this task.
    ///
    /// Returns `None` when no `qa_agent` row is currently `approved` — the
    /// caller must not invalidate in that case, because there is no grant
    /// to invalidate and AC3 has nothing to say about pending rows.
    pub(crate) fn from_task(task: &Task) -> Option<Self> {
        task.approvals
            .iter()
            .find(|approval| approval.approval_type == "qa_agent" && approval.state == "approved")
            .map(|approval| Self {
                pr_number: approval.verified_pr_number,
                head_sha: approval.verified_pr_head_sha.clone(),
                ac_section_digest: approval.verified_ac_section_digest.clone(),
            })
    }

    /// True when any pin is absent. A half-populated row is as
    /// unverifiable as an empty one, so all three read as `Unpinned` rather
    /// than silently validating on the fields that happen to be present.
    pub(crate) fn is_unpinned(&self) -> bool {
        self.pr_number.is_none() || self.head_sha.is_none() || self.ac_section_digest.is_none()
    }
}

/// Compare a granted approval's pins against the PR's current state.
///
/// Pure by design: this is the decision AC3 turns on, and it must be
/// provable without a network.
///
/// `Unpinned` is checked **first**, ahead of any comparison. A missing pin
/// cannot be compared, so a `None` head SHA does not mean "the head moved"
/// — it means "nothing was recorded to compare against". Reporting that as
/// drift would name a regression that did not happen and send an operator
/// hunting a code change that was never pinned. Both outcomes invalidate
/// the grant; only the *explanation* differs, and the explanation is what
/// the reconcile note is for.
pub(crate) fn detect_drift(pins: &RecordedPins, live: &LiveEvidence) -> EvidenceDrift {
    if pins.is_unpinned() {
        return EvidenceDrift::Unpinned;
    }
    let mut fields = Vec::new();
    if pins.pr_number != Some(live.pr_number) {
        fields.push(DriftField::PrNumber);
    }
    if pins.head_sha.as_deref() != Some(live.head_sha.as_str()) {
        fields.push(DriftField::HeadSha);
    }
    if pins.ac_section_digest.as_deref() != Some(live.ac_section_digest.as_str()) {
        fields.push(DriftField::AcSectionDigest);
    }
    if fields.is_empty() {
        EvidenceDrift::Current
    } else {
        EvidenceDrift::Drifted(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Task, TaskApproval};

    fn pins(head: Option<&str>, digest: Option<&str>) -> RecordedPins {
        pins_for(Some(803), head, digest)
    }

    fn pins_for(pr: Option<i64>, head: Option<&str>, digest: Option<&str>) -> RecordedPins {
        RecordedPins {
            pr_number: pr,
            head_sha: head.map(str::to_string),
            ac_section_digest: digest.map(str::to_string),
        }
    }

    fn live(head: &str, digest: &str) -> LiveEvidence {
        live_for(803, head, digest)
    }

    fn live_for(pr: i64, head: &str, digest: &str) -> LiveEvidence {
        LiveEvidence {
            pr_number: pr,
            head_sha: head.to_string(),
            ac_section_digest: digest.to_string(),
        }
    }

    fn approved_qa_row(head: Option<&str>, digest: Option<&str>) -> TaskApproval {
        approved_qa_row_for(Some(803), head, digest)
    }

    fn approved_qa_row_for(
        pr: Option<i64>,
        head: Option<&str>,
        digest: Option<&str>,
    ) -> TaskApproval {
        TaskApproval {
            approval_type: "qa_agent".to_string(),
            state: "approved".to_string(),
            verified_pr_number: pr,
            verified_pr_head_sha: head.map(str::to_string),
            verified_ac_section_digest: digest.map(str::to_string),
            ..TaskApproval::default()
        }
    }

    fn task_with(approvals: Vec<TaskApproval>) -> Task {
        Task {
            id: "task-drift".to_string(),
            approvals,
            ..Task::default()
        }
    }

    // ---- detect_drift ----

    #[test]
    fn matching_pins_are_current() {
        let drift = detect_drift(
            &pins(Some("aaa"), Some("ddd")),
            &live("aaa", "ddd"),
        );
        assert_eq!(drift, EvidenceDrift::Current);
        assert!(!drift.is_stale());
    }

    #[test]
    fn a_swap_to_a_different_pr_is_detected_even_when_the_pins_still_match() {
        // The #803 -> replacement-PR shape this whole task exists for. Both
        // the SHA and the digest would validate against the replacement PR, so
        // a SHA+digest-only pin set reads this grant as `Current` and lets a
        // stale grant survive the swap. Only the third pin sees it.
        let drift = detect_drift(
            &pins_for(Some(803), Some("aaa"), Some("ddd")),
            &live_for(904, "aaa", "ddd"),
        );
        assert_eq!(drift, EvidenceDrift::Drifted(vec![DriftField::PrNumber]));
        assert!(drift.is_stale());
        assert!(drift.reason().contains("attested PR number"));
    }

    #[test]
    fn a_row_missing_only_the_pr_number_does_not_validate_on_the_other_two() {
        // Half-populated rows are as unverifiable as empty ones: without the
        // PR number there is no way to tell a swap from a match.
        let drift = detect_drift(
            &pins_for(None, Some("aaa"), Some("ddd")),
            &live("aaa", "ddd"),
        );
        assert_eq!(drift, EvidenceDrift::Unpinned);
        assert!(drift.is_stale());
    }

    #[test]
    fn a_pr_swap_is_reported_as_a_swap_rather_than_against_an_arbitrary_sibling() {
        // The multi-PR false positive: a task with two delivery PRs, a grant
        // minted against the second. Reporting the first PR's head SHA as the
        // divergence would revoke a perfectly valid grant.
        let drift = EvidenceDrift::PrSwapped {
            attested: Some(904),
            current: vec![803],
        };
        assert!(drift.is_stale());
        let reason = drift.reason();
        assert!(reason.contains("PR #904"));
        assert!(reason.contains("PR #803"));
        assert!(reason.contains("replacement PR"));
    }

    #[test]
    fn a_task_with_no_current_delivery_prs_still_names_the_attested_one() {
        let drift = EvidenceDrift::PrSwapped {
            attested: Some(904),
            current: vec![],
        };
        let reason = drift.reason();
        assert!(reason.contains("PR #904"));
        assert!(reason.contains("none"));
    }

    #[test]
    fn a_body_only_edit_is_detected_even_though_the_head_never_moved() {
        // The exact shape of incident 39667e62: PR #803's head SHA did not
        // change when its AC section was blanked to "test body update". A
        // SHA-only pin would call this `Current` and let the task sit in
        // `doing` for another ten days.
        let drift = detect_drift(
            &pins(Some("unchanged-head"), Some("digest-of-real-evidence")),
            &live("unchanged-head", "digest-of-blanked-body"),
        );
        assert_eq!(drift, EvidenceDrift::Drifted(vec![DriftField::AcSectionDigest]));
        assert!(drift.is_stale());
    }

    #[test]
    fn a_code_change_under_the_approval_is_detected() {
        let drift = detect_drift(
            &pins(Some("old-head"), Some("same-digest")),
            &live("new-head", "same-digest"),
        );
        assert_eq!(drift, EvidenceDrift::Drifted(vec![DriftField::HeadSha]));
    }

    #[test]
    fn both_fields_diverging_reports_both_so_the_reason_cites_each() {
        let drift = detect_drift(
            &pins(Some("old-head"), Some("old-digest")),
            &live("new-head", "new-digest"),
        );
        assert_eq!(
            drift,
            EvidenceDrift::Drifted(vec![DriftField::HeadSha, DriftField::AcSectionDigest])
        );
        let reason = drift.reason();
        assert!(reason.contains("PR head SHA"));
        assert!(reason.contains("AC-evidence section digest"));
    }

    #[test]
    fn a_pre_migration_row_is_stale_rather_than_trusted() {
        // NULL pins mean "nothing was verified" — the state 39667e62 left
        // behind. Passing it would silently honour a grant that certified
        // nothing.
        let drift = detect_drift(&pins(None, None), &live("aaa", "ddd"));
        assert_eq!(drift, EvidenceDrift::Unpinned);
        assert!(drift.is_stale());
    }

    #[test]
    fn a_half_populated_row_does_not_validate_on_the_one_field_present() {
        // Digest present, head SHA absent: trusting the digest alone would
        // let a grant with no code pin sail through.
        let drift = detect_drift(&pins(None, Some("ddd")), &live("aaa", "ddd"));
        assert_eq!(drift, EvidenceDrift::Unpinned);
    }

    #[test]
    fn an_unpinned_row_is_reported_as_unpinned_even_when_the_pr_has_moved() {
        // The live PR head has changed since this row was written, and the
        // row pins nothing. Claiming "head SHA diverged" would send an
        // operator hunting a code change that was never recorded. The
        // honest statement is that the grant certified nothing.
        let drift = detect_drift(&pins(None, Some("old-digest")), &live("aaa", "new-digest"));
        assert_eq!(drift, EvidenceDrift::Unpinned);
        assert!(!drift.reason().contains("diverged"));
    }

    // ---- RecordedPins::from_task ----

    #[test]
    fn pins_are_read_from_the_approved_qa_agent_row() {
        let task = task_with(vec![
            approved_qa_row(Some("head"), Some("digest")),
            TaskApproval {
                approval_type: "spec".to_string(),
                state: "approved".to_string(),
                ..TaskApproval::default()
            },
        ]);
        assert_eq!(
            RecordedPins::from_task(&task),
            Some(RecordedPins {
                pr_number: Some(803),
                head_sha: Some("head".to_string()),
                ac_section_digest: Some("digest".to_string()),
            })
        );
    }

    #[test]
    fn a_revoked_qa_agent_row_is_not_read_as_a_grant() {
        // AC3 must be idempotent: once the invalidation pass has revoked the
        // row, a re-run finds no grant and does nothing, rather than
        // re-revoking and re-routing on every heartbeat.
        let task = task_with(vec![TaskApproval {
            approval_type: "qa_agent".to_string(),
            state: "revoked".to_string(),
            verified_pr_head_sha: Some("head".to_string()),
            verified_ac_section_digest: Some("digest".to_string()),
            ..TaskApproval::default()
        }]);
        assert_eq!(RecordedPins::from_task(&task), None);
    }

    #[test]
    fn a_pending_qa_agent_row_is_not_read_as_a_grant() {
        let task = task_with(vec![TaskApproval {
            approval_type: "qa_agent".to_string(),
            state: "pending".to_string(),
            ..TaskApproval::default()
        }]);
        assert_eq!(RecordedPins::from_task(&task), None);
    }

    #[test]
    fn a_task_with_no_approvals_reads_as_no_grant() {
        assert_eq!(RecordedPins::from_task(&Task::default()), None);
    }

    // ---- reason strings ----

    #[test]
    fn the_unpinned_reason_states_what_is_missing_rather_than_only_that_it_is_stale() {
        let reason = EvidenceDrift::Unpinned.reason();
        assert!(reason.contains("no verified PR number"));
        assert!(reason.contains("head SHA"));
        assert!(reason.contains("AC-section digest"));
    }

    #[test]
    fn the_current_reason_is_not_a_regression_notice() {
        assert_eq!(
            EvidenceDrift::Current.reason(),
            "AC-evidence pins still match the PR"
        );
    }
}
