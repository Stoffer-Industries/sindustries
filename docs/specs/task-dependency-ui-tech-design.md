# Task Dependency UI Tech Design

## Links

- Source spec: `brain/bookmarks/specs/task-dependency-ui-2026-06-27.md`
- Task: `8593d197-f3df-4486-aa50-dcaafd599264`
- Upstream dependency: `456c92a8-835f-453e-a1ef-5ed5a31844f2` is done and merged to `main` in PR #120.
- Branch: `task-8593d197-dependency-ui-rowan`

## Scope

This PR adds the UI layer for the task dependency data model now exposed by the Tasks API:

- `apps/tasks/src/components/TaskEditor.jsx`
  - Render dependency rows with title and status.
  - Validate an entered dependency task ID via `GET /tasks/:id`.
  - Confirm before saving the dependency.
  - Remove individual dependencies through `PATCH /tasks/:id`.
- `apps/tasks/src/components/TaskCardSummary.jsx`
  - Add a small click-to-copy task ID affordance on normal cards.
- `apps/tasks/src/tasksApi.ts`
  - Type `dependsOnIds` on update payloads.
- `apps/tasks/test/e2e/dependency-ui.spec.js`
  - Cover add, list, copy ID, and remove in one browser-level flow.

## Data Flow

The editor treats dependencies as immediate server-side changes rather than draft form fields. This matches comments and archive behavior: dependency edits are independent actions from title, description, and status form edits.

Adding a dependency:

1. User enters a task ID in the detail editor.
2. UI calls `fetchTask(id)` to validate the ID and display the candidate title/status.
3. User confirms.
4. UI patches `{ dependsOnIds: [...currentIds, id] }`.
5. Existing task reload behavior refreshes the rendered dependency list.

Removing a dependency:

1. User clicks the dependency row's remove button.
2. UI patches `{ dependsOnIds: currentIds.filter(id !== removedId) }`.
3. Existing task reload behavior refreshes the rendered dependency list.

## Test Plan

- Unit: `TaskEditor` renders dependencies, validates before confirming, shows lookup errors, and removes one dependency without clearing the rest.
- Unit: `TaskCardSummary` copies the task ID and stops the card/title click path.
- E2E: `dependency-ui.spec.js` exercises the full add, list, copy, remove path against mocked API routes.

## Notes

The UI performs quick client-side checks for empty IDs, self-dependencies, and duplicate direct dependencies. Cycle detection and final validation remain server-owned.
