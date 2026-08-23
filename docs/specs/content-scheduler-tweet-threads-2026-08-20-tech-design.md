---
status: draft
task_id: 1016cbff-7925-4beb-becf-3b833dd66578
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-tweet-threads-2026-08-20.md
shipped_pr: null
shipped_date: null
---

# SIndustries Weekly Updates: tweet threads for multi-part stories — tech design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/in-progress/content-scheduler-tweet-threads-2026-08-20.md`
- Approved by Tom in the product spec.

## Task and implementation context

- Task ID: `1016cbff-7925-4beb-becf-3b833dd66578`
- Task title: `SIndustries Weekly Updates: tweet threads for multi-part stories`
- Repository: `Stoffer-Industries/sindustries`
- Planned branch: `task-1016cbff-content-scheduler-tweet-threads`
- Planned worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-1016cbff-content-scheduler-tweet-threads`
- Current system doc: `docs/systems/content-scheduler.md`
- Dependency: task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`, `Extract Content Scheduler from Tasks API`

## Product intent summary

The scheduler must treat a sequential story as one scheduled and approved object, not as several unrelated calendar items. On X that object publishes as a root tweet followed by replies chained to the immediately preceding tweet. In Mission Control Tom reviews, edits, approves, schedules, and retries the complete thread as one unit.

The weekly campaign must also stop forcing every theme into a five-to-seven-day narrative arc. Ivy first decides whether source material is genuinely sequential. A dependent narrative becomes one thread on one scheduled day; independent signals become concise standalone scheduled posts, each with its own hook and one complete idea.

Non-goals remain:

- channels other than X;
- media on any thread part;
- converting existing queued, approved, or published single items into threads;
- changing previously published X posts;
- automatic content-quality scoring or an LLM service inside the Content Scheduler.

## Ownership boundary and extraction dependency

### Natural owner

This is database-backed Content Scheduler domain data. The backend owns the aggregate, ordering, validation, approval, scheduling, publish attempt state, X side effects, compensation, and retry rules. Mission Control is a direct API consumer and owns only editing/display state. Ivy's weekly workflow decides which aggregate to create, but it does not own scheduler persistence or publishing semantics.

A UI-local grouping shim is not acceptable: separate rows cannot be approved, locked, published, compensated, or retried atomically as one domain object. The durable boundary is one `ContentSchedulerItem` aggregate with an explicit kind and ordered parts.

### Dependency on task `94d5e4fc`

This design **does not assume service extraction has landed**. Current `main` still owns the model, routes, worker, and X client under `services/tasks-api`, so the file plan below names that surface. The implementation should not wait for extraction solely to ship threads.

Keep all new behavior inside the existing Content Scheduler modules and public `/api/v1/content-scheduler/*` contract. Do not add Tasks-domain imports. If task `94d5e4fc` lands before implementation starts, place the same Prisma models, route/service modules, worker changes, and tests under `services/content-scheduler-api` instead. If it lands while this work is open, rebase after extraction and move the whole change; do not split one aggregate or publish attempt across services/databases. Mission Control and Ivy should use a Content Scheduler base URL/config supplied by the extraction, while request/response shapes remain unchanged.

This keeps the change a mergeable increment now without introducing a compatibility endpoint that would need a second migration later.

## `.openclaw` boundary notes

- The product spec and Ivy's live agent definition are surfaced from the OpenClaw workspace, but the canonical agent files changed by implementation are repo-owned under `agents/definitions/ivy/` and `agents/skills/content/`.
- X OAuth credentials remain environment-injected. No credential or `.openclaw` config change belongs in the PR.
- No cron, heartbeat schedule, or host supervisor change is required. The existing event-driven auto-post worker remains the trigger.
- If service extraction requires a new deployed worker process or base URL, that runtime wiring belongs to task `94d5e4fc`, not this feature.

## Proposed domain model

### Item as the scheduled aggregate

Extend `ContentSchedulerItem` rather than creating one scheduler row per tweet:

