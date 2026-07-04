# Tasks App One-Pager Spec

> ⚠️ **SUPERSEDED.** This V1 spec is preserved for historical reference but no longer reflects the current status flow, data model, or API surface. The actual source of truth is **`docs/systems/task-tracking.md`** (status lifecycle, data model, API contract, consumers, runbook). The status enum listed here (`todo`, `doing`, `done`) was replaced by `open → ready → doing → acceptance → done`; many other details (comments, tags, dependencies, specChecksum, taskType, assignee allowlist) have also moved on. New work should consult `docs/systems/task-tracking.md` instead.
>
> Original V1 spec retained below for context.

> Canonical source of truth for Tasks App scope and milestones.
> Any derived docs (handoffs, status summaries, PR notes) must reference this file and must not redefine milestones.


## 1) Problem / Why now
Tom needs a focused, low-friction task management surface that helps him and future collaborators capture, prioritize, and complete work without getting trapped in heavyweight project tooling. Right now, the repo has architecture scaffolding but no implemented product surface. Building `apps/tasks` as the first concrete surface creates immediate utility and validates the monorepo architecture early.

Why now:
- The repository is intentionally spec-first and implementation is deferred; this is the right point to lock requirements before coding.
- `tasks` is the Phase 1 product surface in this repo; defining it unblocks small, mergeable delivery across Stoffer Industries.
- A clear V1 scope reduces rework and protects against feature creep.

## 2) Users & primary jobs-to-be-done
### Primary users
- **Tom (owner/operator):** needs a personal + business execution system.
- **Internal collaborators (agents/team):** will use the task tracker to collaborate around delivering value incrementally.

### Jobs-to-be-done
- Quickly capture tasks before context is lost.
- See what matters now (prioritized, due-soon, overdue).
- Progress tasks through a simple lifecycle.
- Track ownership and basic metadata (priority, due date, tags/project).
- Retrieve tasks via lightweight filtering/search.

## 3) Locked decisions (Tom/Quinn)
1. **V1 auth:** no auth for now (internal/single-user mode).
2. **API service location:** `services/tasks-api`.
3. **Database topology:** single Postgres instance for monorepo initially, with service-owned schema boundaries.
4. **Kanban:** required in V1, including drag-and-drop board interactions.
5. **V1 views:**
   - All-tasks backlog list with filters, sorted by priority.
   - Kanban board sorted by time-in-status per column.
6. **Statuses in V1:** `todo`, `doing`, `done` (no `blocked` in V1).
7. **Delete behavior:** archive-only in V1 (soft delete semantics).
8. **Assignee representation:** free-text in V1.
9. **Testing baseline in V1:** API integration tests, FE component tests for list/board, and 1 E2E happy path.
10. **Interface strategy:** REST-first; CLI deferred.

## 4) Scope (V1) and Non-goals
### In scope (V1)
- Create, read, update, archive tasks.
- Task fields: title, description, status, priority, due date, assignee (free-text), tags, created/updated timestamps.
- Two required views:
  - Backlog list (all tasks) with filters, sorted by priority.
  - Kanban board with drag-and-drop; each status column sorted by time-in-status.
- Status flow: `todo -> doing -> done`.
- Backend REST API with server-side validation.
- Postgres persistence via Prisma.

### Non-goals (V1)
- No authentication/authorization system in V1 (internal mode only).
- No realtime collaboration/presence.
- No recurring tasks.
- No notifications/reminders engine.
- No complex workflow engine/custom status schemas.
- No external integrations (Slack/email/calendar/Jira/etc.).
- No CLI surface in V1 (deferred).
- No mobile-native app (web app only via Vite+React).

## 5) Assumptions
- Single workspace/tenant for initial release.
- Internal/single-user mode is acceptable for V1.
- Expected data volume is modest in V1 (<100k tasks), manageable on single Postgres instance.
- Primary interaction is browser-based; responsive desktop-first UX.
- Tasks app frontend lives in `apps/tasks`; API lives in `services/tasks-api`.

## 6) Functional requirements
1. **Task creation** with required `title`; optional metadata.
2. **Task listing** with pagination, sorting, and filters:
   - status
   - priority
   - due date window
   - assignee (free-text)
   - tag
3. **Task detail retrieval** by id.
4. **Task update** (partial updates supported).
5. **Status transitions** between allowed states (`todo`, `doing`, `done`).
6. **Archive behavior**:
   - Archive-only in V1 (no hard delete endpoint).
7. **Basic text search** on title/description (can be simple `ILIKE` initially).
8. **Validation + error handling** with clear client-facing errors.
9. **Audit timestamps** (`createdAt`, `updatedAt`, optional `completedAt`, plus `statusChangedAt` for board ordering).

