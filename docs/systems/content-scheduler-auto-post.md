# Content Scheduler — Event-Driven Auto-Post

**Status:** Live  
**Last updated:** 2026-07-17  
**Owner:** Rowan (engineering) · Tom (product)  
**Repos:** `Stoffer-Industries/sindustries`  
**Related PR:** https://github.com/Stoffer-Industries/sindustries/pull/245  
**Related tasks:** ac74e9bb-beb6-4d97-b604-8102d35176ee  
**Related tech design:** [`docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md`](../specs/content-scheduler-auto-post-2026-07-16-tech-design.md)  
**Related product spec:** `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md`

---

## What this is

A delayed-job trigger that auto-publishes approved Content Scheduler items when their `scheduledFor` timestamp arrives. The trigger is **event-driven** through a provider-neutral `JobSchedulerAdapter` — no polling loop, no in-process sleep timer. The implementation is cloud-native compatible: swapping the in-process adapter for a managed queue service (BullMQ + Redis locally; Fly.io delayed tasks or similar in production) is a single-class change.

The product truth remains the existing Content Scheduler model (`status` / `scheduledFor` / `publishedAt` / `publishedUrl` / `publishError`). The auto-post flow is purely operational — manual Publish is still available for on-demand posting.

---

## Architecture and ownership

### Code

- `services/tasks-api/src/routes/contentScheduler.ts` — Express routes. Enqueues a delayed job on approve, on `PATCH` of `scheduledFor`, and cancels on unapprove, remove, and successful manual publish.
- `services/tasks-api/src/routes/contentSchedulerJobs.ts` — `JobSchedulerAdapter` interface + `decideAutoPostAction` pure helper. The single point of contact between route/publish code and any queue provider.
- `services/tasks-api/src/routes/contentSchedulerJobs.inProcess.ts` — in-process adapter (default). One `setTimeout` per job, deterministic `in-process:<itemId>:<version>` ids. Survives for the lifetime of the API process. No Redis required.
- `services/tasks-api/src/routes/contentSchedulerJobs.bullmq.ts` — BullMQ placeholder. Throws on use until `bullmq` + `ioredis` are wired in production.
- `services/tasks-api/src/routes/contentSchedulerPublishService.ts` — `publishContentSchedulerItem` shared service. The single write path used by both the manual `POST /items/:id/publish` route and the auto-post worker so guard semantics cannot drift.
- `services/tasks-api/src/routes/autoPostWorker.ts` — `processAutoPostJob` worker function. Reconciles against current item state, handles clock skew via reschedule, returns structured outcomes.
- `services/tasks-api/src/autoPostWorkerMain.ts` — worker entrypoint. `npm run content-scheduler:worker` from `services/tasks-api`.
- `apps/mission-control/src/tabs/ContentSchedulerTab.jsx` — UI. Adds a 10s `setInterval` to refresh `listItems` + `getTodayStatus` while the tab is mounted (AC6).

### Data

- New Prisma fields on `ContentSchedulerItem` (see migration `20260717000000_add_content_scheduler_auto_post_fields`):
  - `autoPostJobId` — provider job id (for best-effort cancellation and debugging)
  - `autoPostScheduleVersion` — monotonically incremented on every state change; the worker's stale-job defense
  - `autoPostScheduledAt` — `scheduledFor` snapshot at enqueue time
  - `autoPostLastEnqueuedAt` — operational timestamp

### Ownership

- **Engineering:** Rowan. Bug fixes, queue-provider swap, schema changes.
- **Product:** Tom. AC verification, QA sign-off via `[qa-ac-verified] true`.
- **Cloud migration:** Quinn. The BullMQ adapter wire-up when Mission Control moves to a cloud runtime.

---

## Runtime behaviour and operational flow

### Trigger path

1. Tom approves an item (or `PATCH /items/:id` with a new `scheduledFor`).
2. The route layer calls `decideAutoPostAction(prior, next)`. Pure function that returns `schedule` / `cancel` / `noop`.
3. The route layer applies the decision through the registered `JobSchedulerAdapter`:
   - `schedule` → `adapter.scheduleAutoPost({itemId, scheduledFor, scheduleVersion})` → returns `{jobId}`. The route persists `autoPostJobId`, bumps `autoPostScheduleVersion`, and stamps `autoPostScheduledAt` + `autoPostLastEnqueuedAt`.
   - `cancel` → `adapter.cancelAutoPost(jobId)` (best-effort). The route bumps `autoPostScheduleVersion` and clears `autoPostJobId`.
4. The adapter fires the job once at `scheduledFor` and calls the registered handler with the job payload.

### Worker path (job handler)