```prisma
enum ContentSchedulerItemKind {
  single
  thread
}

enum ContentSchedulerItemStatus {
  draft
  queued
  approved
  publishing
  cleanup_required
  published
  removed
}

model ContentSchedulerItem {
  // existing fields
  kind ContentSchedulerItemKind @default(single)

  // `body` remains the root/single text for compatibility.
  // Thread replies live in ContentSchedulerThreadPart.
  parts ContentSchedulerThreadPart[]
  publishAttempts ContentSchedulerPublishAttempt[]
}

model ContentSchedulerThreadPart {
  id        String @id @default(uuid()) @db.Uuid
  itemId    String @db.Uuid
  position  Int
  body      String @db.VarChar(1000)
  item      ContentSchedulerItem @relation(fields: [itemId], references: [id], onDelete: Cascade)

  @@unique([itemId, position])
  @@index([itemId, position])
}
```

`ContentSchedulerItem.body` is position `0`, the root tweet. For `kind=thread`, `ContentSchedulerThreadPart` contains reply positions `1..n` with no gaps. For `kind=single`, there are no child parts. The API always returns a normalized `parts` array, synthesizing position `0` from `body`, so Mission Control and workflow callers do not need to know the storage optimization.

This is deliberately incremental: existing single rows require only `kind=single`; no historical body migration or conversion is needed. A service-extraction migration can move the aggregate unchanged.

### Invariants

Validate in the backend transaction used by create/update/approve:

- a single has exactly one normalized part;
- a thread has 2–7 ordered parts;
- every part is non-empty and at most 280 Unicode code points under the same counting helper used by current single-tweet validation;
- thread positions are unique, contiguous, and start at zero in the API contract;
- all parts share the aggregate's `source`, `sourceRef`, `scheduledFor`, status, approval metadata, and auto-post job;
- `published` and `removed` aggregates are immutable;
- `publishing` and `cleanup_required` aggregates cannot be edited, approved, removed, rescheduled, or published through ordinary endpoints;
- editing any part of an approved thread invalidates approval, returns it to `queued`, cancels the delayed job, and bumps `autoPostScheduleVersion`.

The seven-part upper bound prevents accidental long chains in the weekly flow while covering the existing five-to-seven-part campaign shape. It is a server rule, not only prompt guidance.

### Publish-attempt journal

X does not offer a transaction spanning several tweet-creation calls. Persist an attempt journal so partial progress can be compensated and retried safely:

```prisma
enum ContentSchedulerPublishAttemptState {
  publishing
  rolling_back
  rolled_back
  succeeded
  cleanup_required
}

model ContentSchedulerPublishAttempt {
  id          String @id @default(uuid()) @db.Uuid
  itemId      String @db.Uuid
  state       ContentSchedulerPublishAttemptState
  failedAtPosition Int?
  error       String?
  startedAt   DateTime @default(now())
  completedAt DateTime?
  item        ContentSchedulerItem @relation(fields: [itemId], references: [id])
  tweets      ContentSchedulerAttemptTweet[]

  @@index([itemId, startedAt])
}

model ContentSchedulerAttemptTweet {
  id          String @id @default(uuid()) @db.Uuid
  attemptId   String @db.Uuid
  position    Int
  tweetId     String
  url         String
  postedAt    DateTime
  deletedAt   DateTime?
  deleteError String?
  attempt     ContentSchedulerPublishAttempt @relation(fields: [attemptId], references: [id], onDelete: Cascade)

  @@unique([attemptId, position])
  @@unique([attemptId, tweetId])
}
```

On success, the existing `publishedUrl` remains the root URL and `publishedAt` is the completion timestamp. `GET /items` returns published URLs for all parts from the successful attempt. The attempt rows remain audit/recovery data; they are not separate calendar items.

## API contract

Keep existing single-item requests working. Add a discriminated create/update contract:

```ts
type CreateScheduledContent =
  | {
      kind?: 'single';
      body: string;
      source?: ContentSchedulerSource;
      sourceRef?: string | null;
      scheduledFor?: string | null;
    }
  | {
      kind: 'thread';
      parts: Array<{ body: string }>;
      source?: ContentSchedulerSource;
      sourceRef?: string | null;
      scheduledFor?: string | null;
    };
```

For a thread, the route stores `parts[0].body` in the item and positions `1..n` as child rows in one database transaction. It rejects a request containing both thread `parts` and an independent `body` to avoid two sources of truth.

Normalized response additions:

