# Task Dependency UI Tech Design

## Links

- Product spec: `brain/bookmarks/specs/task-dependency-ui-2026-06-27.md`
- Task: `8593d197-f3df-4486-aa50-dcaafd599264` (`🔧 Task Dependency UI`)
- Task API detail: `http://localhost:4001/api/v1/tasks/8593d197-f3df-4486-aa50-dcaafd599264`
- Prerequisite task: `456c92a8-835f-453e-a1ef-5ed5a31844f2` (`🔧 Add Blocked by reference`) — provides `dependsOn`, `dependsOnIds`, and `dependencyBlocked`. PR #120 open, Quinn-approved, awaiting Tom merge.

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-8593d197-dependency-ui`
- Worktree: `~/workspaces/rowan/sindustries` (existing rowan worktree, will be on the new branch for this task — `task-456c92a8-depends-on` is reset back to `origin/main` when this work begins so the UI does not ship on top of a pending data-model PR; the data model must be merged first)
- Primary code surfaces:
  - `apps/tasks/src/components/TaskEditor.jsx` — dependency list rendering, add/remove controls, validate-before-confirm flow
  - `apps/tasks/src/components/TaskCardSummary.jsx` — copy-to-clipboard ID affordance on each card
  - `apps/tasks/src/tasksApi.ts` — surface `dependsOn`, `dependencyBlocked` if not already; expose any UI-only helpers
  - `apps/tasks/src/utils/helpers.js` — small copy helper, status-to-tone mapping for dependency links
  - `apps/tasks/src/App.jsx` — pass new props from card/editor parents; no new top-level state
  - `apps/tasks/src/**/*.test.{jsx,tsx}` — new tests for editor dependency list, copy-ID clipboard, removed-dependency path
  - `apps/tasks/test/e2e/*.spec.js` — Playwright happy-path: add dependency, see link, remove dependency, copy ID

## Product Summary

The `depends-on` data model from `Add Blocked by reference` has no UI surface. Users can read and patch `dependsOnIds` only through API calls today — not practical for a normal workflow. This task ships the UI to:

1. List a task's dependencies inside the task detail editor (TaskEditor.jsx) — each link shows the dependency's title and current status.
2. Add a dependency from the editor by entering a task ID — the editor validates the ID (exists, not archived, not self, no direct cycle) and surfaces the linked task's title before confirming.
3. Remove an individual dependency from the editor.
4. Copy a task's ID from any card with a single click (no page navigation, no modal).

The copy-ID affordance is the enabler for AC2: without an easy way to grab a task's ID, users cannot add dependencies from the UI.

## Data Contract

No new API surface. This task consumes:

- `task.dependsOn` — array of `{ id, title, status, dependencyBlocked }` (already provided by `Add Blocked by reference` PR #120).
- `task.dependsOnIds` — array of dependency task IDs (write-side convenience).
- `task.dependencyBlocked` — boolean. UI does not need to act on it here (the existing `cardState` logic in `App.jsx` will be updated by PR #120 to OR in `dependencyBlocked`); this slice only renders dependencies and copies IDs.

To validate before saving, the UI will call `GET /tasks/:id` with the candidate dependency ID. If the response is 200, surface the title; if 404 or archived, show an inline error.

To add a dependency, the UI uses the existing `PATCH /tasks/:id` with `{ dependsOnIds: [...existing, newId] }` (PR #120 supports replace-style arrays). Validation for direct cycles and self-references lives server-side; the UI surfaces the error message returned by the API.

To remove a dependency, the UI uses `PATCH /tasks/:id` with `{ dependsOnIds: [...existing.filter(id !== removedId)] }`.

## Component Changes

### TaskEditor.jsx — dependency section

Add a new "Dependencies" section to the editor, placed after the existing "Blocked" field and before the comments section. Layout:

- Section heading: "Dependencies" with a small `+ Add dependency` button.
- When the add button is clicked, an inline input appears with placeholder "Enter task ID" and a small submit affordance.
- On submit, fetch `GET /tasks/:id` for the candidate. If valid, show "Link to: <title> [<status>]?" with Confirm / Cancel.
- On confirm, PATCH `dependsOnIds` with the new ID appended.
- Existing dependencies render as a list. Each row:
  - Title (link to task via app navigation — same as `openTask(task.id)` in App.jsx)
  - Status badge (reuse existing status-to-tone mapping)
  - Remove button (small × icon)
- Validation errors render inline beneath the input ("Task not found", "Cannot depend on self", "Circular dependency", "Task archived").

### TaskCardSummary.jsx — copy ID affordance

Add a small icon button (📋 or "Copy ID") in `task-card-footer-meta`, positioned to the left of the assignee avatar. On click:

- `navigator.clipboard.writeText(task.id)`
- Show a transient "Copied!" indicator (e.g. 1.5s tooltip or a small ✓ state on the button)
- Stop event propagation so the card's onClick does not fire

Use the existing `Avatar` or `Button` primitives from `@sindustries/ui/react`; if neither fits, add a minimal `<button>` with a class that the existing stylesheet already supports. No new design system tokens required.

### App.jsx — prop pass-through

The card parent passes the new `onCopyId` callback to `TaskCardSummary`. The editor parent already has `onSave`, which routes through `patchTask`; no change there. The new `onAddDependency` and `onRemoveDependency` callbacks route through the existing `patchTask(task.id, { dependsOnIds: ... })` flow.

## Tasks API Client

No new helper needed. The existing `patchTask` from `apps/tasks/src/tasksApi.ts` already accepts arbitrary patches; we extend its TypeScript type to include `dependsOnIds?: string[]`. PR #120's client changes already include `dependsOn` and `dependencyBlocked` in the read-side mapping.

The CLI helper `agents/skills/ops/tasks-api/tasks_api_client.py` already supports `--depends-on` and `--clear-dependencies` (added by PR #120). No change required for this UI task.

## Workflow, Cron, Skill Changes

- No workflow change.
- No cron change.
- No skill change.

## `.openclaw` Boundary

This task is fully contained in the `sindustries` repo (`apps/tasks/**` and Playwright e2e). No `.openclaw` edits required. No `[openclaw-needed]` handoff needed.

## Implementation Plan

1. **Branch setup** — once PR #120 is merged, create `task-8593d197-dependency-ui` from `origin/main` in `~/workspaces/rowan/sindustries`. (The data model must be on main before this UI can reference it; `dependsOn` and `dependsOnIds` are PR #120's exports.)
2. **Wire type updates** — extend `Task` shape in `apps/tasks/src/tasksApi.ts` to type `dependsOn?` and `dependencyBlocked?` (may already be there from PR #120). Extend the `patchTask` payload type to accept `dependsOnIds?: string[]`.
3. **TaskEditor — dependency section** — new component block + state. Render list, add (with fetch-validate-confirm flow), remove. Use existing form primitives from `@sindustries/ui/react`. Mirror the existing draft-state pattern (`useTaskDrafts.js`) so unsaved dependency edits share the editor's save lifecycle.
4. **TaskCardSummary — copy ID button** — add clipboard helper, transient "Copied" feedback state. Wire through `onCopyId` prop.
5. **App.jsx — prop wiring** — pass `onCopyId` to `TaskCardSummary`; pass `onAddDependency` / `onRemoveDependency` to `TaskEditor`. Both call into `patchTask`.
6. **Tests**
   - Unit (`apps/tasks/src/components/TaskEditor.test.jsx` or a new dedicated test file): render dependency list with one item, click Remove, assert `patchTask` called with `dependsOnIds` excluding the removed ID. Render add flow, mock `GET /tasks/:id` 200, assert Confirm button visible with title, click Confirm, assert `patchTask` called with appended IDs. Render 404 path, assert inline error.
   - Unit (`apps/tasks/src/components/TaskCardSummary.jsx`): clipboard mocked; click button, assert `writeText` called with `task.id`, transient "Copied" indicator appears.
   - Playwright e2e (`apps/tasks/test/e2e/dependency-ui.spec.js`): create two tasks A and B; open A's editor; add B as dependency via ID; assert B's title shows in A's dependency list; click copy ID on A's card, assert clipboard content (use `page.evaluate(() => navigator.clipboard.readText())` with the right permission grant). Remove the dependency; assert empty state.
7. **Run local validation**:
   - `npm --workspace apps/tasks test`
   - `npm --workspace apps/tasks run test:e2e` (only if browsers are available; otherwise rely on CI)
8. **Open PR** — body must check off AC1-AC4. Reviewer: Quinn, plus Tom for the user-facing surface. Mark this PR ready once `npm test` and CI pass.

## Test Plan

- Unit tests cover all four ACs at the component level (Vitest).
- Playwright e2e covers the full add → list → copy-ID → remove cycle.
- Manual smoke: open the deployed dev app, add and remove dependencies on two seeded tasks, verify clipboard paste contains the task ID.

## Capacity Notes

This task fits inside Rowan's `doing` capacity once `Add Blocked by reference` is merged. Until then, the API surface this task depends on does not exist on `main`, so this branch cannot be merged either. The dependency is encoded in the task description; the `dependsOn` field on the Tasks API record can be set to point at `456c92a8-...` after PR #120 lands (or by Quinn during approval) so the factory-v2 lobster workflow will block acceptance until the upstream is done.

## Risks and Open Questions

1. **Task lookup latency** — `GET /tasks/:id` for every add-dependency action is fine for a small dataset; if it grows we should batch or cache. Out of scope for this slice.
2. **Clipboard permissions** — `navigator.clipboard.writeText` requires a secure context. The app already runs on https in prod and on localhost in dev, so this should be fine. E2e tests need `--use-fake-ui-for-media-stream` style clipboard mocking or the Playwright `clipboard-read` permission grant. Confirm before writing e2e.
3. **Cycle error messaging** — the API's cycle error message needs to be surfaced in a friendly way in the editor. Check the exact wording in PR #120's API response and mirror it in the UI copy.
4. **No deep cycle detection** — only direct A↔B cycles are rejected server-side per the upstream tech design. The UI should not pretend to detect multi-step cycles. Document this in the editor's help text or tooltip.
5. **Open question for Tom** — is the copy-ID affordance acceptable as a small icon button on every card, or do you want it tucked behind an explicit "..." menu? Default plan is icon button (consistent with the existing card meta row), but happy to adjust.
6. **Open question for Quinn** — should the dependency list be rendered above or below the description field in the editor? Default plan is below the Blocked toggle and above the comments, but if Quinn prefers it next to description we can move it.