---
status: draft
task_id: 55ac9240-d54a-4b2c-88c4-8bb8af85d2b2
product_spec: brain/tasks/specs/in-progress/bookmark-approval-author-tweet-2026-07-17.md
shipped_pr: null
shipped_date: null
---

# Bookmark approval — author tweet notification — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/bookmark-approval-author-tweet-2026-07-17.md`
- Task: `55ac9240-d54a-4b2c-88c4-8bb8af85d2b2` (`🔧 Bookmark approval: tweet at original X author when tasked`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/55ac9240-d54a-4b2c-88c4-8bb8af85d2b2`
- **Quinn guidance (comment `48101f8f`, 2026-07-17T05:43:52):** reuse the existing tasks-api X client (OAuth 1.0a via `services/tasks-api/src/routes/contentSchedulerPublish.ts::getXClient()`) rather than adding a new OAuth 2.0 PKCE flow. Reuse the env-var credentials that the content scheduler already uses. AC5 (scope check) reframes as a credentials check; if `getXClient()` returns `null` (creds missing), AC3's best-effort fallback handles it. The spec's "Tom re-auths the X OAuth flow to add `tweet.write`" pre-req is dropped.
- Hook point: `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` (script that transitions bookmark state to `tasked` on approval)
- Existing X OAuth 1.0a client: `services/tasks-api/src/routes/contentSchedulerPublish.ts` (`getXClient()`, `XClient`, `FakeXClient`, `RealXClient` — credential envs: `X_CLIENT`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, optional `X_HANDLE`)
- Existing tasks-api client used by other bookmark scripts: `agents/skills/ops/tasks-api/tasks_api_client.py`
- Existing bookmark LLM helper: `agents/workflows/bookmarks/scripts/common.py::call_bookmark_llm()`
- Companion system doc: `docs/systems/bookmark-workflow.md`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-55ac9240-bookmark-approval-author-tweet`
- Worktree: `~/workspaces/rowan/sindustries-task-55ac9240-bookmark-approval-author-tweet`
- No secondary repos. Code lands in `services/tasks-api/src/routes/` (TypeScript, new tweet route + small interface extension) and `agents/workflows/bookmarks/scripts/` (Python, new module + hook).

## Product intent (from approved product spec, restated)

When an X-sourced bookmark is approved and at least one task ID gets created, automatically post a reply tweet at the original tweet's author. The tweet tells them their post made it through triage, that work has begun, and asks an on-topic, content-specific question. The goal is building-in-public engagement: surface the loop-closure publicly, invite conversation.

Non-bookmarks (web articles, podcasts) silently skip the tweet step. X API failures degrade gracefully — the approval and task-creation must still resolve cleanly, with the failure recorded for later inspection.

Approved by Tom (per task description).

## Acceptance criteria recap (with AC5 reframed per Quinn)

- **AC1** — Tweet posted on approve+tasked: reply to the original tweet, mentions `@<handle>`, says work has started, includes a content-specific engaging question.
- **AC2** — Non-X bookmarks (`source != "x"`) silently skip the tweet step with no error.
- **AC3** — X API failure logs to `tweetLog` and does NOT block approval + task creation (best-effort).
- **AC4** — Result (URL on success, error/skip reason otherwise) written back to bookmark state under `tweetLog: { status, tweetUrl, postedAt, error }`.
- **AC5 (reframed)** — Per Quinn's note, the spec's "scope check" becomes a **credentials check**: if `getXClient()` returns `null` (i.e. `X_CLIENT=real` and one of `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` is missing), the AC3 best-effort fallback fires immediately without attempting an HTTP call to `api.twitter.com`. Behaviour is identical to the spec's intent (don't waste a doomed request).

## `.openclaw` boundary

- **No new secrets or tokens.** Reuses the OAuth 1.0a credentials that the content scheduler already reads from env. The pre-req originally called out in the spec (Tom re-auths the X OAuth flow to add `tweet.write` scope) is **dropped** per Quinn's comment.
- **No `~/.openclaw/` writes.** Everything repo-owned.
- **No cron changes.** Posting is triggered inline during the lobster `tasked` transition.
- **No LLM cost policy changes.** Tweet composition reuses `call_bookmark_llm()` (existing helper), so budgets stay where they are.