```ts
type ContentSchedulerItemResponse = {
  // existing fields
  kind: 'single' | 'thread';
  parts: Array<{
    id: string | null; // null for the root backed by ContentSchedulerItem
    position: number;
    body: string;
    publishedUrl: string | null;
  }>;
  publishState: {
    attemptId: string;
    state: 'publishing' | 'rolling_back' | 'rolled_back' | 'succeeded' | 'cleanup_required';
    failedAtPosition: number | null;
    error: string | null;
  } | null;
};
```

Route behavior:

- `POST /content-scheduler/items` accepts either contract and returns one aggregate ID.
- `PATCH /content-scheduler/items/:id` accepts full `parts` replacement for a thread. Full replacement is simpler and safer than independent child routes because validation, ordering, approval invalidation, and job cancellation happen in one transaction.
- Existing approve/unapprove/remove routes act on the aggregate.
- Existing `POST /items/:id/publish` publishes the aggregate. Concurrent calls receive `409 PUBLISH_IN_PROGRESS`.
- Add `POST /items/:id/retry-publish`. For a normal rolled-back failure it starts a fresh attempt. For `cleanup_required`, it first retries deletion of recorded remote tweets; it starts no new X tweets until cleanup has succeeded and the item is back in `approved` state.
- `GET /items` remains the calendar query and returns one row per aggregate.
- `GET /today-status` counts one successfully published aggregate, regardless of part count. A thread therefore occupies one calendar day/cap slot.

Update `apps/mission-control/src/contentSchedulerApi.js` with thread create/update and retry helpers without changing single-item call sites.

## Publishing flow

### X client changes

Extend the provider-neutral `XClient`:

```ts
createTweet(input: {
  text: string;
  in_reply_to_tweet_id?: string;
}): Promise<{ tweetId: string; url: string; postedAt: Date }>;

deleteTweet(tweetId: string): Promise<void>;
```

`RealXClient.createTweet` already sends X's `reply.in_reply_to_tweet_id`; it must return the response ID explicitly. `deleteTweet` calls `DELETE /2/tweets/:id` using the same OAuth 1.0a user context. `FakeXClient` records creates/deletes and supports deterministic failure injection by position for integration tests.

### Preflight and lock

Refactor `publishContentSchedulerItem` into aggregate-oriented orchestration:

1. Load the item and all ordered parts in one snapshot.
2. Run all failure-prone local checks before the first X call: status/approval, schedule, daily cap, credentials, kind/part count, every body limit, and contiguous ordering.
3. Atomically claim the item with a conditional update `approved -> publishing` and create a `publishing` attempt in a database transaction. Only one manual request or auto-post worker can win.
4. The item-level daily cap treats the claim as reserved so concurrent items cannot both pass the cap. Implement the cap reservation in the same serializable transaction/advisory lock used by current publish guards.

### Create the chain

For positions in ascending order:

1. Post position `0` without a reply target.
2. Persist its `tweetId`, URL, and timestamp immediately in the attempt journal.
3. Post each later part with `in_reply_to_tweet_id` set to the **immediately preceding** part's tweet ID, not always the root.
4. Persist each successful remote result before moving to the next part.
5. After every part is recorded, transactionally mark the attempt `succeeded`, item `published`, set root `publishedUrl`, clear `publishError`, clear/cancel the auto-post job, and bump the schedule version.

The worker invokes this same service. There is one delayed job and one `scheduledFor` for the aggregate; no child part is independently queued.

### Failure compensation and retry

If any create call fails after one or more tweets were posted:

1. Mark the attempt `rolling_back`, record the failed position/error, and keep the item unavailable for ordinary edits.
2. Delete recorded tweets in reverse order (latest reply to root).
3. When all deletes succeed, mark the attempt `rolled_back`, return the item to `approved`, write a clear aggregate `publishError`, and expose **Retry thread**. No automatic queue retry occurs.
4. If any delete fails, mark the attempt and item `cleanup_required`, retain each undeleted tweet ID/URL and delete error, and show **Retry cleanup and publish**. A retry performs cleanup first and cannot post a new root until no remote tweet from the failed attempt remains.

If the root create fails, no compensation is needed; the item returns to `approved` with the error and retry action.

### Atomicity limitation

