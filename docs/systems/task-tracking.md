# Task Tracking

**Type:** System reference
**Last updated:** 2026-06-30
**Owner:** Quinn (state transitions) · Rowan (code)
**Repos:** `Stoffer-Industries/sindustries`
**App spec:** `apps/tasks/SPEC.md`

---

## Purpose

The task tracking system is the central coordination layer for all work at Sindustries. It stores tasks, comments, tags, and dependencies in a PostgreSQL database exposed via a REST API, and provides a web UI (`apps/tasks`) for human interaction.

Agents read and write tasks through the Tasks API. Quinn is the only agent that changes task state. Rowan and Ivy open PRs and post comments — they do not touch status or completedAt.

---

## Architecture

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

The API is the single source of truth. The frontend is a thin client — no local task state beyond a session's in-memory view.

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
| `acceptance` | PR merged, awaiting Tom acceptance |
| `done` | Accepted and closed |

State transitions are enforced by convention, not database constraints. Quinn validates before advancing.

**`blocked` flag** — manually set by humans or workflow automation. Independent of `dependencyBlocked`.

**`dependencyBlocked`** — computed (not stored). True when any `dependsOn` task has `status !== "done"`. A task is visibly blocked when either `blocked` or `dependencyBlocked` is true.

**`completedAt`** — set when status transitions to `done`, cleared on transition away from `done`.

**`statusChangedAt`** — updated on every status change. Used for Kanban board sorting (time-in-column).

---

## Data model

### Task

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| title | String | Required |
| description | Text | Nullable, rendered as markdown in UI |
| status | Enum | open, ready, doing, acceptance, done |
| statusChangedAt | Timestamp | Updated on every status change |
| priority | Enum | low, medium, high, urgent (default: medium) |
| dueAt | Timestamp | Nullable |
| completedAt | Timestamp | Set on → done, cleared on ← done |
| assignee | String | Reserved: Tom, Quinn, Rowan, Lox, Ivy |
| archivedAt | Timestamp | Soft delete |
| blocked | Boolean | True when unresolved dependsOn entries exist |
| taskType | Enum | content, code, research, feature (nullable) |
| specChecksum | String | Spec drift detection for feature tasks |
| tags | TaskTag[] | Ad-hoc, case-insensitive unique |
| comments | TaskComment[] | Agent durable comments + human notes |
| dependencies | TaskDependency[] | Blocking relationships |

### TaskComment

Agent communication channel and workflow state machine. Comments follow structured `[tag] value` patterns for machine-readable state:

| Tag | Writer | Meaning |
|---|---|---|
| `[tech-design]` | Rowan | Links to tech design doc |
| `[tech-design-approved]` | Quinn | Approves design for implementation |
| `[system-spec]` | Rowan | Links to system doc updated for this task |
| `[no-system-spec-change]` | Rowan | Declares no system doc change needed (with reason) |
| `[feature-task-progress-checklist]` | Rowan | PR checklist status |
| `[openclaw-needed]` | Rowan | Requests Quinn apply `.openclaw/` change |
| `[openclaw-done]` | Quinn | Confirms `.openclaw/` change applied |

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

## API surface

Base path: `/api/v1`

| Method | Path | Purpose |
|---|---|---|
| GET | /tasks | List with filters: status, priority, assignee, tag, q, blocked, taskType, cursor |
| POST | /tasks | Create task |
| GET | /tasks/:id | Get task with comments, tags, dependencies |
| PATCH | /tasks/:id | Partial update — status, priority, assignee, tags, specChecksum, etc. |
| DELETE | /tasks/:id | Soft archive (sets archivedAt) |
| GET | /tasks/:id/comments | List comments |
| POST | /tasks/:id/comments | Add comment |
| GET | /tags | List tags with usage counts |
| GET | /health | Health check |

**Spec drift guard:** PATCH with `specChecksum` rejects if the task's stored checksum differs. Rowan must resolve spec drift before patching.

**Cursor pagination:** `GET /tasks` returns a `nextCursor` token. Pass as `cursor=` to page. Default limit: 50.

---

## Consumers

| Consumer | Base URL | Use |
|---|---|---|
| `apps/tasks` (frontend) | `http://localhost:4000/api/v1` (dev) | Human task management UI |
| `agents/skills/ops/tasks-api/tasks_api_client.py` | `http://localhost:4001/api/v1` | Agent automation (Quinn heartbeat, Rowan workflow, feature factory) |
| `agents/workflows/feature-task/run.py` | `http://localhost:4001/api/v1` | Feature factory lobster orchestration |
| `agents/workflows/content-tasks/run.py` | `http://localhost:4001/api/v1` | Content task lobster orchestration |

Agent tooling always targets **prodlike** (`4001`). The dev stack (`4000`) is for Rowan's implementation work only.

---

## Runbook notes

**Schema migrations:** `services/tasks-api/prisma/migrations/`. Never write raw SQL. Always `prisma migrate dev` in dev first, then validate in prodlike. Duplicate migration prefixes are rejected by CI.

**Seeding:** `scripts/dev/reset-db.sh` — dev only. Blocked on prodlike intentionally to protect the validation dataset.

**Restart API after migration:** `make up MODE=prodlike` applies pending migrations on container start.

**Common failure: spec drift rejection:** PATCH returns 409 when `specChecksum` doesn't match. Rowan reads current specChecksum from `GET /tasks/:id`, compares to local spec, resolves drift, then retries PATCH.

**Dependency appears blocked but `blocked` is false:** check `dependencyBlocked` — this is expected when an unfinished dependency exists. The two signals are independent.

**PATCH rejects a dependency update:** inspect error code for self-reference, archived dependency, missing task ID, invalid UUID, or direct circular dependency.

**Stale task comments mention an old PR:** read the latest task comments; Lobster state may retain old `prUrls`. Current task comments and workstream fields are the source of truth.

---

## Related

- `apps/tasks/SPEC.md` — app behavioural spec and e2e coverage map
- `docs/systems/feature-task-workflow.md` — how feature tasks flow through the pipeline
- `docs/systems/content-factory.md` — how content tasks are orchestrated
- `agents/skills/ops/tasks-api/tasks_api_client.py` — agent CLI wrapper
