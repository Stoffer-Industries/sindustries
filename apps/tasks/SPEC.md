# Tasks App — Behavioural Spec

**Last updated:** 2026-08-10
**Original design:** `docs/designs/tasks/SPEC.md` (Mowgli/Pulse v12)
**System doc:** `docs/systems/tasks.md`

This spec describes what the tasks app does and what behaviour is expected. Update it when a feature changes user-visible flows. Each flow should have corresponding e2e coverage in `test/e2e/`.

---

## Overview

A focused task management surface for Tom and the agent team. Supports capturing, prioritising, and progressing work through a backlog list and a Kanban board. Tasks move through statuses: `todo → ready → doing → acceptance → done`, with soft archive.

---

## Flows

### 1. Create a task
1. User clicks "New Task"
2. Title is required; priority, description, assignee, due date, and tags are optional
3. Task appears in the backlog at the correct priority position immediately
4. A toast confirms creation

### 2. View and edit a task
1. User clicks a task card to expand it inline (accordion)
2. User can edit all fields inline
3. User can toggle markdown task-list checkboxes in the rendered description without entering raw-text edit mode; the checkbox state persists immediately
4. Rendered markdown description content wraps within the task card instead of overflowing horizontally
5. User can navigate to a full-screen detail view via explicit action
6. Changes persist on save
7. An **Approvals** sub-section renders one row per required approval type for the task's type (`spec`, `tech_design`, `qa`):
   - An unchecked checkbox approves through structured `POST /tasks/:id/approvals` with `{ type }`; a checked checkbox revokes through `DELETE /tasks/:id/approvals/:type`.
   - The browser includes an HttpOnly-cookie session and never supplies an approval owner; the API derives ownership from the authenticated principal.
   - Tasks remain readable while signed out. On load the UI checks `GET /auth/session`; changing an approval while signed out opens a minimal username/password login gate backed by `POST /auth/session`. The password is held only in the form state, cleared after submission/cancel, and never stored in JavaScript storage.
   - The current actor is shown beside Approvals and can end the session through `DELETE /auth/session`.
   - Each row updates optimistically and only the mutating row is disabled. A failed mutation rolls that row back and exposes an accessible row-level error; success refreshes the parent task to reconcile approvals and audit comments.
   - Archived and done tasks have immutable approval controls.
   - Checkbox checked = `approved`; unchecked = `pending` or `revoked` (state is distinguished by avatar opacity / strike-through rather than inline text).
   - Editing acceptance criteria automatically revokes the structured `spec` approval and records the change in task history; the approval must be granted again after the revised scope is reviewed.
   - Owner display name and timestamp remain in the `aria-label` / hover tooltip so the visual stays uncluttered.
   - The required-approvals list is fetched from `GET /task-types/:type/required-approvals` when a `taskType` is set; if none are required the section shows a friendly empty state.
   - When the task has no `taskType` set yet, the section shows a placeholder asking the user to select one.
   - Fetch errors render an inline error message and do not crash the editor.

### 3. Move a task through the board
1. User drags a task card between Kanban columns (desktop)
2. On mobile, user changes status via dropdown in the detail view
3. `statusChangedAt` is recorded on each transition
4. Moving to `done` records `completedAt`; moving away from `done` clears it

### 4. Filter the backlog
1. User applies filters: status, priority, assignee, tag, due date range, text search
2. List updates to show matching tasks only
3. Filter state is preserved in URL query parameters

### 5. Assign a task
1. User selects an assignee from a dropdown of reserved values (Tom, Quinn, Rowan, Lox, Ivy)
2. Assignee is stored and displayed on task cards
3. Task cards render the assignee's display name (e.g. "Quinn") in the avatar aria-label and any visible assignee text, falling back to the trimmed raw assignee when the id is not in the reserved set
4. Task cards show the assignee's avatar image when one is set, with a graceful fallback to the existing first-letter rendering when the avatar is unset or the asset fails to load

### 6. Add and filter by priority
1. Task priority is one of: low, medium, high, urgent (default: medium)
2. Backlog list is sorted by priority descending
3. User can filter to a specific priority level

### 7. Archive a task
1. User archives from expanded card or detail view
2. Task disappears from all main views immediately
3. A toast with an Undo option appears for 5 seconds
4. User can toggle "Show Archived" to see archived tasks (visually distinct)