Literal cross-system atomicity is impossible because X exposes separate create/delete calls and no transaction or idempotency key. There is also an unavoidable crash window after X accepts a tweet but before its ID is persisted locally. This design interprets AC3 as **compensating all-or-none publication with explicit recovery**:

- local validation failures post nothing;
- known partial failures are rolled back automatically;
- cleanup failures are never hidden or called successful;
- retries cannot create a second chain while known remote remnants exist.

The implementation must document this limit in `docs/systems/content-scheduler.md`. If product requires mathematically strict “no partial thread can ever be visible, even transiently or across a process crash,” AC3 is not implementable with X's public API and must be revised before implementation approval.

A startup/worker reconciliation pass should inspect stale `publishing`, `rolling_back`, and `cleanup_required` attempts. It retries only known cleanup, never blindly replays creates. Unknown-outcome crash windows require operator inspection of X and remain a surfaced `cleanup_required` state rather than risking duplicate posts.

## Mission Control changes

Scope:

- `apps/mission-control/src/tabs/ContentSchedulerTab.jsx`
- `apps/mission-control/src/tabs/SchedulerItemCard.jsx`
- `apps/mission-control/src/tabs/useContentScheduler.js`
- `apps/mission-control/src/contentSchedulerApi.js`
- `apps/mission-control/src/styles/components.css`
- corresponding tests and `apps/mission-control/SPEC.md`

Behavior:

- The composer gains a `Single tweet` / `Thread` type choice. Thread mode renders ordered textareas with per-part `n/280` counts, add/remove controls, and move-up/move-down ordering controls. Require at least two parts.
- A thread renders as **one calendar card** on its aggregate `scheduledFor`. It has a `Thread · N parts` badge and a collapsed root preview.
- Expanding the card shows every numbered part in order. Edit mode changes the complete part list and saves through one aggregate `PATCH`; it never emits disconnected child cards.
- Approve/unapprove/schedule/drag/remove actions operate once on the aggregate. Editing an approved thread clearly explains that approval will be cleared.
- During `publishing`, disable mutations and show progress such as `Publishing part 2 of 5` when available from refreshed attempt state.
- On successful publication, show the root URL as the primary link and optional links for each reply.
- On rolled-back failure, show the failed part number, error, confirmation that posted parts were removed, and a `Retry thread` button.
- On `cleanup_required`, show a high-visibility error with the URLs that may still be live and a `Retry cleanup and publish` button. Do not present the item as published.
- Existing 10-second refresh is sufficient for worker progress; no SSE/WebSocket is required.

The 10-day calendar grouping helper needs no conceptual change: it groups aggregate rows. Component coverage is the current practical app-flow layer because Mission Control has component tests for this tab but no browser E2E harness for Content Scheduler. If a browser harness exists by implementation time, add one happy-path review/edit/approve flow there.

## Ivy weekly content-flow changes

### Decision point

Replace the current instruction to force one theme into a five-to-seven-day arc in `agents/definitions/ivy/HEARTBEAT.md` with an explicit classification step after reading the weekly review:

A candidate is a thread only when all are true:

1. It is one narrative, not a collection of weekly wins.
2. Order carries meaning: setup precedes consequence, steps depend on prior steps, or later parts are materially weaker/ambiguous without earlier context.
3. The root can state a concrete hook and promise the thread's payoff.
4. Each reply advances the same story; none is filler or an unrelated update.
5. The story needs at least two parts after applying the 280-character limit and concise-copy pass.

Use a standalone post when the idea is understandable and useful without another post. Shared topic alone is not enough to make a thread. If uncertain, prefer standalone.

### Weekly schedule shape

- A genuine narrative is queued once as one thread at one `scheduledFor`; its parts are not assigned consecutive days.
- Remaining strong signals become standalone scheduled items on later days. Each must have a clear first-line hook, one idea, concrete evidence/detail, and no dependency on another day's copy.
- Do not pad to reach five-to-seven scheduled units. Prefer fewer strong units over filler.
- Do not restate thread parts as standalone posts in the same week.
- If there is no genuine narrative, queue only standalone posts.

