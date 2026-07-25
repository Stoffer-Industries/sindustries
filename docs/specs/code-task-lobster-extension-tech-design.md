---
status: ready
task_id: f77b7a60-225c-445c-b3d9-042e38a86cde
product_spec: brain/tasks/specs/in-progress/code-task-lobster-extension-2026-07-20.md
research_tech_design: brain/research/code-task-lobster-extension-tech-design.md
shipped_pr: null
shipped_date: null
alignment_note: |
  Tech design adapted from research task 843c65b8 (Quinn, 2026-07-16).
  Task-level design focuses on the implementation surface (the two new
  Rust subcommands, the new pipeline YAML, and run.py dispatch changes)
  and on the gate contracts that drive acceptance.
---

# Code-task lobster extension — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/code-task-lobster-extension-2026-07-20.md`
- Research tech design (authoritative for design rationale, alternatives, and risk notes): `brain/research/code-task-lobster-extension-tech-design.md` (Quinn, 2026-07-16)
- Task: `f77b7a60-225c-445c-b3d9-042e38a86cde` (`🔧 Code-task lobster extension`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/f77b7a60-225c-445c-b3d9-042e38a86cde`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f77b7a60-code-task-lobster-extension`
- Worktree: `~/workspaces/rowan/sindustries` (current)
- No secondary repos. All changes land in `agents/workflows/feature-task/` (Rust binary + Python runner + new pipeline YAML).

## Goal

Extend the feature-factory lobster to dispatch `taskType: code` tasks through a simplified open → ready → doing → acceptance → done pipeline. Code tasks skip the product spec machinery entirely and make the tech design gate optional (present or explicitly waived). The shared `feedback_aggregate` and `post_merge` stages are reused unchanged; `archive_done_task_spec()` already no-ops when no `**Spec:**` line is present.

## Why this approach (recap from research design)

Two concrete gaps motivated the task: an incident-action code task and a bookmark-analytics follow-on code task both sat open with no execution path. The feature-task lobster filters on `taskType == "feature"` or `feature-factory` tag in `run.py:discover_tasks()`. A separate binary would duplicate ~1500 lines of shared helpers; branching inside feature-task stages risks regressions on feature tasks. The chosen approach is two new Rust subcommands plus a new pipeline YAML, wired through `run.py`.

## Stage mapping

| Feature task stage | Code task equivalent | Notes |
|---|---|---|
| `spec_check` | **Skipped** | No product spec; no `specChecksum`; no spec drift |
| `ready_checks` | `code-task-ready-checks` | Tech design gate optional (waivable); no spec-drift guard |
| `verify_delivery` | `code-task-verify-delivery` | PR/AC checks reused; spec-drift check removed |
| `feedback_aggregate` | **Reused as-is** | PR review state logic is identical |
| `post_merge` | **Reused as-is** | `archive_done_task_spec()` already no-ops without `**Spec:**` |

## Gate details

### `code-task-ready-checks` (open → ready → doing)

Single stage replacing both `spec_check` and `ready_checks`. Fails if any of:

1. **Tech design gate:** Either `[tech-design] <path>` + `[tech-design-approved] true` must be present, OR `[tech-design-not-required] <reason>` must be present. If neither is present, fail with `"Missing task comment '[tech-design] <path>' or '[tech-design-not-required] <reason>'."`. When `[tech-design]` is present but `[tech-design-approved]` is missing, fail with `"Missing task comment '[tech-design-approved] true'."`. This mirrors how feature tasks handle the system spec gate.
2. **Assignee:** Task must be assigned to Rowan.
3. **Rowan doing capacity:** Reuse the existing `rowan_doing_capacity_failures()` helper (same cap as feature tasks).

No spec-checksum guard. No spec-drift check. No `move_approved_chat_spec_if_needed`.

**New helper needed:** `tech_design_waived(task: &Task) -> bool` — checks for a comment starting with `[tech-design-not-required]` (same parsing pattern as `tagged_values()`).

### `code-task-verify-delivery` (doing → acceptance)

Same checks as feature task `verify_delivery` with spec machinery removed:

- `[rowan-prs]` comment with at least one PR URL.
- PR review state: not `ChangesRequested`, not `ClosedUnmerged`.
- PR body has at least one checked acceptance criterion.
- Task ACs match PR body ACs (reuse `task_ac_vs_open_pr_failures()`).
- At least one workstream in the task description.
- System spec gate (reuse `system_spec_failures()`).
- `[openclaw-needed]` without `[openclaw-done]` blocks.

**Removed vs feature task `verify_delivery`:**
- `block_on_spec_drift_fluid()` call — no spec drift for code tasks.
- `LobsterState.workflow` is set to `"code-task-workflow"` (was hardcoded to `"feature-task-workflow"`).

### `feedback_aggregate` and `post_merge` (reused unchanged)

No code changes. `archive_done_task_spec()` returns `post_merge_no_spec_to_archive` when `**Spec:**` is absent (line ~1291 in main.rs) — correct behavior for code tasks. Worktree cleanup already scans by task-id prefix.

## File changes

### 1. `agents/workflows/feature-task/src/main.rs`

Two new `Subcommand` variants in the `Commands` enum:
```rust
CodeTaskReadyChecks(StageArgs),
CodeTaskVerifyDelivery(StageArgs),
```

Two new top-level functions:
- `code_task_ready_checks(args: StageArgs) -> Result<Envelope>`
- `code_task_verify_delivery(args: StageArgs) -> Result<Envelope>`

One new helper:
- `tech_design_waived(task: &Task) -> bool`

Wired into `main()` in the pattern already established for the other subcommands.

### 2. `agents/workflows/feature-task/code-task.lobster.yaml` (new)

Mirrors `feature-task.lobster.yaml` but with `code_task_ready_checks` and `code_task_verify_delivery` instead of `spec_check` / `ready_checks` / `verify_delivery`. Same `feedback_aggregate` and `post_merge` stages, same args (`taskId`, `tasksApiBaseUrl`, `sindustriesRepo`, `workspaceRoot`, `dryRun`).

### 3. `agents/workflows/feature-task/run.py`

Extend `discover_tasks()` to also pick up `taskType == "code"` tasks:
```python
elif task_type == "code":
    seen.add(task_id)
    tasks.append((task, CODE_TASK_PIPELINE))
```

`run_workflow()` gets a second argument `pipeline: Path`. `main()` iterates the updated return type.

## `.openclaw` boundary

- No `~/.openclaw/` writes required.
- No new cron jobs; heartbeat already calls `run.py`.
- No new secrets, tokens, or environment variables.

## Migration for existing open code tasks

Existing code tasks in `open` status with no lobster-state comment will be picked up on the first heartbeat after the PR merges. `code-task-ready-checks` evaluates their state and either advances to `doing` if `[tech-design]` + `[tech-design-approved]` (or `[tech-design-not-required]`) are present and Rowan is assigned and available, or blocks with a `[feature-task-progress-checklist]` comment listing what's missing.

No data migration required. Code tasks have no `specChecksum` — the spec-drift guard never fires.

The known open code tasks in the 2026-W29 audit cloud-readiness sweep will need `[tech-design-not-required] <reason>` or `[tech-design] <path>` + `[tech-design-approved] true` posted before they can advance. This is a follow-up wave after the pipeline lands.

## Risk notes

- **`post_merge` reuse confirmed:** `archive_done_task_spec()` returns `post_merge_no_spec_to_archive` when `**Spec:**` is absent. Verify in integration tests.
- **Capacity shared with feature tasks:** If Rowan is doing a feature task, code tasks queue. Intentional — single-threaded.
- **`feedback_aggregate` comment key:** Uses `[rowan-feedback]` tag — same for code tasks. No conflict.
- **`[tech-design-not-required]` parsing:** Must use the same `tagged_values()` helper for consistency.
- **`LobsterState.workflow` field:** Set to `"code-task-workflow"` for code task state comments so they're distinguishable.

## AC verification matrix

| AC | Strategy | Tests |
|---|---|---|
| AC1 | `run.py` discovers `taskType: code` tasks and routes them through `code-task.lobster.yaml`. | `run.py` unit test asserting code-task dispatch; integration test with sample code task in `open` status. |
| AC2 | `code-task-ready-checks` gates on `[tech-design]`+`[tech-design-approved]` OR `[tech-design-not-required]`, plus assignee + capacity. | Unit test for each gate failure path and the happy path. |
| AC3 | `code-task-verify-delivery` reuses AC text/evidence checks and system spec gate, removes spec-drift logic. | Unit test asserting spec-drift is not evaluated; same AC evidence checks as feature-task tests. |
| AC4 | `feedback_aggregate` and `post_merge` unchanged; `archive_done_task_spec()` no-ops without `**Spec:**`. | Unit test asserting `archive_done_task_spec()` returns `post_merge_no_spec_to_archive` for code tasks. |
| AC5 | Existing open code tasks are picked up on first run; blocked at `code-task-ready-checks` with checklist if missing prerequisites. | Integration test with sample code task missing tech-design → expect `criteriaMet: false` + checklist comment. |
| AC6 | `LobsterState.workflow` set to `"code-task-workflow"` for code task state comments. | Unit test asserting `lobster_state.workflow == "code-task-workflow"` after `code-task-ready-checks`. |

## Out of scope

- Migrating existing open code tasks to have `[tech-design]` or `[tech-design-not-required]` comments — separate follow-up wave.
- Adding new code-task-specific feedback paths beyond `[rowan-feedback]` reuse.
- Auto-generating tech designs for code tasks.
- UI surfaces or `apps/*` changes.

## Open questions

- **Q1 — Capacity accounting.** Code tasks share Rowan's doing capacity with feature tasks. Should high-priority code tasks be allowed to preempt a lower-priority feature task? Current design: no, single-threaded. If a code task is genuinely urgent (security fix), Tom or Quinn can manually intervene.
- **Q2 — Spec-required escape hatch.** Some code tasks may eventually grow product-style criteria. The current design treats `[tech-design-not-required]` as the waiving mechanism, but should a `taskType: code` task that needs spec machinery be promoted to a feature task instead? Current recommendation: yes — promotion is cleaner than bolting spec machinery into code tasks.
- **Q3 — Backwards compatibility.** Existing code tasks with `[openclaw-needed]` but no `[openclaw-done]` will block at `code-task-verify-delivery` exactly like feature tasks. No escape hatch — must complete the handoff before acceptance.

## Companion doc updates

- `agents/workflows/feature-task/README.md` — add a section documenting the code-task pipeline and the tech-design-optional gate.
- `agents/definitions/rowan/WORKFLOW.md` — note that code tasks also pass through the lobster and follow the same status transitions.
- `docs/systems/tasks.md` — add code-task pipeline diagram and stage-mapping table.