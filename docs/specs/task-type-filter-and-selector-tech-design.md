# Task Type Filter and Selector Tech Design

## Links

- Product spec: `brain/tasks/specs/task-type-filter-and-selector-2026-06-29.md`
- Task: `5dbf2967-c15e-44df-82fb-f1d0761b01ef` — Task Type Filter and Type Selector on Edit Card
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-5dbf2967-task-type-filter-and-selector`
- Worktree: `~/workspaces/rowan/sindustries`

The product spec file referenced by the task was not present in the local workspace during design. This design is based on the task description and AC1-AC5 in the Tasks API record.

## Scope

Add first-class task type controls to the existing Tasks app UI:

- A list-level type filter with an `All` default.
- A task edit-card type selector that persists changes via the existing `PATCH /tasks/:id` path.
- `feature` as a supported type in the create form.
- Immediate UI refresh after create/edit operations through the existing `useTasks` mutation reload path.

## Implementation Plan

1. Centralize task type constants in `apps/tasks/src/utils/constants.js`, next to the existing status, priority, and assignee options. Include `content`, `code`, `research`, and `feature`, plus labels suitable for filter and select controls.
2. Extend `apps/tasks/src/tasksApi.ts` types so `taskType` accepts `feature` everywhere and `TaskFilters` accepts an optional `taskType`. Add `taskType` to the `fetchTasks` query string when selected.
3. Add server-side task type filtering in `services/tasks-api/src/routes/tasks.ts` by reading `taskType` from `req.query`, validating it against `validTaskTypes`, and adding `{ taskType }` to the Prisma `where` clause. This keeps the UI filter consistent with other list filters and avoids client-only filtering drift.
4. Add an App-level type filter dropdown in `apps/tasks/src/App.jsx` using the same menu pattern as priority and assignee filters. Store it in the existing `filters` state so it persists across view switches and internal navigation during the session.
5. Update the create form's "Content type" selector to use the shared task type options and include `feature`.
6. Update `apps/tasks/src/utils/helpers.js` so `normalizeTaskForEditor` includes `taskType`, then add a "Type" selector to `apps/tasks/src/components/TaskEditor.jsx`. Include it in `buildSavePayload`, focus order, and keyboard save flow.
7. Keep the save behavior aligned with existing editor fields: the selector changes the local draft first, and the existing Save action sends the full editor payload through `patchTask`. Do not introduce auto-save for task type only.

## API Contract

The Tasks API already accepts `taskType` on create and update, and validates `content | code | research | feature`. This task adds only one API read-side capability:

- `GET /tasks?taskType=<type>` filters tasks by exact task type.
- Empty or omitted `taskType` means no type filter.
- Invalid values return `400 INVALID_TASK_TYPE_FILTER`.

No schema migration is required; `taskType` already exists in Prisma.

## .openclaw Boundary

No `.openclaw` changes are needed. All implementation work stays in `Stoffer-Industries/sindustries`.

## Workflow, Cron, and Skill Changes

No workflow, cron, or skill changes are needed. This is an app/API surface change only.

## Test Plan

- `npm test --workspace @sindustries/tasks-api` for the new `taskType` list filter validation and query behavior.
- `npm --workspace apps/tasks test` for App, TaskEditor, and tasksApi coverage:
  - `fetchTasks` sends `taskType`.
  - Create form includes `feature`.
  - Edit card saves `taskType`.
  - Type filter updates filters and combines with existing status/priority/assignee behavior.
- `npm --workspace apps/tasks run test:e2e` with focused Playwright coverage for filtering by type and changing a task's type from the edit card.
- `npm --workspace apps/tasks run build` to catch TypeScript and bundling issues.

## Risks and Open Questions

- The task's declared product spec path was not found locally. If Quinn/Tom expect constraints beyond the task ACs, update this design before implementation.
- The filter should be server-backed because existing filters are server-backed. This is a small API change, but it is still observable and needs tasks-api tests.
- The task says the filter persists across page navigation "within the session." Existing app filters persist in React state across view switches but not browser reloads; this design matches that current behavior unless Tom wants sessionStorage persistence.
- The edit selector will save with the existing Save button rather than immediately on select. AC3 says selecting a type updates via PATCH; if immediate patch-on-select is required, call that out before implementation because it would diverge from the current editor model.
