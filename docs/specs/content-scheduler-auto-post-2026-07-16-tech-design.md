---
status: draft
task_id: ac74e9bb-beb6-4d97-b604-8102d35176ee
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Content Scheduler: event-driven auto-post — tech design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/ac74e9bb-beb6-4d97-b604-8102d35176ee`

## Task and repository

- Task ID: `ac74e9bb-beb6-4d97-b604-8102d35176ee`
- Task title: `🔧 Content Scheduler: Event-Driven Auto-Post`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-ac74e9bb-content-scheduler-auto-post`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-ac74e9bb-content-scheduler-auto-post`

## Product intent summary

Approved Content Scheduler items should publish automatically when `scheduledFor` arrives. The existing approval gate remains the control surface: only items in `approved` status are eligible, and manual Publish remains available for on-demand posting. The trigger must be event-driven: writing or changing `scheduledFor` on an approved item schedules a delayed job rather than relying on a polling loop or an in-process sleep timer. Failed auto-posts remain visible to Tom through `publishError` and are not retried automatically.

## Service boundary and data ownership

- Current repo state has Content Scheduler routes, publish guard logic, Prisma model, and tests under `services/tasks-api`. The design below names those files because that is the current implementation branch surface.
- There is already a draft service-extraction design at `docs/specs/content-scheduler-service-extraction-tech-design.md`. If that extraction lands first, apply the same design in `services/content-scheduler-api` instead of `services/tasks-api`; the queue adapter and worker should move with the Content Scheduler service boundary. Mission Control should continue to call the same public `/api/v1/content-scheduler/*` contract.
- Domain owner: Content Scheduler owns queue state, approval metadata, scheduled job identity, publish guards, X publish integration, and published metadata.
- Consumers: `apps/mission-control` reads scheduler state through `apps/mission-control/src/contentSchedulerApi.js`. `apps/tasks` is not directly involved except that this feature task is tracked in the Tasks API.
- Core publish logic should stay independent of the queue provider. The worker calls the same publish service used by the manual `POST /items/:id/publish` path so guard behavior cannot drift.

## `.openclaw` boundary notes

- No secrets or `.openclaw` file edits are required for the design or implementation. X credentials remain environment-injected and must not be committed.
- No `.openclaw` cron should be added for this task. The implementation should be event-driven through a job queue and a repo-owned worker process, not Quinn's local cron.
- If production deployment needs the worker process registered in a host-specific supervisor, Quinn should handle that outside the repo after reviewing the implementation. The repo change should document the worker command and local dev startup path, but not write to runtime scheduler files.

## Implementation plan

### 1. Introduce a scheduler adapter abstraction

Add a small provider-neutral interface near the Content Scheduler backend code:

- Preferred current path: `services/tasks-api/src/routes/contentSchedulerJobs.ts` or `services/tasks-api/src/contentScheduler/jobs.ts` if the implementation splits route helpers out of `routes/`.
- If service extraction lands first: equivalent path under `services/content-scheduler-api/src/`.

Interface shape:

```ts
export type ContentSchedulerJob = {
  itemId: string;
  scheduledFor: Date;
  scheduleVersion: number;
};

export interface JobSchedulerAdapter {
  scheduleAutoPost(job: ContentSchedulerJob): Promise<{ jobId: string }>;
  cancelAutoPost(jobId: string): Promise<void>;
}
```

The route layer uses only this adapter. The concrete local provider can be BullMQ backed by Redis, but the adapter keeps managed delayed queues replaceable later without touching the publish guard or route code.

### 2. Local delayed-job implementation

Add BullMQ + Redis as the local implementation:

- Add dependencies to the owning service package: `bullmq` and `ioredis` (or BullMQ's required Redis client version if package conventions differ).
- Add `services/tasks-api/src/contentScheduler/bullMqScheduler.ts` (or extracted-service equivalent) implementing `JobSchedulerAdapter` with `queue.add('content-scheduler-auto-post', payload, { delay, jobId })`.
- Compute `delay = max(0, scheduledFor.getTime() - Date.now())` at enqueue time. Immediate or past schedules enqueue with zero delay.
- Use deterministic provider job IDs such as `content-scheduler-auto-post:<itemId>:<scheduleVersion>` so duplicate route calls are idempotent and stale jobs are distinguishable.
- Do not use an in-process `setTimeout` as the scheduler. BullMQ's delayed set persists through process restarts and maps cleanly to a managed queue later.
- Add Redis connection config with clear env names, e.g. `CONTENT_SCHEDULER_REDIS_URL` falling back to `REDIS_URL`, and document local defaults in the owning service README.

### 3. Add a worker entrypoint

Add a long-running worker process that consumes delayed jobs:

- File: `services/tasks-api/src/contentScheduler/autoPostWorker.ts` (or `services/content-scheduler-api/src/contentScheduler/autoPostWorker.ts` after extraction).
- Package scripts:
  - `content-scheduler:worker`: run the worker once as a process.
  - optional `content-scheduler:worker:dev`: `tsx watch` variant for local development.
- The worker registers a BullMQ `Worker` for the queue name, logs startup, and handles graceful shutdown on `SIGINT`/`SIGTERM`.
- Worker handler flow:
  1. Load the item by `itemId`.
  2. If not found, `removed`, `published`, or no longer `approved`, exit cleanly with a structured log.
  3. Compare job `scheduleVersion` with the item's current `autoPostScheduleVersion`; stale jobs exit cleanly.
  4. Confirm `scheduledFor <= now` with small clock-skew tolerance. If the queue fired early, reschedule using the adapter and exit.
  5. Call the shared publish service, not the Express route. The service should reuse `guardPublish`, `getXClient`, and the existing DB updates for success/failure.
  6. On publish failure, write `publishError`, leave status `approved`, and return success to BullMQ so there is no automatic retry.
- Configure BullMQ attempts as `attempts: 1` and `removeOnComplete`/`removeOnFail` according to observability needs. Domain failures should not surface as queue retries.

### 4. Refactor publish path into a reusable service

The current manual publish route owns orchestration in `services/tasks-api/src/routes/contentScheduler.ts` and uses helpers from `contentSchedulerPublish.ts`. Extract a callable service so manual and automatic paths share exactly one write path:

- Add `publishContentSchedulerItem({ itemId, actor, source })` in `contentSchedulerPublish.ts` or a new `contentSchedulerPublishService.ts`.
- Inputs:
  - `actor`: `Tom` for manual routes, `auto-post-worker` for worker jobs.
  - `source`: `manual` or `auto` for logs/tests.
- Responsibilities:
  - load item;
  - run `guardPublish`;
  - resolve X client;
  - post to X;
  - update `status='published'`, `publishedAt`, `publishedUrl`, `publishError=null` on success;
  - update only `publishError` and keep `status='approved'` on X/client failure;
  - return structured result codes the route can map to HTTP statuses.
- The route `POST /content-scheduler/items/:id/publish` becomes a thin HTTP wrapper around the service.

### 5. Enqueue on approval and schedule updates

In the Content Scheduler write routes:

- `POST /content-scheduler/items/:id/approve`: after setting `status='approved'`, enqueue if `scheduledFor` is non-null.
- `PATCH /content-scheduler/items/:id`: if an approved item's `scheduledFor` changes, enqueue a replacement delayed job.
- Optional but recommended: if `scheduledFor` is cleared, cancel the current job if the provider supports cancellation and increment the schedule version so any already-delayed job becomes stale.
- `POST /content-scheduler/items/:id/unapprove`, `remove`, and successful manual `publish`: cancel the current job when possible and always increment or clear queue state so in-flight stale jobs exit cleanly.
- `POST /content-scheduler/items` does not enqueue by itself unless the create route allows immediate creation in `approved` status. Current behavior creates `queued`, so no job is created on initial compose.

The enqueue should happen after the database write succeeds. If enqueue fails, return a clear 503/500 from the write route and do not pretend the auto-post is scheduled. If the DB write has already committed, leave the item approved but set `publishError` to an operational scheduling message or include a clear API error so Tom can manually publish; implementation should choose one and test it.

### 6. Mission Control UI refresh behavior

No WebSocket/SSE is needed. `apps/mission-control/src/tabs/ContentSchedulerTab.jsx` already reloads after mutations. For auto-posted items, add or confirm a ≤10s background refresh while the Content tab is mounted:

- Use a 10-second `setInterval` in the tab component to call `reload()`/`getTodayStatus()` while mounted.
- Keep the interval UI-only; it does not drive publishing and is not the backend trigger.
- Ensure rows display existing `publishedAt`, `publishedUrl`, and `publishError` fields after reload.

### 7. Runtime/dev workflow

- Add a Redis service to local dev compose/Tilt/Make only if the repo's dev stack already has a central place for service dependencies. If no such stack exists, document a minimal `docker run redis` command in the owning service README and keep code defaults explicit.
- Add scripts to run API and worker separately. Production must run both the API process and the worker process against the same DB + Redis/queue provider.
- Do not add cron. The worker is event-driven because delayed jobs are scheduled by writes and then delivered by the queue.

## Data model and API contract changes

### ContentSchedulerItem fields

Add queue bookkeeping to `ContentSchedulerItem`:

```prisma
autoPostJobId            String?
autoPostScheduleVersion  Int      @default(0)
autoPostScheduledAt      DateTime?
autoPostLastEnqueuedAt   DateTime?
```

Field meaning:

- `autoPostJobId`: provider job identifier for best-effort cancellation/debugging.
- `autoPostScheduleVersion`: monotonically increments whenever an item's effective auto-post schedule is changed, cleared, unapproved, removed, or manually published. Worker jobs carry this value and exit if stale.
- `autoPostScheduledAt`: the `scheduledFor` value captured when the current job was enqueued.
- `autoPostLastEnqueuedAt`: operational timestamp for UI/debugging/tests.

Existing fields remain the core product state:

- `publishError`: stores X/client/worker publish failure visible to Tom.
- `publishedAt`: populated on successful manual or automatic publish.
- `publishedUrl`: populated with the X URL on successful manual or automatic publish.
- `scheduledFor`: business schedule time chosen by Tom.

### Queue state

BullMQ stores delayed queue state in Redis. The application should not depend on BullMQ's internal schema beyond the adapter. The database fields above are the durable cross-provider reconciliation state and make stale delayed jobs safe.

### API response

`GET /content-scheduler/items` can include the new `autoPost*` fields for observability, but Mission Control does not need to render them in v1. Avoid exposing provider-specific details beyond `autoPostJobId` unless useful for debugging.

## Workflow, cron, and skill changes

- Cron: none. Do not implement a polling cron or heartbeat scanner for eligible items.
- Worker: add a repo-owned Content Scheduler worker process and document how to run it locally and in production.
- Skills: no skill changes required. Existing Tasks API skill is only used to post task comments for this feature workflow.
- Mission Control: UI polling every ≤10s is allowed only for freshness after auto-post; it is not part of the publish trigger.

## Test plan

### Automated tests

- Backend unit tests for the adapter-facing scheduling decisions:
  - approving an item with `scheduledFor` enqueues a delayed job;
  - patching `scheduledFor` on an approved item increments `autoPostScheduleVersion` and enqueues a replacement;
  - clearing `scheduledFor`, unapproving, removing, or manually publishing prevents stale delayed jobs from publishing.
- Backend worker tests with a fake `JobSchedulerAdapter` and fake X client:
  - eligible approved item publishes and writes `publishedAt`/`publishedUrl`;
  - unapproved/queued/published/removed items exit cleanly;
  - stale `scheduleVersion` exits cleanly;
  - X/client failure writes `publishError`, leaves status `approved`, and does not ask the queue to retry.
- Integration tests for BullMQ/Redis can be added if the service test harness supports Redis. If not, cover the provider through adapter unit tests and one documented local smoke.
- Mission Control component test for the ≤10s mounted refresh path: with `vi.useFakeTimers()`, advance the timer and assert `listItems`/`getTodayStatus` are called and published metadata appears.
- Existing manual publish tests should remain green and should assert manual publish still uses the same guard semantics.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Integration-testable. Seed/create an approved item with near-future `scheduledFor`, enqueue through the write path, run the worker handler with fake X client, then assert item becomes `published` without calling the manual route. | Backend integration or worker-service test asserting `publishedAt` and `publishedUrl` are populated. |
| AC2 | Design-validation AC. Code review confirms writes call `JobSchedulerAdapter.scheduleAutoPost()` and no backend polling loop, cron scanner, or sleep timer drives publish. Unit tests assert approve/patch call the adapter. | Tech/design review plus adapter-call tests. |
| AC3 | Integration-testable. Run worker for jobs whose item is now `queued`, `removed`, or `published`, and for stale schedule versions. | Worker tests assert clean no-op and no thrown error/no publish call. |
| AC4 | Integration-testable. Stub X client/credentials failure in worker publish path. | Worker/publish-service test asserts `publishError` written, `status` remains `approved`, and queue attempts are not retried. |
| AC5 | Design-validation AC. Adapter boundary isolates BullMQ from route/publish logic; DB carries provider-neutral stale-job state. | Code review of `JobSchedulerAdapter` usage and absence of BullMQ imports outside provider/worker bootstrap. |
| AC6 | Integration-testable. After worker publish, Mission Control mounted refresh sees updated item within one 10s timer interval. | Component test with fake timers plus backend publish-service test for `publishedAt`/`publishedUrl`. |

## Open questions and risks

1. **Service extraction ordering.** If `services/content-scheduler-api` lands before this implementation, implement the worker there. If not, keep the current `services/tasks-api` placement but avoid coupling the adapter to Tasks-specific code so extraction stays easy.
2. **Redis availability.** BullMQ needs Redis in local and production runtime. The repo may need a dev dependency service documented or added to compose/Tilt. Keep this as repo config, not `.openclaw` cron.
3. **Schedule enqueue failure semantics.** The safest product behavior is to surface scheduling failure immediately and keep manual Publish available. Implementation should choose whether to store an operational `publishError` on enqueue failure; Quinn should approve the exact UX.
4. **Clock and timezone.** `scheduledFor` is stored as UTC `DateTime`; the worker compares absolute time, while daily cap continues to use Pacific/Auckland. Tests should avoid relying on local machine timezone.
5. **Duplicate/stale delayed jobs.** Delayed queues usually cannot guarantee perfect cancellation after a job becomes active. The `autoPostScheduleVersion` check is mandatory defense-in-depth.
6. **No automatic retry.** BullMQ defaults can retry if configured. This task must set attempts to one and convert domain publish failures into completed jobs after writing `publishError`.
7. **Provider lock-in.** BullMQ is acceptable locally, but BullMQ types/imports should not leak into route or publish-service code. That is the main AC5 review point.
