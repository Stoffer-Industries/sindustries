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
//! Missing, revoked, and unknown states fail closed.
//!
//! Spec drift is intentionally NOT blocked here. Tom owns the ACs
//! during QA and may legitimately refine them; the spec-resync flow
//! (unchecking "Approved by Tom" and requiring explicit re-approval)
//! handles drift tracking.

use crate::Task;

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

fn latest_qa_verdict(task: &Task) -> Option<&'static str> {
    task.comments.iter().rev().find_map(|comment| {
        let text = comment
            .text
            .as_deref()
            .or(comment.body.as_deref())
            .unwrap_or_default();
        let starts_with_tag =
            |tag: &str| text.lines().any(|line| line.trim_start().starts_with(tag));
        if starts_with_tag("[qa-agent-deferred]") {
            Some("deferred")
        } else if starts_with_tag("[qa-agent-blocked]") {
            Some("blocked")
        } else if starts_with_tag("[qa-agent-verified]") {
            Some("verified")
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
        Some("verified") | Some("blocked") => false,
        _ => task
            .approvals
            .iter()
            .find(|approval| approval.approval_type == "qa_agent" && approval.state == "approved")
            .and_then(|approval| approval.note.as_deref())
            .is_some_and(|note| {
                note.lines().any(|line| {
                    let line = line.to_ascii_lowercase();
                    line.contains("deferred") && !line.contains("no deferred")
                })
            }),
    }
}

/// True when a deferred Ash capability gap has been captured as a real
/// capability-extension dependency. The original task must remain unapproved
/// until the extension lands, but Quinn is no longer the active owner once
/// the dependency edge exists.
pub(crate) fn qa_agent_deferred_waiting_on_capability_extension(task: &Task) -> bool {
    task.dependency_blocked && qa_agent_deferred(task)
}

/// True when Ash has reported an evidence blocker after an older approval.
pub(crate) fn qa_agent_blocked(task: &Task) -> bool {
    matches!(latest_qa_verdict(task), Some("blocked"))
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
}
