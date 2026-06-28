# Feature Task Workflow

**Type:** System reference (keep updated as the pipeline evolves)
**Last updated:** 2026-06-29
**Repo:** `Stoffer-Industries/sindustries` · `agents/workflows/feature-task/`

---

## Purpose

Take approved feature tasks through implementation, review, merge, and post-merge cleanup without a bespoke Telegram approval flow. The workflow is the durable path Tom approves intent through and Rowan ships code through — feature work should land only when the GitHub review state is green and the system spec is in place.

For the wider agent map, see `docs/systems/agent-orchestration.md`. For bookmark-driven spec intake, see `docs/systems/bookmark-workflow.md`.

---

## Pipeline Stages

```
ready ─────→ doing ─────→ acceptance ─────→ done
   ↓            ↓              ↓
blocked    in-flight       blocked (PR review)
   ↓            ↓              ↓
ready-      blocked        waiting
checks      (CI / spec)    (Tom approval)
```

The Rust CLI under `agents/workflows/feature-task/` owns parsing, gate enforcement, and idempotent reconciliation. The Lobster YAML composes the CLI commands into status transitions. The Python wrapper discovers active tasks and runs the Lobster pipeline for each.

### 1. `ready` — gate checks before implementation

- **Cron / heartbeat:** feature-task lobster run on every Quinn heartbeat tick
- Rust command: `feature-task ready-checks`
- Required to pass before `ready -> doing`:
  - `taskType: feature` is set on the task
  - Linked product spec exists and is approved by Tom (sign-off recorded in spec or comment)
  - `[tech-design] <url>` task comment exists (durable first-class `tech_design_url` field is the eventual home)
  - `[tech-design-approved] true` task comment exists (Quinn writes this after Tom signs off)
  - No spec drift (`specChecksum` matches current AC JSON)
- Failed checks produce a task comment listing each failed criterion

### 2. `doing` — implementation

- **Owner:** Rowan, working on the agreed worktree branch
- Required Rowan behaviour:
  - All changes land via PR (no direct pushes to `main`)
  - `[rowan-prs] <url1>, <url2>` task comment lists every open PR
  - `[openclaw-needed]` task comment if any `.openclaw` file edits are required (with proposed diff + rollback note) — Rowan does not touch `.openclaw/` directly
  - PR body lists every parent task AC checked off
  - When implementation is complete, `[rowan-done] <files> | <validation commands> | <pr url>` task comment
- Rust command: `feature-task verify-delivery` runs after the `[rowan-prs]` signal to confirm PRs and CI state

### 3. `acceptance` — review and gate enforcement

- Owner: Tom reviews the PR; Rowan addresses `CHANGES_REQUESTED` feedback on the same branch
- Required to pass before `acceptance -> done`:
  - All PRs linked from `[rowan-prs]` are merged
  - GitHub review state on every linked PR is `APPROVED` (no `CHANGES_REQUESTED` outstanding)
  - CI on the merged commits is green
  - System spec exists at `docs/systems/<file>.md` (gated via `[system-spec]` task comment) OR a substantive `[no-system-spec-change] <reason>` is recorded
  - No `[openclaw-needed]` pending without matching `[openclaw-done]` from Quinn
  - Spec checksum still matches AC JSON (no drift since `ready`)
- Rust commands: `feature-task feedback-aggregate`, then `feature-task post-merge`

### 4. `done` — terminal

- Lobster writes `done` after `post-merge` checks pass
- No further workflow steps

---

## State Machine

| Status | Description | Next states |
|---|---|---|
| `ready` | Task has approved product spec + tech design | `doing`, `blocked` |
| `doing` | Implementation in flight on a worktree branch | `acceptance`, `blocked` |
| `acceptance` | PRs open, awaiting review | `done`, `blocked` |
| `done` | All PRs merged, post-merge checks passed | **terminal** |
| `blocked` | One or more gates failing | loops back to prior state once gate clears |

`blocked` is not a separate workflow status — it is an annotation in the Lobster state comment that explains why the transition is being held. The task record status remains in `ready` / `doing` / `acceptance`; only the Lobster state carries the blocking reason.

---

## Key Files

