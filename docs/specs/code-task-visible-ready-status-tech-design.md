---
status: draft
task_id: 3ba96b5e-36ea-4e43-a883-d6c3cd0c25e3
product_spec: brain/tasks/specs/in-progress/code-task-visible-ready-status-2026-07-25.md
shipped_pr: null
shipped_date: null
---

# Code-task visible ready status — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/code-task-visible-ready-status-2026-07-25.md`
- Task: `3ba96b5e-36ea-4e43-a883-d6c3cd0c25e3` (`🔧 Code tasks get a real ready status once their tech design clears`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/3ba96b5e-36ea-4e43-a883-d6c3cd0c25e3`
- Predecessor task: `f77b7a60-225c-445c-b3d9-042e38a86cde` (code-task lobster extension) — this task refines the gate introduced there.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-3ba96b5e-code-task-visible-ready-status`
- Worktree: `~/workspaces/rowan/sindustries-task-3ba96b5e-code-task-visible-ready-status`
- No secondary repos. All changes land in `agents/workflows/feature-task/` (Rust binary + YAML pipeline) plus `docs/systems/code-task-workflow.md`.
- Dependency: task `f77b7a60` (code-task lobster extension, currently `acceptance` — PR #276 still merging in review) must ship first, because the single-stage `code-task-ready-checks` it lands is what this task splits. Without f77b7a60 merged, the "today's behaviour" column above does not exist on `main` yet.

## Goal

Split the code-task pipeline so that an approved tech design (or explicit waiver) alone is enough to move a task to `ready`, while the assignee/capacity check is a separate gate that advances `ready` → `doing`. Today the `code-task-ready-checks` stage bundles both gates into a single open → doing transition. The bundled gate hides a useful signal: a task with an approved design but no assignee currently looks identical to a task with no design work at all — both sit in `open`. Feature tasks already implement this split (product spec gate → tech-design/assignee gate); code tasks should match.

## Why this approach

Two patterns considered:

1. **Two-stage pipeline** — add a new `code-task-tech-design-check` stage that runs ahead of `code-task-ready-checks` and only advances open → ready. The existing `code-task-ready-checks` is repurposed to handle only ready → doing.
2. **Single-stage branching** — keep `code-task-ready-checks` as one stage but make its transition target conditional on which subset of gates pass (open → ready when only tech design is satisfied; ready → doing when capacity is also satisfied).

Approach 1 is chosen because it mirrors the feature-task pipeline structure (`spec_check` → `ready_checks` → `verify_delivery`), keeps each stage's failure message focused on one gate, and lets the lobster's per-stage `criteriaMet` boundary cleanly route the right task status changes. Approach 2 would couple two unrelated gate concerns into a single stage and produce ambiguous failure comments when both gates fail.

## Stage mapping

| Today's behaviour | After this change | Notes |
|---|---|---|
| `code-task-ready-checks` (open → doing, both gates bundled) | `code-task-tech-design-check` (open → ready) | New stage. Tech design gate only. |
| _not present_ | `code-task-ready-checks` (ready → doing) | Repurposed. Tech-design gate removed; assignee/capacity only. |
| `code-task-verify-delivery` (doing → acceptance) | unchanged | |
| `feedback_aggregate` | unchanged | |
| `post_merge` | unchanged | |

## Gate details

### `code-task-tech-design-check` (open → ready) — new stage

Single-concern stage. Fails if any of:

1. **Tech design gate:** Either `[tech-design] <path>` + `[tech-design-approved] true` must be present, OR `[tech-design-not-required] <reason>` must be present. If neither is present, fail with `"Missing task comment '[tech-design] <path>' or '[tech-design-not-required]' <reason>'."`. When `[tech-design]` is present but `[tech-design-approved]` is missing, fail with `"Missing task comment '[tech-design-approved] true'."`. **Same parsing pattern as today's bundled check** — extracted from `code-task_ready_checks` into a new helper that returns only the tech-design failures.
2. **Manual block:** `manual_block_failures()` still applies. If the task is manually blocked, the comment uses `[code-task-blocked]` (preserves today's prefix).

No assignee check. No capacity check. These move to the next stage.

Comment prefix changes from `[code-task-progress-checklist]` to `[code-task-tech-design-checklist]` so the comment signal alone tells the reader which gate is open. The lobster's `lastOrchestratedAt` is still updated so the next heartbeat re-runs the gate.

If `is_past(task, "ready")` is true, return `criteriaMet: true` with `action_taken: "already_past_ready"`. This makes the stage idempotent in the same way the existing `code-task-ready-checks` is idempotent w.r.t. `is_past("doing")`.

### `code-task-ready-checks` (ready → doing) — repurposed

Drop the tech-design gate (moved to the new stage). Keep:

1. **Assignee:** Task must have an assignee/implementer. Fail with `"Task must have an assignee/implementer before moving to `doing`."`.
2. **Rowan doing capacity:** Reuse `implementer_doing_capacity_failures()` (same cap as feature tasks and today's code-task check).

If these are the only failures, the status comment says the blocker is the assignee/capacity gate — not tech design. This is what AC4 requires.

If `is_past(task, "doing")` is true, return `criteriaMet: true` with `action_taken: "already_past_doing"`. Preserve today's idempotency.

Comment prefix stays `[code-task-progress-checklist]`.

### Other stages

`code-task-verify-delivery`, `feedback_aggregate`, and `post_merge` are unchanged. The post-merge stage already emits the analytics row per task `f170e344`; nothing in this task changes that.

## Pipeline YAML

`agents/workflows/feature-task/code-task.lobster.yaml` gains one stage and renames the existing one:

```yaml
steps:
  - id: load_task
    command: … (unchanged)

  - id: code_task_tech_design_check
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      code-task-tech-design-check --base-url ${tasksApiBaseUrl} --dry-run ${dryRun} --repo ${sindustriesRepo} --workspace-root ${workspaceRoot}
    stdin: $load_task.stdout

  - id: code_task_ready_checks
    command: >-
      cargo run --manifest-path ${sindustriesRepo}/agents/workflows/feature-task/Cargo.toml --
      code-task-ready-checks --base-url ${tasksApiBaseUrl} --dry-run ${dryRun} --repo ${sindustriesRepo} --workspace-root ${workspaceRoot}
    stdin: $code_task_tech_design_check.stdout
    condition: $code_task_tech_design_check.json.criteriaMet

  - id: code_task_verify_delivery
    # unchanged: condition is $code_task_ready_checks.json.criteriaMet
```

The `condition:` on `code_task_ready_checks` switches from `$load_task.stdout` (today) to `$code_task_tech_design_check.json.criteriaMet`, ensuring the second gate only runs once the first has passed.

## Source-of-truth boundary

The change is owned by the feature-task workflow binary and its YAML pipeline. No new tables, no API changes, no shared-package changes. The lobster state already tracks per-stage `lastOrchestratedAt`, so a task that lands in `ready` after only the tech design gate will be re-evaluated on the next heartbeat and naturally advance to `doing` once the assignee arrives.

## `.openclaw` boundary

No `~/.openclaw/` writes required. No new crons, no new secrets, no new env vars. The Rust binary and the YAML pipeline are both in this repo.

## Test plan — AC verification matrix

| AC | Layer | Plan |
|---|---|---|
| AC1 (tech design → ready without assignee) | E2E: feature-task workflow tests | Run the new `code-task-tech-design-check` against a fixture task with `[tech-design] <url>` + `[tech-design-approved] true` and no assignee. Assert `criteriaMet: true`, status transitions to `ready`, and the next run is idempotent (`already_past_ready`). |
| AC2 (no tech design, no waiver → stays in open) | Unit | Tests on the new helper that returns only tech-design failures: assert the helper returns the expected failure string for a task with neither, and `criteriaMet: false` is returned. |
| AC3 (ready → doing requires assignee + capacity) | E2E: feature-task workflow tests | Two fixtures: (a) ready task with no assignee → fail; (b) ready task with assignee but capacity exhausted → fail with `implementer_doing_capacity_failures` message. Assert `criteriaMet: false` and status stays at `ready`. |
| AC3 (ready → doing succeeds when both gates clear) | E2E | Fixture task with assignee + capacity available → `criteriaMet: true`, status transitions to `doing`. |
| AC4 (blocked-ready comment names the assignee/capacity gate, not tech design) | Unit | When the second-stage check fails on assignee or capacity, the failure string is one of the two expected strings. When the tech-design stage fails, the comment uses `[code-task-tech-design-checklist]` prefix. |
| AC5 (system doc describes the two-gate flow) | Manual + lint | `docs/systems/code-task-workflow.md` gains a section describing the new `open → ready → doing` flow with the same diagram-style wording as the feature-task section. CI/docs lint check that the file still passes the existing `## Tasks using this workflow` cross-link (the lobster's `system_spec_failures` gate already validates the doc references this task). |

E2E coverage is appropriate because the change is end-to-end observable (lobster runs against a real Tasks API fixture). No `file:` evidence — every plan is a unit or e2e test.

## Open questions and risks

- **Backfill for tasks already in `open` with an approved design.** Task `94d5e4fc` (the spec's cited example) is one. After merge, the next heartbeat will run the new pipeline and advance it to `ready` automatically. No manual backfill needed.
- **Comment-prefix renaming.** Existing tasks in `doing` / `acceptance` will never re-emit `[code-task-progress-checklist]` from the tech-design gate (the new stage uses `[code-task-tech-design-checklist]`). The lobster's `LobsterState.lastOrchestratedAt` ensures the gates only re-run on heartbeat. The prefix split is intentionally a signal change, not a refactor.
- **Other tasks referencing the old prefix.** The `code-task-progress-checklist` prefix is still emitted by `code-task-ready-checks` (the second-stage gate). The new prefix is additive; no broadcast regex needs updating.