## 7) UX flow (simple)
1. User lands on **Backlog List** (all non-archived tasks), default sorted by priority.
2. User clicks **New Task** -> enters title + optional fields -> saves.
3. Task appears in backlog list immediately.
4. User switches to **Kanban Board** and drags task across `todo`, `doing`, `done`.
5. Within each board column, tasks are sorted by time-in-status.
6. User opens task detail drawer/page -> edits metadata, changes status.
7. User archives task from detail view.

UX principles for V1:
- Minimize clicks for capture/edit.
- Clear visual status/priority cues.
- Fast list/board interactions over heavy page transitions.

## 8) Data model (high-level entities/fields)
### `Task`
- `id` (uuid)
- `title` (string, required)
- `description` (text, nullable)
- `status` (enum: `todo | doing | done`)
- `statusChangedAt` (timestamp, required; used for board ordering)
- `priority` (enum: `low | medium | high | urgent`)
- `dueAt` (timestamp, nullable)
- `completedAt` (timestamp, nullable)
- `assignee` (string, nullable; free-text)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)
- `archivedAt` (timestamp, nullable)

### `Tag`
- `id` (uuid)
- `name` (string, unique in scope)
- `createdAt` (timestamp)

### `TaskTag` (join table)
- `taskId`
- `tagId`

## 9) API surface (minimal endpoints)
Base path: `/api/v1`

- `POST /tasks` — create task
- `GET /tasks` — list tasks (filters, search, pagination/sorting)
- `GET /tasks/:id` — get task detail
- `PATCH /tasks/:id` — update task fields/status
- `DELETE /tasks/:id` — archive task (soft delete)
- `GET /tags` — list tags
- `POST /tags` — create tag

Query params for `GET /tasks` (minimal):
- `status`, `priority`, `assignee`, `tag`, `q`, `dueBefore`, `dueAfter`, `limit`, `cursor`, `sort`

Notes:
- REST is the first-class interface in V1.
- CLI commands are explicitly deferred.

## 10) Architecture (how Vite/React + Express + Prisma + Postgres fit)
- **Frontend (`apps/tasks`)**: Vite + React SPA for task capture, backlog list, and kanban interactions.
- **Backend (`services/tasks-api`)**: Express REST API handling validation, business rules, and response shaping.
- **Data access**: Prisma client in service layer; schema + migrations define Task/Tag models.
- **Database**: single Postgres instance for monorepo initially, with service-owned schema boundaries.

Request flow:
`React UI -> Express route/controller -> service/domain layer -> Prisma -> Postgres -> response -> UI state update`

Boundary guidance:
- Keep app-specific logic in `apps/tasks` and `services/tasks-api`.
- Move only truly reusable types/helpers to `packages/`.

## 11) Security/privacy considerations
- Internal/single-user mode in V1 (no auth), but keep future auth boundary clear in service architecture.
- Validate and sanitize all input server-side.
- Enforce least-privilege DB credentials.
- Avoid exposing internal errors/stack traces in API responses.
- Archive-only deletion to reduce accidental data loss.
- Log access and mutation events with request correlation IDs.

## 12) Observability + operational considerations
- Structured logs (JSON) in API service.
- Request metrics: latency, error rate, throughput per endpoint.
- Health endpoints: liveness/readiness.
- Prisma migration discipline (versioned and deterministic).
- Seed script for local/dev bootstrap.
- Basic backup/restore posture documented for Postgres.

## 13) Risks/tradeoffs
- **No-auth V1 risk:** fastest path now, with expected auth retrofit later.
- **Simple search tradeoff:** `ILIKE` is fast to ship but may degrade at scale.
- **Three-status model tradeoff:** clarity/simplicity now, less expressive workflow semantics.
- **Archive-only accumulation:** safer operations but requires future retention/cleanup strategy.

## 14) Milestones (small, mergeable)
1. **M1: Schema + foundation**
   - Prisma models, migration, seed, service skeleton, and baseline tests wired.
2. **M2: Read API + backlog list**
   - `GET /tasks`, `GET /tasks/:id`, `GET /tags` + list UI with filters/sorting.
3. **M3: Write API + board interactions**
   - `POST /tasks`, `PATCH /tasks/:id`, archive endpoint, drag-and-drop status updates.
4. **M4: UI implementation against ACs**
   - Build `apps/tasks` frontend against `services/tasks-api`.
   - Deliver backlog list view with required filters + priority sorting.
   - Deliver kanban board (`todo`/`doing`/`done`) with drag-and-drop status transitions.
   - Deliver create/update/archive task flows from UI.
5. **M5: Hardening / integration / CI**
   - Validation/error handling polish, observability checks, integration hardening.
   - Complete/maintain test baseline in CI (API integration + FE list/board component tests + one E2E happy path).