1. `processAutoPostJob({itemId, scheduledFor, scheduleVersion})` loads the current item from the DB.
2. Early-exit checks (return structured `rejected-*` outcomes without publishing):
   - Item missing → `rejected-not-found`
   - Status `removed` → `rejected-removed`
   - Status `published` → `rejected-already-published`
   - `item.autoPostScheduleVersion > job.scheduleVersion` → `rejected-stale-version` (defense in depth against missed cancellations)
   - `item.scheduledFor > now + 1s` → `rescheduled-early-fire` (clock skew; re-enqueues for the remaining delay)
3. Calls `publishContentSchedulerItem(itemId, 'auto')` (shared service).
4. On success, clears `autoPostJobId`, bumps `autoPostScheduleVersion`, stamps `autoPostLastEnqueuedAt`.
5. On failure (X API error, missing credentials), the publish service writes `publishError` and leaves `status='approved'`. The worker returns `failed-publish-error` or `failed-missing-credentials`. The queue adapter is configured to **not** retry (domain failures are terminal — Tom re-triggers manually via the existing Publish button).

### Schedule state machine

| Prior status | New status | New scheduledFor | Action |
| --- | --- | --- | --- |
| any | `published` | (n/a) | cancel any prior job, bump version |
| any | `removed` | (n/a) | cancel any prior job, bump version |
| any non-approved | (n/a) | (n/a) | cancel any prior job |
| `approved` | `approved` | cleared | cancel any prior job |
| `approved` | `approved` | unchanged + job present | `noop` |
| `approved` (or other) | `approved` | set / changed | schedule (or replace) job, version+1 |

---

## Data contracts, API fields, task comments

### API

- `POST /api/v1/content-scheduler/items/:id/approve` — enqueues a delayed job when `scheduledFor` is non-null. Returns 503 `AUTO_POST_SCHEDULE_FAILED` if the adapter rejects the enqueue.
- `PATCH /api/v1/content-scheduler/items/:id` — re-evaluates the schedule when `scheduledFor` changes. Returns 503 `AUTO_POST_SCHEDULE_FAILED` if the adapter rejects.
- `POST /api/v1/content-scheduler/items/:id/unapprove` / `…/remove` — cancels any in-flight delayed job.
- `POST /api/v1/content-scheduler/items/:id/publish` — on success, cancels any in-flight delayed job and bumps the schedule version.
- `GET /api/v1/content-scheduler/items` — includes the new `autoPost*` fields in the response. Mission Control ignores them in v1; they are available for debugging and future UI work.

### DB fields (ContentSchedulerItem)

| Field | Type | Notes |
| --- | --- | --- |
| `autoPostJobId` | `String?` | provider job id; null when no job is queued |
| `autoPostScheduleVersion` | `Int @default(0)` | monotonic; worker's stale-job defense |
| `autoPostScheduledAt` | `DateTime?` | `scheduledFor` at enqueue time |
| `autoPostLastEnqueuedAt` | `DateTime?` | operational timestamp |

### Env vars

- `CONTENT_SCHEDULER_JOB_ADAPTER` — `in-process` (default) or `bullmq`. The API entrypoint must install the matching adapter at boot.
- `CONTENT_SCHEDULER_REDIS_URL` / `REDIS_URL` — Redis connection string. Used by the (not-yet-wired) BullMQ adapter.

### Task comment

- `[system-spec] docs/systems/content-scheduler-auto-post.md` (this doc) — required for the task to move from `doing` to `acceptance`.

---

## In-process adapter: durability and isolation limitations

The default `JobSchedulerAdapter` is the in-process implementation (`services/tasks-api/src/routes/contentSchedulerJobs.inProcess.ts`). It is correct for local development but has two failure modes every operator must understand before relying on auto-post in any non-local environment.

### Durability: pending jobs are lost on process restart

The in-process adapter stores every pending job in a single `Map<string, Entry>` (line 46) keyed by an internal job id and fires each one with `setTimeout` + `unref()` (lines 97–112). There is no disk persistence, no replay log, and no recovery path on boot. Any pending job is silently lost on:

- a clean API restart (deploy, signal-triggered shutdown, container scale-in);
- an API crash (out-of-memory, unhandled rejection, host reboot);
- `setTimeout` reaching its unref'd tail in a busy event loop — the timer is intentionally not ref'd so it never blocks process exit, but this also means it can be dropped before firing.

Recovery for lost jobs is manual: Tom clicks the existing Publish button on each affected item (the route calls `publishContentSchedulerItem`, the same code path the worker would have used). Bulk re-hydration from the DB is not wired into the in-process adapter.

### Isolation: the worker entrypoint's Map is a separate, empty instance

`npm run content-scheduler:worker` boots `services/tasks-api/src/autoPostWorkerMain.ts`, which calls `createInProcessJobSchedulerAdapter()` (line 21) and `setJobSchedulerAdapter(adapter, 'in-process')`. That adapter instantiates its OWN local `Map<string, Entry>` inside the worker process — a different map from the one in the API process. Consequence:

