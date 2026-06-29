# Add Blocked by Reference Tech Design

## Links

- Product spec: `brain/bookmarks/specs/blocked-by-reference-2026-06-27.md`
- Task: `456c92a8-835f-453e-a1ef-5ed5a31844f2` (`Add Blocked by reference`)
- Task API detail: `http://localhost:4001/api/v1/tasks/456c92a8-835f-453e-a1ef-5ed5a31844f2`

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-456c92a8-depends-on`
- Worktree: `~/workspaces/rowan/sindustries`
- Primary code surfaces:
  - `services/tasks-api/prisma/schema.prisma`
  - `services/tasks-api/src/routes/tasks.ts`
  - `services/tasks-api/test/read-endpoints.test.ts`
  - `services/tasks-api/test/pagination-cursor.test.ts` if list mapping needs integration-style coverage
  - `apps/tasks/src/tasksApi.ts`
  - `apps/tasks/src/App.jsx`
  - `apps/tasks/src/utils/helpers.js`
  - `apps/tasks/src/**/*.test.*` for visible blocked behavior
  - `agents/skills/ops/tasks-api/tasks_api_client.py`
  - `agents/skills/ops/tasks-api/tests/test_tasks_api_client.py` or a new focused client test if the current suite is not the right fit

## Product Summary

The existing `blocked` field is a manual override and must keep that meaning. This feature adds explicit task dependencies so a task can say "I depend on these other tasks" as first-class data. The API returns `dependencyBlocked: true` when at least one dependency is not `done`. Consumers treat a task as visibly blocked when `blocked || dependencyBlocked`.

The first version is data/API/client only except for keeping current UI blocked styling correct when `dependencyBlocked` appears. There is no dependency graph UI, no cascading status transition, no notification on dependency resolution, and no deep cycle detection beyond rejecting self references and direct A/B circular dependencies.

## Data Model

Add a self-referential join model rather than a JSON array on `Task`. A join table keeps referential integrity, makes dependency status joins straightforward, and avoids ad hoc UUID parsing from a text field.

Proposed Prisma shape:

```prisma
model Task {
  id                  String           @id @default(uuid()) @db.Uuid
  // existing fields...
  dependencies        TaskDependency[] @relation("TaskDependsOn")
  dependedOnBy        TaskDependency[] @relation("TaskDependedOnBy")
}