Add a low-level repo skill `agents/skills/content/schedule-tweet-thread/SKILL.md` that validates 2–7 parts and makes one authenticated `POST /content-scheduler/items` with `kind=thread` and `parts`. Keep `schedule-tweets` as the single-tweet primitive. Both return one aggregate item ID. Update Ivy's traceability comment to identify each scheduled unit as `thread (N parts)` or `single`; the existing `[ivy-tweets-queued]` gate remains valid and needs no parser change.

Update `agents/workflows/content-tasks/scripts/pr_transition.py` guidance so a missing gate points Ivy to the weekly campaign decision and both scheduling primitives, rather than implying every output is a set of singles.

### Sharpening the rest of the schedule

Make the quality bar deterministic enough for review, without adding an automated content-scoring service:

- one independently understandable claim/lesson per single;
- hook in the opening line rather than a generic weekly-summary lead;
- at least one concrete detail from the weekly review when the source supports it;
- no “part N,” dangling pronouns, unexplained callbacks, or promises fulfilled by another day's post;
- reject filler, generic summaries, and near-duplicates during Ivy's sketch pass;
- apply the existing `sindustries-copy` and `no-ai-slop` skills before queueing;
- include a one-line purpose for each single in `[ivy-tweets-queued]` so Tom/Quinn can audit the schedule without opening every card.

This is workflow policy plus human review, not a backend publish gate. The scheduler validates shape/length; Tom retains final editorial approval in Mission Control.

## File/module implementation plan

### Content Scheduler backend (current pre-extraction paths)

- `services/tasks-api/prisma/schema.prisma` and a new migration — add kind/status values, ordered reply parts, and publish-attempt journal.
- `services/tasks-api/src/routes/contentScheduler.ts` — discriminated create/update validation, aggregate transaction loading, retry route, state guards.
- `services/tasks-api/src/routes/contentSchedulerPublish.ts` — return explicit tweet IDs, add `deleteTweet`, implement fake/real delete behavior.
- `services/tasks-api/src/routes/contentSchedulerPublishService.ts` — preflight, claim, chained create, journal writes, reverse compensation, retry/reconciliation entry points.
- `services/tasks-api/src/routes/contentSchedulerJobs.ts` — treat `publishing`/`cleanup_required` as non-schedulable and preserve aggregate schedule-version semantics.
- `services/tasks-api/src/routes/autoPostWorker.ts` and `autoPostReconciliation.ts` — publish one aggregate job; reconcile stale attempt states without blind create replay.
- Backend route/service/worker tests — add thread and compensation cases while preserving all existing single-item tests.

If extraction lands, these exact responsibilities move under `services/content-scheduler-api`; no Tasks API compatibility proxy is added.

### Mission Control

- Extend the files listed in the Mission Control section for type selection, ordered-part editing, aggregate cards, publish progress/errors, and retry.
- Update `apps/mission-control/SPEC.md` Flow 7 to describe thread review/edit/approval, one-card calendar behavior, and recovery UX.

### Weekly workflow and docs

- `agents/definitions/ivy/HEARTBEAT.md` — thread-vs-single decision, one-unit scheduling, and standalone quality bar.
- `agents/skills/content/schedule-tweet-thread/SKILL.md` — authenticated one-aggregate thread queue primitive.
- `agents/workflows/content-tasks/scripts/pr_transition.py` — updated missing-gate guidance.
- Existing workflow tests/fixtures around `[ivy-tweets-queued]` — prove the marker remains accepted with mixed single/thread descriptions.
- `docs/systems/content-scheduler.md` — on ship, replace the thread known gap with the aggregate model, publish/compensation runbook, and X atomicity limitation.

## Test plan

Run at minimum (workspace/package names may move with service extraction):

- Content Scheduler backend unit/integration suite;
- Mission Control `ContentSchedulerTab`, `SchedulerItemCard`, hook, and API-client tests;
- full Mission Control test suite and build;
- content-task workflow Python tests;
- Prisma validate plus migration test on a database containing existing single items.

Backend automated coverage:

