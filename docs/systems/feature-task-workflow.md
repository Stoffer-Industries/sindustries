# Feature Task Workflow

**Type:** System reference (keep updated as the pipeline evolves)
**Last updated:** 2026-07-19
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
  - `[implementer-prs] <url>` task comment lists every open PR (legacy alias `[rowan-prs]` still accepted)
  - `[openclaw-needed]` task comment if any `.openclaw` file edits are required (with proposed diff + rollback note) — Rowan does not touch `.openclaw/` directly
  - PR body lists every parent task AC checked off with evidence annotations
  - PR body includes a `## System Spec` section (see below) — required before the PR is converted from draft to ready-for-review
  - When implementation is complete, post `[implementer-prs] <url>` task comment
- Rust command: `feature-task verify-delivery` runs after the `[implementer-prs]` signal to confirm PRs, CI state, AC text, and system spec

### 3. `acceptance` — review and gate enforcement

- Owner: Tom reviews the PR; Rowan addresses `CHANGES_REQUESTED` feedback on the same branch
- Required to pass before `acceptance -> done`:
  - All PRs linked from `[rowan-prs]` are merged
  - GitHub review state on every linked PR is `APPROVED` (no `CHANGES_REQUESTED` outstanding)
  - CI on the merged commits is green
  - PR body `## System Spec` section declares either a spec path (`docs/systems/<file>.md`) or a substantive no-change reason — validated at `verify_delivery` (doing → acceptance gate), not acceptance → done
  - No `[openclaw-needed]` pending without matching `[openclaw-done]` from Quinn
  - `[qa-ac-verified] true` task comment from Tom
- Rust commands: `feature-task feedback-aggregate`, then `feature-task post-merge`

**`## System Spec` PR body section (doing → acceptance, pre-merge):** `verify_delivery` reads the `## System Spec` section from the **latest implementer PR body** (highest PR number). The section must contain either:
- A path to the spec file committed on the same branch: `docs/systems/<file>.md` (plain or backtick-quoted). The lobster fetches the file from the PR branch (or `main` when merged) and confirms it references the task ID or PR URL.
- A substantive no-change reason (≥ 12 non-whitespace characters, no `docs/systems/` path): use when no system-level behaviour changed.

A stub like "No change" (< 12 non-whitespace chars) is treated as missing and blocks acceptance. **The system spec must be committed in the same PR as the feature code** — a separate backfill PR is not acceptable. No task comment is needed; the PR body section is the gate. See `agents/skills/dev/pr-open/SKILL.md` for the canonical PR body template.

**AC text check (doing → acceptance, pre-merge):** before the lobster will let the task advance from `doing` to `acceptance`, it compares every task description AC against the **open** PR body. If any AC is missing from the PR, has altered text, or lacks a valid evidence annotation `(testID|file|not tested|not code)`, the transition is blocked with a `[feature-task-progress-checklist]` comment listing the specific failures — the task stays in `doing` until Rowan opens a fix PR that lists every AC verbatim with evidence. Tom may edit ACs in the task description during QA — spec drift does not block this gate (it is covered by the resync feature; see task b2ab54db).

Note: prior versions of this workflow ran an equivalent AC text check at the `post-merge` stage (the "QA bounce") that moved a task back from `acceptance` to `doing` if the latest merged PR's AC text didn't match. That path was removed because it triggered after merge, forcing a wasteful revert + fix-PR round-trip. The check now runs pre-merge so mistakes are caught before the PR is merged.

**PR AC evidence formats** — priority order (use the first that applies):
- `(🧪 testID: <id>)` — e2e (Playwright) or unit test reference. **Default — always prefer this.**
- `(⚠️ not tested: <reason>)` — explicit opt-out; requires a substantive reason
- `(📄 not code: <reason>)` — AC fulfilled outside the codebase (doc, spec, config)
- `(🔗 pr: #<n>)` — covered by another merged PR

`file:` has been removed (it was being used to cite implementation files rather than tests). Emojis are optional but encouraged for visual clarity in reviews.

### 4. `done` — terminal