| File | Role |
|---|---|
| `agents/workflows/feature-task/src/main.rs` | Rust CLI — task parsing, gate enforcement, idempotent reconciliation |
| `agents/workflows/feature-task/Cargo.toml` | Crate manifest, deps (`serde`, `serde_json`, `ureq`, `clap`, `toml`) |
| `agents/workflows/feature-task/feature-task.lobster.yaml` | Lobster pipeline definition composing the CLI commands |
| `agents/workflows/feature-task/run.py` | Wrapper script — discovers active feature tasks and runs the Lobster pipeline for each |
| `agents/crons/prompts/feature-task-workflow.md` | Cron prompt that runs the wrapper |
| `agents/skills/dev/tech-design/SKILL.md` | Authoring guide for tech designs |
| `agents/skills/dev/system-spec/SKILL.md` | Authoring guide for system specs (this file is one) |
| `docs/specs/<task-slug>-tech-design.md` | Per-task tech design, branch URL recorded as `[tech-design]` task comment |
| `docs/systems/<system>.md` | Per-system spec; recorded as `[system-spec]` task comment |
| `services/tasks-api/prisma/schema.prisma` | Tasks API persistence — `taskType`, `specChecksum` |

---

## Key Scripts / Commands

| Command | Stage | Notes |
|---|---|---|
| `cargo run -- load-task` | any | Fetch + normalize a single feature task |
| `cargo run -- spec-check` | `ready` gate | Product spec link + Tom approval + specChecksum verification |
| `cargo run -- ready-checks` | `ready` gate | Tech design gate + spec drift |
| `cargo run -- verify-delivery` | `doing` gate | PR list + CI status + AC checklist presence |
| `cargo run -- feedback-aggregate` | `acceptance` gate | Aggregates `CHANGES_REQUESTED` feedback to Rowan |
| `cargo run -- post-merge` | `done` gate | Verifies all PRs merged + post-merge CI green + system spec |
| `agents/workflows/feature-task/run.py` | dispatcher | One-tick invocation: discovers active feature tasks and runs the Lobster pipeline per task |

---

## Task Comment Tags (Interim Contract)

Until first-class Tasks API fields exist, the workflow reads these tags from task comments:

| Tag | Owner | Purpose |
|---|---|---|
| `[tech-design] <url>` | Rowan | Tech design URL (durable `tech_design_url` is the eventual home) |
| `[tech-design-approved] true` | Quinn | Tom signed off on the tech design |
| `[rowan-prs] <url1>, <url2>` | Rowan | PRs implementing this task |
| `[rowan-done] <files> \| <validation> \| <pr url>` | Rowan | Implementation complete signal |
| `[openclaw-needed] <reason>` | Rowan | Flag a `.openclaw` change for Quinn |
| `[openclaw-done] <summary>` | Quinn | `.openclaw` change applied |
| `[system-spec] docs/systems/<file>.md` | implementer | System spec reference |
| `[no-system-spec-change] <reason>` | implementer | Bypass for code-only changes |
| `[lobster-state] { ... }` | Lobster | Reconciler state — `version`, `last_orchestrated_at`, gate outcomes |
| `[scope-add] <summary>` | Quinn / Tom | Document a scope change after spec approval (used in factory-v2 grandfathering) |

The first-class Tasks API target is `taskType`, `tech_design_url`, `tech_design_approved`, `system_spec_path`, `no_system_spec_change_reason`, and `specChecksum`. Field availability is surfaced through the lobster; missing fields fall back to comment tags.

---

## Spec Checksum Safeguards (factory-v2 last grandfathered edit)

After a spec is approved, the task record stores `specChecksum` (sha256 of the canonical AC JSON with sorted keys). A drift between the stored checksum and the current AC text blocks the write with `409 SPEC_CHECKSUM_MISMATCH`, pointing the user to write a new spec; there is no one-click create-new-spec UI yet.

### Which writes hit the drift handshake

Only the two write surfaces that mutate `description` enforce the checksum:

| Surface | Trigger | Drift guard |
|---|---|---|
| `PATCH /tasks/:id` (with `description` in body) | `tasks.ts` calls `rejectSpecDrift(res, existing, newDescription)` | `409 SPEC_CHECKSUM_MISMATCH` if the canonical AC checksum no longer matches `existing.specChecksum` |
| `POST /tasks/:id/comments` | `tasks.ts` calls `rejectSpecDrift(res, existing, existing.description)` | Same `409` response if ACs have drifted since the comment was authored |

