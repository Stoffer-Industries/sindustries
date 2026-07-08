---
status: draft
task_id: 115e8d89-be43-4b81-9e0e-9ab422810f5f
product_spec: brain/tasks/specs/content-scheduler-multi-channel-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Content Scheduler tab in Mission Control — tech design

## Links

- Product spec: `brain/tasks/specs/content-scheduler-multi-channel-2026-07-07.md`
  - The spec file in this repo is a stub (`- [x] **Approved by Tom**` only). The design is derived from the task description, ACs, and the related idea at `brain/ideas/content-scheduler-multi-channel.md`.
- Task: `115e8d89-be43-4b81-9e0e-9ab422810f5f`
- Mission Control tab registry: `apps/mission-control/src/pulseTabs.js`
- Mission Control API client: `apps/mission-control/src/tasksApi.js`
- Existing tabs precedent: `apps/mission-control/src/tabs/BookmarksTab.jsx` (a non-iframe data tab with its own API client)
- Tasks API server (host for new content-scheduler routes): `services/tasks-api/src/app.ts`
- Tasks API Prisma schema (host for new `ContentSchedulerItem` model): `services/tasks-api/prisma/schema.prisma`
- Design System primitives used: `@sindustries/ui/react` `Button`, `Card`, `Field`, `Modal`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-115e8d89-content-scheduler-tab`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-115e8d89-content-scheduler-tab`
- No secondary repos. The change is contained in `apps/mission-control/` (UI), `services/tasks-api/` (API + persistence), and `apps/mission-control/SPEC.md`. No cross-repo coordination needed.

## Product intent (from approved product spec + idea)

- Outcome: a Content Scheduler tab inside Mission Control lets Tom queue approved content for posting to X, schedule one tweet per day, reorder/edit/remove queued items, and see published timestamps + URLs. Nothing posts without Tom's explicit per-item approval.
- Source material today: ops notes pipeline output (already generated but not surfaced) and CTO Craft mailing list content Quinn reads. Both feed into the queue.
- Why now: closes the loop from "Tom ships something" → "Tom shares something." Without the scheduler, the ops-notes signals have nowhere to go.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals (per AC text + idea doc):
  - automatic cron-driven publishing (this is a manual-approval UI; future cron is a separate task)
  - TikTok calendar planning (different channel, separate future task — idea doc mentions it but ACs only cover X)
  - multi-user collaboration (single-user MVP, Tom only)
  - third-party UIs (Buffer, Hootsuite) — Mission Control owns the queue
  - media attachments (images/video) in v1 — text-only tweets
  - thread composition (single tweet per queued item in v1)

## Acceptance criteria recap