## 15) Acceptance criteria (V1)
- User can create, update, and archive tasks from UI.
- Backlog list view exists with required filters and priority sorting.
- Kanban board exists with drag-and-drop across `todo`, `doing`, `done`.
- Board columns are sorted by time-in-status.
- Status transitions persist correctly and update `statusChangedAt`.
- Prisma schema/migrations apply cleanly on fresh Postgres.
- API returns consistent error format for validation failures.
- Test baseline exists: API integration tests, FE component tests (list + board), and one E2E happy path.
- Architecture remains aligned with stack policy: Vite+React, Express, Prisma, Postgres.
- No out-of-scope features implemented in V1.

## 16) Milestone 1 implementation plan (schema + foundation)

### 16.1 Concrete deliverables
- `services/tasks-api` scaffold with Express app bootstrap, route registration, and health endpoint.
- Prisma setup for `tasks-api` with initial schema and migration.
- Initial domain entities persisted: Task, Tag, TaskTag.
- Archive semantics and status enum constraints represented in schema.
- Seed script to populate representative local data.
- Minimal API skeleton endpoints wired (can return stubbed/empty for non-M1 behaviors, but compiles/runs).
- Test harness baseline for integration/component/E2E tracks (at least one runnable placeholder/spec per track).
- README notes for local run/migrate/seed/test workflow.

### 16.2 Prisma model definitions (high level)
- **Task**
  - UUID primary key.
  - Required: `title`, `status`, `priority`, `statusChangedAt`, `createdAt`, `updatedAt`.
  - Optional: `description`, `dueAt`, `completedAt`, `assignee`, `archivedAt`.
  - Indexes: `(archivedAt, priority)`, `(status, statusChangedAt)`, `(dueAt)`, text-search-supporting index strategy deferred or basic index for V1.
- **Tag**
  - UUID primary key.
  - `name` unique (case-handling policy documented; canonicalization decision deferred if not needed for M1).
  - `createdAt` timestamp.
- **TaskTag**
  - Composite key `(taskId, tagId)`.
  - Foreign keys to Task and Tag with cascade behavior appropriate for archival model (no hard delete path in V1).
- **Enums**
  - `TaskStatus`: `todo`, `doing`, `done`.
  - `TaskPriority`: `low`, `medium`, `high`, `urgent`.

### 16.3 Migration plan
1. Create initial Prisma schema under `services/tasks-api/prisma/schema.prisma`.
2. Generate first migration (baseline tables + enums + indexes).
3. Apply migration to local dev Postgres schema owned by tasks service.
4. Verify migration idempotency in fresh database and clean rollback strategy for local/dev.
5. Record migration naming/versioning convention in docs.

### 16.4 Seed data plan
- Seed 20–30 tasks spanning:
  - all three statuses,
  - all priority values,
  - mix of with/without due dates,
  - mix of assigned/unassigned free-text assignee values,
  - at least 3 archived tasks.
- Seed 6–10 tags and map many-to-many across tasks.
- Include deliberately varied `statusChangedAt` timestamps to validate board sort behavior.

### 16.5 Dev env requirements
- Postgres available locally (single instance shared in monorepo; tasks service uses owned schema namespace).
- Node + package manager aligned with repo defaults.
- Environment variables documented for DB connection + app port.
- Standard scripts defined for:
  - migrate,
  - seed,
  - run API in dev,
  - run test suites.

### 16.6 Test plan for M1
- **API integration tests**
  - DB connectivity and migration-applied startup.
  - Health endpoint success.
  - At least one task read endpoint returning seeded records.
- **FE component tests (list/board baseline)**
  - Render empty + populated backlog list state.
  - Render board columns for `todo/doing/done` with ordering assertion using `statusChangedAt`.
- **E2E happy path (single test)**
  - Create task -> see in backlog -> move on board -> verify status persisted.

### 16.7 Explicit acceptance criteria (M1)
- `services/tasks-api` exists and runs locally.
- Prisma migration creates required tables/enums/indexes in tasks-owned schema.
- Seed script runs successfully and produces deterministic baseline data.
- Backlog and board UI can render against seeded API data in dev.
- Baseline test suites exist and pass in local CI-equivalent run.
- Documentation exists for setup, migrate, seed, and test commands.

### 16.8 Out-of-scope for M1
- Authentication/authorization implementation.
- Advanced search indexing/full-text tuning.
- Hard delete and retention policies.
- Real-time updates/websocket presence.
- Notifications, recurring tasks, and external integrations.
- CLI interface for tasks management.
- Production infra/deployment automation beyond local/dev baseline.

### 16.9 M1 implementation status (completed)
Implemented in `services/tasks-api`:
- Express skeleton with health endpoints (`/health`, `/api/v1/health`)
- Prisma schema for `Task`, `Tag`, `TaskTag`
- Status enum locked to `todo|doing|done`
- Archive-only support (`archivedAt`) and board ordering support (`statusChangedAt`)
- Initial SQL migration checked in
- Seed script checked in
- `.env.example` + local setup instructions
- Baseline tests: API health test + Prisma schema validation test
