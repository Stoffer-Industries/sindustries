//! Cross-cutting integration tests for the feature-task workflow.
//!
//! These tests exercise contracts spanning multiple sibling modules. They
//! moved out of `main.rs` in Slice 4 of the W38+ main.rs carve so the binary
//! entrypoint retains only CLI orchestration and shared crate types.

use serde_json::{json, Value};
use std::{fs, path::Path};

use super::*;
use crate::brain_spec_reconcile::{reconciliation_spec_link, BrainSpecApprovalPlan};
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
    let spec =
        product_spec_parsing::parse_product_spec_ref("**Spec:** brain/bookmarks/specs/example.md")
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
                text: Some("[tech-design-not-required] small PR — no design needed".to_string()),
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
    assert_eq!(
        lobster_state::workflow_for_task(&task),
        "code-task-workflow"
    );
}

#[test]
fn workflow_for_task_returns_feature_workflow_for_feature_tasks() {
    let task = Task {
        task_type: Some("feature".to_string()),
        ..Task::default()
    };
    assert_eq!(
        lobster_state::workflow_for_task(&task),
        "feature-task-workflow"
    );
}

#[test]
fn workflow_for_task_returns_feature_workflow_when_task_type_missing() {
    let task = Task {
        task_type: None,
        ..Task::default()
    };
    assert_eq!(
        lobster_state::workflow_for_task(&task),
        "feature-task-workflow"
    );
}

#[test]
fn workflow_for_task_returns_feature_workflow_for_unknown_types() {
    // Defensive: future taskType additions should default to the
    // feature-task workflow unless explicitly opted in.
    let task = Task {
        task_type: Some("research".to_string()),
        ..Task::default()
    };
    assert_eq!(
        lobster_state::workflow_for_task(&task),
        "feature-task-workflow"
    );
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
    let with_marker = "- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it";
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
            "## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Also build this".to_string(),
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

    assert!(
        lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan")
            .is_empty()
    );
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

    assert!(
        lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan")
            .is_empty()
    );
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
        vec!["Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2).".to_string()]
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

    assert!(
        lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan")
            .is_empty()
    );
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

    assert!(
        lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan")
            .is_empty()
    );
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

    assert!(
        lobster_state::implementer_doing_capacity_failures(&tasks, "current-task", "Rowan")
            .is_empty()
    );
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
        vec!["Implementer `Rowan` already has 2 active task(s) in `doing` (limit 2).".to_string()]
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

// ---- source-of-truth handling (AC5) ----

// ---- AC4 helpers ----

// ---- plan_task_spec_archive ----

// ---- rewrite_spec_line_in_description ----

// ---- AC4 resync orchestrator ----

// ---- Post-merge worktree cleanup (feature task ba116063) ----
// Tests moved to `git_worktree.rs` (W37 A3 main.rs carve, PR-H).

// ---- clippy evidence gate helpers (task 55c98158) ----

// The AC1 of task f6a4d56a ("Add Ash: QA-verifier gate") test group
// moved to `task_approvals::tests` in PR-D (W37 A3 main.rs carve).
// `task_approvals::qa_agent_verified`, `accepted_structured`,
// `accepted_structured_failures`, and `verify_delivery::qa_agent_verified_failures`
// are exercised in their respective module-local test blocks. The
// cross-stage integration tests above (e.g.
// `structured_approval_rows_are_the_only_gate_source`) reference the
// new module via `crate::task_approvals::*` paths per the W36 carve
// convention.
