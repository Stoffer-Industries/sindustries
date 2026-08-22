---
status: draft
task_id: 5279b310-9a15-43eb-ad31-c42e866728ca
product_spec: brain/tasks/specs/open/bookmark-approval-author-mention-tweet-2026-08-19.md
shipped_pr: null
shipped_date: null
refresh_of: docs/specs/bookmark-approval-author-mention-tweet-2026-08-19-tech-design.md
refresh_reason: Content Scheduler backend extracted from tasks-api into content-scheduler-api (PR #509 of task 94d5e4fc, merged 2026-08-22). Original tech design paths and naming pre-date the extraction.
---

# Bookmark approval — build-in-public tweet + manual reply draft — tech design REFRESH

## Why refresh

The original tech design (`docs/specs/bookmark-approval-author-mention-tweet-2026-08-19-tech-design.md`, Quinn-approved 2026-08-21T00:12:05Z) targets the pre-extraction service boundary. Since then, task 94d5e4fc "Extract Content Scheduler from Tasks API" landed via PR #509 (stacked on PR #507, merged 2026-08-22T07:04Z; mergeCommit on main = `494faf4378c6d74af03c8a039658f65116fab08c`). The Content Scheduler backend moved out of `services/tasks-api` into `services/content-scheduler-api/`, and the Prisma model + routes + tests + xTweet.ts all moved with it.

This refresh is a **path + naming delta**. No semantic change to AC1–AC6, no change to the public product spec, no change to the LLM prompts, no change to the failure-isolation posture. The original shape (kind discriminator on the draft/item type, new PATCH route for posted-URL capture, Python helper, hook site, Mission Control UI section) is correct as-is; only file paths, the type name, the route segment, and the env var name have drifted.

## Path mapping

| Original (pre-extraction)                                            | Post-extraction                                                          | Notes                                                              |
|----------------------------------------------------------------------|--------------------------------------------------------------------------|--------------------------------------------------------------------|
| `services/tasks-api/src/types/contentScheduler.ts`                    | `services/content-scheduler-api/src/routes/contentScheduler.ts`          | Type co-located with route; no separate `src/types/` subdirectory  |
| `services/tasks-api/src/routes/contentSchedulerPublish.ts`            | `services/content-scheduler-api/src/routes/contentSchedulerPublish.ts`   | Routes moved whole-file; logic unchanged                            |
| `services/tasks-api/src/routes/contentSchedulerValidation.ts`         | `services/content-scheduler-api/src/routes/contentSchedulerValidation.ts` |                                                                       |
| `services/tasks-api/src/routes/contentSchedulerJobs*.ts`              | `services/content-scheduler-api/src/routes/contentSchedulerJobs*.ts`      | Job scheduler adapter selection intact                              |
| `services/tasks-api/src/routes/xTweet.ts`                            | `services/content-scheduler-api/src/routes/xTweet.ts`                    | `xTweet.ts` moved with the XClient now co-located with publish helper |
| `services/tasks-api/test/contentScheduler.test.ts`                   | `services/content-scheduler-api/test/contentScheduler.test.ts`            | Plus 3 sibling tests (`AutoPost`, `AutoPostDurable`, `Import`)      |

Verified against origin/main `11d99a42` (refresh-branch tip) via `git ls-tree origin/main services/content-scheduler-api/src/routes/` — confirms the route files (10 + `xTweet.ts`) now live at `services/content-scheduler-api/src/routes/`, NOT `services/tasks-api/src/routes/`.

## Naming corrections

| Original design name             | Actual API / DB name                  | What changes                                                                                  |
|----------------------------------|----------------------------------------|-----------------------------------------------------------------------------------------------|
| `ContentDraft` (type)            | `ContentSchedulerItem` (Prisma model)  | The kind discriminator + 3 optional fields attach to `ContentSchedulerItem`, not `ContentDraft` |
| `DraftKind` (enum)               | n/a                                    | Becomes an inline `kind: "scheduled" \| "manual_reply"` discriminator on `ContentSchedulerItem` |
| `drafts` (route segment)         | `items`                                | API surface is `/content-scheduler/items`, NOT `/content-scheduler/drafts`                    |
| `manualPostedUrl` / `manualPostedAt` / `linksToDraftId` (field names) | unchanged | Field names are correct; just attach to `ContentSchedulerItem` |

The Mission Control UI label **"Reply drafts (manual)"** is kept as user-facing copy because it describes Tom's intent (a draft Tom will post), even though the underlying API/DB name is "items". The user-facing noun and the API noun can disagree — that's fine.

## Route surface

Actual post-extraction route surface (verified from `services/content-scheduler-api/src/routes/contentScheduler.ts` at origin/main `11d99a42`):
- `GET  /content-scheduler/items` — list
- `POST /content-scheduler/items` — create; extend body validation to accept `kind`, `manualPostedUrl`, `manualPostedAt`, `linksToDraftId`
- `PATCH /content-scheduler/items/:id` — edit; same field extensions
- `POST /content-scheduler/items/:id/approve` — mark approved
- `POST /content-scheduler/items/:id/unapprove` — clear approval
- `POST /content-scheduler/items/:id/publish` — publish; MUST skip rows where `kind === "manual_reply"`
- `POST /content-scheduler/items/:id/remove` — soft-delete
- `POST /content-scheduler/reorder` — rewrite positions
- `GET  /content-scheduler/today-status` — daily cap
- **NEW (this PR):** `PATCH /content-scheduler/items/:id/posted-url` — lightweight endpoint for AC5's posted-URL capture. Body: `{ manualPostedUrl: string }`. URL is validated as `https://x.com/...` or `https://twitter.com/...`. Persists `manualPostedUrl` + `manualPostedAt` (server clock). Returns the updated item row. Idempotent: re-PATCHing the same URL is a no-op (200, no timestamp update). Auth: same localhost-trust pattern as the existing `/content-scheduler/*` routes (the Mission Control UI is the only caller).

The publish loop in `contentSchedulerPublish.ts` and the job-scheduler adapter selection in `contentSchedulerJobs*.ts` must skip rows where `kind === "manual_reply"`, regardless of `scheduledFor`. **Default `kind` is `"scheduled"`** so existing rows continue to publish unchanged — no migration of historical rows needed.

## Env var / port changes

| Original (pre-extraction)                                   | Post-extraction                                              |
|-------------------------------------------------------------|--------------------------------------------------------------|
| `TASKS_API_BASE_URL`                                        | `CONTENT_SCHEDULER_API_BASE_URL`                             |
| Default `http://localhost:4001/api/v1` (tasks-api prodlike) | Default `http://localhost:4003/api/v1` (content-scheduler-api prodlike) |

The hook script `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` currently reads `TASKS_API_BASE_URL` (line 18: `_TASKS_API_BASE_URL = os.getenv("TASKS_API_BASE_URL", "http://localhost:4001/api/v1")`) and passes it as `tasks_api_base_url=` to a helper (line 121). After this PR, the hook must read `CONTENT_SCHEDULER_API_BASE_URL` instead and pass it as `content_scheduler_api_base_url=` to the new `queue_bookmark_mention_drafts()` helper. The Tiltfile / `.env.prodlike` entry for the lobster invocation must add the new env var.

Verified via `apps/mission-control/src/contentSchedulerApi.js` (lines 11–16):
```js
const DEFAULT_API_BASE_BY_PORT = {
  '5173': 'http://localhost:4000/api/v1',
  '5174': 'http://localhost:4001/api/v1',
  '5175': 'http://localhost:4002/api/v1',
  '5176': 'http://localhost:4003/api/v1'
};
```
→ Port `4003` is the content-scheduler-api port in the prodlike stack (mapped to Vite dev port `5176`). The refresh preserves this mapping; the MC client only changes which env var it reads.

## Mission Control UI

| Original (pre-extraction)                          | Post-extraction                                                                                  |
|---------------------------------------------------|--------------------------------------------------------------------------------------------------|
| `apps/mission-control/src/contentSchedulerApi.js` | Same path; client must read `VITE_CONTENT_SCHEDULER_API_BASE_URL` (new env var) before falling back to `DEFAULT_API_BASE_BY_PORT['5176']` (= `http://localhost:4003/api/v1`) |
| `apps/mission-control/src/tabs/ContentSchedulerTab.jsx` (UI section) | Same path; add new "Reply drafts (manual)" section + copy button + URL-capture input under the existing scheduled list |
| `apps/mission-control/src/tabs/SchedulerItemCard.jsx` | Same path; render the manual-reply row with a distinct visual treatment (deferred to design review per original §6) |

The MC UI shape from the original design (new "Reply drafts (manual)" section + copy button + URL-capture input + visual distinction) is correct as-is; only the base-URL wiring changes.

## Prisma migration

A new migration is required to add the `kind` discriminator enum and the three optional fields on `ContentSchedulerItem`:

```prisma
enum ContentSchedulerItemKind {
  scheduled
  manual_reply
}

model ContentSchedulerItem {
  // ... existing fields (id, body, source, sourceRef, status, scheduledFor, position, ...) ...
  kind                 ContentSchedulerItemKind @default(scheduled)
  manualPostedUrl      String?
  manualPostedAt       DateTime?
  linksToItemId        String?                  // renamed from linksToDraftId to match the items/ naming
  // ... rest of existing fields ...
}
```

Migration file: `services/content-scheduler-api/prisma/migrations/<timestamp>_add_manual_reply_kind/migration.sql`. The default `kind = "scheduled"` preserves backwards compat for every existing row — no data migration needed.

Note the field rename `linksToDraftId` → `linksToItemId` to keep terminology aligned with the rest of the API/DB. The Mission Control UI will look up the linked item by id (via `linksToItemId`).

## Test plan update

Pre-extraction tests moved intact. New / extended tests:

- **`services/content-scheduler-api/test/contentScheduler.test.ts`** *(extended)* — `kind` defaults to `"scheduled"`; publish loop skips `kind == "manual_reply"` regardless of `scheduledFor`; new route validations.
- **`services/content-scheduler-api/test/contentSchedulerItems.test.ts`** *(new)* — POST accepts new fields; rejects `manualPostedUrl` without `kind == "manual_reply"`; PATCH `/items/:id/posted-url` validates URL shape; idempotent re-PATCH.
- **`agents/workflows/bookmarks/scripts/tests/test_x_author_mention_tweets.py`** *(new)* — Python `unittest`. Cases (unchanged from original design):
  - `compose_build_in_public_tweet` happy + LLM error.
  - `compose_reply_tweet` happy + LLM error + `parse_x_link` returns None (AC3 degradation: handle missing → body uses "the original poster" instead of `@handle`).
  - `post_draft` (renamed `post_item`) happy + 4xx + 5xx.
  - `queue_bookmark_mention_drafts` integration: covers all skip + error branches, verifies NEVER raises.
- **`agents/workflows/bookmarks/scripts/tests/test_lobster_resolve_spec_request.py`** *(extended)* — Cases (unchanged from original design; plus the env var swap):
  - Approval with X source + tasked + ≥1 task → `queue_bookmark_mention_drafts` invoked, `contentDrafts.queuedDraftIds` populated.
  - Approval with non-X source → `queue_bookmark_mention_drafts` NOT invoked.
  - Approval with `next_status == "approved"` (no tasks) → NOT invoked.
  - Hook raises nothing when `queue_bookmark_mention_drafts` raises (defense in depth); `contentDrafts.errors` populated; lobster exit code stays 0.
  - Hook reads `CONTENT_SCHEDULER_API_BASE_URL` (not `TASKS_API_BASE_URL`).
- **Regression:** existing `test_common.py`, `test_analytics_db.py`, `test_spec_lifecycle.py`, all tasks-api and content-scheduler-api tests still pass.

## Documentation updates

- **`docs/systems/bookmark-workflow.md`** — unchanged from original design; add a one-line note that the helper now writes to `services/content-scheduler-api` not `services/tasks-api`.
- **`apps/mission-control/README.md`** — unchanged from original design; the `VITE_CONTENT_SCHEDULER_API_BASE_URL` env var replaces `VITE_TASKS_API_BASE_URL` for content-scheduler calls.
- **`services/content-scheduler-api/README.md`** *(modified)* — pointer under "Routes" for `PATCH /content-scheduler/items/:id/posted-url` (POST extension noted in the existing items section). NEW file relative to the original design (which pointed at `services/tasks-api/README.md`).

## Open questions for Quinn

1. The original design called the type `ContentDraft`; the refresh renames it to `ContentSchedulerItem` to match the actual Prisma model and route surface. Acceptable?
2. The route surface is `/items`, not `/drafts`. The Mission Control UI label "Reply drafts (manual)" stays because it describes user intent, but the API and Prisma use "items". Acceptable to keep "drafts" in user-facing copy while the API is `/items`?
3. The new `kind` enum + 3 optional fields require a Prisma migration in `services/content-scheduler-api/prisma/migrations/`. OK to add it as part of this PR?
4. The Mission Control API client (`apps/mission-control/src/contentSchedulerApi.js`) currently reads `VITE_TASKS_API_BASE_URL` and falls back to per-port `DEFAULT_API_BASE_BY_PORT` (port 5176 → 4003). Confirm the new env var name should be `VITE_CONTENT_SCHEDULER_API_BASE_URL` (preserves the existing 5176 → 4003 fallback).

## Out of scope (unchanged from original design)

- Pipeline ever posting the reply itself.
- Auto-detecting or polling whether/when Tom has posted the reply.
- Engagement tracking (likes, replies, reposts) on either tweet beyond AC5's URL capture.
- Retroactively drafting for bookmarks already `tasked` before this ships.
- Generalising the manual-reply lifecycle to other X-engagement scenarios (retweets, quote-posts, threads).
- Persisting `contentDraftIds` / `contentDraftErrors` to Postgres (`analytics.bookmark_transitions`).
- Refactoring the predecessor's `xTweet.ts` out of content-scheduler-api. The route moved alongside the extraction but is still dead surface for our flow (no callers from this PR); leave it in place until the predecessor's `x_author_tweet.py` is also removed (separate cleanup task).

## Implementation branch

- Branch: `task-5279b310-bookmark-approval-author-mention-tweet-refresh` (cut off `origin/main` at `11d99a42`)
- Worktree: `~/workspaces/.../worktrees/task-5279b310-bookmark-approval-author-mention-tweet-refresh` (created via `infra/guards/sindustries-worktree.sh task-5279b310-bookmark-approval-author-mention-tweet-refresh`)

When Quinn approves the refresh:
1. Implement on the **refresh branch** (do not implement on the original `task-5279b310-bookmark-approval-author-mention-tweet` branch — that branch is at `266b3e4` pre-extraction and would need a noisy rebase).
2. Once the PR is open and approved, rebase the original branch onto the refresh branch tip before merge, so the original branch's history stays a clean linear sequence from main.

## Verification commands (run before posting this design)

```bash
# Confirm extraction landed in main
git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries log --oneline origin/main --grep="content-scheduler-api" | head -5
# → expected: 2609cdf (extraction), 494faf4 (CI fix), a19b976 (scaffold)

# Confirm new route files at the right path
git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries ls-tree origin/main services/content-scheduler-api/src/routes/ | head -15
# → expected: 10 scheduler route files + xTweet.ts

# Confirm ContentSchedulerItem model (and no kind field yet)
git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries show origin/main:services/content-scheduler-api/prisma/schema.prisma | grep -E "model ContentSchedulerItem|kind"
# → expected: model definition shown; no `kind` field yet (must be added by this PR's migration)

# Confirm MC client currently uses VITE_TASKS_API_BASE_URL (will need refresh)
git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries show origin/main:apps/mission-control/src/contentSchedulerApi.js | grep -E "VITE_|DEFAULT_API_BASE"
# → expected: VITE_TASKS_API_BASE_URL fallback + DEFAULT_API_BASE_BY_PORT mapping port 5176 → 4003

# Confirm hook still uses TASKS_API_BASE_URL
git -C /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries show origin/main:agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py | grep -E "TASKS_API_BASE_URL|tasks_api_base_url"
# → expected: TASKS_API_BASE_URL env var + tasks_api_base_url= kwarg (must be replaced by CONTENT_SCHEDULER_API_BASE_URL)
```

## References

- Original tech design: `docs/specs/bookmark-approval-author-mention-tweet-2026-08-19-tech-design.md` (Quinn-approved 2026-08-21T00:12:05Z)
- Extraction PRs: PR #507 (scaffold) + PR #509 (extraction WS2+WS3+WS5) — task 94d5e4fc, merged 2026-08-22
- Extraction mergeCommit on main: `494faf4378c6d74af03c8a039658f65116fab08c`
- Post-extraction origin/main HEAD at refresh time: `11d99a42ef2cea9435e653812353280023247768`
- Refresh branch tip at draft time: matches origin/main HEAD = `11d99a42ef2cea9435e653812353280023247768`
- Refresh worktree: `~/.openclaw/workspace/worktrees/task-5279b310-bookmark-approval-author-mention-tweet-refresh`
- Task: `5279b310-9a15-43eb-ad31-c42e866728ca` (🔧 Bookmark approval — build-in-public tweet + manual reply draft)
- Product spec: `brain/tasks/specs/open/bookmark-approval-author-mention-tweet-2026-08-19.md`