- **AC1 — Tab registered.** New tab `Content Scheduler` at `/content-scheduler`, visible in the sidebar tab bar (vertical sidebar from PR #194), rendering a `ContentSchedulerTab` component.
- **AC2 — Add to queue.** Tom can paste or compose tweet text, optionally tag a source (`ops-notes`, `cto-craft`, `manual`), and add it to the queue. Items enter the queue in `draft` status; transitioning to `queued` happens on add in v1 (no separate "save draft" affordance) — `draft` is the field used to hold items removed from `queued`.
- **AC3 — Max one per day.** The backend enforces: across all `published` items, no two can share the same calendar date (Tom's local time, `Pacific/Auckland`). The publish endpoint returns `409 Conflict` with a structured error if Tom tries to publish a second item on a day that already has a `published` item.
- **AC4 — Queue UI.** A single page lists all non-`removed` items grouped by `status` (queued, approved, published). Within each group items are sortable by `position` (ascending). Each item exposes: edit body, change scheduled date, approve, publish (if approved + scheduledFor ≤ now + max-one/day OK), remove (soft-delete to `removed` status).
- **AC5 — Published metadata.** On successful publish, the row updates with `publishedAt` (ISO timestamp from server) and `publishedUrl` (the X post URL returned by the publish integration). UI shows these in the published group.
- **AC6 — Approval gate.** `publish` endpoint refuses items where `approvedAt IS NULL`. UI disables the publish button until approval is recorded. There is no implicit approval (e.g. typing "y" in a comment); the explicit `approve` endpoint must be hit.

## `.openclaw` boundary

- X credentials (OAuth tokens, API keys) live outside the repo. They belong in `.openclaw` or environment-injected secrets at runtime. **Do not commit credentials.** The implementation will reference them via `process.env.X_API_BEARER_TOKEN` (and related env vars), with code paths that error gracefully if unset (returning a 503 with a clear "missing credential" message rather than crashing).
- Mission Control already runs at `http://localhost:5174`. Tasks API runs at `http://localhost:4001`. No new cross-origin concerns (Mission Control already calls Tasks API via the existing `tasksApi.js` client which already handles the 5174 → 4001 cross-origin setup).
- No `.openclaw` files are written by this PR.
- If production deployment requires the X credentials in the deployed Mission Control / Tasks API runtime, post `[openclaw-needed]` during implementation so Quinn can wire env vars into the deploy pipeline.

## Implementation plan

### File / module scope

#### Mission Control (UI) — `apps/mission-control/`

- **`apps/mission-control/src/tabs/ContentSchedulerTab.jsx`** *(new)* — Tab component. Three sections stacked vertically:
  1. **Composer card** (top): `<Field>` for body (multi-line, 280 char counter), `<Field>` for scheduled date (datetime-local input, defaults to "now + 1 minute" rounded to the nearest 5 min), source `<Field>` (dropdown: ops-notes / cto-craft / manual / free text). Submit button `Add to queue`. Resets on success.
  2. **Queue list** (middle): grouped sections — "Queued", "Approved", "Published". Each row is a `Card` with body preview, scheduled date, source tag, status badge, and action buttons (Edit / Approve / Publish / Remove). `position` drives order; drag handles (native HTML5 drag-and-drop, no new dep) let Tom reorder queued items.
  3. **Day-status strip** (bottom, sticky): shows today's date + "✓ 0 / 1 posts published today" or "✓ 1 / 1 posts published today (max reached)". The strip pulls `/content-scheduler/today-status` on mount + after every state-mutating action.
- **`apps/mission-control/src/contentSchedulerApi.js`** *(new)* — Thin API client mirroring `tasksApi.js`. Methods: `list`, `create`, `update`, `approve`, `publish`, `remove`, `reorder`, `getTodayStatus`. Uses the existing `fetch` pattern with the Tasks API base URL. All methods return promises that throw on non-2xx with the error body parsed.
- **`apps/mission-control/src/pulseTabs.js`** *(modified)* — Register the new tab between `flow-metrics` and the end:
  ```js
  {
    id: 'content-scheduler',
    label: 'Content',
    path: '/content-scheduler',
    component: ContentSchedulerTab
  }
  ```
- **`apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx`** *(new)* — Vitest cases (mirroring `BookmarksTab.test.jsx` patterns):
  - Renders composer, queue list, day-status strip on mount.
  - Adding an item posts to `/api/v1/content-scheduler/items` and clears the composer.
  - Approve button calls `approve` endpoint and updates local state.
  - Publish button is disabled until `approvedAt` is set; clicking it calls `publish`.
  - When `todayStatus.publishedCount === 1`, publish button is disabled on other items with a tooltip explaining the max-one-per-day rule.
  - Drag-and-drop reorder calls `reorder` with new position ordering.
  - Removing an item soft-deletes (sets `status: 'removed'`) and removes from view.
- **`apps/mission-control/SPEC.md`** *(modified)* — Add "Content Scheduler tab" to the Screens table with the three sub-sections; add the new Vitest cases to the E2e coverage table; note the approval gate + max-one-per-day rule under Data Sources / business rules.
- **`apps/mission-control/README.md`** *(modified)* — Mention the new tab in the "Adding a new tab" / "Shell features" intro paragraph.

#### Tasks API (backend) — `services/tasks-api/`

- **`services/tasks-api/prisma/schema.prisma`** *(modified)* — Add `ContentSchedulerItem` model:
  ```prisma
  enum ContentSchedulerItemStatus {
    draft
    queued
    approved
    published
    removed
  }

  enum ContentSchedulerSource {
    ops_notes
    cto_craft
    manual
    other
  }

  model ContentSchedulerItem {
    id            String                       @id @default(uuid()) @db.Uuid
    body          String                       @db.VarChar(1000)
    source        ContentSchedulerSource       @default(manual)
    sourceRef     String?
    status        ContentSchedulerItemStatus   @default(queued)
    scheduledFor  DateTime?
    position      Int                          @default(0)
    approvedAt    DateTime?
    approvedBy    String?
    publishedAt   DateTime?
    publishedUrl  String?
    publishError  String?
    createdAt     DateTime                     @default(now())
    updatedAt     DateTime                     @updatedAt
    removedAt     DateTime?

    @@index([status, position])
    @@index([status, scheduledFor])
    @@index([status, publishedAt])
  }
  ```
  The three indexes support the queue-listing query (status + position), the publish-eligibility scan (status + scheduledFor), and the daily cap check (status + publishedAt).
- **`services/tasks-api/prisma/migrations/<timestamp>_content_scheduler/migration.sql`** *(new)* — Auto-generated by `prisma migrate dev --name content_scheduler`. Hand-written backup in the PR description if `prisma migrate dev` isn't available.
- **`services/tasks-api/src/routes/contentScheduler.ts`** *(new)* — Express router mounted at `/api/v1/content-scheduler`:
  - `GET /items` — list non-`removed` items, optionally filtered by `status`. Returns `[{ id, body, source, sourceRef, status, scheduledFor, position, approvedAt, approvedBy, publishedAt, publishedUrl, publishError, createdAt, updatedAt }]` sorted by `status, position ASC, createdAt ASC`.
  - `POST /items` — create. Body: `{ body, source?, sourceRef?, scheduledFor? }`. Validates `body.length <= 1000` and `body.length > 0`. Returns the created item.
  - `PATCH /items/:id` — update `body`, `scheduledFor`, `source`, `sourceRef`. Refuses if status is `published` or `removed` (returns 409).
  - `POST /items/:id/approve` — sets `status='approved'`, `approvedAt=now()`, `approvedBy=<actor>`. Refuses if already published/removed.
  - `POST /items/:id/unapprove` — clears `approvedAt`/`approvedBy` (UI escape hatch).
  - `POST /items/:id/publish` — runs the publish flow (see below). Returns the updated item.
  - `POST /items/:id/remove` — sets `status='removed'`, `removedAt=now()`. Refuses if already published (returns 409; once published, can't be un-published from this UI).
  - `POST /reorder` — body `{ ids: string[] }` (in desired order). Writes `position` per item in a single transaction. Refuses any id whose status is `published` or `removed`.
  - `GET /today-status` — returns `{ date: 'YYYY-MM-DD', publishedCount: 0|1, publishedItemId?: string }` for `Pacific/Auckland` "today".
  - All write endpoints accept an `actor` header (`x-actor`) defaulting to `unknown` (no auth in v1; single-user MVP).
- **`services/tasks-api/src/routes/contentSchedulerPublish.ts`** *(new)* — Houses the publish service. Three sub-routines:
  1. **`guardPublish(item, today)`** — pure function. Returns `{ ok: true }` or `{ ok: false, code: 'NOT_APPROVED' | 'ALREADY_PUBLISHED' | 'DAY_CAP_REACHED' | 'SCHEDULED_IN_FUTURE' | 'MISSING_CREDENTIALS' | 'NO_X_CLIENT' }`. Used by the route and unit-tested independently.
  2. **`getXClient()`** — returns an instance of a thin `XClient` interface (defined in this file). When `process.env.X_API_BEARER_TOKEN` is unset, returns `null`. The publish endpoint surfaces a 503 with `{ code: 'MISSING_CREDENTIALS' }` in that case so the UI shows a clear message.
  3. **`publishToX(client, item)`** — calls `client.createTweet({ text: item.body })`. Returns `{ url: string, postedAt: Date }`. Wraps the underlying fetch in a 10-second timeout. On non-2xx, returns the error message for `publishError`.
  - **Stub X client** for dev/test: a `FakeXClient` that returns `{ url: 'https://x.com/sindustries/status/<deterministic-id>', postedAt: new Date() }`. Selected via `process.env.X_CLIENT === 'fake'` (default in dev/test). The `RealXClient` calls `https://api.twitter.com/2/tweets` with bearer auth and is selected when `X_CLIENT=real`.
- **`services/tasks-api/src/routes/contentScheduler.test.ts`** *(new)* — Vitest cases:
  - CRUD happy paths and validation (empty body, too-long body).
  - `approve` writes `approvedAt`; `unapprove` clears it.
  - `publish` rejects unapproved items (`NOT_APPROVED`).
  - `publish` rejects when a same-day `published` item already exists (`DAY_CAP_REACHED`).
  - `publish` rejects items with `scheduledFor` more than ~1 minute in the future (`SCHEDULED_IN_FUTURE`).
  - `publish` with `X_CLIENT=fake` and credentials present succeeds and returns a fake URL.
  - `publish` without credentials returns 503 (`MISSING_CREDENTIALS`).
  - `publish` with `X_CLIENT=real` and the fetch stub returning 401 propagates the error into `publishError`.
  - `reorder` accepts the id list, writes positions in a transaction, and rejects any id that is published/removed.
  - `remove` soft-deletes; `published` items can't be removed.
  - `today-status` counts only `published` items in `Pacific/Auckland` "today".
- **`services/tasks-api/src/app.ts`** *(modified)* — Mount `contentScheduler` and `contentSchedulerPublish` (or merge into one router; the design keeps them separate for clarity). Existing health/tasks/tags routes untouched.
- **`services/tasks-api/README.md`** *(modified)* — Document the new endpoints, the X-Client env vars (`X_CLIENT`, `X_API_BEARER_TOKEN`), and the timezone convention (Pacific/Auckland).

### Data model summary

One new table `ContentSchedulerItem` with two new enums. Three indexes support the three primary queries (queue listing, publish-eligibility scan, daily cap check). No changes to existing `Task`, `TaskComment`, or `TaskTag` tables.

### Cross-context coordination

- Mission Control at `http://localhost:5174` calls Tasks API at `http://localhost:4001` — already a configured cross-origin pair via Vite proxy and CORS in `services/tasks-api/src/app.ts`. No new CORS work.
- No iframe between Mission Control and Tasks API (Tasks API is JSON over HTTP, not embedded). No `postMessage` work.
- The X publish call is server-side (Tasks API makes the outbound HTTPS call to `api.twitter.com`); Mission Control never holds the X credential.

### Workflow / cron / skill changes

- **No automatic cron-driven publishing in this PR.** Tom clicks Publish manually per item in the UI. Future cron / "publish at scheduledFor" automation is a separate task (would need a cron worker that scans `status='approved' AND scheduledFor <= now()` items and calls publish).
- **No new agent skills.** Future skills (e.g. an `ops-notes → content-scheduler` skill) can call `POST /api/v1/content-scheduler/items` to enqueue items programmatically, but that's out of scope here.

### Design system usage

- `Button` (variants: `primary`, `ghost`, `danger`) — same primitive used elsewhere.
- `Card` — for queue item rows and the composer.
- `Field` / `Textarea` — for body and metadata inputs.
- `Badge` — for status pills (queued/approved/published).
- `Modal` — for confirm-on-remove and confirm-on-publish dialogs.
- No new design tokens or components.

## Test plan

- **Unit — `services/tasks-api/src/routes/contentScheduler.test.ts`:** see the cases enumerated above. Each guard branch is asserted independently. The `FakeXClient` covers the happy path; the real-client error path is stubbed with `vi.spyOn(global, 'fetch')`.
- **Unit — `services/tasks-api/src/routes/contentSchedulerPublish.ts`:** the `guardPublish` pure function gets its own describe block; cases mirror the route tests but at the function level.
- **Component — `apps/mission-control/src/tabs/ContentSchedulerTab.test.jsx`:** see cases above. Uses `@testing-library/react` + `vi.mock` on the API client.
- **Integration:** `npm --workspace @sindustries/tasks-api run test:integration` exercises the new model + migration against the dev Postgres in Docker.
- **Build:** `npm --workspace @sindustries/mission-control run build` and `npm --workspace @sindustries/tasks-api run build`.
- **Dev smoke (Mission Control):**
  1. `make up` → open `http://localhost:5174/content-scheduler`.
  2. Compose a tweet, click Add → see it in "Queued".
  3. Click Approve → moves to "Approved" group.
  4. Click Publish → moves to "Published" with a URL + timestamp.
  5. Add another item, approve it, attempt to publish → see "max 1 per day reached" disable + tooltip.
  6. Drag a queued item to reorder → UI reflects new order, `position` field updated.
  7. Click Remove on a queued item → disappears from the list, soft-deleted server-side.
- **Dev smoke (X integration):**
  - With `X_CLIENT=fake X_API_BEARER_TOKEN=dummy`, the publish flow succeeds and `publishedUrl` looks like `https://x.com/sindustries/status/<id>`.
  - With `X_API_BEARER_TOKEN` unset, publish returns 503 and the UI shows "X credentials not configured."

## Open questions / risks

- **Q1 — X API access.** The task does not yet have live X API credentials. The dev/test path uses `FakeXClient`; production posting needs a real bearer token. **Mitigation:** the implementation degrades gracefully (clear 503) when credentials are missing; we don't block the UI on this. Quinn/Tom wires credentials via env vars at deploy time. If credentials require app review / elevated access, that's a separate `[openclaw-needed]` task.
- **Q2 — Timezone.** The "one tweet per day" rule uses `Pacific/Auckland` (Tom's local). The server stores `scheduledFor` and `publishedAt` as UTC and computes "today" via `Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland' })`. The convention is documented in `services/tasks-api/README.md`. If Tom travels and wants a different day boundary, that's a future setting.
- **Q3 — `position` is global.** Within a single status group, position is contiguous. Reordering uses a full `POST /reorder` payload (id list) rather than a per-item `PATCH` to avoid two clients racing on partial reorders. The UI sends the full list on every drag.
- **Q4 — `approvedAt` doesn't expire.** An item can sit approved for days; the publish gate only checks `approvedAt IS NOT NULL`. If we want a "re-approve weekly" rule, that's a future change.
- **Q5 — Edit after publish.** A `published` item cannot be edited or removed via this UI (the routes refuse with 409). If Tom wants to delete a published post, that's an X-side action, not in scope.
- **Q6 — Soft-delete recovery.** `removed` items are not surfaced in the UI but remain in the DB for audit. If Tom wants a "trash" view, that's a follow-up.
- **Q7 — Multi-account X.** v1 is single-account MVP. The X client is constructed once with the env-var credentials; per-account support is a future feature.
- **Q8 — Rate limits.** X's `api.twitter.com/2/tweets` endpoint has per-app rate limits. The first implementation doesn't track usage; if Tom hits a limit, the error is surfaced as `publishError`. A future task can add a token-bucket counter.

## Out of scope

- Automatic cron publishing at `scheduledFor` time.
- TikTok calendar planning (idea doc mentions it; not in ACs).
- Multi-user auth (single-user MVP).
- Image / video attachments (text-only tweets in v1).
- Thread composition (multi-tweet threads).
- Per-account X credential management.
- A "trash" view for removed items.
- A "draft" save affordance separate from "queued" (the status enum supports it; the UI doesn't expose it in v1).
- Per-platform routing beyond X (the column name is generic — `publishedUrl` — but only X is wired).

## Companion doc updates

- `apps/mission-control/SPEC.md` — new "Content Scheduler tab" row in the Screens table; new Vitest cases in the E2e coverage table; new "Approval gate" and "Max one X post per day" entries under Data Sources / business rules.
- `apps/mission-control/README.md` — one paragraph on the new tab in the "Shell features" intro.
- `services/tasks-api/README.md` — list the new endpoints, the two X-client env vars, and the timezone convention.
- `docs/systems/feature-task-workflow.md` — **no change.** This task is not a feature-task workflow change.
- `[no-system-spec-change]` — Mission Control is a static SPA, not a cross-cutting system; the Tasks API change is a new resource on an existing service, not a new system. No `docs/systems/*` update needed.

## Later todos (parking lot)

- Cron-driven publishing at `scheduledFor` (a worker that scans approved items and calls publish when due).
- "Draft" affordance separate from "queued" (the status enum already supports it).
- Image / video attachments (X supports media uploads; needs a media endpoint and storage).
- Thread composition (X supports reply chains; would need a parent/child relation in `ContentSchedulerItem`).
- Multi-account X support (per-account credentials + UI account picker).
- Trash view for `removed` items.
- Per-item rate-limit tracking and back-off.
- A `no-system-spec-change` is recorded at PR time; if cross-cutting analytics on the scheduler emerge later, a `docs/systems/content-scheduler.md` would be the home.