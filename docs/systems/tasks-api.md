# Tasks API

**Type:** System reference
**Last updated:** 2026-07-01
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries`
**Related task:** 5dbf2967-c15e-44df-82fb-f1d0761b01ef — Task Type Filter and Type Selector on Edit Card
**Related PR:** https://github.com/Stoffer-Industries/sindustries/pull/145

---

## Purpose

The Tasks API is the source of truth for Stoffer Industries work items, comments, tags, task type routing, status transitions, and workflow metadata used by the Tasks app and agent automation.

Related system specs cover specialized behavior:

- `docs/systems/feature-task-workflow.md` — feature task gate orchestration.
- `docs/systems/task-dependencies.md` — dependency data and blocking behavior.
- `docs/systems/bookmark-workflow.md` — bookmark-to-task intake.

---

## Data Contract

Tasks expose `taskType` as a nullable string used for routing and filtering. Supported first-class values are:

- `content`
- `code`
- `research`
- `feature`

The Tasks app treats the same set as its shared type options for create, edit, and filtering surfaces. `feature` tasks are used by the feature-task workflow and must remain available through normal task create, read, update, and list paths.

---

## List API

`GET /tasks` accepts the standard list filters plus `taskType`.

| Query | Behavior |
|---|---|
| omitted or empty `taskType` | returns tasks without a type constraint |
| `taskType=content` | returns only content tasks |
| `taskType=code` | returns only code tasks |
| `taskType=research` | returns only research tasks |
| `taskType=feature` | returns only feature tasks |

Invalid task type filters return `400 INVALID_TASK_TYPE_FILTER`.

The API validates the filter against the same accepted task type set used by create and update validation, then applies an exact Prisma `taskType` filter in the list query. This keeps UI filtering and automation discovery aligned with persisted task metadata.

---

## UI Behavior

The Tasks app sends the selected type filter as `taskType=<type>` in `fetchTasks`. The default "all" state omits the query parameter.

The task editor preserves `taskType` in unsaved drafts and includes type changes in the existing save/PATCH payload, so type edits follow the same manual save model as other editable task fields.

---

## Operational Notes

- No schema migration is required for PR #145; `taskType` already exists on persisted tasks.
- New task type values must be added consistently across API validation, app shared options, and workflow consumers before use.
- Automation that needs feature-task routing should prefer first-class `taskType: feature` over tag-only conventions.