model TaskDependency {
  taskId       String   @db.Uuid
  dependsOnId  String   @db.Uuid
  createdAt    DateTime @default(now())

  task          Task     @relation("TaskDependsOn", fields: [taskId], references: [id], onDelete: Cascade)
  dependsOn     Task     @relation("TaskDependedOnBy", fields: [dependsOnId], references: [id], onDelete: Cascade)

  @@id([taskId, dependsOnId])
  @@index([dependsOnId])
}
```

Run a Prisma migration under `services/tasks-api/prisma/migrations/`. No data backfill is required because existing tasks start with no dependencies.

## API Contract

Extend task response mapping with:

```json
{
  "dependsOn": [
    {
      "id": "uuid",
      "title": "Dependency title",
      "status": "doing",
      "completedAt": null
    }
  ],
  "dependsOnIds": ["uuid"],
  "dependencyBlocked": true
}
```

`dependsOnIds` gives automation a compact stable field. `dependsOn` gives humans and clients enough detail to explain why a task is blocked without a second round trip. `dependencyBlocked` is derived in the service layer on read from included dependency task statuses, not materialized in the database. That keeps completion of a dependency immediately reflected on the next read and avoids write-time synchronization.

For `GET /tasks`, include dependency records with only the fields needed to compute and display dependency state. Keep comments out of list responses as they are today. For `GET /tasks/:id`, include dependency details alongside existing tags and comments.

For `PATCH /tasks/:id`, accept a full replacement field:

```json
{
  "dependsOnIds": ["uuid-a", "uuid-b"]
}
```

Full replacement matches current `tags` behavior and makes add/remove idempotent for agents. Omitted `dependsOnIds` means no dependency change. An empty array clears dependencies.

Validation rules:

- `dependsOnIds` must be an array of UUID strings.
- Unknown dependency task IDs return `400` with a clear code such as `DEPENDENCY_TASK_NOT_FOUND`.
- Self reference returns `400 SELF_DEPENDENCY_NOT_ALLOWED`.
- Direct circular reference returns `400 CIRCULAR_DEPENDENCY_NOT_ALLOWED` when task A would depend on B while B already depends on A.
- Duplicate IDs are normalized away before writes.
- Archived dependency tasks are rejected for new dependency writes unless product approval explicitly allows historical dependencies. This keeps "blocked by completed/unfinished work" tied to active tasks.

Use a Prisma transaction for the dependency update path so deleting old dependency rows and inserting new rows is atomic. Keep general task field updates and dependency replacement in the same request flow, but avoid partial success when dependency validation fails.

## UI Behavior

Although graph editing is out of scope, the existing tasks UI already computes card visual state from `task.blocked`. Update that logic to use `task.blocked || task.dependencyBlocked` so dependent tasks look blocked in current board/backlog views.

Update TypeScript task shapes in `apps/tasks/src/tasksApi.ts` to include:

- `dependsOn?: DependencyReference[]`
- `dependsOnIds?: Array<string | number>`
- `dependencyBlocked?: boolean`

Do not add dependency editing controls in this task unless Tom/Quinn explicitly expand scope. The spec only requires dependencies addable/removable through the existing API update endpoint, not through the current UI.

## Tasks API Client

Update `agents/skills/ops/tasks-api/tasks_api_client.py` so `get` and `list` print the new fields unchanged from the API response. Add patch support for dependency replacement, preferably:

```bash
python3 tasks_api_client.py patch --id <task-id> --depends-on <uuid-a> <uuid-b>
```

Implementation detail: map `--depends-on` to `dependsOnIds`. Passing no values should not be ambiguous with "clear all"; use an explicit `--clear-dependencies` flag if clearing from the CLI is needed. Programmatic callers can still use raw `api_request` or helper extension if they need exact control.

## [openclaw-needed]

No out-of-repo OpenClaw runtime change is required if the implementation branch updates the versioned `agents/skills/ops/tasks-api/tasks_api_client.py` in this repository. After merge, confirm the runtime copy at `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py` is refreshed from the repository checkout before relying on the new CLI flags in heartbeats.

## Implementation Plan

1. Add the Prisma self-referential dependency model and migration.
2. Extend route-level include helpers for list/detail reads so dependencies are available to `mapTask`.
3. Update `mapTask` to return `dependsOn`, `dependsOnIds`, and `dependencyBlocked`.
4. Add `dependsOnIds` parsing and validation in `PATCH /tasks/:id`.
5. Implement dependency replacement in a Prisma transaction after validating self references, missing tasks, archived tasks, and direct cycles.
6. Update frontend task types and card state to treat `dependencyBlocked` as blocked for existing visual state.
7. Update `tasks_api_client.py` to expose returned dependency fields and support setting dependency IDs through `patch`.
8. Add focused tests across API mapping, validation, CLI argument payload creation, and existing UI blocked state.

## Test Plan

- `npm test --workspace services/tasks-api`
  - list response includes `dependencyBlocked: false` and empty dependency arrays when no dependencies exist
  - detail response includes dependency references and computes `dependencyBlocked: true` when a dependency is `open`, `ready`, `doing`, or `acceptance`
  - detail/list response computes `dependencyBlocked: false` when all dependencies are `done`
  - patch can add, replace, and clear dependencies through `dependsOnIds`
  - patch rejects self dependency
  - patch rejects direct circular dependency
  - patch rejects unknown or archived dependency IDs with clear errors
- `npm test --workspace apps/tasks`
  - `Task` API typing/normalization keeps dependency fields
  - card state uses `blocked || dependencyBlocked`
- `python3 -m pytest agents/skills/ops/tasks-api/tests`
  - CLI patch args produce `dependsOnIds`
  - list/get output preserves dependency fields
- Manual smoke:
  - create two tasks through API
  - set task B to depend on task A
  - confirm task B returns `dependencyBlocked: true`
  - mark task A `done`
  - confirm task B returns `dependencyBlocked: false` while `blocked` remains unchanged

## Open Questions and Risks

- Should dependencies on archived tasks be allowed for historical accuracy? This design rejects them for new writes to keep active workflow semantics simple.
- Should the response field be only `dependsOn`, only `dependsOnIds`, or both? This design returns both because humans and agents have different needs and the payload size is small.
- The current `GET /tasks` route already has known pagination/sort limitations. Adding dependency includes should not expand that refactor; keep the dependency change focused and leave pagination semantics unchanged.
- Direct cycle detection is intentionally shallow per spec. A later graph feature may need recursive cycle checks before dependencies become heavily nested.
