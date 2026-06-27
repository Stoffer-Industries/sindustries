# Feature Factory v2 Tech Design

## Links

- Product spec: `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md`
- Tech design: `docs/specs/feature-factory-v2-tech-design.md`
- Task: `2527ff9d-4369-444f-995d-4d4bb0ac7b70` (`Feature Factory v2`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-2527ff9d-feature-factory-v2`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must update Rowan's `.openclaw` docs and register the feature-task cron outside this repo.

## Scope

Feature Factory v2 is the agent workflow that takes approved feature tasks through implementation, review, merge, and post-merge cleanup without a bespoke Telegram approval flow.

The implementation should add a new workflow lane under `agents/workflows/feature-task/`:

- A Rust CLI crate that owns task parsing, workflow checks, GitHub inspection, and idempotent state reconciliation.
- A Lobster pipeline YAML that composes the CLI commands into status transitions.
- A small wrapper that discovers active feature tasks and runs the Lobster pipeline for each task.
- A cron prompt that runs the wrapper.
- Spec skills for tech design and system spec authoring.
- Unit tests and fixtures for the Rust decision logic.

## Current Constraints

- Rust is the default language for workflow scripts in `agents/workflows/feature-task/`.
- The workflow must use an idempotent reconciler pattern. Do not use `wait_for` or any blocking Lobster primitive.
- Approval must use GitHub review state for acceptance. No custom Telegram approval channel.
- `ready` -> `doing` is blocked until the task has `tech_design_url` and `tech_design_approved: true`.
- Tech design approval lives on the task, not in the product spec. Do not look for Tom's sign-off in the spec file. The task remains blocked in `ready` while waiting for tech design approval; Quinn sets `tech_design_approved: true` on the task once Tom confirms.
- Rowan capacity is one unblocked feature task per state, matching the Ivy content-task workflow capacity pattern.
- The current Tasks API schema does not expose first-class `tech_design_url`, `tech_design_approved`, system spec, or arbitrary metadata fields. Existing workflow state is stored through task comments using `[lobster-state]`.
- `.openclaw` changes are outside the primary repo boundary and must be flagged for Quinn rather than edited silently here.

## Data Model

The feature-task workflow should normalize the task into an internal model rather than operating on raw description text everywhere.

Minimum internal model:

```rust
struct FeatureTask {
    id: String,
    title: String,
    status: TaskStatus,
    assignee: Option<String>,
    description: String,
    tags: Vec<String>,
    comments: Vec<TaskComment>,
    lobster_state: FeatureTaskState,
    product_spec: Option<ProductSpecRef>,
    tech_design: Option<TechDesignGate>,
    system_spec: Option<SystemSpecGate>,
    workstreams: Vec<Workstream>,
}
```

`FeatureTaskState` should be serialized back into task comments with `[lobster-state]` so the reconciler can safely rerun. It should carry at least:

- `version`
- `workflow: "feature-task-workflow"`
- `last_orchestrated_at`
- `pr_urls`
- `review_feedback_routed_at`
- `openclaw_needed`
- `openclaw_done`
- `system_spec_path`
- `no_system_spec_change_reason`

The desired end state is first-class Tasks API fields for `tech_design_url` and `tech_design_approved`. Until those fields exist, the Rust CLI should read them from task comments with stable tags and report a failed criterion if the durable fields are unavailable.

Proposed interim comment tags:

- `[tech-design] <url>`
- `[tech-design-approved] true`
- `[rowan-prs] <one or more GitHub PR URLs>`
- `[openclaw-needed] <reason>`
- `[openclaw-done] <summary>`
- `[system-spec] docs/systems/<file>.md`
- `[no-system-spec-change] <reason>`

## Tasks API Workstream

Feature Factory v2 needs first-class `taskType: feature` support before the workflow can rely on durable task discovery and validation.

Implementation requirements:

- Extend Tasks API task validation and persistence so `taskType: feature` is an accepted first-class type.
- Add or update Tasks API route tests, schema tests, and any UI/API contract tests that enumerate task types.
- Update workflow discovery so the feature-task wrapper selects active tasks with `taskType: feature` instead of treating feature work as `code` or relying only on tags.
- Keep `feature-factory` tag fallback only as an interim compatibility path while existing tasks are migrated.

Acceptance criterion:

- A feature task with `taskType: feature` can be created, read, listed, validated by tests, and discovered by the feature-task workflow without tag-only routing.

## Rust CLI

Create `agents/workflows/feature-task/` as a Cargo crate. The binary can be named `feature-task`.

Recommended dependencies:

- `clap` for command parsing.
- `serde`, `serde_json`, and `serde_yaml` for API payloads, fixtures, and Lobster-compatible JSON output.
- `reqwest` or `ureq` for Tasks API requests. Prefer the smaller choice unless async becomes necessary.
- `regex` for parsing tagged task comments and workstream blocks.
- `tempfile` for tests that need fixture files.

Commands:

- `load-task --base-url <url> --task-id <id>`
  - Fetches the task and comments.
  - Parses `[lobster-state]`.
  - Emits the normalized JSON envelope used by downstream commands.

- `spec-check`
  - Implements `open` -> `ready`.
  - Verifies a linked product spec exists and includes enough implementation-ready scope. It must not require or parse Tom's approval from the product spec.
  - Verifies the task has feature-task acceptance criteria and workstreams.
  - Posts a specific failed-criteria comment if blocked.
  - Moves `open` -> `ready` when criteria pass.

- `ready-checks`
  - Implements `ready` -> `doing`.
  - Requires `tech_design_url`.
  - Requires `tech_design_approved: true`.
  - Treats missing task-level tech design approval as a blocked `ready` state, not as a product spec defect.
  - Requires Rowan assignment.
  - Requires no active unblocked Rowan feature task beyond the configured capacity of one task per state.
  - Moves `ready` -> `doing` when criteria pass.

- `verify-delivery`
  - Implements `doing` -> `acceptance`.
  - Reads `[rowan-prs]` and task workstreams.
  - Supports multiple PR URLs.
  - Verifies CI/check state for each PR.
  - Verifies PR descriptions check off the acceptance criteria assigned to each workstream.
  - Enforces system spec presence and freshness, or requires `[no-system-spec-change]`.
  - Detects `[openclaw-needed]` and blocks until `[openclaw-done]`.
  - Moves `doing` -> `acceptance` when criteria pass.

- `feedback-aggregate`
  - Implements acceptance feedback routing.
  - Reads GitHub review decision and inline review comments.
  - If any PR has `CHANGES_REQUESTED`, open review comments, or required review missing, writes a concise task comment for Rowan and leaves the task in `acceptance` while Rowan addresses PR feedback.
  - Does not mark the task blocked for Rowan-addressable PR feedback; `blocked` is reserved for cases where the workflow is waiting on Tom.
  - Does not route through Telegram approval.

- `post-merge`
  - Implements `acceptance` -> `done`.
  - Verifies every tracked PR is merged.
  - Verifies post-merge checks are satisfied.
  - Writes final Lobster state.
  - Moves the task to `done`.

Each command should:

- Read JSON from stdin when it is not the first step.
- Emit one JSON object with `criteria_met`, `already_past`, `action_taken`, `task`, `lobster_state`, and `failures`.
- Be idempotent. If the task is already past a stage and criteria still pass, return `already_past` without writing duplicate comments.
- Add task comments only when the failure set or state materially changes.

## Lobster YAML

Add `agents/workflows/feature-task/feature-task.lobster.yaml`.

Shape:

```yaml
name: feature-task

args:
  taskId:
    required: true
  tasksApiBaseUrl:
    default: ${TASKS_API_BASE_URL}
  sindustriesRepo:
    default: /Users/quinnstoffer/workspaces/rowan/sindustries
  dryRun:
    default: false

steps:
  - id: load_task
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      load-task --base-url ${tasksApiBaseUrl} --task-id ${taskId}

  - id: spec_check
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      spec-check --base-url ${tasksApiBaseUrl} --dry-run ${dryRun}
    stdin: $load_task.stdout

  - id: ready_checks
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      ready-checks --base-url ${tasksApiBaseUrl} --dry-run ${dryRun}
    stdin: $spec_check.stdout
    condition: $spec_check.json.criteria_met

  - id: verify_delivery
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      verify-delivery --base-url ${tasksApiBaseUrl} --dry-run ${dryRun}
    stdin: $ready_checks.stdout
    condition: $ready_checks.json.criteria_met

  - id: feedback_aggregate
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      feedback-aggregate --base-url ${tasksApiBaseUrl} --dry-run ${dryRun}
    stdin: $verify_delivery.stdout
    condition: $verify_delivery.json.criteria_met

  - id: post_merge
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      post-merge --base-url ${tasksApiBaseUrl} --dry-run ${dryRun}
    stdin: $feedback_aggregate.stdout
    condition: $feedback_aggregate.json.criteria_met
```

Each Lobster step should invoke the CLI through `cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml -- ...`. Do not encode `target/debug` or `target/release` binary paths in Lobster YAML, and do not assume a cached compiled binary exists before the workflow runs.

Add `agents/workflows/feature-task/run.py` or a Rust subcommand wrapper that:

- Lists active feature tasks in `open`, `ready`, `doing`, and `acceptance`.
- Selects tasks with `taskType == "feature"` once the Tasks API workstream lands, with `feature-factory` tag fallback only for interim migration.
- Runs `lobster run --mode tool agents/workflows/feature-task/feature-task.lobster.yaml --args-json ...`.
- Returns a JSON summary with per-task results and errors.

## Spec Skills

Add skills under `agents/skills/dev/` unless the repository conventions suggest a more precise location during implementation:

- `tech-design`
  - Creates `docs/specs/<task-slug>-tech-design.md`.
  - Requires product spec link, task ID, branch, worktree, repos, `.openclaw` boundary, implementation plan, test plan, and open questions.
  - Posts or instructs posting the design URL to the task.

- `system-spec`
  - Creates or updates `docs/systems/<system>.md`.
  - Records architecture, operational behavior, runbook notes, data contracts, and ownership.
  - Supports the `[no-system-spec-change]` bypass when a code-only change does not alter system behavior.

## Testing

Rust unit tests should use JSON fixtures committed under `agents/workflows/feature-task/fixtures/`.

Fixture groups:

- Product spec parsing:
  - approved spec with Tom approval marker.
  - missing spec.
  - spec exists but not approved.
  - malformed spec path.

- Task parsing:
  - full Feature Factory v2 task body.
  - duplicated spec blocks.
  - missing acceptance criteria.
  - multiple workstreams.
  - `taskType: feature` accepted and discoverable through the Tasks API.

- Workstream parsing:
  - Rowan-only workstream.
  - Rowan plus Quinn `.openclaw` workstream.
  - multiple repo PRs.

- GitHub review state parsing:
  - all PRs approved and merged.
  - review required.
  - changes requested.
  - inline comments present.
  - closed without merge.

- System spec enforcement:
  - system spec exists and references current task or PR.
  - missing system spec.
  - stale system spec.
  - valid `[no-system-spec-change]` reason.

Test commands:

- `cargo test --manifest-path agents/workflows/feature-task/Cargo.toml`
- Add the Rust test command to CI once the crate exists.
- Manual first-run validation for heartbeat, cron, and skill work:
  - Run the wrapper with `--dry-run true`.
  - Run one task through Lobster in tool mode.
  - Confirm comments are not duplicated across repeated runs.
  - Confirm `ready` -> `doing` stays blocked until the tech design fields are approved.

## Implementation Plan

1. Create the Rust crate and shared model layer.
2. Add Tasks API support for first-class `taskType: feature`, including validation, tests, and workflow discovery updates.
3. Add fixture-driven parsers for task descriptions, task comments, workstreams, and PR URLs.
4. Implement the Tasks API client and idempotent comment/state helpers.
5. Implement `load-task` and `spec-check`.
6. Implement `ready-checks`, including the task-level tech design approval gate.
7. Implement GitHub inspection helpers using `gh` JSON output or GitHub REST responses.
8. Implement `verify-delivery`, `feedback-aggregate`, and `post-merge`.
9. Add `feature-task.lobster.yaml` and the active-task wrapper.
10. Add the feature-task cron prompt.
11. Add tech-design and system-spec skills.
12. Add CI coverage for the Rust crate.
13. Run a dry-run pass against task `2527ff9d-4369-444f-995d-4d4bb0ac7b70`.

## Open Questions

- Should Tasks API get first-class fields for `tech_design_url`, `tech_design_approved`, `system_spec_url`, and `no_system_spec_change_reason`, or should v2 initially encode non-taskType fields in tagged comments?
- Which `.openclaw` repository/path should own Rowan `HEARTBEAT.md`, `WORKFLOW.md`, and cron registration changes for AC7.1, AC9.2, and AC9.3?
