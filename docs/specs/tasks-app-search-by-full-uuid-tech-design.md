---
status: draft
task_id: 9c1ac684-5662-4c85-a88a-63abe236f0c6
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tasks App Search by Full UUID — Tech Design

**Task:** `9c1ac684-5662-4c85-a88a-63abe236f0c6` — Tasks app search does not find tasks by full UUID  
**Branch:** `task-9c1ac684-tasks-app-uuid-search`  
**Worktree:** `/Volumes/WD1/worktrees/rowan/task-9c1ac684-uuid-search`  
**Repository:** `Stoffer-Industries/sindustries`  
**Owning service:** `services/tasks-api`  
**Direct client:** `apps/tasks`  
**Other direct consumer:** `agents/skills/ops/tasks-api/tasks_api_client.py`

## Product intent summary

There is no linked product spec, so the task record is the product intent.

> “The Tasks app search does not return an existing task when searching by its full UUID.”

> “searching by a complete task UUID returns the matching task.”

The reproduction identifier is `39b79a40-e39a-4378-a30d-9bddcbb73a1d`. The fix must be case-insensitive, preserve title/description/tag search, and add automated known-UUID and unknown-UUID coverage.

## Current state and defect

The app already sends search as `GET /tasks?q=<value>`: `apps/tasks/src/App.jsx` owns/debounces `filters.q`, and `apps/tasks/src/tasksApi.ts` serialises it.

The defect is API-side. `services/tasks-api/src/routes/tasks.ts` maps `q` to a Prisma `OR` containing only case-insensitive `title contains` and `description contains`. It never compares `Task.id`, which `services/tasks-api/prisma/schema.prisma` stores as native PostgreSQL UUID.

`services/tasks-api/src/routes/tasks/_constants.ts` already defines the case-insensitive canonical dashed UUID pattern, and `services/tasks-api/src/routes/tasks/_validation.ts` exposes `parseTaskId()`. Reusing it prevents arbitrary text from being cast to UUID.

The checked-in contract says `q` searches title/description (`docs/designs/tasks/SPEC.md` and Python client help); tags use independent exact `tag`. AC2’s “tag search” is interpreted as preserving that path and its composition with `q`, not silently broadening `q` to tag names.

## Scope

**In scope**

- Full canonical UUID equality via `GET /api/v1/tasks?q=...`.
- Lower/upper-case UUID equivalence.
- Existing title/description substring and independent tag filtering.
- Route-unit, real-database integration, and Tasks app E2E coverage.
- App/system behavioural-contract updates.

**Out of scope**

- Partial/prefix, undashed, or fuzzy UUID lookup.
- Searching comments, dependencies, or owners.
- Pagination, sorting, auth, response-projection, schema, or index changes.
- Broadening `q` to tag names.

## Service boundary and data ownership

### Owning domain and service

`services/tasks-api` owns task/workflow state, identifiers, persistence, and list-query semantics. ID matching belongs there because the service composes it with archive/status/assignee/tag/ownership/pagination filters and owns the PostgreSQL UUID representation.

The Tasks app owns UI-local input/display state only. An app-side fetch-all/filter shim would duplicate semantics, disagree with pagination, and leave CLI/future consumers broken. No other service is appropriate: this is not Mission Control aggregation, shared UI, or a new product domain.

### Data and direct consumers

- `services/tasks-api`: owns `Task.id`, title, description, tags, and `GET /tasks`.
- `apps/tasks`: directly calls the endpoint through `apps/tasks/src/tasksApi.ts`.
- `agents/skills/ops/tasks-api/tasks_api_client.py`: exposes the endpoint through `list --q`.
- No cross-service writes or derived state.

### Extraction/migration plan

None. This lands at the durable API boundary, with no temporary placement, backfill, or service migration.

## Ownership boundary check

**Natural source of truth: API-owned resource and database-backed domain data.** The task UUID is the primary key of the Tasks API resource. The durable API fix is smaller than a UI shim: add one guarded ID branch to the existing predicate.

Only a full UUID adds exact ID equality. Ordinary text retains title/description search and cannot trigger an invalid PostgreSQL UUID cast.

## `.openclaw` boundary notes

No `.openclaw` work: no operator steps, secrets, dashboards, cron, OpenClaw config, or out-of-repo migration. Normal Tasks API/app deployment is sufficient; existing data is already correct.

## Implementation plan

### WS1 — API search predicate

**Files:** `services/tasks-api/src/routes/tasks.ts`; optionally `services/tasks-api/src/routes/tasks/_validation.ts` only for a small named helper.

1. Preserve current `q` shape validation and title/description clauses.
2. Pass `qValue` through `parseTaskId`.
3. On success, lowercase it and add exact `Task.id` equality inside the same `OR`.
4. On failure, add no ID branch.
5. Keep the `OR` nested in the top-level `where`, so all independent filters remain AND-composed.

Intended shape:

```ts
const taskIdQuery = parseTaskId(qValue)?.toLowerCase();

OR: [
  ...(taskIdQuery ? [{ id: taskIdQuery }] : []),
  { title: { contains: qValue, mode: 'insensitive' } },
  { description: { contains: qValue, mode: 'insensitive' } }
]
```

Exact syntax may adjust for generated `Prisma.TaskWhereInput`; ID equality is emitted only for a full UUID.

### WS2 — Client discoverability and shared contract