- create/list/update a thread as one aggregate with stable order;
- reject fewer than 2/more than 7 parts, gaps, empty parts, and over-limit parts;
- existing single requests/responses remain compatible;
- editing an approved thread clears approval and cancels/bump-invalidates its job;
- one manual/worker caller wins the conditional publish claim;
- fake X receives root with no reply ID and each later part replying to the immediately prior returned ID;
- successful chain writes one published aggregate and all part URLs;
- failure before root posts leaves no remote tweets and exposes retry;
- failure at each reply position deletes earlier tweets in reverse order and returns to approved;
- injected delete failure enters `cleanup_required`, preserves live IDs/URLs, and blocks new creates;
- retry cleans remnants before starting a new chain;
- stale `publishing` reconciliation never blindly creates a duplicate;
- thread counts once against the Pacific/Auckland daily cap;
- auto-post enqueues/fires once per aggregate.

Mission Control component coverage:

- switch composer to thread mode, add/reorder/remove parts, and submit one create call;
- one thread appears as one calendar card with ordered expandable parts;
- editing and approving operate on the aggregate;
- publishing and cleanup-required states disable unsafe actions and show the correct retry control/error;
- published thread shows root/reply links;
- single-item behavior remains unchanged.

Manual smoke with `FakeXClient`:

1. Queue a three-part thread, inspect one calendar card, edit part two, and approve the aggregate.
2. Publish and verify fake calls form `root -> reply to root -> reply to reply`.
3. Inject a failure on part three and verify parts one/two are deleted and Retry is available.
4. Inject a delete failure and verify Mission Control shows the possibly-live URL, blocks a new chain, then recovers through retry cleanup.
5. Queue two standalone posts and verify they remain independent cards on their own days.

### Acceptance-criterion verification matrix

| AC | Verification layer | Planned evidence |
| --- | --- | --- |
| AC1 | Backend integration + Mission Control component | Create one thread aggregate, assert one calendar item/job/schedule, then assert X calls are a root followed by replies to the immediately previous IDs. No child is independently scheduled. |
| AC2 | Mission Control component (browser E2E if harness is available) | Render, expand, reorder/edit, approve, drag, and publish a thread through one card and one aggregate ID; assert ordered parts stay together. |
| AC3 | Backend integration + worker/reconciliation tests + manual failure smoke | Inject failure at every create/delete position; assert reverse compensation, explicit `cleanup_required`, known live URLs, no new creates before cleanup, and a working retry path. Document the unavoidable X transaction/crash limitation. |
| AC4 | Workflow file tests/review + API integration | Fixtures for a dependent narrative produce one thread request; independent signals produce single requests. Verify one thread ID appears as one scheduled unit and no narrative parts are spread across days. |
| AC5 | Workflow policy tests where deterministic, plus Tom's Mission Control approval | Verify generated campaign instructions require hooks, one idea, independence, concrete detail, no filler/duplicates, and existing copy/slop passes. Editorial quality remains human-reviewed rather than encoded as a brittle API heuristic. |

## Risks and open questions

1. **AC3 wording versus X capability:** strict external atomicity is unavailable. This design uses compensating deletes and explicit cleanup recovery. Quinn/Tom should confirm that interpretation before implementation; otherwise the AC must change.
2. **Unknown outcome after process death:** a tweet may be accepted by X before its ID reaches Postgres. Reconciliation must stop and surface operator inspection rather than risk duplicate chains. Better observability cannot remove this API limitation.
3. **Delete permissions/rate limits:** production OAuth credentials must permit deleting tweets created by the account. Add a fake-client test and a credentialed manual smoke before enabling thread auto-post in production.
4. **Character counting:** current storage permits 1000 characters while the scheduling skill uses 280. The implementation should centralize the existing X-safe counting rule and apply it to every part and to singles accepted through this route; do not rely on HTML `maxLength` alone.
5. **Approval invalidation:** this design clears approval after editing any thread part. That is safer than silently publishing edited copy, but it is a behavior change Tom should see clearly in the UI.
6. **Daily cap semantics:** one thread counts as one scheduled/published content unit even though it creates several X posts. This matches the one-card outcome; analytics that count raw X tweets must use attempt-part rows, not the scheduler's daily unit count.
7. **Migration/extraction ordering:** implementation paths change if `94d5e4fc` lands first, but the public contract and aggregate model should not. Avoid parallel migrations against two databases.
8. **No retroactive conversion:** there is intentionally no “Convert to thread” action for existing rows. New thread creation begins after deployment; existing singles stay singles.