- Lobster writes `done` after `post-merge` checks pass
- After moving to `done`, the lobster's `post-merge` stage runs a best-effort **worktree cleanup** that removes the Rowan feature worktree (e.g. `~/workspaces/rowan/sindustries-task-<8char-prefix>-<slug>`) registered with the primary `sindustries` worktree. The cleanup is idempotent (missing paths are no-ops) and non-fatal (a failure is logged via `[feature-task-progress-checklist]` but does not block `done`). Tracked as task `ba116063-382a-446c-ab91-c01b60d9a7c3`.
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
| `docs/systems/<system>.md` | Per-system spec; committed on the implementation branch and declared in the PR body's `## System Spec` section |
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
| `[implementer-prs] <url>` | Rowan | PRs implementing this task (`[rowan-prs]` is a legacy alias, still accepted) |
| `[openclaw-needed] <reason>` | Rowan | Flag a `.openclaw` change for Quinn |
| `[openclaw-done] <summary>` | Quinn | `.openclaw` change applied |
| `[qa-ac-verified] true` | Tom | Explicit QA sign-off; required before `acceptance -> done` |
| `[feature-task-progress-checklist] ...` | Lobster | Posted when the pre-merge AC text check (doing → acceptance) finds a missing, altered, or unannotated AC in the open PR body. Also posted for other gate failures (missing `[implementer-prs]`, missing `## System Spec` PR body section, manual block, etc.) |
| `[lobster-state] { ... }` | Lobster | Reconciler state — `version`, `last_orchestrated_at`, gate outcomes |
| `[scope-add] <summary>` | Quinn / Tom | Document a scope change after spec approval (used in factory-v2 grandfathering) |

The first-class Tasks API target is `taskType`, `tech_design_url`, `tech_design_approved`, `system_spec_path`, `no_system_spec_change_reason`, and `specChecksum`. Field availability is surfaced through the lobster; missing fields fall back to comment tags.

---

## Spec Checksum Safeguards (factory-v2 last grandfathered edit)

After a spec is approved, the task record stores `specChecksum` (sha256 of the canonical AC JSON with sorted keys). The fluid AC lifecycle (shipped via task `b2ab54db`) replaces the old hard-block on drift with a Tom-gated re-approval flow. The brain spec remains the AC source of truth in `open`, but Tom may approve the spec in either the brain spec or the task description while the task is still `open`; Lobster mirrors task-side approval back to the brain spec before moving to `ready`. The task description is the source of truth in every later status.

### Fluid AC lifecycle state machine

The lobster (`agents/workflows/feature-task/src/main.rs`) recognises three states for the `**Approved by Tom**` marker in the task description:

| Marker | Drift present? | Outcome |
|---|---|---|
| `[x]` (checked) | No | Stage passes |
| `[x]` (checked) | Yes + matching `[spec-resynced]` already present | Stage passes (checksum has been reset for this drift episode) |
| `[x]` (checked) | Yes + Lobster previously unchecked this drift episode | Lobster resyncs the brain spec AC section from the task description, resets `specChecksum`, posts `[spec-resynced]`, and stage passes on the next evaluation |
| `[x]` (checked) | Yes + no current resync record | Lobster unchecks the marker via PATCH, posts a `[feature-task-progress-checklist]` comment listing the drift, and blocks |
| `[ ]` (unchecked) | (drift recorded earlier) | Block waiting on Tom to re-check `**Approved by Tom**` on the new spec |
| Absent (legacy tasks) | Yes | Legacy hard block with `write a new spec` message |

`open` status always uses the brain spec ACs as source of truth. The open → ready approval gate accepts `- [x] **Approved by Tom**` in either the brain spec or the task description; if approval was only in the task description, Lobster mirrors the checked marker into the brain spec before transition. Drift marker machinery still only kicks in for `ready`, `doing`, `acceptance`, `done`.

### Tasks API writes under the fluid lifecycle

