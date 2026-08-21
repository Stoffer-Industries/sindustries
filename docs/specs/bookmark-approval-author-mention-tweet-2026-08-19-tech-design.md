---
status: draft
task_id: 5279b310-9a15-43eb-ad31-c42e866728ca
product_spec: brain/tasks/specs/open/bookmark-approval-author-mention-tweet-2026-08-19.md
shipped_pr: null
shipped_date: null
---

# Bookmark approval — build-in-public tweet + manual reply draft — tech design

## Links

- Product spec: `brain/tasks/specs/open/bookmark-approval-author-mention-tweet-2026-08-19.md`
- Task: `5279b310-9a15-43eb-ad31-c42e866728ca` (`🔧 Bookmark approval — build-in-public tweet + manual reply draft`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/5279b310-9a15-43eb-ad31-c42e866728ca`
- **Spec rationale (key context):** the spec's "Why" section documents that the pipeline has tried twice now to notify bookmark authors automatically — the predecessor task `55ac9240-d54a-4b2c-88c4-8bb8af85d2b2` called for a quote-post, the implementation built a reply instead, and X has since restricted programmatic replies to summoned accounts (Feb 2026) and removed Quote-Posts from the API entirely on every self-serve tier (April 2026) — both confirmed dead via a live test against the bookmark that surfaced this. A standalone non-reply tweet that plain-text @-mentions a stranger was confirmed to post cleanly (`https://x.com/Stoff81/status/2089785422478192951`). The current spec lands on a better shape: full automation for content that's genuinely the account's own (timeline tweet) + human in the loop for anything that engages someone else's content (reply draft).
- Predecessor (superseded): task `55ac9240-d54a-4b2c-88c4-8bb8af85d2b2`, spec `brain/tasks/specs/done/bookmark-approval-author-tweet-2026-07-17.md`, tech design `docs/specs/bookmark-approval-author-tweet-tech-design.md` — the implementation surface in `services/tasks-api/src/routes/xTweet.ts` + `agents/workflows/bookmarks/scripts/x_author_tweet.py` is **not** the path this design takes. We are routing everything through the Content Scheduler, not direct X API calls.
- **Author-resolution capability (reused by AC3):** shipped 2026-08-18 in the predecessor task. `parse_x_link(url) -> (handle, status_id) | None` lives in `agents/workflows/bookmarks/scripts/x_author_tweet.py`. Spec confirms this is reused, not rebuilt.
- Hook point: `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` (the existing approve → tasked transition loop)
- Existing LLM helper (reused for tweet composition): `agents/workflows/bookmarks/scripts/common.py::call_bookmark_llm()`
- Content Scheduler API surface: `services/tasks-api/src/routes/contentScheduler*.ts` (existing draft create/list/publish endpoints; will extend with `kind` field)
- Mission Control Content Scheduler UI: `apps/mission-control/...` — exact file path resolved during implementation; the view that lists scheduled drafts and lets Tom publish/inspect them.
- Companion system doc: `docs/systems/bookmark-workflow.md`

## Repositories

- Primary: `Stoffer-Industries/sindustries`
- Branch: `task-5279b310-bookmark-approval-author-mention-tweet`
- Worktree: `~/workspaces/.../sindustries-task-5279b310-bookmark-approval-author-mention-tweet` (created via `infra/guards/sindustries-worktree.sh task-5279b310-bookmark-approval-author-mention-tweet`)
- No secondary repos. Code lands in `services/tasks-api/src/routes/` (TypeScript — extend `contentScheduler*.ts`), `agents/workflows/bookmarks/scripts/` (Python — new composition helper + hook extension), `apps/mission-control/...` (UI — new manual-reply section + posted-URL capture).

## Product intent (from approved product spec, restated)

When an X-sourced bookmark is approved AND at least one task is created, two draft items are queued in the Content Scheduler:

1. A standalone "build in public" timeline tweet — Tom publishes through the Content Scheduler as usual, on his own timeline, announcing work has started with a short outline.
2. A reply draft — content that links back to the standalone tweet, references the original bookmark, and asks a content-specific question. **Tom copies this draft, posts it manually as a reply on X, then records the resulting tweet URL against the draft.**

Non-X bookmarks silently skip both steps. Any draft-creation failure is recorded but does NOT block the bookmark approval or task creation. This satisfies a standing rule established in the spec's "Why": every tweet from a Sindustries account routes through the Content Scheduler, none posted by ad-hoc script.

Approved by Tom (per task description).

## Acceptance criteria recap

- **AC1** — X-source + tasked + ≥1 task created → standalone timeline tweet draft appears in Content Scheduler with build-in-public content.
- **AC2** — Same trigger → second draft queued, body links to standalone tweet, references bookmark, asks content-specific question. Intended for manual reply.
- **AC3** — Reply draft correctly identifies original tweet's author even when bookmark URL doesn't carry handle directly (reuses `parse_x_link` shipped 2026-08-18).
- **AC4** — Reply draft visibly distinct in Content Scheduler from ordinary scheduled tweets; never auto-published; copy-button + URL-capture affordance.
- **AC5** — Tom records his posted reply URL against the draft; URL stored on the draft; draft state reflects posted.
- **AC6** — Non-X bookmarks silently skip both steps; draft-creation failures recorded without blocking approval or task creation.

## `.openclaw` boundary

- **No new secrets or tokens.** We are routing through the Content Scheduler (existing `services/tasks-api/src/routes/contentScheduler*.ts`), which already owns its OAuth 1.0a credentials. The predecessor task's pre-req ("Tom re-auths the X OAuth flow to add `tweet.write`") is **dropped** — this design never calls the X API directly.
- **No `~/.openclaw/` writes.** Everything repo-owned.
- **No cron changes.** Draft creation runs inline at the existing approve → tasked transition.
- **No LLM cost policy changes.** Tweet composition reuses `call_bookmark_llm()` from `common.py`. Two LLM calls per qualifying bookmark approval (timeline + reply). Acceptable at current approval volume (~tens/week, see Q5).

## Out of scope (parking lot, deliberately)

- The pipeline ever posting the reply itself, automatically or otherwise. Standing rule per spec "Why" — every tweet that engages someone else's content gets a human pressing "reply".
- Auto-detecting or polling whether/when Tom has posted the reply. Spec §Non-Goals confirms: Tom records the URL himself.
- Engagement tracking (likes, replies, reposts) on either tweet beyond AC5's URL capture.
- Retroactively drafting for bookmarks already `tasked` before this ships. Spec §Non-Goals confirms: trigger applies going forward only.
- Generalising the manual-reply draft lifecycle to other X-engagement scenarios (retweets, quote-posts, threads).
- Persisting `contentDraftIds` / `contentDraftErrors` to Postgres (`analytics.bookmark_transitions`). JSONL / state mirror captures them; a dedicated column is a follow-up if Pulse wants it.
- Refactoring the predecessor's `xTweet.ts` route out of the codebase. The route is dead surface for our flow but still has callers from the predecessor task's `x_author_tweet.py` — leave it in place until that module is also removed (separate cleanup task).

## Implementation plan

### File / module scope

#### 1. Extend Content Scheduler draft type — `services/tasks-api/src/types/contentScheduler.ts` *(modified)*

Add a `kind` discriminator so the publish loop can skip manual-reply drafts and the UI can render them in a distinct section.

```ts
export type DraftKind = "scheduled" | "manual_reply";

export interface ContentDraft {
  // existing fields (text, scheduledAt, status, postedAt, postedUrl, ...)
  kind: DraftKind;                 // NEW: default "scheduled" for backwards compat
  // AC5 capture surface
  manualPostedUrl?: string;        // present when kind == "manual_reply" AND Tom has recorded it
  manualPostedAt?: string;         // ISO-8601; mirrors manualPostedUrl recording
  // AC2 cross-reference: which timeline-tweet draft this reply links back to
  linksToDraftId?: string;         // present when kind == "manual_reply"; UI resolves when target draft publishes
}
```

The publish loop (`contentSchedulerPublish.ts`) must explicitly skip rows where `kind === "manual_reply"`, regardless of `scheduledAt`. **Default `kind` is `"scheduled"`** so existing rows continue to publish unchanged — no migration needed.

#### 2. New tasks-api route — `POST /content-scheduler/drafts` *(extended)*

The existing create-draft endpoint accepts the new `kind`, `manualPostedUrl`, `manualPostedAt`, `linksToDraftId` fields. Body validation rejects `manualPostedUrl` when `kind !== "manual_reply"` and rejects `linksToDraftId` when `kind !== "manual_reply"`.

#### 3. New tasks-api route — `PATCH /content-scheduler/drafts/:id/posted-url` *(new)*

Lightweight endpoint to satisfy AC5. Body: `{ manualPostedUrl: string }`. URL is validated as `https://x.com/...` or `https://twitter.com/...`. Persists `manualPostedUrl` + `manualPostedAt` (server clock). Returns the updated draft row.

- Auth: same localhost-trust pattern as the existing `/content-scheduler/*` routes (the Mission Control UI is the only caller; the predecessor precedent holds).
- Idempotent: re-PATCHing the same URL is a no-op (200, no timestamp update).

#### 4. New Python module — `agents/workflows/bookmarks/scripts/x_author_mention_tweets.py` *(new)*

Sibling to the predecessor's `x_author_tweet.py` but **never** calls the X API. Public entry point:

```python
def queue_bookmark_mention_drafts(
    state_item: dict,
    *,
    tasks_api_base_url: str | None = None,
) -> dict:
    """Queue timeline + reply drafts for an X-sourced bookmark that just transitioned to `tasked`.

    Returns a status dict shaped like:
        {
            "queuedDraftIds": [id1, id2],            # both successful
            "errors": [{"kind": "timeline"|"reply", "error": "<reason>"}],  # per-failure
            "skipped": "non_x_source" | "no_tasks" | None,
        }

    NEVER raises. Failures are recorded in `errors`; the caller (lobster hook) is
    expected to persist this dict onto state_item and continue.
    """
```

Internal helpers:

- `compose_build_in_public_tweet(state_item) -> str` — LLM call via `call_bookmark_llm()`. Prompt: announce work started, short outline of what's being built, content-specific. ≤280 chars enforced. Raises `TweetComposeError` on LLM failure.
- `compose_reply_tweet(state_item, *, standalone_tweet_body: str) -> str` — LLM call. Body references the standalone tweet (placeholder; resolved post-publish via `linksToDraftId`), the original bookmark, asks content-specific question. Uses `parse_x_link(state_item["link"])` to resolve `@handle` (AC3 reuse — already shipped). ≤280 chars enforced. Raises `TweetComposeError` on LLM failure.
- `post_draft(draft_body: dict, *, base_url: str) -> str` — stdlib-only `urllib` POST to `/content-scheduler/drafts`. Returns the draft id. Raises `DraftCreateError` on 4xx/5xx with the body attached.
- `queue_bookmark_mention_drafts` integration:
  - `state_item["source"] != "x"` → `{"skipped": "non_x_source"}`.
  - `merged_task_ids` empty → `{"skipped": "no_tasks"}`.
  - Compose fails for timeline → record error, do NOT attempt reply (reply references the timeline).
  - Compose fails for reply → record error, the timeline draft is still queued (one-of-two is better than none).
  - POST fails for either → record error, do NOT raise.
  - Both succeed → `{"queuedDraftIds": [timeline_id, reply_id], "errors": []}`.

#### 5. Hook site — `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` *(modified)*

Today the script transitions each approved bookmark's `reviewStatus` to `tasked` (or `approved` when no tasks were created). The new step is added **after** the transition succeeds:

For each `state_item` that landed in `next_status == "tasked"` AND `state_item["source"] == "x"` AND at least one task ID is in `merged_task_ids` (AC1's "≥1 task created" gate):

1. Call `queue_bookmark_mention_drafts(state_item, tasks_api_base_url=base)`.
2. Persist the returned dict as `state_item["contentDrafts"] = <returned-dict>`. Shape documented in module's docstring.
3. Use `save_state()` to flush.

The hook is wrapped in a top-level `try/except Exception` that records any unexpected error to `state_item["contentDrafts"]["errors"]` without raising. The lobster script's exit code stays 0.

The `next_status == "approved"` branch (no tasks created) **must not** invoke `queue_bookmark_mention_drafts` because AC1 requires ≥1 task created. Both gates (X source + tasked + ≥1 task) are tested.

#### 6. Mission Control UI — reply-drafts section + URL capture (AC4)

In the Content Scheduler view (`apps/mission-control/...`):

- New section below the regular scheduled list: **"Reply drafts (manual)"** — empty when none.
- Each row shows: the reply body (rendered with a copy-to-clipboard button), the source bookmark link, the timeline tweet the reply links back to (resolved via `linksToDraftId` → fetches the target draft), and a `Posted URL` text field with a **Save** button.
- On save: PATCH `/content-scheduler/drafts/:id/posted-url`. Row updates to show a posted indicator + the URL as a link (with `target="_blank"`).
- Reply drafts have a distinct visual treatment (different background / badge per design system — defer exact styling to design review).

#### 7. Cross-link resolution for `linksToDraftId` (AC2 detail)

The reply body references the standalone tweet, but that tweet only has an id AFTER it's published. Two options were considered:

- **(a) Resolve at reply-creation time** — requires the timeline tweet to publish first, then trigger a second LLM call to fill in the id. Two-step trigger, more moving parts.
- **(b) Defer resolution via `linksToDraftId`** — the reply body uses a placeholder ("see linked build-in-public tweet"), and the UI resolves the actual URL when the user opens the reply row. Single-step trigger.

**Decision: (b).** Lower complexity, no second LLM call, UI does the cheap fetch. The `linksToDraftId` field is the explicit cross-reference; the UI fetches the target draft when rendering the reply row.

#### 8. Tests

- **`services/tasks-api/test/contentScheduler.test.ts`** *(extended)* — `kind` defaults to `"scheduled"` for existing rows; publish loop skips `kind == "manual_reply"` regardless of `scheduledAt`; new route validations.
- **`services/tasks-api/test/contentSchedulerDrafts.test.ts`** *(new)* — POST accepts new fields; rejects `manualPostedUrl` without `kind == "manual_reply"`; PATCH `/posted-url` validates URL shape; idempotent re-PATCH.
- **`agents/workflows/bookmarks/scripts/tests/test_x_author_mention_tweets.py`** *(new)* — Python `unittest`. Cases:
  - `compose_build_in_public_tweet` happy + LLM error.
  - `compose_reply_tweet` happy + LLM error + `parse_x_link` returns None (AC3 degradation: handle missing → body uses "the original poster" instead of `@handle`).
  - `post_draft` happy + 4xx + 5xx.
  - `queue_bookmark_mention_drafts` integration: covers all skip + error branches, verifies NEVER raises.
- **`agents/workflows/bookmarks/scripts/tests/test_lobster_resolve_spec_request.py`** *(extended)* — Cases:
  - Approval with X source + tasked + ≥1 task → `queue_bookmark_mention_drafts` invoked, `contentDrafts.queuedDraftIds` populated.
  - Approval with non-X source → `queue_bookmark_mention_drafts` NOT invoked.
  - Approval with `next_status == "approved"` (no tasks) → NOT invoked.
  - Hook raises nothing when `queue_bookmark_mention_drafts` raises (defense in depth); `contentDrafts.errors` populated; lobster exit code stays 0.
- **Regression:** existing `test_common.py`, `test_analytics_db.py`, `test_spec_lifecycle.py`, the predecessor's `test_x_author_tweet.py` (kept for now), and all tasks-api Content Scheduler tests still pass.

#### 9. Documentation — `docs/`

- **`docs/systems/bookmark-workflow.md`** *(modified)* — Add a "Build-in-public tweet + manual reply draft" subsection under the existing "Approval → Task Creation" stage. Explain: trigger condition (X source + tasked + ≥1 task created), what the AI prompt produces, where the result lands (`contentDrafts.queuedDraftIds` + `contentDrafts.errors`), the AC4 visual distinction, AC5's posted-URL capture, and AC6's failure isolation. Reference this tech design.
- **`apps/mission-control/README.md`** *(modified)* — short entry under "Content Scheduler" listing the new manual-reply section.
- **`services/tasks-api/README.md`** *(modified)* — pointer under "Routes" for `PATCH /content-scheduler/drafts/:id/posted-url` (POST extension noted in the existing draft section).

### Data model summary

Two new optional fields on each affected bookmark item:

```python
state.items[<key>]["contentDrafts"] = {
    "queuedDraftIds": [id1, id2],            # both successful
    "errors": [{"kind": "timeline"|"reply", "error": "<reason>"}],
    "skipped": "non_x_source" | "no_tasks" | None,
}
```

Three new optional fields on each affected `ContentDraft` row:

```ts
{
    kind: "scheduled" | "manual_reply",      // default "scheduled"
    manualPostedUrl?: string,                // AC5 capture
    manualPostedAt?: string,                 // ISO-8601 mirror
    linksToDraftId?: string,                 // AC2 cross-ref
}
```

No schema migration in the Postgres sense (`contentDrafts.kind` defaults to `"scheduled"` on existing rows via a NOT NULL with default). Bookmark state is free-form JSONL, no migration.

### Cross-context coordination

- **lobster_resolve_spec_request.py → tasks-api `POST /content-scheduler/drafts`:** HTTP POST over `TASKS_API_BASE_URL` (defaults to `http://localhost:4001/api/v1`). The lobster is the only caller in v1.
- **Mission Control UI → tasks-api `PATCH /content-scheduler/drafts/:id/posted-url`:** HTTP PATCH from the UI to record Tom's posted reply URL.
- **No new IPC, no `postMessage`, no cron.**
- **tasks-api lifecycle:** the lobster already requires tasks-api running (the existing task-creation step). Same expectation for draft creation.

### Workflow / cron / skill changes

- **Cron:** none. Draft creation runs inline at the existing approve → tasked transition.
- **Skill:** `schedule-tweets` may need a minor section on the manual-reply kind. Defer to implementation; the skill's existing body is small.
- **Lobster:** `bookmarks.lobster.yaml` does not change. The hook site is the Python script invoked by the existing lobster step.

### Design system usage

The Mission Control UI additions (AC4's reply-drafts section, AC5's posted-URL capture) need design system review. Per spec approval, intent is OK; exact styling, badge, copy-button affordance, and layout are deferred to implementation + design review.

### Service boundary notes

- **Domain owner:** the bookmark workflow owns the trigger (X source + tasked + ≥1 task) and the write-back to state (`contentDrafts.*`).
- **Why drafts live in Content Scheduler:** spec "Why" establishes the standing rule — every tweet from a Sindustries account routes through the Content Scheduler. The manual-reply draft is the human-in-the-loop variant: Tom copies the body, posts it manually, then records the URL. The Content Scheduler is the natural owner of the draft lifecycle.
- **Why the predecessor's `xTweet.ts` route is NOT used:** the predecessor's design called for direct X API calls; this design routes through Content Scheduler drafts instead. The predecessor route stays in the codebase but is no longer called from this flow.
- **Extraction / migration plan:** if a second domain ever needs to compose draft tweets (e.g. newsletter cross-post), extract `compose_build_in_public_tweet` + `compose_reply_tweet` into a shared `agents/workflows/tweet-composer/` package. **Not done in this PR.**

## Test plan

- **Unit (TypeScript):** extended `contentScheduler.test.ts` (kind default + publish-skip), new `contentSchedulerDrafts.test.ts` (POST + PATCH validation, idempotency).
- **Unit (Python):** new `test_x_author_mention_tweets.py` (compose + post + queue helpers), extended `test_lobster_resolve_spec_request.py` (hook integration).
- **Regression:** all existing Python and TypeScript tests still pass.
- **Manual smoke (against a real X-sourced bookmark):**
  1. Approve → two drafts appear, one in "Reply drafts (manual)" section, one in the regular scheduled list.
  2. Copy the reply body, post manually on X as a reply to the original bookmark's author, capture the URL.
  3. Paste the URL into the reply-draft row's field, save → row updates to "posted" with the URL as a link.
  4. Approve a non-X bookmark → no drafts created, no errors recorded, `contentDrafts.skipped == "non_x_source"`.
  5. Approve an X bookmark where tasks-api is down → approval + task creation succeed; `contentDrafts.errors` records `tasks_api_unreachable`; lobster exit code 0.
- **CI:** both Python and TypeScript CI workflows stay green.

## AC verification matrix

| AC | Strategy | New tests |
|---|---|---|
| AC1 | Hook calls `queue_bookmark_mention_drafts`; helper composes timeline body via LLM with bookmark context; draft queued via `POST /content-scheduler/drafts` with `kind: "scheduled"`. | `compose_build_in_public_tweet` happy; `post_draft` happy; hook integration X-source+tasked+≥1 task path. |
| AC2 | Helper composes reply body via LLM with `parse_x_link`-resolved handle (AC3); second draft queued with `kind: "manual_reply"` + `linksToDraftId` referencing the timeline draft. | `compose_reply_tweet` happy + handle-missing fallback; `post_draft` happy for reply; hook integration verifies both ids in `queuedDraftIds`. |
| AC3 | `compose_reply_tweet` calls `parse_x_link(state_item["link"])`. When the link lacks a usable handle, body uses "the original poster" instead of `@handle` — graceful degradation, no error. | `compose_reply_tweet` `parse_x_link` returns None path. |
| AC4 | Publish loop skips `kind == "manual_reply"`. Mission Control renders distinct section with copy button. | `contentScheduler.test.ts` publish-skip; manual UI smoke. |
| AC5 | New `PATCH /content-scheduler/drafts/:id/posted-url` route persists `manualPostedUrl` + `manualPostedAt`. Mission Control PATCH on save. | `contentSchedulerDrafts.test.ts` PATCH validation + idempotency. |
| AC6 | Hook wraps draft creation in try/except (defense in depth); helper itself never raises; `contentDrafts.errors` populated per failure; non-X branch returns early. | `queue_bookmark_mention_drafts` integration tests for all error branches; `test_lobster_resolve_spec_request` non-X skip + no-tasks skip + exception-swallowed path. |

## Open questions / risks

- **Q1 — Default `kind` migration.** Existing Content Scheduler rows need a `kind` default of `"scheduled"`. A NOT NULL DEFAULT `"scheduled"` on the column handles it at the DB level; ORM-level defaults handle it in code. Mitigation: explicit check `if draft.kind === "manual_reply" continue;` in the publish loop. Reviewed during migration review.
- **Q2 — `linksToDraftId` resolution surface.** The UI fetches the target draft when rendering the reply row. If the target draft has been deleted (manual cleanup), the reply row should still render — just with a "linked tweet unavailable" placeholder. Cheap to handle; spec a UI fallback.
- **Q3 — LLM prompt safety.** Same risk class as the predecessor (hostile bookmark → hostile tweet). Reuse the existing constraints from `compose_author_tweet` (in the predecessor module): ≤280 chars, prompt template constraints. **Mitigation:** explicit prompt instructions ("produce only a build-in-public announcement; do not include URLs beyond the bookmark source") and char-limit enforcement. Acceptable for v1; document in `docs/systems/bookmark-workflow.md`. Future task: human-review queue if needed.
- **Q4 — Mission Control UX review.** Reply-drafts section needs design system review (location, copy button affordance, posted state indicator). Defer to implementation; spec approved means intent is OK. The existing `design system sync` CI check (saw it green on PR #497) will catch any syntax regressions.
- **Q5 — Two LLM calls per qualifying approval.** At ~tens of X-sourced approvals/week (current volume), that's ~tens of LLM calls/week for tweet composition. Well within budget. If volume scales, the timeline + reply compositions could be batched into a single LLM call returning both drafts — follow-up.
- **Q6 — Reply draft and Tom's X account.** The manual-reply draft body mentions `@handle` — when Tom posts it, his X account sends it. There's no API involved here; Tom is posting as himself via X's UI. The pipeline never sees Tom's X credentials. **No new credential surface.**
- **Q7 — Predecessor module cleanup.** `x_author_tweet.py` + `xTweet.ts` + the predecessor spec's tech design become dead surface for this flow. Kept in place during this PR (separate cleanup task). Mention in companion doc updates.
- **Q8 — Failure isolation boundaries.** AC6 says failure "is recorded without blocking". The lobster script's exit code must remain 0 even if BOTH drafts fail to create. The `try/except` wrapper around the hook call must catch ALL exceptions (broad `except Exception`), and `queue_bookmark_mention_drafts` itself must never raise. Both layers are tested.

## Companion doc updates

- `docs/systems/bookmark-workflow.md` — new "Build-in-public tweet + manual reply draft" subsection under "Approval → Task Creation".
- `apps/mission-control/README.md` — pointer under "Content Scheduler" for the new manual-reply section.
- `services/tasks-api/README.md` — pointer under "Routes" for `PATCH /content-scheduler/drafts/:id/posted-url`.
- `docs/ARCHITECTURE.md` — no change (no new domain added; this is a lifecycle extension of the existing Content Scheduler).

## Later todos (parking lot)

- Remove the predecessor's `xTweet.ts` route + `x_author_tweet.py` module + predecessor spec's tech design once we confirm no other callers exist.
- Batch the two LLM calls (timeline + reply) into one if volume justifies it.
- Auto-promote a reply draft to "engagement received" state if Tom's recorded URL is later detected to have replies of its own (would need X API polling — explicitly out of scope).
- Surface `contentDrafts.errors` in a Pulse dashboard column so Tom can see failed draft creations at a glance.
- Auth header for `PATCH /content-scheduler/drafts/:id/posted-url` if/when the Mission Control UI stops being on the same host as tasks-api.
- Persist `contentDrafts` rows into `analytics.bookmark_transitions` as a `payload` field for Pulse querying.
- Human-review queue for tweets if Q3 risk ever surfaces.