Other task events (status changes, dependency adds, tag edits, AC-free PATCH writes, comment edits) do **not** re-check the checksum — they succeed even if ACs have drifted. If a caller needs to assert the AC is still in scope on those paths, the caller is responsible for passing `description` into a `PATCH` first.

The error message returned on drift names the task id, the stored `specChecksum`, and the current recomputed checksum so the caller can decide whether to write a new spec or roll the stored checksum forward via a follow-up `PATCH /tasks/:id` with the matching `description`.

`factory-v2` is the last task grandfathered with editable ACs after spec approval. From the next task onward, ACs are frozen at approval and any change requires a new task.

Lives in:
- `services/tasks-api/prisma/schema.prisma` — `specChecksum` field on tasks
- `services/tasks-api/src/routes/tasks/_spec.ts` — `rejectSpecDrift` helper + canonical AC checksum
- `services/tasks-api/src/routes/tasks.ts` — write-side validation at the two PATCH/POST call sites above
- `agents/workflows/feature-task/src/main.rs` — Rust-side checksum guard at the lobster gate

---

## Cron Behaviour

- **Cron prompt:** `agents/crons/prompts/feature-task-workflow.md`
- **Schedule:** runs on Quinn heartbeat tick (every 30 min) via `agents/workflows/feature-task/run.py`
- **Idempotency:** the reconciler pattern means reruns are safe — `lobster-state` carries the last orchestration timestamp and outcome
- **No `wait_for`:** the workflow must not block; gates are evaluated against current GitHub / Tasks API state, then the lobster writes the next state or no-ops

---

## Heartbeat Responsibilities

| Agent | Step | What it does |
|---|---|---|
| Quinn | LOBSTER CHECK | Runs `run.py`, reports only failures / blocked gates / meaningful transitions |
| Quinn | OPENCLAW HANDOFF | Scans active feature tasks for `[openclaw-needed]` and posts `[openclaw-done]` after applying |
| Rowan | TASK DISCOVERY | Lists active tasks assigned to Rowan |
| Rowan | TECH DESIGN | Writes `docs/specs/<task-slug>-tech-design.md` and posts `[tech-design]` task comment (when `ready`) |
| Rowan | IMPLEMENTATION | Implements on the worktree branch; `[rowan-prs]` once PRs are open |
| Rowan | PR FEEDBACK | Stays in `acceptance` while addressing `CHANGES_REQUESTED` on the same branch |

---

## `.openclaw` Boundary

The `.openclaw/` directory is outside this repo. Any required `.openclaw` change is flagged from the primary repo via `[openclaw-needed]` and applied by Quinn. Rowan must not edit `.openclaw/` files directly; doing so violates the documented permission boundary.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `ready -> doing` blocked | Missing `[tech-design-approved]` or `specChecksum` drift | Quinn confirms Tom sign-off and posts `[tech-design-approved] true`; for drift, write a new spec |
| `[openclaw-needed]` never resolved | Quinn missed the heartbeat step | Quinn scans active feature tasks on the next heartbeat tick |
| `acceptance -> done` blocked | `[system-spec]` missing or no `[no-system-spec-change]` reason | Author `docs/systems/<system>.md` and post `[system-spec] <path>` |
| Spec checksum mismatch | ACs edited after spec approval | Hits only `PATCH /tasks/:id` (with `description`) and `POST /tasks/:id/comments`; both return `409 SPEC_CHECKSUM_MISMATCH`. Treat as spec drift — write a new spec, do not hand-edit ACs. |
| `PATCH` succeeds despite stale ACs | Other event types (status change, dependency add, tag edit) don't re-check the checksum | Pass the updated `description` through `PATCH /tasks/:id` first so the drift check fires there. |
| CI green but PR not merged | Reviewer has not approved | Wait for `APPROVED` review state; Lobster will not mark `done` until GitHub merge is recorded |

---

## Related Specs

- `docs/specs/feature-factory-v2-tech-design.md` — factory-v2 tech design (system spec's reference implementation)
- `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` — factory-v2 product spec
- `docs/systems/agent-orchestration.md` — wider agent map
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake (parallel pipeline)