### 8. Task dependencies
1. User can mark a task as blocked by another task
2. Blocked tasks are visually flagged in list and board views
3. Dependency links open the blocking task

### 9. Workflow-gate ownership and attention owners (data surface — WS1)
WS1 introduces the data shape only; the stacked avatar rendering and
detail-view composer land in WS3.

1. Task responses include `workflowGates` (derived view of outstanding /
   approved structured gates), `attentionOwners` (insertion-ordered
   distinct owner strings), and `attentionOwnerDetails` (full audit
   rows). The existing `Blocked` indicator, `dependencyBlocked`, and
   `blockedBy` dependency references remain unchanged.
2. The detail view surfaces each plane in its own labelled section:
   delivery assignee, outstanding workflow gates with their configured
   owner and state, dependencies, the existing `Blocked` indicator, and
   exceptional attention requests with the per-row `note` and `addedBy`.
   Each section has its own heading and accessibility label so the
   planes stay distinguishable for screen readers.
3. The backlog filter affordances expose two new filter chips:
   "My outstanding gates" (issues `?workflowGateOwner=<self>`) and
   "Needs my attention" (issues `?attentionOwner=<self>`). Both filters
   combine via AND with the existing status/priority/assignee filters
   and persist in the URL query string.
4. PATCH affordances for attention owners expose a clearly named
   "Attention needed from" editor (not "Blocked by"). Replacing the
   list replaces the full set; clearing all rows leaves every other
   task field untouched. Removing one row only removes that row.
5. No UI affordance should generate an attention request when an
   explicit workflow gate already represents the action. When a user
   opens a structured approval (spec / tech_design / qa), the
   approval-row UX is the only path; the attention-editor UX never
   surfaces for the same action.

## E2e coverage

| Flow | Spec file |
|---|---|
| Create task, move to doing, archive | `test/e2e/happy-path.spec.js` |
| Assignee dropdown (reserved values) | `test/e2e/assignee-dropdown.spec.js` |
| Filter by assignee | `test/e2e/assignee-filter.spec.js` |
| Task dependencies UI | `test/e2e/dependency-ui.spec.js` |
| Markdown checkbox toggle + description wrapping | `apps/tasks/src/components/TaskEditor.test.jsx`, `apps/tasks/src/utils/markdown.test.js` |
| Filter by priority | `test/e2e/priority-filter.spec.js` |
| Approvals sub-section (session login/logout and current actor, optimistic approve/revoke, per-row pending + rollback errors, immutable states, avatars/tooltips, empty states) | `apps/tasks/src/components/ApprovalsSection.test.jsx`, `apps/tasks/src/tasksApi.test.ts`, `apps/tasks/test/e2e/approval-checkboxes.spec.js` |

---

## Data model (summary)

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| title | String | Required |
| description | Text | Nullable, markdown rendered |
| status | Enum | todo, ready, doing, acceptance, done |
| statusChangedAt | Timestamp | Updated on every status change |
| priority | Enum | low, medium, high, urgent |
| dueAt | Timestamp | Nullable |
| completedAt | Timestamp | Set when status → done, cleared on transition away |
| assignee | Enum | Tom, Quinn, Rowan, Lox, Ivy |

The list of reserved assignees and their display metadata (id → display name, optional avatar) lives in `apps/tasks/src/users/assignees.js`. v1 ships with no avatar image files in the repo; adding real avatar assets is a separate follow-up task.
| archivedAt | Timestamp | Soft delete |
| tags | String[] | Ad-hoc, case-insensitive unique |
| blockedBy | UUID[] | Dependency references |
| approvals | TaskApproval[] | Native approvals owned by the tasks-api (see `services/tasks-api/SPEC.md` for the authoritative schema). The Tasks UI mutates this collection only through the structured authenticated approval endpoints and then refreshes the task. |
| workflowGates | `{ type, owner, state }[]` | Derived view: each required approval type for the task's `taskType`, with `state: "outstanding"` or `state: "approved"`. Computed server-side from `approvals` + the resolved required-approvals policy. Empty for tasks whose `taskType` requires no approvals. |
| attentionOwners | `string[]` | Distinct owner strings (insertion order, case-insensitive dedup) for exceptional / unmodelled attention requests. Empty array means no requests. |
| attentionOwnerDetails | `{ id, owner, addedBy, note, createdAt }[]` | Full audit rows for `attentionOwners`. Preserves order and per-row context for detail UI. |
