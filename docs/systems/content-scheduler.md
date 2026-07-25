# Content Scheduler

**Status:** Live (calendar view + event-driven auto-post shipped)
**Last updated:** 2026-07-25
**Owner:** Rowan (engineering) · Tom (product)
**Repos:** `Stoffer-Industries/sindustries`
**Related PRs:**
- [PR #213](https://github.com/Stoffer-Industries/sindustries/pull/213) — original Content Scheduler tab + backend (task 115e8d89)
- [PR #257](https://github.com/Stoffer-Industries/sindustries/pull/257) — 10-day calendar view (task 95e65d06)
- [PR #245](https://github.com/Stoffer-Industries/sindustries/pull/245) — event-driven auto-post (task ac74e9bb)

**Related tasks:** `115e8d89` (initial tab), `95e65d06` (calendar view), `ac74e9bb` (auto-post), `94d5e4fc` (future service extraction)
**Related tech designs:**
- [Tab + backend](../specs/content-scheduler-tab-tech-design.md)
- [Calendar view](../specs/content-scheduler-calendar-view-2026-07-16-tech-design.md)
- [Auto-post](../specs/content-scheduler-auto-post-2026-07-16-tech-design.md)
- [Service extraction](../specs/content-scheduler-service-extraction-tech-design.md)

---

## What this is

The Content Scheduler is the Mission Control tab that lets Tom queue tweet copy, schedule it to specific days, and publish to X without leaving the shell. The primary view is a 10-day forward calendar (today through today + 9) in `Pacific/Auckland`. Each day is a column; approved, queued, and published items appear as cards on their scheduled day. Items without a `scheduledFor` in the window land in an Unscheduled overflow area. Tom drags cards between day columns to reschedule; published cards are read-only and each day column enforces a hard "max one published per day" rule with an inline error if violated.

Manual publish is still available. Auto-publish of approved items whose `scheduledFor` has arrived is an **event-driven** delayed-job trigger with no polling loop — see [§ Auto-post](#auto-post-event-driven-delayed-jobs) below.

---

## Architecture and ownership

### Code

- `apps/mission-control/src/tabs/ContentSchedulerTab.jsx` — UI. Composer at the top, 10-day calendar grid below, "Unscheduled" overflow section after the grid, day-status banner at the bottom. Adds a 10s `setInterval` to refresh `listItems` + `getTodayStatus` while the tab is mounted (AC6).
- `apps/mission-control/src/tabs/contentSchedulerCalendar.js` — pure helpers: `buildCalendarDays`, `getAucklandDayKey`, `getAucklandTimeOfDay`, `zonedDateTimeToIso` (handles NZST/NZDT offset + DST start), `rescheduleIsoForDay`, `groupItemsForCalendar`, `dayDropBlocked`.
- `apps/mission-control/src/contentSchedulerApi.js` — Mission Control API client (list/create/update/approve/unapprove/publish/remove/reorder + today-status).
- `apps/mission-control/src/styles/components.css` — calendar grid CSS (10-column flex grid, `Unscheduled` panel, drop-target outline).
- `services/tasks-api/src/routes/contentScheduler.ts` — Express routes. Mounted under `/api/v1`. Enqueues a delayed auto-post job on approve and on `PATCH` of `scheduledFor`; cancels on unapprove, remove, and successful manual publish.
- `services/tasks-api/src/routes/contentSchedulerPublish.ts` — `guardPublish`, `XClient` interface, `RealXClient` (OAuth 1.0a), `FakeXClient` (CI), `getXClient()`, `getAucklandTodayParts()`.
- `services/tasks-api/src/routes/contentSchedulerPublishService.ts` — `publishContentSchedulerItem` shared between manual and auto-post paths so guard semantics cannot drift.
- `services/tasks-api/src/routes/contentSchedulerJobs.ts` — `JobSchedulerAdapter` interface + `decideAutoPostAction` pure helper. The single point of contact between route/publish code and any queue provider.
- `services/tasks-api/src/routes/contentSchedulerJobs.inProcess.ts` — default adapter. One `setTimeout` per job, deterministic `in-process:<itemId>:<version>` ids. Survives for the lifetime of the API process. No Redis required. **See limitations below.**
- `services/tasks-api/src/routes/contentSchedulerJobs.bullmq.ts` — BullMQ placeholder. Throws on use until `bullmq` + `ioredis` are wired in production.
- `services/tasks-api/src/routes/autoPostWorker.ts` — `processAutoPostJob` worker function. Reconciles against current item state, handles clock skew via reschedule, returns structured outcomes.
- `services/tasks-api/src/autoPostWorkerMain.ts` — worker entrypoint. `npm run content-scheduler:worker` from `services/tasks-api`.
- `services/tasks-api/prisma/schema.prisma` — `ContentSchedulerItem` model + `ContentSchedulerItemStatus` / `ContentSchedulerSource` enums + `autoPost*` fields.
- `apps/mission-control/SPEC.md` — Mission Control behavioural contract (Flow 7).

### Service boundary

The Content Scheduler backend currently lives inside `services/tasks-api` for historical reasons (PR #213 landed before the service-extraction work). This is treated as **temporary coupling**. A dedicated `services/content-scheduler-api` is planned under task `94d5e4fc`; the design at [`docs/specs/content-scheduler-service-extraction-tech-design.md`](../specs/content-scheduler-service-extraction-tech-design.md) defines the extraction. Mission Control will call Content Scheduler API directly once the extraction lands — it should not get an aggregate backend.

Mission Control owns the calendar UI. The Tasks API owns the data plane until extraction. The X (Twitter) API is reached only through the server-side `XClient` abstraction; the browser never holds X credentials.

---

## Data model

### `ContentSchedulerItem` (Prisma)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | server-assigned |
| `body` | `VarChar(1000)` | tweet copy; max 1000 chars |
| `source` | `ContentSchedulerSource` | `ops_notes` \| `cto_craft` \| `manual` \| `other` |
| `sourceRef` | `String?` | optional URL/reference back to the source signal |
| `status` | `ContentSchedulerItemStatus` | `draft` \| `queued` \| `approved` \| `published` \| `removed` |
| `scheduledFor` | `DateTime?` | optional ISO timestamp; drives calendar placement and auto-post |
| `position` | `Int` | ascending sort within `queued` items (manual reorder) |
| `approvedAt` | `DateTime?` | set when explicit approval recorded; required before publish |
| `approvedBy` | `String?` | actor name (currently `Tom`) |
| `publishedAt` | `DateTime?` | server timestamp on successful publish |
| `publishedUrl` | `String?` | X post URL returned by publish integration |
| `publishError` | `String?` | last publish failure reason; surfaced in UI and on item |
| `autoPostJobId` | `String?` | provider job id; null when no job is queued |
| `autoPostScheduleVersion` | `Int @default(0)` | monotonic; worker's stale-job defense |
| `autoPostScheduledAt` | `DateTime?` | `scheduledFor` at enqueue time |
| `autoPostLastEnqueuedAt` | `DateTime?` | operational timestamp |
| `createdAt`, `updatedAt` | `DateTime` | Prisma `@default(now())` / `@updatedAt` |
| `removedAt` | `DateTime?` | soft-delete marker |

Indexes: `(status, position)`, `(status, scheduledFor)`, `(status, publishedAt)`.

Terminal statuses: `published`, `removed`. Items in `removed` are kept in the table for audit and are not returned by the default `GET /items` listing.

The `autoPost*` fields landed in migration `20260717000000_add_content_scheduler_auto_post_fields`.

### Status state machine

```
        create
   ──►  queued  ──approve──►  approved  ──publish──►  published
            │                    │                       │
            ├──remove──► removed ├──remove──► removed  └───(terminal)
            │                    │
            └────unapprove───────┘
```

- `draft` exists for parity with the earlier spec but the current UI composes items directly into `queued`. `draft` is reserved for future "save without queue" affordances.
- `published` is reached only via `POST /items/:id/publish` (manual) or via the auto-post worker. Both call the shared `publishContentSchedulerItem` service.
- `removed` is a soft-delete; rows are retained.

---

## API surface

All routes are mounted under `/api/v1` from `services/tasks-api/src/app.ts`. CORS allows `x-actor` so the Mission Control client can send the operator identity.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/content-scheduler/items` | List non-`removed` items. Includes the `autoPost*` fields. Used by the calendar grouping helper. |
| `POST` | `/content-scheduler/items` | Create a new item. Defaults: `status=queued`, `source=manual`, `position=next` |
| `PATCH` | `/content-scheduler/items/:id` | Edit `body`, `scheduledFor`, `source`, `sourceRef`. Reschedules preserve HH:MM client-side; server stores ISO. Re-evaluates the auto-post schedule when `scheduledFor` changes. Returns 503 `AUTO_POST_SCHEDULE_FAILED` if the adapter rejects. |
| `POST` | `/content-scheduler/items/:id/approve` | Set `approvedAt`/`approvedBy`. Enqueues auto-post job. Returns 503 `AUTO_POST_SCHEDULE_FAILED` if the adapter rejects the enqueue. |
| `POST` | `/content-scheduler/items/:id/unapprove` | Clear approval. Cancels auto-post job. |
| `POST` | `/content-scheduler/items/:id/publish` | Manual publish. Runs `guardPublish` then `publishContentSchedulerItem`. On success, cancels any in-flight delayed job and bumps the schedule version. |
| `POST` | `/content-scheduler/items/:id/remove` | Soft-delete; sets `status=removed`, `removedAt=now`. Cancels any in-flight delayed job. |
| `POST` | `/content-scheduler/reorder` | Body: `{ ids: string[] }`. Rewrites `position` for `queued` items only. |
| `GET` | `/content-scheduler/today-status` | `{ publishedCount, cap, publishedItemId }` for `Pacific/Auckland` today. Drives the day-status banner and the "max reached" UI hint. |

### `guardPublish` outcomes

`guardPublish` is the single source of truth for "can this item publish right now?". It returns one of:

- `{ ok: true, ... }` — proceed.
- `{ ok: false, code: 'not_approved' }` — `approvedAt IS NULL`. The `Publish` button is also disabled in the UI.
- `{ ok: false, code: 'already_published_today' }` — `today.publishedCount >= cap` and the item is not the one already published.
- `{ ok: false, code: 'missing_credentials' }` — `getXClient()` returned `null` because the X OAuth env vars are not set; the publish route returns `503`.

The route maps each guard code to a structured `4xx`/`5xx` response with a stable error code. The Mission Control client surfaces these inline.

---

## Runtime flow

### Calendar view

1. Mission Control mounts `ContentSchedulerTab`.
2. On mount the tab calls `GET /items` and `GET /today-status` in parallel; the 10s `setInterval` keeps them fresh while the tab is mounted.
3. `groupItemsForCalendar(items, days, 'Pacific/Auckland')` partitions items into one bucket per day-key plus an `Unscheduled` bucket for items with no `scheduledFor` or a date outside the 10-day window.
4. The grid renders 10 day columns labelled "Wed 16 Jul" style (weekday short + day + month short), plus an `Unscheduled` overflow panel.
5. Tom drags a non-published card onto a different day column:
   - `dataTransfer.setData('text/plain', itemId)` on drag start; `preventDefault` + `setDragOverId` on drag over.
   - On drop, the client calls `dayDropBlocked(publishedByDayKey, targetDayKey, itemId)` first.
     - If the target day already has a published item, no API call is made; the UI shows the inline error `"Already has a published post — choose another day."` and the drag is refused at the UI layer.
   - Otherwise the client computes `rescheduleIsoForDay(item, targetDayKey)`: preserves the existing HH:MM if present, defaults to `09:00` if not, and uses `Intl.DateTimeFormat` with `timeZone: 'Pacific/Auckland'` to get the correct UTC offset (handles NZST/NZDT and the DST start edge).
   - The client calls `PATCH /items/:id` with `{ scheduledFor: <new ISO> }` and reloads.
6. Published cards have `draggable={false}`, a greyed style, and a "Published" badge. Their day column shows a `✓ Published` indicator.
7. The day-status banner at the bottom shows `✓ N / cap posts published today` from the latest `today-status` poll.

### Publish (manual)

1. Tom clicks **Publish** on an approved item whose `scheduledFor` has arrived.
2. The Mission Control client calls `POST /items/:id/publish` with `x-actor: Tom`.
3. The route calls `guardPublish(item, today)`. Any non-`ok` outcome is returned as a structured `409` (cap) or `400` (not approved) response.
4. On `ok`, the route calls `publishContentSchedulerItem` which:
   - Fetches the X client (`RealXClient` or `FakeXClient`).
   - Posts the tweet via OAuth 1.0a.
   - On success: sets `publishedAt`, `publishedUrl`; cancels any in-flight auto-post job.
   - On failure: writes the error to `publishError` and leaves `status` at `approved` so Tom can retry.
5. The route returns the updated item. The client reloads.

### Auto-post (event-driven delayed jobs)

The auto-post flow is a delayed-job trigger that fires **once** at each item's `scheduledFor`. It is event-driven through a provider-neutral `JobSchedulerAdapter` — no polling loop, no in-process sleep timer. Swapping the in-process adapter for a managed queue service (BullMQ + Redis locally; Fly.io delayed tasks or similar in production) is a single-class change.

**Trigger path:**

1. Tom approves an item (or `PATCH /items/:id` with a new `scheduledFor`).
2. The route layer calls `decideAutoPostAction(prior, next)`. Pure function that returns `schedule` / `cancel` / `noop`.
3. The route layer applies the decision through the registered `JobSchedulerAdapter`:
   - `schedule` → `adapter.scheduleAutoPost({itemId, scheduledFor, scheduleVersion})` → returns `{jobId}`. The route persists `autoPostJobId`, bumps `autoPostScheduleVersion`, and stamps `autoPostScheduledAt` + `autoPostLastEnqueuedAt`.
   - `cancel` → `adapter.cancelAutoPost(jobId)` (best-effort). The route bumps `autoPostScheduleVersion` and clears `autoPostJobId`.
4. The adapter fires the job once at `scheduledFor` and calls the registered handler with the job payload.

**Worker path (job handler):**

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

**Schedule state machine:**

| Prior status | New status | New scheduledFor | Action |
| --- | --- | --- | --- |
| any | `published` | (n/a) | cancel any prior job, bump version |
| any | `removed` | (n/a) | cancel any prior job, bump version |
| any non-approved | (n/a) | (n/a) | cancel any prior job |
| `approved` | `approved` | cleared | cancel any prior job |
| `approved` | `approved` | unchanged + job present | `noop` |
| `approved` (or other) | `approved` | set / changed | schedule (or replace) job, version+1 |

### Timezone handling

- All calendar math is in `Pacific/Auckland`. The `SCHEDULER_TIME_ZONE` constant in `contentSchedulerCalendar.js` is the single source of truth.
- `Intl.DateTimeFormat` (with `timeZoneName: 'longOffset'`) is used to compute the correct UTC offset for any given local date — this avoids the bug where fixed-offset libraries give the wrong answer across the NZ DST start (last Sunday of September).
- Day boundaries are computed via `getAucklandDayKey(value, 'Pacific/Auckland')`, which formats a Date as `YYYY-MM-DD` in the target zone.
- The server (`getAucklandTodayParts`) and the client (`buildCalendarDays`) use the same Intl-based approach so the UI's "today" matches the server's "today" for publish-cap checks.

---

## Data contracts and observability

- API responses are JSON. Errors carry `{ error: { code: string, message: string } }` shapes — clients pattern-match on `code`, not on `message`.
- The X client is selected at request time from env vars: `X_CLIENT=real` forces `RealXClient`; otherwise `getXClient()` returns `RealXClient` only when **all four** of `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` are set, else `null`. Local dev / CI default to `FakeXClient` (set by tests).
- Mission Control never logs X tokens. The server logs publish success/failure at INFO / ERROR with the item id and the truncated error message.
- The auto-post worker logs job enqueue / fire / cancel at INFO with `jobId`, `itemId`, and `version`.

### Env vars

- `X_CLIENT` — `real` forces `RealXClient`. Otherwise `RealXClient` is used only when all four `X_API_*` env vars are set.
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — OAuth 1.0a credentials for X. Missing one returns `null` from `getXClient()`.
- `CONTENT_SCHEDULER_JOB_ADAPTER` — `in-process` (default) or `bullmq`. The API entrypoint must install the matching adapter at boot.
- `CONTENT_SCHEDULER_REDIS_URL` / `REDIS_URL` — Redis connection string. Used by the (not-yet-wired) BullMQ adapter.

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

### `GET /content-scheduler/today-status` returns `publishedCount` >= `cap` for a day Tom is sure he hasn't posted to

- The day boundary uses `Pacific/Auckland`. An X post that landed at `23:30 UTC` (i.e. `11:30 NZST` next day) is counted against the **NZ** day, not the UTC day. Check the item's `publishedAt` and convert to `Pacific/Auckland` to confirm.
- If a row has `status=published` with `publishedAt` on the wrong day, it is a real bug — escalate. Do not delete rows.

### Publish fails with `missing_credentials` even though the X OAuth env vars look right

- `getXClient()` requires **all four** of `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. Missing one returns `null`.
- Set `X_CLIENT=real` to fail loudly on missing vars rather than silently returning `null`.

### `Pacific/Auckland` day changes mid-session

- The calendar rebuilds day keys on each reload. If the user's browser/system clock drifts, two items can end up in different day columns across reloads. The browser-side `buildCalendarDays(now)` is the source of truth; the server-side `getAucklandTodayParts(now)` is the source of truth for publish-cap checks. If they disagree, server wins — the client must accept the guard result and not retry.

### Item scheduled in NZST but visible as one day earlier / later in the calendar

- This is the NZ DST start (last Sunday of September). At `03:00 local` the clock jumps to `04:00`. Items scheduled at `02:30` on that date are ambiguous. `zonedDateTimeToIso` handles the offset via Intl, but the UI should be inspected directly. If the wrong day is rendered, file a bug — do not edit the data.

### "Item is `approved` with `scheduledFor` but never auto-posts"

- Check that the API process is using a queue provider the worker can also consume (in single-process dev: yes; in any multi-process layout: BullMQ). The in-process adapter is per-process, so jobs scheduled by the API process are not visible to a separate worker process unless both are using a shared provider.
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

### Service extraction (future, task `94d5e4fc`)

- The Content Scheduler tables/routes will move from `services/tasks-api` to `services/content-scheduler-api`.
- Mission Control will switch from `tasksApi.js` to a new `contentSchedulerApi.js`-equivalent client pointing at the new host.
- The X client lives on the new service, not on Mission Control.
- The design at [`docs/specs/content-scheduler-service-extraction-tech-design.md`](../specs/content-scheduler-service-extraction-tech-design.md) covers the migration plan and the rollback path.

---

## Test plan and E2E coverage

| Layer | Coverage |
|---|---|
| Pure helpers (`contentSchedulerCalendar.js`) | `contentSchedulerCalendar.test.js` covers timezone, NZST/NZDT offset, DST start edge, scheduling defaults, day-key grouping, drop-guard logic |
| UI (`ContentSchedulerTab.jsx`) | `ContentSchedulerTab.test.jsx` covers mount/loading/error/retry, calendar grid layout, drag-and-drop reschedule, Unscheduled overflow, published read-only badge, max-one-per-day inline error, today-status banner |
| API (`services/tasks-api`) | `contentScheduler.test.ts` covers CRUD, approve/unapprove, publish guard outcomes (incl. `not_approved`, `already_published_today`, `missing_credentials`), reorder, today-status |
| Auto-post (`services/tasks-api`) | `contentSchedulerAutoPost.test.ts` covers the job queue adapter, BullMQ placeholder, in-process timer, end-to-end publish-via-auto-post |

Mission Control suite: 161/161 green as of PR #257 merge.

---

## Key file locations

| What | Where |
|---|---|
| UI tab | `apps/mission-control/src/tabs/ContentSchedulerTab.jsx` |
| Calendar helpers | `apps/mission-control/src/tabs/contentSchedulerCalendar.js` |
| API client | `apps/mission-control/src/contentSchedulerApi.js` |
| Calendar grid CSS | `apps/mission-control/src/styles/components.css` |
| Express routes | `services/tasks-api/src/routes/contentScheduler.ts` |
| Publish guard + X client | `services/tasks-api/src/routes/contentSchedulerPublish.ts` |
| Shared publish service | `services/tasks-api/src/routes/contentSchedulerPublishService.ts` |
| Auto-post jobs adapter | `services/tasks-api/src/routes/contentSchedulerJobs*.ts` |
| Auto-post worker | `services/tasks-api/src/routes/autoPostWorker.ts` |
| Auto-post worker entrypoint | `services/tasks-api/src/autoPostWorkerMain.ts` |
| Prisma model | `services/tasks-api/prisma/schema.prisma` |
| App behavioural contract | `apps/mission-control/SPEC.md` (Flow 7) |

---

## Known gaps / future work

- **Service extraction** (task `94d5e4fc`): move out of `services/tasks-api` into a dedicated `services/content-scheduler-api` per [`docs/specs/content-scheduler-service-extraction-tech-design.md`](../specs/content-scheduler-service-extraction-tech-design.md).
- **`draft` affordance**: the data model supports `draft` but the UI never produces one. If a "save without queueing" button is added, it should land in a follow-up PR.
- **Multi-channel publishing**: ACs are X-only. TikTok, LinkedIn, etc. are future channels.
- **Media attachments** (images / video): not supported in the model or the X client. Future work.
- **Thread composition**: a single Content Scheduler item is a single tweet. Thread drafts are out of scope for v1.
- **Per-user actor attribution**: `approvedBy` is a free-form string. The future Multi-user support work should formalise this.
- **BullMQ wiring**: the `bullmq` adapter is a throw-stub. Wire it up + add `bullmq`/`ioredis` deps + flip `CONTENT_SCHEDULER_JOB_ADAPTER` for production.