# Tasks App — Behavioural Spec

**Last updated:** 2026-06-30
**Original design:** `docs/designs/tasks/SPEC.md` (Mowgli/Pulse v12)
**System doc:** n/a (tasks app is a standalone surface, no cross-cutting system doc)

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

---

## E2e coverage

| Flow | Spec file |
|---|---|
| Create task, move to doing, archive | `test/e2e/happy-path.spec.js` |
| Assignee dropdown (reserved values) | `test/e2e/assignee-dropdown.spec.js` |
| Filter by assignee | `test/e2e/assignee-filter.spec.js` |
| Task dependencies UI | `test/e2e/dependency-ui.spec.js` |
| Markdown checkbox toggle + description wrapping | `apps/tasks/src/components/TaskEditor.test.jsx`, `apps/tasks/src/utils/markdown.test.js` |
| Filter by priority | `test/e2e/priority-filter.spec.js` |

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
| archivedAt | Timestamp | Soft delete |
| tags | String[] | Ad-hoc, case-insensitive unique |
| blockedBy | UUID[] | Dependency references |