| Surface | Behaviour |
|---|---|
| `PATCH /tasks/:id` with `description` change | Drift guard fires UNLESS the description change is marker-only (the `**Approved by Tom**` line toggling checked → unchecked). The marker-only exception lives in `services/tasks-api/src/routes/tasks/_spec.ts` (`descriptionsDifferOnlyByApprovalMarker`); bundling any AC text change with the marker toggle still returns `409 SPEC_CHECKSUM_MISMATCH`. |
| `POST /tasks/:id/comments` | Drift-tolerant. Comments are meta-discussion, not scope changes; the lobster must be able to post `[feature-task-progress-checklist]`, `[spec-resynced]`, `[qa-ac-verified]` even when ACs have drifted. |
| Status changes / dependency adds / tag edits / AC-free PATCH writes | No drift re-check; succeed even if ACs have drifted. |

### Lobster resync contract

After Lobster has detected drift on a non-`open` task, it unchecks `**Approved by Tom**` and records that it has acted on the current drift episode. When Tom re-checks `**Approved by Tom**`, Lobster owns the resync:

1. Resolve the task's `**Spec:** <path>` and allow only Markdown files under `brain/`. Acceptable subtrees today are `brain/bookmarks/specs/*.md` and the chat-spec lifecycle dirs (`brain/tasks/specs/open/`, `brain/tasks/specs/in-progress/`, `brain/tasks/specs/done/`); top-level files directly under `brain/tasks/specs/` are only tolerated when the spec predates the lifecycle rollout and Quinn has explicitly approved a grace period.
2. Read the current task description ACs and rewrite only the brain spec's `Acceptance Criteria` section. The `**Approved by Tom**` marker is stripped from the AC list before writing — it belongs in the task description only and must not appear as a spec AC.
3. Reset `specChecksum` to the checksum of the current task ACs. Lobster clears `specChecksum` to `null` first, then sets the new sha256. The Tasks API `SPEC_CHECKSUM_LOCKED` guard allows null (a deliberate clear) but still rejects any non-null value that differs from the stored checksum, keeping the lock intact outside the resync path.
4. Post `[spec-resynced] <summary>` with `checksum=<sha256>` and `driftFingerprint=<sha256>` fields.
5. Clear the drift-unchecked state so a later drift episode starts the marker cycle again.

A `[spec-resynced]` comment is trusted only when both bindings match the current drift episode and stored checksum. Older unbound comments remain visible for audit but do not clear future drift.

### Source-of-truth handling

- `open` status: brain spec ACs win. Approval may be checked in either brain spec or task description; task-side approval is mirrored into the brain spec before transition. Drift against the stored checksum is treated as a blocker.
- `ready`, `doing`, `acceptance`, `done`: task description wins. Lobster reflects drift via the marker, then resyncs the brain spec to match after Tom re-checks approval.

### Spec folder lifecycle

Feature specs use a forward-only file lifecycle under `brain/tasks/specs/`:

- `brain/tasks/specs/open/` — new chat-created feature specs awaiting Tom approval. `feature-task-create` and `tasks-create` must create new chat specs here with an unchecked `- [ ] **Approved by Tom**` marker.
- `brain/tasks/specs/in-progress/` — approved specs attached to active feature work. On each `spec-check` run, the Rust lobster bootstraps `open/`, `in-progress/`, and `done/`, then fails loudly if any other direct subdirectory exists under `brain/tasks/specs/`. When a chat spec in `open/` is checked as approved, the lobster moves it to `in-progress/` and patches the task `**Spec:**` line. The move is idempotent; unchecked specs already in `in-progress/` are never moved back.
- `brain/tasks/specs/done/` — specs for completed feature tasks. After `post-merge` transitions a task to `done`, the lobster moves its spec from `in-progress/` to `done/` and patches the task `**Spec:**` line. Specs already in `done/` stay there even if a task later reopens.

Bookmark specs stay in `brain/bookmarks/specs/` through approval. The bookmark approval handler only toggles the file checkbox to `- [x] **Approved by Tom**`; it does not move the file. When the bookmark workflow creates or links a task from an approved bookmark spec, it moves that spec to `brain/tasks/specs/in-progress/<same-filename>.md` and creates/repairs the task `**Spec:**` line to point at the destination. From that point onward, the feature-task lifecycle treats bookmark-origin specs the same as chat-origin specs.

