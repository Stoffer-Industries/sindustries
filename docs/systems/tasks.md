# Tasks

**Type:** System reference (data plane + workflows)
**Last updated:** 2026-08-04
**Owner:** Rowan (engineering) · Quinn (workflow orchestration) · Tom (product)
**Repos:** `Stoffer-Industries/sindustries`
**App spec:** `apps/tasks/SPEC.md`

---

## Purpose

This doc is the single source of truth for everything task-shaped at Sindustries: the Tasks API (data plane and Tasks app), the shared task lifecycle, and the three workflows that orchestrate each `taskType` end-to-end (`feature`, `code`, `content`). Read it first when touching tasks API endpoints, task lifecycle rules, or any of the three workflow pipelines.

Cross-cutting references:

- `docs/systems/agent-orchestration.md` — wider agent map.
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake (parallel pipeline).
- `docs/systems/content-factory.md` — content factory context.

If you are looking for a workflow-specific subsystem (auto-post, content scheduler, etc.), prefer the matching system doc; this doc covers what is common to **every** task, not features that one workflow adds on top.

---

## Section index

1. [Architecture (Tasks API + Tasks app)](#architecture-tasks-api--tasks-app)
2. [Service boundary](#service-boundary)
3. [Data model](#data-model)
4. [Task lifecycle](#task-lifecycle)
5. [API surface](#api-surface)
6. [Consumers and runbook](#consumers-and-runbook)
7. [Workflows: feature / code / content](#workflows-feature--code--content)
8. [Shared workflow contract](#shared-workflow-contract)
9. [`.openclaw` boundary](#openclaw-boundary)
10. [Common failure modes](#common-failure-modes)
11. [Related specs, tasks, and PRs](#related-specs-tasks-and-prs)

---

## Architecture (Tasks API + Tasks app)

```
apps/tasks (React/Vite)
      │
      │ REST  http://localhost:4000 (dev)
      │       http://localhost:4001 (prodlike)
      ▼
services/tasks-api (Express + TypeScript)
      │
      │ Prisma ORM
      ▼
PostgreSQL
  sindustries_dev      (port 6432)
  sindustries_prodlike (port 7432)
```

The Tasks API is the single source of truth for task tracking. The frontend is a thin client — no local task state beyond a session's in-memory view.

---

## Service boundary

`services/tasks-api` owns task/workflow state only: tasks, comments, tags, dependencies, task lifecycle metadata, and workflow comments consumed by agents/lobsters.

It must not become the default backend for Mission Control or other apps. New product domains such as content scheduling/publishing, bookmarks, budget/finance, analytics, or agent incident reporting should expose their own service APIs and be called directly by the consuming apps/services. Budget/finance already has a separate service boundary in `services/budget-api`; related work should extend that service or justify a new finance-domain service, not land in `tasks-api`. Exceptions need an explicit service-boundary note in the tech design/PR explaining why the placement is temporary or domain-correct, plus an extraction path if temporary.

---

## Data model

### Task

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `title` | String | Required |
| `description` | Text | Nullable, rendered as markdown in UI |
| `status` | Enum | open, ready, doing, acceptance, done |
| `statusChangedAt` | Timestamp | Updated on every status change |
| `priority` | Enum | low, medium, high, urgent (default: medium) |
| `dueAt` | Timestamp | Nullable |
| `completedAt` | Timestamp | Set on → done, cleared on ← done |
| `assignee` | String | Reserved: Tom, Quinn, Rowan, Lox, Ivy |
| `archivedAt` | Timestamp | Soft delete |
| `blocked` | Boolean | True when unresolved `dependsOn` entries exist (manual flag) |
| `dependencyBlocked` | computed (not stored) | True when any `dependsOn` task has `status !== "done"` |
| `taskType` | Enum | content, code, research, feature (nullable) |
| `specChecksum` | String | Spec drift detection for feature tasks |
| `tags` | `TaskTag[]` | Ad-hoc, case-insensitive unique |
| `comments` | `TaskComment[]` | Agent durable comments + human notes |
| `dependencies` | `TaskDependency[]` | Blocking relationships |

`taskType` is the routing key: which workflow lobster picks the task up, which gates apply, which task-comment tags the workflow reads. Supported first-class values are `content`, `code`, `research`, `feature`. The Tasks app treats the same set as its shared type options for create, edit, and filtering surfaces. `feature` tasks are used by the feature-task workflow and must remain available through normal task create, read, update, and list paths.

The API validates the `taskType` filter against the same accepted task type set used by create and update validation, then applies an exact Prisma `taskType` filter in the list query. This keeps UI filtering and automation discovery aligned with persisted task metadata. Invalid filters return `400 INVALID_TASK_TYPE_FILTER`.

New task type values must be added consistently across API validation, app shared options, and workflow consumers before use. Automation that needs feature-task routing should prefer first-class `taskType: feature` over tag-only conventions.

### TaskComment

Agent communication channel and workflow state machine. Comments follow structured `[tag] value` patterns for machine-readable state. The full tag vocabulary spans all three workflows — see [Shared workflow contract](#shared-workflow-contract) for the canonical list.

### TaskDependency

Join table: `taskId → dependsOnId`. Cascade deletes on either side. Index on `dependsOnId` for reverse lookups.

Task responses include:

- `dependsOn` — array of `{ id, title, status, completedAt }` for each dependency
- `dependsOnIds` — flat array of dependency UUIDs
- `dependencyBlocked` — computed boolean, true when any dependency `status !== "done"`

`PATCH /tasks/:id` accepts `dependsOnIds`:

- Array of UUIDs replaces the full dependency set
- Empty array clears all dependencies
- Omitted field leaves dependencies unchanged

Validation rejects: non-UUID values, self-references, missing task IDs, archived dependencies, direct circular dependencies (A→B, B→A). Deep cycle detection is out of scope.

**CLI:** `tasks_api_client.py` exposes `--depends-on <id>` (repeatable) and `--clear-dependencies` (mutually exclusive) for automation.

---

## Task lifecycle

```
open → ready → doing → acceptance → done
         ↑__________________|
```

| Status | Meaning |
|---|---|
| `open` | Created, not yet ready for work |
| `ready` | Scoped and unblocked — available for pickup |
| `doing` | Actively being worked |
| `acceptance` | PR merged (code/feature) or delivered (content), awaiting Tom acceptance |
| `done` | Accepted and closed |

State transitions are enforced by convention, not database constraints. Quinn validates before advancing.

`blocked` and `dependencyBlocked` are independent: a task is visibly blocked when either is true. `completedAt` is set on → done and cleared on ← done. `statusChangedAt` is updated on every status change and powers Kanban board sorting (time-in-column).

The fluid AC lifecycle (spec drift re-approval flow) replaces the old hard-block on drift with a Tom-gated re-approval flow. See [Spec Checksum Safeguards](#spec-checksum-safeguards-factory-v2-last-grandfathered-edit) below.

---

## API surface

Base path: `/api/v1`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tasks` | List with filters: status, priority, assignee, tag, q, blocked, taskType, cursor |
| `POST` | `/tasks` | Create task |
| `GET` | `/tasks/:id` | Get task with comments, tags, dependencies |
| `PATCH` | `/tasks/:id` | Partial update — status, priority, assignee, tags, specChecksum, description, dependsOnIds |
| `DELETE` | `/tasks/:id` | Soft archive (sets archivedAt) |
| `GET` | `/tasks/:id/comments` | List comments |
| `POST` | `/tasks/:id/comments` | Add comment (drift-tolerant) |
| `GET` | `/tags` | List tags with usage counts |
| `GET` | `/health` | Health check |

**Spec drift guard:** `PATCH /tasks/:id` with `description` change rejects with `409 SPEC_CHECKSUM_MISMATCH` if the task's stored `specChecksum` differs from the recomputed checksum of the new AC JSON (sorted keys). Marker-only edits (toggling `**Approved by Tom**` from `[x]` to `[ ]` or vice versa with no AC text change) are exempt via `descriptionsDifferOnlyByApprovalMarker` in `services/tasks-api/src/routes/tasks/_spec.ts`. The Comments endpoint (`POST /tasks/:id/comments`) does **not** apply the drift guard — comments are meta-discussion, not scope changes.

**Cursor pagination:** `GET /tasks` returns a `nextCursor` token. Pass as `cursor=` to page. Default limit: 50.

---

## Consumers and runbook

| Consumer | Base URL | Use |
|---|---|---|
| `apps/tasks` (frontend) | `http://localhost:4000/api/v1` (dev) | Human task management UI |
| `agents/skills/ops/tasks-api/tasks_api_client.py` | `http://localhost:4001/api/v1` | Agent automation (Quinn heartbeat, Rowan workflow, feature factory) |
| `agents/workflows/feature-task/run.py` | `http://localhost:4001/api/v1` | Feature factory lobster orchestration |
| `agents/workflows/code-task/run.py` | `http://localhost:4001/api/v1` | Code-task lobster orchestration |
| `agents/workflows/content-tasks/run.py` | `http://localhost:4001/api/v1` | Content task lobster orchestration |

Agent tooling always targets **prodlike** (`4001`). The dev stack (`4000`) is for Rowan's implementation work only.

### Runbook

- **Schema migrations:** `services/tasks-api/prisma/migrations/`. Never write raw SQL. Always `prisma migrate dev` in dev first, then validate in prodlike. Duplicate migration prefixes are rejected by CI.
- **Seeding:** `scripts/dev/reset-db.sh` — dev only. Blocked on prodlike intentionally to protect the validation dataset.
- **Restart API after migration:** `make up MODE=prodlike` applies pending migrations on container start.
- **Spec drift rejection on PATCH:** returned as `409` with the stored vs. current checksum. Treat as scope drift: wait for Tom re-approval rather than hand-editing ACs. The lobster resync path is the exception (see [Spec Checksum Safeguards](#spec-checksum-safeguards-factory-v2-last-grandfathered-edit)).
- **Dependency appears blocked but `blocked` is false:** check `dependencyBlocked` — this is expected when an unfinished dependency exists. The two signals are independent.
- **PATCH rejects a dependency update:** inspect error code for self-reference, archived dependency, missing task ID, invalid UUID, or direct circular dependency.
- **Stale task comments mention an old PR:** read the latest task comments; lobster state may retain old `prUrls`. Current task comments and workstream fields are the source of truth.
- **Rowan queue says a `doing` implementation task is waiting externally:** that should only happen when the latest `[implementer-prs]` delivery still points exclusively at live open PRs that are genuinely waiting on review or CI. Closed-unmerged delivery comments remain `ACTIONABLE` until Rowan opens a replacement PR.
- **Malformed UUID on any path parameter:** `GET` / `PATCH` / `DELETE /tasks/:id` and `POST /tasks/:id/comments` now return `400 INVALID_TASK_ID` (PR #271). Pass full 36-char UUIDs; the 8-char lobster prefix is display-only.

---

## Workflows: feature / code / content

All three workflows reuse the same Rust binary (`agents/workflows/feature-task/`). The lobster YAML selects a smaller subset of subcommands and a smaller tag vocabulary. State comments persist `workflow: "<workflow-name>"` in the `[lobster-state]` block so the three pipelines stay distinguishable on re-runs.

### Feature-task workflow

Take approved feature tasks through implementation, review, merge, and post-merge cleanup without a bespoke Telegram approval flow. The workflow is the durable path Tom approves intent through and Rowan ships code through — feature work should land only when the GitHub review state is green and the system spec is in place.

#### Pipeline

```
ready ─────→ doing ─────→ acceptance ─────→ done
   ↓            ↓              ↓
blocked    in-flight       blocked (PR review)
   ↓            ↓              ↓
ready-      blocked        waiting
checks      (CI / spec)    (Tom approval)
```

The Lobster YAML composes the Rust CLI commands into status transitions. The Python wrapper discovers active tasks and runs the Lobster pipeline for each.

**`ready` — gate checks before implementation**

- Rust command: `feature-task ready-checks`
- Required to pass before `ready → doing`:
  - `taskType: feature` is set on the task
  - Linked product spec exists and is approved by Tom (sign-off recorded in spec or comment)
  - `[tech-design] <url>` task comment exists (durable first-class `tech_design_url` field is the eventual home)
  - `[tech-design-approved] true` task comment exists (Quinn writes this after Tom signs off)
  - No spec drift (`specChecksum` matches current AC JSON)
- Failed checks produce a task comment listing each failed criterion

**`doing` — implementation**

- **Owner:** Rowan, working on the agreed worktree branch
- All changes land via PR (no direct pushes to `main`)
- `[implementer-prs] <url>` task comment lists every open PR (legacy alias `[rowan-prs]` still accepted)
- `[openclaw-needed]` task comment if any `.openclaw` file edits are required (with proposed diff + rollback note) — Rowan does not touch `.openclaw/` directly
- PR body lists every parent task AC checked off with evidence annotations
- PR body includes a `## System Spec` section (see below) — a documentation convention, not a lobster gate
- When implementation is complete, post `[implementer-prs] <url>` task comment
- Rust command: `feature-task verify-delivery` runs after the `[implementer-prs]` signal to confirm PRs, CI state, and AC text

**`acceptance` — review and gate enforcement**

- Owner: Tom reviews the PR; Rowan addresses `CHANGES_REQUESTED` feedback on the same branch
- Required to pass before `acceptance → done`:
  - All PRs linked from `[implementer-prs]` are merged
  - GitHub review state on every linked PR is `APPROVED` (no `CHANGES_REQUESTED` outstanding)
  - CI on the merged commits is green
  - No `[openclaw-needed]` pending without matching `[openclaw-done]` from Quinn
  - `[qa-ac-verified] true` task comment from Tom
- Rust commands: `feature-task feedback-aggregate`, then `feature-task post-merge`

**`## System Spec` PR body section (documentation convention, not enforced):** PR authors note in the PR body whether `docs/systems/<file>.md` was written or updated, or give a short reason why not. The lobster does not parse or validate this section — it was removed (2026-07-26) after repeated regex gaps (the parser couldn't distinguish an actual declaration from an incidental mention of an existing doc, and had no way to validate declaration quality). Doc content is too varied to check reliably in code; system-spec upkeep is now judgment-based, checked by the reviewer, not the lobster. See `agents/skills/dev/pr-open/SKILL.md` for the canonical PR body template.

**AC text check (doing → acceptance, pre-merge):** before the lobster will let the task advance from `doing` to `acceptance`, it compares every task description AC against the **open** PR body. Every AC must appear in the PR body as a `- [x] **AC<N>` line — not a bullet, not `- [ ]`, not plain prose, not a `✅` emoji. The `- [x]` form is required because it is the only signal the lobster can machine-parse to confirm the AC is covered by this PR (or by a referenced merged predecessor PR on the same line, e.g. `PR #285`). The line must also carry an evidence annotation `(testID|not tested|not code|pr)` per `agents/skills/dev/pr-open/SKILL.md`. If an AC is missing, has altered text, lacks the checked-checkbox form, or lacks the evidence annotation, the transition is blocked with a `[feature-task-progress-checklist]` comment listing the specific failures — the task stays in `doing` until Rowan opens a fix PR that lists every AC verbatim with evidence. Tom may edit ACs in the task description during QA — spec drift does not block this gate (it is covered by the resync feature; see task b2ab54db). Rule added per Tom's 2026-07-25 21:12 NZST feedback after PR #296 shipped with ACs as bullets + ✅ emoji.

Note: prior versions of this workflow ran an equivalent AC text check at the `post-merge` stage (the "QA bounce") that moved a task back from `acceptance` to `doing` if the latest merged PR's AC text didn't match. That path was removed because it triggered after merge, forcing a wasteful revert + fix-PR round-trip. The check now runs pre-merge so mistakes are caught before the PR is merged.

**PR AC evidence formats:** the canonical process lives in `agents/skills/dev/pr-open/SKILL.md`. Do not duplicate the accepted-format list here; the Lobster parser and `pr-open` skill are the source of truth. Historical note: `file:` evidence was removed because agents used it to cite implementation files rather than tests.

**`done` — terminal**

- Lobster writes `done` after `post-merge` checks pass
- After moving to `done`, the lobster's `post-merge` stage runs a best-effort **worktree cleanup** that removes the Rowan feature worktree (e.g. `~/workspaces/rowan/sindustries-task-<8char-prefix>-<slug>`) registered with the primary `sindustries` worktree. The cleanup is idempotent (missing paths are no-ops) and non-fatal (a failure is logged via `[feature-task-progress-checklist]` but does not block `done`). Tracked as task `ba116063-382a-446c-ab91-c01b60d9a7c3`.

#### Feature-Task Lifecycle Analytics (task f170e344)

Feature-task lifecycle analytics is the durable, queryable record of what
happened to a feature task from creation to terminal state. Every gate
failure during the lifecycle emits a `gate_failure` event, and every
successful transition to `done` (or `accepted`, when added) emits a
single `terminal_summary` event. Tom and Quinn use the weekly aggregate
to spot quality vs capacity regressions, and the per-task replay to
audit a specific task's failure history.

##### Event types

| Event type | Fields (key ones) | Emitted from | Frequency |
|---|---|---|---|
| `gate_failure` | `taskId`, `eventKey`, `gate`, `cause` (`capacity` \| `quality`), `message` | `transition_or_block`, `block_with_manual_block` in the Rust CLI | One per failure string per gate run |
| `terminal_summary` | `taskId`, `eventKey`, `terminalStatus`, `completionTimestamp`, `totalGateFailureCount`, `capacityBlockCount`, `qualityFailureCount`, `prCycleTimeSeconds`, `evidenceTypeDistribution` | `post_merge` (after move to `done`) | One per terminal transition; idempotent on re-run via stable `eventKey` |

##### Failure classification

`classify_failure(gate, failure_text)` in `agents/workflows/feature-task/src/analytics.rs` maps a free-text gate failure string to `capacity` or `quality` using case-insensitive substring heuristics. Capacity covers implementer-capacity messages, dependency blocks, and manual blocks. Quality covers missing spec / approval / assignee / evidence, CI or check failures, review `changes_requested`, drift, malformed PR body, and system-spec regressions. Unknown failures default to `quality` so dashboards never undercount when a new failure mode ships without an update.

##### API surface (Tasks API)

The Tasks API owns the analytics events table and aggregation; the
feature-task workflow is a thin client.

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/feature-task-analytics/events` | Idempotent upsert by `eventKey`. Accepts a single event or a batch (max 500). Validates UUIDs and `eventType` / `cause` enums. |
| `GET  /api/v1/feature-task-analytics/tasks/:taskId/events` | Raw events in `(occurredAt, createdAt)` order for per-task replay. |
| `GET  /api/v1/feature-task-analytics/weekly?weeks=N` | Monday-start buckets with `terminalTaskCount`, `gateFailureCount` split into `capacityFailureCount` and `qualityFailureCount`, `gateFailureRate` (null when the denominator is zero), `medianPrCycleTimeSeconds`, `p90PrCycleTimeSeconds`, and `evidenceTypeDistribution`. Reuses the `flowMetrics.isoMonday()` convention from Mission Control. |

Backed by a new Prisma model `FeatureTaskAnalyticsEvent` with
`eventKey @unique` for idempotent writes, an index on `(taskId,
occurredAt)` for replay, and a `(weekStart, terminalStatus)` index for
the weekly aggregation.

##### CLI replay

`feature-task analytics replay --task-id <uuid>` prints a chronological
human-readable replay of one task's events. Returns a JSON envelope on
stdout that matches the rest of the CLI so callers can pipe through `jq`.
Non-zero exit only on invalid task IDs, unreachable API, or malformed
response; "no events" is a successful empty replay.

##### Dashboard

Mission Control renders a Feature Factory analytics panel under the Flow
dashboard (`apps/mission-control/src/tabs/FlowMetricsTab.jsx` →
`FeatureTaskAnalyticsPanel`). The panel shows:

- Summary cards for the last 8 weeks: terminal tasks, capacity failures,
  quality failures, and the gate-failure trend delta.
- Latest-active-week detail: gate failure rate, median PR cycle time,
  evidence-type summary.
- Weekly stacked bar chart (capacity vs quality failures).

All values are pure derivations of the Tasks API response — no charting
library, no new backend. Helpers live in `apps/mission-control/src/flowMetrics.js`
and are unit-tested in `flowMetrics.test.js`.

##### Operational guarantees

- **Fail-open emission.** The Rust workflow POSTs events best-effort. An
  analytics POST failure is logged to stderr and swallowed; the
  workflow never blocks on observability.
- **Idempotent writes.** Every event has a stable `eventKey` derived
  from `(taskId, gate, failure_hash, ordinal)` for `gate_failure` and
  `(taskId, "terminal", terminalStatus)` for `terminal_summary`.
  Re-running a stage or the terminal hook does not duplicate events.
- **Best-effort terminal summary.** If the GET that gathers the prior
  gate-failure counts fails, the terminal summary is still emitted with
  zero counts so downstream consumers always see a record. PR cycle
  time falls back to `null` when no PRs are merged or `gh` metadata is
  unavailable.

Lives in:
- `services/tasks-api/src/routes/featureTaskAnalytics.ts` — routes
- `services/tasks-api/prisma/schema.prisma` — `FeatureTaskAnalyticsEvent` model
- `agents/workflows/feature-task/src/analytics.rs` — emission + classification
- `agents/workflows/feature-task/src/main.rs` — wiring (`emit_gate_failure_events`, `emit_terminal_summary_event`, `analytics replay` subcommand)
- `apps/mission-control/src/tasksApi.js` — `fetchFeatureTaskAnalyticsWeekly`, `fetchFeatureTaskAnalyticsReplay`
- `apps/mission-control/src/flowMetrics.js` — pure panel helpers
- `apps/mission-control/src/tabs/FlowMetricsTab.jsx` — `FeatureTaskAnalyticsPanel`

---

### Code-task workflow

Code tasks track implementation work that changes existing code without adding a new product capability. They cover bug fixes, security hardening, maintenance, refactors, migrations, dependency work, and architecture/service-boundary corrections.

They are lighter than feature tasks: no product spec is required. They still need enough design and review to keep risky code changes visible.

#### Pipeline

```
open ──────→ ready ──────→ doing ──────→ acceptance ──────→ done
  ↓             ↓             ↓              ↓
blocked      blocked      in-flight      blocked (PR review)
  ↓             ↓             ↓              ↓
code-task-   code-task-   code-task-     code-task-
tech-        ready-       verify-        verify-
design-      checks       delivery       delivery
check
```

The lobster dispatches `taskType: code` tasks through `agents/workflows/feature-task/code-task.lobster.yaml`. The same Rust binary that runs the feature-task pipeline is reused; the YAML selects a smaller set of subcommands.

After the code-task lifecycle-specific gates, delivery verification uses the same `verify-delivery` stage as feature tasks. Code and feature tasks therefore share the same PR, acceptance-criteria, workstream, and handoff contract; only the product-spec lifecycle and optional tech-design gate differ.

The `open → ready → doing` jump is split into two stages so the tech-design gate and the assignee/capacity gate are visible separately (task `3ba96b5e`):

- `code-task-tech-design-check` gates `open → ready`. It only checks the tech design (or explicit waiver). A task with no assignee still advances to `ready` once its tech design is approved.
- `code-task-ready-checks` gates `ready → doing`. After the tech-design stage has moved the task to `ready`, this stage only checks for an assignee and assignee capacity. The tech-design check is no longer performed here.

The comment prefix on each stage is the signal that names which gate is open: `[code-task-tech-design-checklist]` for the tech-design stage, `[code-task-progress-checklist]` for the readiness stage. A blocker comment therefore tells the operator exactly which gate is still open without having to read the task code.

**Stage mapping**

| Code-task stage | Feature-task stage | Difference |
|---|---|---|
| `code-task-tech-design-check` | `ready_checks` (tech-design portion) | New stage (task `3ba96b5e`). Splits the old single `open → doing` jump into `open → ready → doing`. Only checks the tech design (or waiver). Transitions to `ready`. |
| `code-task-ready-checks` | `ready_checks` (assignee + capacity portion) | Tech-design check removed (moved to the preceding stage). Now only checks assignee + capacity. Transitions to `doing`. |
| `verify-delivery` | `verify_delivery` | Shared delivery gate; code tasks have no `specChecksum`, so the spec-drift check is a no-op |
| `feedback_aggregate` | `feedback_aggregate` | Reused unchanged |
| `post_merge` | `post_merge` | Reused unchanged; `archive_done_task_spec()` no-ops when no `**Spec:**` is present |

Progress-checklist comments use `[code-task-tech-design-checklist]` (tech-design gate), `[code-task-progress-checklist]` (assignee/capacity gate), and `[code-task-blocked]` tags (versus `[feature-task-progress-checklist]` and `[feature-task-blocked]`).

**When to use a code task**

Use `taskType: code` when the work:

- produces a PR that should be tracked;
- fixes or changes existing code with no new product capability;
- is too large/risky for direct assignment or code-garden;
- comes from a repo audit finding that is important but not code-garden-safe.

Examples:

- security hardening in an existing service;
- extracting misplaced backend code into the right service;
- database migration/backfill refactors;
- dependency upgrades with behavior or security implications;
- correctness fixes that change observable behavior but do not add a new capability.

Do not use a code task for:

- net-new user/product capability — use `feature`;
- investigation with no implementation PR yet — use `research`;
- tiny one-turn chores that do not need tracking;
- behavior-preserving cleanup that fits code-garden.

**Required task shape**

A code task must include:

- short problem statement;
- source link if created from an audit finding;
- why it is not code-garden-safe, when applicable;
- observable acceptance criteria;
- the standard `**Workstreams**` section used by feature tasks;
- assignee and relevant tags.

A product spec is not required.

**Tech design requirement**

A tech design is required for a code task when the work touches any of these:

- service boundaries or ownership;
- data ownership, migrations, backfills, or deletion risk;
- security posture, auth/authz, secrets, credentials, or external integrations;
- cross-service API contracts;
- substantial internal architecture/refactor decisions;
- runtime/language choices.

The tech design lives at `docs/specs/<slug>-tech-design.md` and is linked from the task via `[tech-design] <path-or-url>`.

Tech designs for code tasks do not require Tom product sign-off by default. Escalate for Tom/Quinn sign-off when the design involves security risk, data-loss risk, user-visible behavior changes, new external credentials, or architecture decisions that need human judgement.

**Audit follow-up ledger**

Repo audit findings should remain traceable in the audit document.

When an audit finding is important but not code-garden-safe:

1. Create the correct task type (`code`, `feature`, or `research`).
2. Link the task from the audit finding line.
3. Add a tech design if required.
4. When the implementation PR lands, update the same audit line with the PR link.

Ledger format:

```md
### [High] Example finding title ➡️ Tracked by task `abcd1234` (`abcd1234-...`)
```

After implementation:

```md
### [High] Example finding title ➡️ Tracked by task `abcd1234` (`abcd1234-...`) ✅ [PR #234](https://github.com/Stoffer-Industries/sindustries/pull/234)
```

If the task is created during the weekly audit, include the task link in the audit PR. If the task is created later, open a tiny docs-only audit-ledger PR to add the task link.

**Completion**

A code task implementation PR should:

- reference the task ID;
- list the task ACs and evidence;
- include validation results;
- update relevant `docs/systems/` docs, or include `[no-system-spec-change] <reason>`;
- update the source audit ledger line if the task came from an audit.

### Content-task workflow

Content tasks are dispatched by `agents/workflows/content-tasks/`. The dispatcher (`run.py`) discovers every active `taskType: content` task and runs `content-task.lobster.yaml` once per task. The pipeline is Python-driven (no Rust binary) because content work runs in Ivy's workspace rather than the Sindustries repo.

Capacity-gate behaviour: while one content task is in `doing`, additional `ready` content tasks are blocked from auto-promotion until the `doing` one moves. The gate is `ivyCapacityLimit` (default 1) and is enforced inside `capacity_transition.py`.

### Heartbeat responsibilities (all three workflows)

| Agent | Step | What it does |
|---|---|---|
| Quinn | LOBSTER CHECK | Runs `run.py` for each workflow, reports only failures / blocked gates / meaningful transitions |
| Quinn | OPENCLAW HANDOFF | Scans active tasks for `[openclaw-needed]` and posts `[openclaw-done]` after applying |
| Rowan | TASK DISCOVERY | Lists active tasks assigned to Rowan |
| Rowan | TECH DESIGN | Writes `docs/specs/<task-slug>-tech-design.md` and posts `[tech-design]` task comment (when `ready`) |
| Rowan | IMPLEMENTATION | Implements on the worktree branch; `[implementer-prs]` once PRs are open |
| Rowan | PR FEEDBACK | Stays in `acceptance` while addressing `CHANGES_REQUESTED` on the same branch |

---

## Shared workflow contract

The three workflows share the same Rust binary (feature + code). Gate approvals are first-class `TaskApproval` resources and never fall back to comments or description markers. Comments remain durable links, workflow signals, and human-readable audit history only.

### Tag vocabulary (consolidated)

| Tag | Owner | Workflow | Purpose |
|---|---|---|---|
| `[tech-design] <url>` | Rowan | feature, code | Tech design URL |
| `[tech-design-not-required] <reason>` | Rowan | code | Code task with no tech design |
| `[implementer-prs] <url>` | Rowan | feature, code | PRs implementing this task (`[rowan-prs]` legacy alias still accepted) |
| `[openclaw-needed] <reason>` | Rowan | feature, code | Flag a `.openclaw` change for Quinn |
| `[openclaw-done] <summary>` | Quinn | feature, code | `.openclaw` change applied |
| `[system-spec] docs/systems/<file>.md` | Rowan | feature, code | System spec path (legacy convention, not parsed by the lobster) |
| `[no-system-spec-change] <reason>` | Rowan | feature, code | Declares no system doc change needed (legacy convention, not parsed by the lobster) |
| `[spec-resynced] <summary>` | Lobster | feature | Drift resync: `checksum=<sha256>` + `driftFingerprint=<sha256>` |
| `[feature-task-progress-checklist] ...` | Lobster | feature | Gate failure fingerprint; pre-merge AC text failures also land here |
| `[code-task-progress-checklist] ...` | Lobster | code | Gate failure fingerprint (assignee + capacity gate) |
| `[code-task-tech-design-checklist] ...` | Lobster | code | Gate failure fingerprint (tech-design gate, task `3ba96b5e`) |
| `[feature-task-blocked] ...` | Lobster | feature | Block reason while in `ready` / `doing` / `acceptance` |
| `[code-task-blocked] ...` | Lobster | code | Block reason while in `ready` / `doing` / `acceptance` |
| `[lobster-state] { ... }` | Lobster | all | Reconciler state — `version`, `last_orchestrated_at`, gate outcomes, `workflow` |
| `[scope-add] <summary>` | Quinn / Tom | feature | Document a scope change after spec approval (used in factory-v2 grandfathering) |

`blocked` is not a separate workflow status — it is an annotation in the lobster state comment that explains why the transition is being held. The task record `status` remains `ready` / `doing` / `acceptance`; only the lobster state carries the blocking reason.

### Structured approval and authentication contract

`TaskApproval` is the only source of truth for `spec`, `tech_design`, and `qa` gates. Missing or revoked rows fail closed. Legacy `[tech-design-approved] true`, `[qa-ac-verified] true`, and checked `Approved by Tom` text remain historical data only and cannot grant a runtime gate.

Browser approval writes require a durable login session:

- `POST /api/v1/auth/session` verifies a configured scrypt password hash, creates a database-backed session, and sets the opaque `tasks_api_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production).
- `GET /api/v1/auth/session` resolves the current actor.
- `DELETE /api/v1/auth/session` revokes the session and clears the cookie.

Agent writes use `Authorization: Bearer <service-token>` with a separately scoped credential. The server derives actor and authorization; clients cannot submit `owner`. Initial policy is Tom → `spec`/`qa`, Quinn → `tech_design`. Session tokens are stored only as SHA-256 hashes and expire according to `TASKS_API_APPROVAL_SESSION_TTL_SECONDS`.

Approval POST/DELETE and their ordinary audit comment execute in one Prisma transaction. A real transition creates exactly one comment (`Approval <type> approved|revoked by <actor>.`); identical POST and absent/already-revoked DELETE are no-ops with no duplicate history. Archived and `done` tasks are immutable.

---

## `.openclaw` boundary

The `.openclaw/` directory is outside this repo. Any required `.openclaw` change is flagged from the primary repo via `[openclaw-needed]` and applied by Quinn. Rowan must not edit `.openclaw/` files directly; doing so violates the documented permission boundary.

---

## Spec Checksum Safeguards (factory-v2 last grandfathered edit)

After a structured `spec` approval is granted, the task record stores `specChecksum` (sha256 of the canonical AC JSON with sorted keys). The brain spec remains the AC source of truth in `open`; the task description is the source of truth in every later status. Legacy markdown markers may still be manipulated by the drift-resync compatibility machinery, but they do not grant the spec gate—the `TaskApproval` row does.

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

`open` status always uses the brain spec ACs as source of truth. The open → ready approval gate requires an approved structured `spec` row. Checked markdown in the brain spec or task description cannot satisfy it. Drift marker compatibility machinery only runs for later-state resync bookkeeping.

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

- `open` status: brain spec ACs win. Structured `spec` approval is required; legacy marker state is ignored by the gate. Drift against the stored checksum is treated as a blocker.
- `ready`, `doing`, `acceptance`, `done`: task description wins. Lobster reflects drift via the marker, then resyncs the brain spec to match after Tom re-checks approval.

### Spec folder lifecycle

Feature specs use a forward-only file lifecycle under `brain/tasks/specs/`:

- `brain/tasks/specs/open/` — new chat-created feature specs awaiting Tom's structured `spec` approval. New templates do not add an approval marker.
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

## Cron behaviour

- **Cron prompt:** `agents/crons/prompts/feature-task-workflow.md` (and parallel cron prompts for code-task + content-task workflows)
- **Schedule:** runs on Quinn heartbeat tick (every 30 min) via each workflow's `run.py`
- **Idempotency:** the reconciler pattern means reruns are safe — `[lobster-state]` carries the last orchestration timestamp and outcome
- **No `wait_for`:** the workflow must not block; gates are evaluated against current GitHub / Tasks API state, then the lobster writes the next state or no-ops

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `ready → doing` blocked | Missing structured `tech_design` approval or `specChecksum` drift | Quinn grants `tech_design` through the authenticated API; for drift, follow the resync path |
| `[openclaw-needed]` never resolved | Quinn missed the heartbeat step | Quinn scans active tasks on the next heartbeat tick |
| Spec checksum mismatch | ACs edited after spec approval | Hits `PATCH /tasks/:id` when the description ACs change. Treat as spec drift: Lobster unchecks `**Approved by Tom**`, waits for Tom to re-check, then performs the resync path. Comments are drift-tolerant and remain usable for progress/checklist/resync signals. |
| Spec lifecycle layout failure | Unexpected direct subdirectory under `brain/tasks/specs/` | Remove or migrate the unexpected subdir so only `open/`, `in-progress/`, and `done/` remain. The lobster creates missing expected dirs automatically. |
| Stale `**Spec:**` line after a move | Prior run moved a spec but failed before patching the task description | Re-run the relevant lobster stage; move helpers treat destination-present/source-absent as idempotent and repair the task `**Spec:**` path. |
| `PATCH` succeeds despite stale ACs | Other event types (status change, dependency add, tag edit) don't re-check the checksum | Pass the updated `description` through `PATCH /tasks/:id` first so the drift check fires there. |
| CI green but PR not merged | Reviewer has not approved | Wait for `APPROVED` review state; Lobster will not mark `done` until GitHub merge is recorded |
| Task bounced to `doing` from `acceptance` | (legacy — the post-merge QA bounce path was removed; AC text mismatches now block at the doing → acceptance gate before merge instead) | n/a |
| `doing → acceptance` blocked on AC text | Open PR body is missing an AC, has altered AC text, or lacks a valid evidence annotation `(testID|not tested|not code|pr)` | Update the PR body so every task AC appears verbatim with evidence; `[feature-task-progress-checklist]` comment lists the specific failures |
| `acceptance → done` blocked on structured QA approval | Tom has not signed off | Tom grants `qa` in the Tasks UI after verifying ACs on staging |
| `400 INVALID_TASK_ID` on `GET` / `PATCH` / `DELETE /tasks/:id` or `POST /tasks/:id/comments` | Path id is not a full 36-char UUID | Pass full UUIDs from `data[].id` in `/api/v1/tasks?…` responses; the 8-char lobster prefix is display-only |

---

## Key files

| File | Role |
|---|---|
| `services/tasks-api/prisma/schema.prisma` | Tasks API persistence — `Task`, `TaskComment`, `TaskDependency`, `TaskTag`; `specChecksum`, `taskType` |
| `services/tasks-api/src/routes/tasks.ts` | REST routes (`/tasks`, `/tasks/:id`, `/tags`, `/health`) |
| `services/tasks-api/src/routes/tasks/_spec.ts` | Canonical AC checksum, marker-only exception (`descriptionsDifferOnlyByApprovalMarker`), drift detection |
| `services/tasks-api/src/app.ts` | App wiring (middleware, CORS, route mounting) |
| `agents/workflows/feature-task/src/main.rs` | Rust CLI — task parsing, gate enforcement, idempotent reconciliation, drift-aware resync |
| `agents/workflows/feature-task/Cargo.toml` | Crate manifest, deps (`serde`, `serde_json`, `ureq`, `clap`, `toml`) |
| `agents/workflows/feature-task/feature-task.lobster.yaml` | Feature-task Lobster pipeline |
| `agents/workflows/feature-task/code-task.lobster.yaml` | Code-task Lobster pipeline (subset of feature-task commands) |
| `agents/workflows/feature-task/run.py` | Feature-task dispatcher — discovers active `feature` + `code` tasks and runs the right Lobster YAML per task |
| `agents/workflows/content-tasks/run.py` | Content-task dispatcher — discovers active `content` tasks and runs the content-task Lobster YAML |
| `agents/workflows/content-tasks/content-task.lobster.yaml` | Content-task Lobster pipeline (Python-driven) |
| `agents/crons/prompts/feature-task-workflow.md` | Cron prompt for the feature-task dispatcher |
| `agents/skills/dev/tech-design/SKILL.md` | Authoring guide for tech designs |
| `agents/skills/dev/system-spec/SKILL.md` | Authoring guide for system specs (this file is one) |
| `agents/skills/dev/pr-open/SKILL.md` | Canonical PR body template (`## System Spec` section, AC evidence format) |
| `agents/skills/ops/tasks-api/tasks_api_client.py` | Agent CLI wrapper for the Tasks API |
| `docs/specs/<task-slug>-tech-design.md` | Per-task tech design, branch URL recorded as `[tech-design]` task comment |
| `docs/systems/<system>.md` | Per-system spec; committed on the implementation branch and declared in the PR body's `## System Spec` section |

---

## Key scripts / commands

| Command | Stage | Notes |
|---|---|---|
| `cargo run -- load-task` | any | Fetch + normalize a single feature or code task |
| `cargo run -- spec-check` | `ready` gate | Product spec link + Tom approval + specChecksum verification |
| `cargo run -- ready-checks` | `ready` gate | Tech design gate + spec drift |
| `cargo run -- verify-delivery` | `doing` gate | PR list + CI status + AC checklist presence |
| `cargo run -- feedback-aggregate` | `acceptance` gate | Aggregates `CHANGES_REQUESTED` feedback to Rowan |
| `cargo run -- post-merge` | `done` gate | Verifies all PRs merged + post-merge CI green + system spec |
| `agents/workflows/feature-task/run.py` | dispatcher | One-tick invocation: discovers active `feature` and `code` tasks and runs the Lobster pipeline per task |
| `agents/workflows/content-tasks/run.py` | dispatcher | One-tick invocation: discovers active `content` tasks and runs the content-task Lobster pipeline per task |

### Terminal invocation

Run the normal dispatcher, which discovers active `feature` and `code` tasks and invokes the right Lobster YAML once per task:

```bash
cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  agents/workflows/feature-task/run.py --dry-run
```

Run one specific feature-task Lobster pipeline directly. If `lobster` is not on your shell `PATH`, use the OpenClaw-managed binary at `/Users/quinnstoffer/.openclaw/tools/node-v24.15.0/bin/lobster` or temporarily prepend that directory to `PATH`:

```bash
cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
export PATH="/Users/quinnstoffer/.openclaw/tools/node-v24.15.0/bin:$PATH"
lobster run --mode tool agents/workflows/feature-task/feature-task.lobster.yaml \
  --args-json '{"taskId":"TASK_ID_HERE","tasksApiBaseUrl":"http://localhost:4001/api/v1","sindustriesRepo":"/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries","workspaceRoot":"/Users/quinnstoffer/.openclaw/workspace","dryRun":true}'
```

Swap `feature-task.lobster.yaml` for `code-task.lobster.yaml` when manually targeting a `taskType: code` task. Swap `agents/workflows/feature-task/run.py` for `agents/workflows/content-tasks/run.py` when manually targeting a `taskType: content` task. Set `"dryRun":false` only when you want the run to write task status/comments.

Dry runs still return the gate result on stdout. Checklist-style blockers appear in the JSON envelope's `failures` array and `actionTaken` field, but dry runs do **not** post the `[feature-task-progress-checklist]` task comment. Non-dry runs both return the same failure envelope and write the task comment when the failure fingerprint is new.

For a readable terminal checklist across every active feature/code task, use a temporary formatter script rather than a fragile one-line Python command:

```bash
cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
export PATH="/Users/quinnstoffer/.openclaw/tools/node-v24.15.0/bin:$PATH"

cat > /tmp/feature_factory_format.py <<'PY'
import json, sys

data = json.load(sys.stdin)
print(f"Feature factory dry-run: {data.get('count', 0)} task(s)")

for result in data.get('results', []):
    env = result.get('envelope') or {}
    outputs = env.get('output') or []
    final = outputs[-1] if outputs else {}
    task = final.get('task') or {}
    failures = final.get('failures') or []

    title = task.get('title') or '(title unavailable)'
    status = task.get('status') or '?'
    action = final.get('actionTaken') or '?'
    icon = '✅' if not failures and final.get('criteriaMet') else '⚠️'

    print(f"\n{icon} {title}")
    print(f"   {result.get('taskId')} · status={status} · action={action}")

    if failures:
        print('   Missing / blocked:')
        for failure in failures:
            print(f"   - {failure}")
    else:
        print('   No checklist blockers.')
PY

TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/workflows/feature-task/run.py --dry-run 2>/dev/null \
  | python3 /tmp/feature_factory_format.py
```

---

## Related specs, tasks, and PRs

### Specs

- `docs/specs/feature-factory-v2-tech-design.md` — factory-v2 tech design (system spec's reference implementation)
- `brain/bookmarks/specs/feature-factory-v2-2026-06-04.md` — factory-v2 product spec
- `docs/specs/code-task-lobster-extension-tech-design.md` — code-task workflow tech design
- `docs/specs/spec-resync-fluid-ac-lifecycle-tech-design.md` — fluid AC lifecycle tech design
- `docs/systems/agent-orchestration.md` — wider agent map
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake (parallel pipeline)
- `docs/systems/content-factory.md` — content factory context
- `docs/specs/tasks-one-pager.md` — high-level summary of the task system
- `apps/tasks/SPEC.md` — Tasks app behavioural spec and e2e coverage map

### Tasks / PRs

- Task `ba116063-382a-446c-ab91-c01b60d9a7c3` — Lobster worktree cleanup after merge (PR #208): the source of the post-merge worktree cleanup step in the feature-task `done` section above
- Task `a5a4ed8f-e7c4-4b6c-8ac9-bb962211ac44` — spec folder lifecycle and bookmark/feature lobster sync
- Task `b2ab54db` — fluid AC lifecycle (drift re-approval flow)
- Task `f77b7a60-225c-445c-b3d9-042e38a86cde` — initial implementation of the code-task lobster extension (PR #276)
- Task `f520c396-9664-4210-b149-180371dc8a53` — GymTrack Agent-Powered Workouts (PR #285, PR #296): planned_workouts schema + HMAC-signed agent endpoints for workout history + per-exercise progression. MVP behaviour in `apps/gymtrack/SPEC.md`; agent-specific schema/endpoints in the PR #285 + #296 migrations.
- Task `f170e344-ea5f-4443-bebb-035948686fc1` — Post-Merge Feature Factory Analytics (tech design approved, impl pending capacity): analytics row writes at post-merge for the factory flow dashboard.
- PR #145 — first-class `taskType` field on tasks (the foundation of routing)
- PR #259 — system spec gate moved from `[system-spec]` task comment to `## System Spec` PR body section (shipped 2026-07-19)
- PR #296 — surfaced two gaps in the `## System Spec` gate: the regex matched an incidental doc mention as a declaration, and the gate had no equivalent check for `apps/*/SPEC.md`
- Removed the `## System Spec` PR-body gate entirely (2026-07-26, Tom: "docs are too vague to enforce with checks/code") rather than patching the regex — `verify_delivery` no longer reads or blocks on this section; it is reviewer-judgment only going forward
- PR #271 — `400 INVALID_TASK_ID` on malformed path UUIDs (`get`/`patch`/`delete`/`POST /comments`), shipped 2026-07-21