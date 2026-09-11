//! Lobster workflow-state parsing, capacity, and comment-text helpers.
//!
//! Extracted from `main.rs` (2026-W37 audit, finding A3: "Feature-task
//! `main.rs` remains a 7,796-line / 160-item god file"). This module hosts
//! the structured `LobsterState` comment parser, the persistence helper
//! (`write_state`), the implementer-capacity gate
//! (`implementer_doing_capacity_failures` + `IMPLEMENTER_DOING_CAPACITY`),
//! the stage-comparison helpers (`status_rank`, `is_past`), the
//! `workflow_for_task` router that distinguishes code tasks from feature
//! tasks on re-read, the spec-gate failure strings
//! (`spec_failures`, `missing_spec_checksum_failures`, `spec_is_approved`),
//! and the `comment_text` reader used by the comment-parsing surface.
//!
//! `pub(crate)` surface (consumed by `main.rs`, `verify_delivery.rs`,
//! `post_merge.rs`, `brain_spec_lifecycle.rs`, and the cross-cutting
//! `mod tests` blocks in those modules):
//!
//! - `write_state` — POST the latest `LobsterState` JSON as a `[lobster-state]`
//!   comment on the task (with an optional leading note).
//! - `parse_lobster_state` — read the most recent `[lobster-state]`
//!   comment block off a `Task` and pin the workflow string via
//!   `workflow_for_task`.
//! - `workflow_for_task` — return the `LobsterState.workflow` value for a
//!   task (`code-task-workflow` vs `feature-task-workflow`).
//! - `status_rank` / `is_past` — `is_past(&task, "open")` etc. predicates
//!   the stage handlers use to short-circuit when the task has already
//!   advanced.
//! - `list_all_active_tasks` — fetch every task across the four pre-`done`
//!   statuses for the capacity gate.
//! - `task_implementer` / `is_actionable_for` — derive the
//!   `assignee` + `attention_owners[0]` pair that the capacity filter
//!   keys on.
//! - `implementer_doing_capacity_failures` / `IMPLEMENTER_DOING_CAPACITY`
//!   — the doing-capacity gate (Tom: 2026-07-28, "im fine with increasing
//!   the limit to 2 for implementer in doing").
//! - `comment_text` — `TaskComment.text || TaskComment.body || ""`.
//!   Used by `parse_lobster_state` and by `brain_spec_lifecycle`'s
//!   archive spec lifecycles.
//! - `spec_failures` / `missing_spec_checksum_failures` — failure strings
//!   surfaced by the `ready` and `code_task_ready_checks` stages when the
//!   spec gate is unmet.
//! - `spec_is_approved` — predicate over the structured `Task.approvals`
//!   row (delegates to `task_approvals::task_approval_granted`).
//!
//! Private to this module:
//!
//! - `status_rank` / `is_past` are leaf helpers but stay module-public
//!   so the cross-cutting `mod tests` blocks in `main.rs` can pin their
//!   ordering invariants.

use crate::api_client;
use crate::product_spec_parsing;
use crate::task_approvals;
use crate::{
    LobsterState, Task, TaskComment, CODE_TASK_WORKFLOW, STATE_TAG, STATUS_ORDER, WORKFLOW,
};
use anyhow::Result;
use serde_json::Value;
use std::{fs, path::Path};

/// Maximum number of tasks (of any `taskType`) an implementer may have in
/// `doing` at once. Tom: 2026-07-28 — "im fine with increasing the limit
/// to 2 for implementer in doing."
pub(crate) const IMPLEMENTER_DOING_CAPACITY: usize = 2;

pub(crate) fn write_state(
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
    api_client::add_comment(base_url, task_id, &body)
}