## Out of scope (parking lot, deliberately)

- Replying to a quoted/parent tweet (only direct replies to the bookmarked tweet — no threading model yet).
- Tracking reply engagement (likes, replies, reposts) after posting.
- Drafting tweets for human approval before posting. Direct, low-stakes notification; if a model ever needs human review, separate task.
- Persisting `tweetLog` to Postgres (`analytics.bookmark_transitions`). The JSONL / state mirror already captures the transition; a dedicated column is a follow-up if Pulse wants it.
- Posting to anything other than X (e.g. Bluesky cross-post).
- Generalising `getXClient()` into a shared `services/x/` package. The content scheduler's client is intentionally scoped; abstraction is premature here.
- Cross-environment credential sharing between the lobster's Python process and the tasks-api process. Both already run as the same user on Tom's machine; if prod isolated the two, the simplest fix is the existing `TASKS_API_BASE_URL` env var.

## Implementation plan

### File / module scope

#### 1. New tasks-api route — `services/tasks-api/src/routes/xTweet.ts` *(new)*

A thin route that exposes the existing `getXClient()` as a generic "post a tweet" endpoint for sibling services (the bookmark lobster is the first caller). Endpoint does NOT live inside `contentScheduler*` because it isn't a content-scheduler-only capability.

- `POST /x/tweets` request body: `{ text: string, in_reply_to_tweet_id?: string }`. Text length validation mirrors X's 280-char rule (reject with 400 `TWEET_TOO_LONG` when over). `in_reply_to_tweet_id` is optional but always populated from the bookmark URL parser in our caller.
- Logic:
  1. Validate body shape.
  2. Call `getXClient()`. If `null` → return 503 `{ code: "MISSING_CREDENTIALS", message: "X credentials are not configured" }`. This is the "credentials check" gate that satisfies AC5 in its reframed form.
  3. Call `client.createTweet({ text, in_reply_to_tweet_id })`. (See "XClient interface change" below.)
  4. Return `{ url, postedAt }` on success.
  5. On `client.createTweet` failure: log structured error server-side, return 502 `{ code: "X_API_ERROR", message: <truncated body> }` so the Python caller can record `tweetLog.status == "error"`.
