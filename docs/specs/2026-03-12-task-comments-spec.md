---
status: shipped
task_id: 1ac0de01-47fc-47c3-96b7-dfb2eaf756c7
product_spec: n/a
shipped_pr: null
shipped_date: 2026-03
---

# Task comments spec

Date: 2026-03-12
Task: `1ac0de01-47fc-47c3-96b7-dfb2eaf756c7`

## Goal
Add first-class task comments across the tasks backend and UI without breaking the existing prodlike task tracker. All schema, API, and UI validation work happens against dev (`localhost:4000`) only.

## Scope
- Persist comments in the Tasks API database.
- Return comments on task detail reads.
- Add an API endpoint for creating comments.
- Render comments in the task detail editor beneath the save row.
- Cover the new API and UI flow with automated tests, including at least one E2E path for covered ACs.

## Data model
Add a `TaskComment` model in `services/tasks-api/prisma/schema.prisma`.

Proposed fields:
- `id UUID @id`
- `taskId UUID` → `Task.id`, `onDelete: Cascade`
- `author String`
- `body String`
- `createdAt DateTime @default(now())`
- `updatedAt DateTime @updatedAt`

Add `comments TaskComment[]` on `Task`.

Indexes:
- `@@index([taskId, createdAt])`

Non-goals for this slice:
- comment editing/deletion
- rich text / markdown
- threaded replies
- auth-derived user identity

## API contract
### Read
- `GET /api/v1/tasks/:id` returns task detail with `comments`.
- Comments are sorted oldest-first so the thread reads naturally top-to-bottom.

Comment shape:
```json
{
  "id": "uuid",
  "author": "Rowan",
  "text": "Investigated API contract",
  "createdAt": "2026-03-12T00:00:00.000Z",
  "updatedAt": "2026-03-12T00:00:00.000Z"
}
```

### Create
Add `POST /api/v1/tasks/:id/comments`.

Request body:
```json
{
  "author": "Rowan",
  "text": "Investigated API contract"
}
```

Validation:
- task must exist
- `author` required, trimmed, non-empty
- `text` required, trimmed, non-empty
- reject unknown empty payloads with 400

Response:
- `201` with created comment payload
- `404` if task missing

## UI behavior
In `apps/tasks`, extend the selected task detail view:
- Comments section appears beneath the existing save/archive/close row.
- Existing comments render with author, local-formatted timestamp, and body text.
- Add a compact composer with `author` and `comment` fields plus an `Add comment` button.
- On success, the created comment appears immediately and composer clears.
- While submitting, disable the submit button.
- Keep comments separate from unsaved task field drafts so editing title/description does not lose comment state.

## Frontend data changes
- Extend `tasksApi.js` with `createTaskComment(taskId, payload)`.
- Keep comment fetching piggybacked on task detail/list payloads if the API returns comments in `GET /tasks/:id` and optionally list payloads. Preferred initial approach: only task detail needs comments rendered; list rows can omit comments.
- Normalize comment arrays defensively (`[]` when absent).

## Testing
### Tasks API
- route tests for `GET /tasks/:id` comment mapping
- route tests for `POST /tasks/:id/comments` success + validation + missing task
- prisma validation/integration coverage for schema if needed

### UI unit/integration
- render comments in task detail
- create comment calls the new endpoint and updates UI
- submit disabled / cleared state behavior

### E2E
Add one happy-path comment flow in `apps/tasks/test/e2e`:
- open task detail
- add comment
- confirm author/text/timestamp area renders

If timestamp text is flaky by locale, assert author + text and the presence of a timestamp container, and note that exception in the PR.

## Implementation notes / guardrails
- Do not run migrations against prodlike (`4001`).
- Build and validate schema/API changes only against dev DB and dev app ports.
- Because the repo checkout has already proven capable of breaking prodlike task reads when schema and runtime drift, keep any risky runtime validation isolated from the prodlike-backed process.
- If needed, use a dev-only worktree or a dev-only server process before merging.