**Files:** `apps/tasks/src/App.jsx`, `apps/tasks/src/tasksApi.ts` (test/confirmation only), and `agents/skills/ops/tasks-api/tasks_api_client.py` (help only).

Keep debounce and `q` serialization. Update the search placeholder and Python `--q` help to mention full UUID. This changes documentation/discoverability, not client control flow.

### WS3 — Automated coverage

**Files:**

- `services/tasks-api/test/read-endpoints.test.ts`
- `services/tasks-api/test/taskSearch.integration.test.ts` (new)
- `services/tasks-api/vitest.integration.config.ts`
- `apps/tasks/test/e2e/task-search.spec.js` (new)

Route tests inspect Prisma `where`: full/uppercase UUID adds normalized ID and retains title/description; ordinary text adds no ID; `tag` stays alongside search `OR`.

The real-Postgres integration test seeds a test-owned UUID/title/description/tag and calls the real Express route/Prisma client. It verifies lowercase UUID, uppercase UUID, title, description, tag, and unknown UUID empty-list behaviour. It cleans only owned rows and is explicitly added to the integration config so CI runs it.

The Playwright spec follows existing `page.route('**/api/v1/tasks**')` fixtures. It fills Search with the reported UUID, waits through debounce, asserts complete `q`, and asserts the matching card. A second case returns no rows for an unknown UUID and asserts absence/empty state. E2E owns UI wiring; API integration owns database semantics.

### WS4 — Durable docs

**Files:** `apps/tasks/SPEC.md`, `docs/systems/tasks.md`, and this design’s frontmatter on ship.

Update “Filter the backlog” to include full UUID and link the E2E test. Update the existing Tasks system doc’s `GET /tasks` contract for title/description substring plus exact UUID, with `tag` separate. Do not create a new system doc.

## Data model and API contract changes

### Persistence

No model or migration. `Task.id` remains `String @id @default(uuid()) @db.Uuid`.

### Request

```http
GET /api/v1/tasks?q=<string>
```

- Every non-empty `q`: unchanged case-insensitive title/description substring match.
- Complete canonical dashed UUID: additionally exact `Task.id` match.
- UUID input is case-insensitive.
- Partial/malformed UUID-like text remains ordinary text and is never cast to UUID.
- `tag=<name>` remains independent case-insensitive exact filtering, AND-composed with `q`.

### Response

No shape/status/pagination/error change. Known UUID returns its normal list row. Unknown valid UUID returns `200` with empty `data` and existing page metadata, not `404`.

### Performance

Exact UUID equality uses the existing primary-key index. Existing text-search cost is unchanged; no index is added.

## Workflow, cron, and skill changes

- **Workflow:** none.
- **Cron:** none.
- **Skill:** none.
- **Tasks API CLI:** help text only; no logic change.
- **OpenClaw:** none.

## Test plan

### Acceptance-criterion verification matrix

| AC | Verification | Layer | Planned test |
|---|---|---|---|
| **AC1** — reported full UUID returns that task | Fill app Search; assert complete debounced `q` and visible matching card. Independently query a real seeded API task by UUID. | E2E + API integration | `apps/tasks/test/e2e/task-search.spec.js`; `services/tasks-api/test/taskSearch.integration.test.ts` |
| **AC2** — case-insensitive UUID; title, description, tag preserved | Query uppercase UUID, title, description, and tag. Route-test `tag` as sibling filter and title/description retained in `OR`. | API integration + route unit | integration spec; `services/tasks-api/test/read-endpoints.test.ts` |
| **AC3** — known and unknown UUID automated coverage | Real DB asserts known UUID returns exactly the seed and unknown valid UUID returns empty; E2E covers visible known/no-match flows. | API integration + E2E | the two new specs |

### Commands

```bash
npm test --workspace services/tasks-api
npm run test:integration --workspace services/tasks-api
npm test --workspace apps/tasks
npm run test:e2e --workspace apps/tasks -- task-search.spec.js
npm run typecheck --workspace services/tasks-api
```

Integration uses the repo’s normal test PostgreSQL/migrated schema, never production data.

## Open questions and risks

### Open questions

1. **Noted — AC2 terminology:** checked-in contracts implement tags through `tag`, not `q`. This design preserves that contract. If Tom intended `q` to search tag names, that is a separate product/API expansion.
2. **Noted — whitespace:** `parseTaskId()` trims before validation, while text uses original `qValue`. Do not globally trim `q`; that would change established free-text semantics.

### Risks

- **Noted — invalid UUID casts:** unconditional `{ id: qValue }` breaks text search. Guard with `parseTaskId()`.
- **Noted — mock-only confidence:** mocked route/E2E cannot prove PostgreSQL case behaviour. Add real-Postgres integration.
- **Noted — filter broadening:** misplaced ID matching could bypass filters. Keep it inside existing `q` `OR` and assert a combined tag query.
- **Noted — test collision:** use a test-owned UUID distinct from production; reserve the reported UUID for mocked E2E; clean only owned rows.
- **Noted — documentation drift:** update placeholder, CLI help, app spec, and system doc in the implementation PR.

## Decision summary

Implement exact, case-insensitive full-UUID matching in the Tasks API `q` predicate, guarded by the shared UUID validator. Keep the app thin, preserve existing search/filter behaviour, and verify route-unit, real-database integration, and user-visible E2E layers.