/// Fetch every task across the statuses the capacity gate cares about,
/// regardless of `taskType`. The capacity check is purely about how many
/// tickets an implementer has in `doing` right now, so it must not filter
/// by feature-vs-code (or any other task type/tag) — that filtering was
/// the root cause of the code-task lobster being blind to an
/// implementer's existing code-task load (Tom: 2026-07-28, "it doesn't
/// need to use type at all, just check on number of tickets assigned in
/// doing").
pub(crate) fn list_all_active_tasks(base_url: &str) -> Result<Vec<Task>> {
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

pub(crate) fn task_implementer(task: &Task) -> Option<String> {
    task.assignee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn is_actionable_for(task: &Task, implementer: &str) -> bool {
    task.attention_owners
        .first()
        .map(|owner| owner.trim().eq_ignore_ascii_case(implementer.trim()))
        .unwrap_or(true)
}

pub(crate) fn implementer_doing_capacity_failures(
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
                && is_actionable_for(task, implementer)
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

pub(crate) fn comment_text(comment: &TaskComment) -> &str {
    comment
        .text
        .as_deref()
        .or(comment.body.as_deref())
        .unwrap_or("")
}

pub(crate) fn parse_lobster_state(task: &Task) -> LobsterState {
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
pub(crate) fn workflow_for_task(task: &Task) -> String {
    match task.task_type.as_deref() {
        Some("code") => CODE_TASK_WORKFLOW.to_string(),
        _ => WORKFLOW.to_string(),
    }
}

pub(crate) fn status_rank(status: &str) -> usize {
    STATUS_ORDER
        .iter()
        .position(|value| *value == status)
        .unwrap_or(0)
}

pub(crate) fn is_past(task: &Task, stage: &str) -> bool {
    status_rank(&task.status) > status_rank(stage)
}

pub(crate) fn spec_failures(task: &Task, repo: &Path, workspace_root: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    match product_spec_parsing::product_spec(task) {
        Some(spec) => {
            let path =
                product_spec_parsing::resolve_product_spec_path(&spec.path, repo, workspace_root);
            if !path.exists() {
                failures.push(format!("Product spec not found at {}", spec.path));
            } else if fs::read_to_string(&path).is_ok() && !spec_is_approved(task) {
                failures.push("Structured spec approval is missing or not approved; Tom must approve the `spec` TaskApproval.".to_string());
            }
        }
        None => failures.push("Task description must include a **Spec:** line".to_string()),
    }
    if product_spec_parsing::acceptance_criteria_text(&task.description.clone().unwrap_or_default())
        .is_empty()
    {
        failures.push("Task description must include acceptance criteria checkboxes.".to_string());
    }
    if product_spec_parsing::workstreams(task).is_empty() {
        failures.push("Task description must include workstreams.".to_string());
    }
    failures
}

pub(crate) fn missing_spec_checksum_failures(
    task: &Task,
    repo: &Path,
    workspace_root: &Path,
) -> Vec<String> {
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
pub(crate) fn spec_is_approved(task: &Task) -> bool {
    task_approvals::task_approval_granted(task, "spec")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TaskApproval, CODE_TASK_WORKFLOW, WORKFLOW};
    use std::fs;
    use tempfile::tempdir;

    fn approval_row(kind: &str, state: &str) -> TaskApproval {
        TaskApproval {
            approval_type: kind.into(),
            state: state.into(),
            ..Default::default()
        }
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
        assert_eq!(workflow_for_task(&task), CODE_TASK_WORKFLOW);
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_feature_tasks() {
        let task = Task {
            task_type: Some("feature".to_string()),
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), WORKFLOW);
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_when_task_type_missing() {
        let task = Task {
            task_type: None,
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), WORKFLOW);
    }

    #[test]
    fn workflow_for_task_returns_feature_workflow_for_unknown_types() {
        // Defensive: future taskType additions should default to the
        // feature-task workflow unless explicitly opted in.
        let task = Task {
            task_type: Some("research".to_string()),
            ..Task::default()
        };
        assert_eq!(workflow_for_task(&task), WORKFLOW);
    }

    // ---- spec_failures ----

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

    // ---- spec_is_approved ----

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
        assert!(spec_is_approved(&approved));
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
        assert!(!spec_is_approved(&legacy));
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
        assert!(!spec_is_approved(&revoked));
        assert!(!product_spec_parsing::tech_design_approved_structured(
            &revoked
        ));
        assert!(!task_approvals::accepted_structured(&revoked));
    }

    // ---- missing_spec_checksum_failures ----

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
    }

    // ---- implementer_doing_capacity_failures ----

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

        assert!(implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").is_empty());
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
            implementer_doing_capacity_failures(&tasks, "current-task", "Rowan").len(),
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
}