- Mounted in `services/tasks-api/src/app.ts` (alongside `/content-scheduler/*`). Plain `express.Router()`, matching the existing style. ~50 lines including validation.
- Auth: this endpoint is intended for in-cluster callers (the bookmark lobster's Python process lives on the same host as the tasks-api dev container). For now, **no auth header** — matching the existing pattern where the lobster's `tasks_api_client.py` calls `http://localhost:4001/api/v1` unauthenticated. If we ever expose tasks-api to a non-localhost network, this route must be locked down. Documented in the route's header comment.

#### 2. XClient interface change — `services/tasks-api/src/routes/contentSchedulerPublish.ts` *(modified)*

The existing `XClient` interface and its `FakeXClient`/`RealXClient` implementations need to support an optional `in_reply_to_tweet_id`. This is a minor, additive change:

```ts
export interface XClient {
  createTweet(input: { text: string; in_reply_to_tweet_id?: string }): Promise<{ url: string; postedAt: Date }>;
}
```

- `FakeXClient.createTweet` accepts the new field, hashes `text + reply_id` to keep deterministic URL output stable per (text, reply) pair. Existing call sites pass only `{ text }` — those continue to work unchanged.
- `RealXClient.createTweet` forwards `in_reply_to_tweet_id` into the `reply: { in_reply_to_tweet_id }` field of the POST body. When omitted, the field is not included.
- Existing content-scheduler publish path (`contentScheduler.ts`) still calls with no `in_reply_to_tweet_id`, so behaviour is unchanged.

The interface change is the smallest diff that lets us reuse the existing client without parallel implementations. Existing tests in `services/tasks-api/test/contentScheduler.test.ts` and any `contentSchedulerPublish.test.ts` must still pass.

#### 3. New Python module — `agents/workflows/bookmarks/scripts/x_author_tweet.py` *(new)*

A small Python module with one public entry point — `try_post_author_tweet(state_item: dict, *, tasks_api_base_url: str | None = None) -> dict` — that returns the `tweetLog` payload to merge into the bookmark item. Internal helpers:

- `parse_x_link(url: str) -> tuple[handle, status_id] | None` — pure function. Returns `None` for any non-X URL or malformed path. Splits on `/status/` or `/statuses/`, trims query string/anchor, returns the segments.
  - **Tests:** x.com handle+id, twitter.com handle+id, mobile.twitter.com handle+id, URL with trailing slash, URL with UTM params, blog/non-X URL → None, malformed handle (empty) → None.
- `compose_author_tweet(state_item: dict) -> str` — calls `call_bookmark_llm()` from `common.py`. Single-pass prompt that takes `title`, `bodyExcerpt[:300]`, and `tags`. Returns a string ≤280 chars. On LLM error, raises `TweetComposeError` so the caller can record the failure. The prompt is committed as a module-level constant — easy to review/iterate without touching workflow code.
- `call_x_tweets_route(text: str, in_reply_to_tweet_id: str, *, base_url: str | None) -> dict` — small `urllib`-based POST helper (stdlib-only posture, matching the rest of the bookmark workflow). Body is JSON; returns `{ url, postedAt }` on 200; raises `XApiError` on 4xx/5xx; raises `CredentialsMissingError` on 503 with `code == "MISSING_CREDENTIALS"`. Connection refused (tasks-api down) raises a third exception subclass `TasksApiUnreachableError`.
- `try_post_author_tweet` integration:
  - `state_item["source"] != "x"` → `{ status: "skipped", error: "non_x_source" }`.
  - Missing or malformed `state_item["link"]` → `{ status: "skipped", error: "missing_x_link" }`.
  - `compose_author_tweet` raises → `{ status: "error", error: "llm_compose_failed:<reason>" }`.
  - `call_x_tweets_route` raises `CredentialsMissingError` → `{ status: "skipped", error: "missing_credentials" }` (AC5 reframed).
  - `call_x_tweets_route` raises `XApiError` → `{ status: "error", error: "x_api_<status>:<body>" }`.
  - `call_x_tweets_route` raises `TasksApiUnreachableError` → `{ status: "error", error: "tasks_api_unreachable:<reason>" }`.
  - Success → `{ status: "posted", tweetUrl, postedAt }`.
- A `TWEET_LOG_STATUSES` enum: `"posted" | "skipped" | "error"` for `tweetLog.status`. Doc-comment lists which fields each variant requires.

#### 4. Hook site — `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` *(modified)*

Today the script transitions each approved bookmark's `reviewStatus` to `tasked` (or `approved` when no tasks were created) inside the per-item loop. The new step is added **after** the transition succeeds:

For each `state_item` that landed in `next_status == "tasked"` AND `state_item["source"] == "x"` AND at least one task ID is in `merged_task_ids` (AC1's "≥1 task created" gate):

1. Build a tasks-api base URL from `os.getenv("TASKS_API_BASE_URL", "http://localhost:4001/api/v1")`.
2. Call `try_post_author_tweet(state_item, tasks_api_base_url=base)`.
3. Persist the returned dict as `state_item["tweetLog"]`.
4. Use `save_state()` to flush the updated item.

The approve loop also continues to release the approval lock and write `resolved` / `skipped` for the lobster caller; the tweet step is purely additive. The transaction-like ordering is: state transition → transition log → task IDs written → **tweet attempt → tweetLog write**. There is no transactional rollback if the tweet fails — that's the AC3 best-effort contract.

The hook will be small enough to inline (≤30 lines plus a typed status enum). I am not abstracting it into a helper module yet because the spec is single-purpose; if a second caller appears (e.g. re-curation, manual re-trigger), we hoist then.

Crucial: the **non-X source** case MUST skip without writing a `tweetLog`. Likewise, the `next_status == "approved"` branch (no tasks created) MUST NOT call `try_post_author_tweet` because AC1 requires ≥1 task created. Both gates are tested.

#### 5. Tests

- **`services/tasks-api/test/xTweet.test.ts`** *(new)* — Vitest. Cases:
  - 200 path: route delegates to `getXClient()` and returns `{ url, postedAt }` from the client. Use a stub client (no need to mock the real X API).
  - 503 `MISSING_CREDENTIALS`: stub `getXClient()` returning `null`. Assert response body shape.
  - 400 `TWEET_TOO_LONG`: text over 280 chars.
  - 400 missing fields: empty body / no `text`.
  - 502 `X_API_ERROR` when the client throws.
  - `in_reply_to_tweet_id` propagates to the client stub.
- **`services/tasks-api/test/contentSchedulerPublish.test.ts`** *(new or extended)* — confirm the existing `FakeXClient.createTweet({ text })` and `RealXClient.createTweet({ text })` still work (unchanged signature), AND that `createTweet({ text, in_reply_to_tweet_id })` works. Existing content-scheduler tests in `contentScheduler.test.ts` must still pass.
- **`agents/workflows/bookmarks/scripts/tests/test_x_author_tweet.py`** *(new)* — Python `unittest`. Cases:
  - `parse_x_link` cases (see Implementation §3).
  - `compose_author_tweet` happy and unhappy (mock `call_bookmark_llm`).
  - `call_x_tweets_route` happy + 503 + 502 + connection error.
  - `try_post_author_tweet` integration: covers all six branches.
- **`agents/workflows/bookmarks/scripts/tests/test_lobster_resolve_spec_request.py`** *(new or extended)* — Cases:
  - Approval with X source + valid link → `try_post_author_tweet` invoked, `tweetLog` persisted.
  - Approval with non-X source → `try_post_author_tweet` NOT invoked.
  - Approval with no tasks created (`next_status == "approved"`) → `try_post_author_tweet` NOT invoked.
  - An exception inside the tweet step is swallowed: exit code 0, approval still completes, `tweetLog.error` recorded.
- **Regression:** existing `test_common.py`, `test_analytics_db.py`, `test_spec_lifecycle.py` and any other bookmark-test modules still pass. The tasks-api test surface runs via `npm --workspace services/tasks-api run test` and must stay green.

#### 6. Documentation — `docs/` and inline

- **`docs/systems/bookmark-workflow.md`** *(modified)* — Add an "Author tweet notification" subsection under the existing "Approval → Task Creation" stage. Explain: trigger condition (X source + tasked + ≥1 task created), what the AI prompt produces, where the result lands (`tweetLog` field), the graceful-degradation contract (AC5 reframed as a credentials check via `getXClient() == null`), and that no re-auth is required (Quinn's comment 48101f8f dropped the spec's pre-req). Reference this tech design.
- **`services/tasks-api/README.md`** *(modified)* — short entry under "Routes" listing `POST /x/tweets`. Note it's intended for in-cluster callers (the lobster) and trusts localhost.
- **`agents/workflows/bookmarks/scripts/README.md`** *(modified if it exists, or `agents/workflows/bookmarks/README.md`)* — one paragraph under "Approval" pointing to the new behavior and to `docs/systems/bookmark-workflow.md`.

### Data model summary

A new optional field is added to each affected bookmark item:

```
state.items[<key>]["tweetLog"] = {
  "status": "posted" | "skipped" | "error",
  "tweetUrl"?: string,        # when status == "posted"
  "postedAt"?: ISO-8601,      # when status == "posted"
  "error"?: string            # when status == "skipped" or "error"
}
```

No schema migration in the JSON sense (state is free-form); the field appears only when a tweet step ran or was attempted. The field is overwritten on each subsequent approval re-trigger. Acceptable for v1 — append-only `tweetAttempts[]` is a follow-up if needed.

### Cross-context coordination

- **lobster_resolve_spec_request.py → tasks-api `POST /x/tweets`:** HTTP POST over `TASKS_API_BASE_URL` (defaults to `http://localhost:4001/api/v1`). The lobster is the only caller in v1; the route sits in tasks-api because the credential surface lives there.
- **No new IPC, no `postMessage`, no cron.**
- **tasks-api lifecycle:** the lobster requires `tasks-api` to be running to post. In dev this is true (the lobster's pre-condition already requires tasks-api for `create_tasks_from_proposals.py`). In prod, same expectation.

### Workflow / cron / skill changes

- **Cron:** none. Tweet step runs inline at the existing approve → tasked transition.
- **Skill:** none new. Existing `bookmark-state-analyzer` skill continues to work; surfacing `tweetLog` is parked.
- **Lobster:** `bookmarks.lobster.yaml` does not change. The hook site is the Python script invoked by the existing lobster step.

### Design system usage

Not applicable. Backend Python + TypeScript; no UI changes.

### Service boundary notes

- **Domain owner:** the bookmark workflow owns the trigger and the write-back to state.
- **Why the X client lives in `services/tasks-api`:** the existing OAuth 1.0a credentials (env vars `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, plus `X_CLIENT` and `X_HANDLE`) are already owned by the content-scheduler feature in tasks-api. Quinn's comment 48101f8f explicitly directs reusing them. Moving the client into a shared `services/x/` package is a separate refactor; not done here.
- **Extraction / migration plan:** if a second domain ever needs reply-tweeting (e.g. newsletter replies) and credential ownership is decoupled from content-scheduler, extract the `XClient` interface and its impls into a `services/x/` package. **Not done in this PR.** Today the new route reuses via import.

## Test plan

- **Unit (TypeScript):** `xTweet.test.ts` (route), extended `contentSchedulerPublish.test.ts` (interface + fake/real client). Run via `npm --workspace services/tasks-api run test`.
- **Unit (Python):** `test_x_author_tweet.py`, `test_lobster_resolve_spec_request.py`. Run via the existing Python test target.
- **Regression:** all existing tests in both languages still pass.
- **Manual smoke:**
  1. With `X_CLIENT=real` and all 4 OAuth env vars present: approve an X-sourced bookmark, confirm `tweetLog.status == "posted"` with a URL.
  2. With `X_CLIENT=real` and any of the 4 OAuth env vars missing: approve an X-sourced bookmark, confirm `tweetLog.status == "skipped", error == "missing_credentials"`, no HTTP `POST https://api.twitter.com/2/tweets` call attempted.
  3. With `X_CLIENT=fake`: confirm `tweetLog.status == "posted"` with a deterministic fake URL — proves the test path through tasks-api.
  4. With a non-X bookmark (`source != "x"`): approve it, confirm no `tweetLog` is written.
  5. With a bookmark that has `next_status == "approved"` (no task created — `taskIds` empty): confirm no `tweetLog` is written.
  6. With tasks-api down: confirm `try_post_author_tweet` catches the connection error, writes `tweetLog.status == "error", error == "tasks_api_unreachable:<reason>"`, and the lobster script still exits 0 with approval resolving.
- **CI:** both Python and TypeScript CI workflows stay green.

## AC verification matrix

| AC | Strategy | New tests |
|---|---|---|
| AC1 | Tasks-api route delegates to `getXClient()`; Python composes text via LLM with bookmark context; URL persisted. | `xTweet.test.ts` 200 path; `compose_author_tweet` happy; `try_post_author_tweet` happy; `parse_x_link` shapes |
| AC2 | Hook site checks `state_item["source"] == "x"` before invoking `try_post_author_tweet`. | `test_lobster_resolve_spec_request` non-X skip |
| AC3 | `call_x_tweets_route` raises `XApiError` on HTTP error; `try_post_author_tweet` catches and writes `tweetLog.status == "error"`. Approval path doesn't gate on the tweet. Hook site catches any unhandled exception with logged `tweetLog.error`. | `xTweet.test.ts` 502; `call_x_tweets_route` 502; `try_post_author_tweet` error branch; `test_lobster_resolve_spec_request` exception swallowed |
| AC4 | All branches of `try_post_author_tweet` return a `tweetLog`-shaped dict; state is persisted via the existing `save_state()` call. | `try_post_author_tweet` integration tests; `test_lobster_resolve_spec_request` tweetLog persistence |
| AC5 (reframed) | `getXClient() == null` → route returns 503 `MISSING_CREDENTIALS` → Python catches `CredentialsMissingError` → `tweetLog.status == "skipped", error == "missing_credentials"`. **No X HTTP call attempted.** | `xTweet.test.ts` 503 path; `call_x_tweets_route` 503 path; `try_post_author_tweet` missing-credentials branch (verified with `mock.patch` of `urllib.request.urlopen` and assertion it was never called when the branch fires) |

## Open questions / risks

- **Q1 — Quinn guidance vs. spec text.** Quinn's comment predates the spec by several hours and explicitly overrode the OAuth-flow decision, the scope-check wording, and the pre-req note. The ACs as currently stored in the task description still reference `tweet.write` (AC5). I am reframing AC5 to "credentials check" via the existing `getXClient()` semantics; the contract (no doomed HTTP call) is preserved. If Quinn wants AC5 reworded in the spec before approval, the spec needs a Tom re-approval cycle. **Proposed path:** keep the existing ACs, document the reframing here, and rely on the `tweetLog.error == "missing_credentials"` outcome for verification. Quinn — please flag in your `[tech-design-approved]` response if you'd rather drive a spec resync first.
- **Q2 — LLM prompt safety.** The composed tweet mentions an `@handle` taken from a user-controlled URL and quotes content from the bookmark body. A malicious bookmark could provoke a hostile tweet. **Mitigation:** the prompt is constrained (`compose_author_tweet` enforces ≤280 chars and uses an explicit instruction template: "produce only a tweet that mentions @handle and references the content"). For v1 we accept the residual risk and document it in `docs/systems/bookmark-workflow.md`. Future task: add a human review queue if needed.
- **Q3 — `@handle` spoofing.** `https://x.com/<handle>/status/<id>` allows any string as the handle (including `@example`). **Mitigation:** the composed tweet prefixes with `@` and embeds the raw handle from the URL; if X rejects the tweet body, `post_author_tweet` surfaces the error and `tweetLog.status == "error"`. No additional sanitization.
- **Q4 — Quoted tweet status IDs.** The bookmark may be a quote-tweet rather than the canonical tweet. Today we reply to whatever `link` is on the bookmark; that's also what X's bookmarks API returns for the original tweet (confirmed in the existing `process.cjs`). No change.
- **Q5 — Per-day rate limits.** X's v2 endpoints have a 100-tweet-per-day user-context limit. At SIndustries' current approval volume (~tens per week), we are nowhere near it. **Decision:** no rate-limit cache in v1. If volume scales, add a `tweetLog` rate-counter as a follow-up.
- **Q6 — tasks-api availability.** The lobster now needs tasks-api running for the tweet step. This dependency is already implicit (the lobster's task-creation step requires tasks-api). Acceptable; the failure mode degrades to `tweetLog.status == "error", error == "tasks_api_unreachable"` and the rest of the workflow completes.
- **Q7 — Tests for the LLM prompt.** `compose_author_tweet` is tested with a mocked LLM (return-value fixtures). The prompt text is committed as a const and reviewed in code review, but no golden-output regression test exists. Acceptable for v1; if we observe drift, add a small set of (input → output) fixtures.

## Companion doc updates

- `docs/systems/bookmark-workflow.md` — add the "Author tweet notification" subsection under the existing approval → task-creation stage.
- `services/tasks-api/README.md` — pointer under "Routes" for `POST /x/tweets`.
- `agents/workflows/bookmarks/scripts/README.md` (or `agents/workflows/bookmarks/README.md`, whichever exists) — pointer paragraph.
- `apps/mission-control/SPEC.md` — no change (no user-visible app behaviour shifts in this PR).
- `docs/ARCHITECTURE.md` — no change (no new domain added).

## Later todos (parking lot)

- Extract the `XClient` interface and impls into `services/x/` if Content Scheduler ever needs a unified poster. Big refactor; out of scope.
- Append-only `tweetLog` history (`tweetAttempts[]`) once we have a use case for retry policy.
- Pulse / BookmarksTab dashboard column for `tweetLog.status`.
- Bulk-resend endpoint for failed tweets (Tom action).
- Human-approval queue for tweets if Q2 risk ever surfaces.
- Rate-limit-aware retry/backoff in `post_author_tweet` (parked until volume justifies it).
- Persist `tweetLog` rows into `analytics.bookmark_transitions` as a `payload` field for Pulse querying.
- Auth header for `POST /x/tweets` if/when the lobster and tasks-api stop being on the same host.