- The worker process never receives delayed jobs enqueued by the API.
- The worker process only fires jobs its own boot path enqueued — and the worker has no enqueue path. It only attaches a handler to the in-process adapter via `adapter.setHandler(...)`.
- Result: the worker runs, accepts `SIGINT` cleanly, and processes zero jobs against API-enqueued work.
- The auto-post worker is therefore a **silent no-op** against API-enqueued jobs while `CONTENT_SCHEDULER_JOB_ADAPTER=in-process`. Running `npm run content-scheduler:worker` does not pick up any in-flight jobs the API scheduled, even though both processes are healthy and reachable.

### When the in-process adapter is appropriate

The in-process adapter is fine for local development and short-lived single-process deploys where losing a handful of scheduled posts to a restart is acceptable. It is **not** appropriate for any environment where:

- API processes can restart or crash (all current candidate deploy targets);
- the API and the worker run as separate processes (all current candidate deploy topologies);
- automatic recovery of `approved` items with `scheduledFor > now` after boot is required.

The production fix is to switch to the BullMQ adapter (`services/tasks-api/src/routes/contentSchedulerJobs.bullmq.ts`) by setting `CONTENT_SCHEDULER_JOB_ADAPTER=bullmq` plus a Redis URL; both processes then enqueue and consume against the same Redis-backed queue, so jobs survive restarts and the worker entrypoint becomes a real consumer. The BullMQ adapter is currently a throw-stub and requires wiring before the swap.

---

## Runbook notes and common failure modes

### "Item is `approved` with `scheduledFor` but never auto-posts"

- Check that the worker process is running: `npm run content-scheduler:worker` in `services/tasks-api`. The in-process adapter is per-process, so jobs scheduled by the API process are not visible to a separate worker process unless both are using a shared provider (BullMQ in production).
- Check `publishError` on the item for X API / credential failures.
- Check the `autoPostScheduleVersion` — if it has been bumped, the prior job is stale and the worker will exit cleanly when it fires.

### "Duplicate tweets from auto-post"

- The publish service is idempotent for already-`published` items (no re-post). Duplicate tweets indicate a missing or stale-version guard, or that the API process lost its in-process adapter state (e.g. crash and restart). Production should switch to BullMQ so delayed jobs survive restarts.

### "Item was approved, then unapproved, then a delayed job fires"

- Worker checks item status first; an unapproved item exits with `rejected-not-approved`. No publish, no error written. The `autoPostScheduleVersion` bump on unapprove means the worker also has a defense-in-depth check.

### Clock skew

- If the queue fires a job before `scheduledFor + 1s`, the worker reschedules for the remaining delay and returns `rescheduled-early-fire`. The new job carries the bumped `autoPostScheduleVersion`. This is rare in practice but covers the case where BullMQ's delayed set fires slightly early.

### Manual retry after a failed auto-post

- Tom clicks the existing Publish button on the item. The route calls `publishContentSchedulerItem(itemId, 'manual')` (the shared service, same code path the worker would have used), which:
  - Clears `publishError` on success
  - Re-writes `publishError` on failure
  - Returns the same `PUBLISH_FAILED` / `MISSING_CREDENTIALS` codes the worker would have returned

### Production swap to BullMQ

- Add `bullmq` and `ioredis` to `services/tasks-api` dependencies.
- Replace the throw-stub in `contentSchedulerJobs.bullmq.ts` with the real adapter (the comment in that file lists the steps).
- Set `CONTENT_SCHEDULER_JOB_ADAPTER=bullmq` and `CONTENT_SCHEDULER_REDIS_URL` (or `REDIS_URL`) in the API and worker environments.
- Run the API process and the worker process against the same Redis. Multiple worker replicas are safe — BullMQ's `jobId` is the deterministic `in-process:<itemId>:<version>` string so duplicate enqueues collapse.
- The route, publish service, and worker code do not change. The interface boundary (AC5) makes the swap a one-class change.

---

## Related specs, tasks, and PRs

- Tech design: [`docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md`](../specs/content-scheduler-auto-post-2026-07-16-tech-design.md)
- Product spec: `brain/tasks/specs/in-progress/content-scheduler-auto-post-2026-07-16.md`
- Implementation PR: https://github.com/Stoffer-Industries/sindustries/pull/245
- Task: ac74e9bb-beb6-4d97-b604-8102d35176ee
- Related Content Scheduler work:
  - Tab (manual publish): task 115e8d89-be43-4b81-9e0e-9ab422810f5f
  - Calendar view (in flight): task 95e65d06-e529-466e-a6b0-d8dfb1e2eb87
- Service-extraction design (future): `docs/specs/content-scheduler-service-extraction-tech-design.md` — when Content Scheduler is extracted to its own service, the worker + adapter move with it.