The task description `**Spec:**` line is the authoritative pointer for `spec-check`; every move is paired with a best-effort idempotent description patch so the next lobster run reads the new path without fallback scanning.

Lives in:
- `services/tasks-api/prisma/schema.prisma` — `specChecksum` field on tasks
- `services/tasks-api/src/routes/tasks/_spec.ts` — canonical AC checksum, marker-only exception (`descriptionsDifferOnlyByApprovalMarker`), `descriptionWithSpecDriftApprovalState`
- `services/tasks-api/src/routes/tasks.ts` — write-side validation at the PATCH call site; comments endpoint intentionally drift-tolerant
- `agents/workflows/feature-task/src/main.rs` — `block_on_spec_drift_fluid`, approval marker helpers, safe brain spec rewrite, checksum reset, and fingerprint-bound `[spec-resynced]` handling

### Error message

The `409 SPEC_CHECKSUM_MISMATCH` response names the task id, the stored `specChecksum`, and the current recomputed checksum. Outside the Lobster resync path, callers should treat this as scope drift and wait for Tom re-approval rather than hand-editing ACs. The Lobster resync path is the exception: it rewrites the brain spec and advances the stored checksum only after Tom re-checks `**Approved by Tom**`.

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
| `doing -> acceptance` blocked on system spec | PR body `## System Spec` section absent, empty, or stub (< 12 non-whitespace chars) | Add `## System Spec` to the PR body with the spec path or a substantive no-change reason; the spec file must be committed on the same branch |
| Spec checksum mismatch | ACs edited after spec approval | Hits `PATCH /tasks/:id` when the description ACs change. Treat as spec drift: Lobster unchecks `**Approved by Tom**`, waits for Tom to re-check, then performs the resync path. Comments are drift-tolerant and remain usable for progress/checklist/resync signals. |
| Spec lifecycle layout failure | Unexpected direct subdirectory under `brain/tasks/specs/` | Remove or migrate the unexpected subdir so only `open/`, `in-progress/`, and `done/` remain. The lobster creates missing expected dirs automatically. |
| Stale `**Spec:**` line after a move | Prior run moved a spec but failed before patching the task description | Re-run the relevant lobster stage; move helpers treat destination-present/source-absent as idempotent and repair the task `**Spec:**` path. |
| `PATCH` succeeds despite stale ACs | Other event types (status change, dependency add, tag edit) don't re-check the checksum | Pass the updated `description` through `PATCH /tasks/:id` first so the drift check fires there. |
| CI green but PR not merged | Reviewer has not approved | Wait for `APPROVED` review state; Lobster will not mark `done` until GitHub merge is recorded |
| Task bounced to `doing` from `acceptance` | (legacy — the post-merge QA bounce path was removed; AC text mismatches now block at the doing → acceptance gate before merge instead) | n/a |
| `doing -> acceptance` blocked on AC text | Open PR body is missing an AC, has altered AC text, or lacks a valid evidence annotation `(testID|file|not tested|not code)` | Update the PR body so every task AC appears verbatim with evidence; `[feature-task-progress-checklist]` comment lists the specific failures |
| `acceptance -> done` blocked with "Missing `[qa-ac-verified] true`" | Tom has not signed off | Tom posts `[qa-ac-verified] true` after verifying ACs on staging |

---

## Related Specs

- `docs/specs/feature-factory-v2-tech-design.md` — factory-v2 tech design (system spec's reference implementation)
- `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` — factory-v2 product spec
- `docs/systems/agent-orchestration.md` — wider agent map
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake (parallel pipeline)

## Related Tasks / PRs

- Task `ba116063-382a-446c-ab91-c01b60d9a7c3` — Lobster worktree cleanup after merge (PR #208): the source of the post-merge worktree cleanup step in the `done` section above
- Task `a5a4ed8f-e7c4-4b6c-8ac9-bb962211ac44` — spec folder lifecycle and bookmark/feature lobster sync
- PR #259 — system spec gate moved from `[system-spec]` task comment to `## System Spec` PR body section (shipped 2026-07-19)
