# Bookmark Workflow

**Type:** System reference (keep updated as the pipeline evolves)
**Last updated:** 2026-08-09
**Repo:** `Stoffer-Industries/sindustries` · `agents/workflows/bookmarks/`

---

## Purpose

Turn X/Twitter bookmarks into approved implementation specs and Tasks API tasks, with minimal manual triage. Tom reviews one approval message per ready spec; everything else is automated.

For the wider agent map, see `docs/systems/agent-orchestration.md`.

---

## Pipeline Stages

```
ingest → summarize → curate ─────────→ spec_requested → spec_created → approval_pending → tasked
   ↓          ↓          ↓                                                       ↓
ingested  summarized  needs_research (human-gated)                      declined (terminal)
                                                                          revision_requested → spec_created (loop)
```

### 1. Ingest
- **Cron:** `bookmark-ingestion.md` (runs `run_x_ingest.py`)
- Pulls new bookmarks from X, writes raw markdown to `brain/bookmarks/x/<slug>.md`
- For non-tweet HTML links, fetches and stores a bounded, plain-text article body alongside the original tweet; unsupported or failed fetches fall back to tweet-only output
- When a bookmarked tweet quotes a tweet containing a Twitter article, captures the article body through the X API
- Sets `reviewStatus: ingested`

### 2. Summarize
- **Separate lobster cron** (runs `summarize.py`)
- Picks up `ingested` items, runs LLM pass, writes summary to `brain/bookmarks/summaries/<slug>-<key>.md`
- Summary shape: `headline`, `problem`, `approach`, `valueProposition`, `keyDetails`, `relevantTo`, `constraints`
- Sets `reviewStatus: summarized`; does NOT set an opinion on whether to implement

### 3. Curate
- **Heartbeat step** (Quinn) — see `HEARTBEAT.md` → BOOKMARK CURATION
- Reads the summary, scores relevance 0–10 against every focus topic in `brain/state/focus-config.json`
- Writes curation verdict (`topic`, `score`, `reasoning`, `relevanceScores`) to `brain/state/curate-output.json`
- `validate_curate_output.py` applies curation to state — sets `item.curation`, logs `curation refreshed` transition
- Items are re-curated when curation is missing or older than `recurationDays`
- Items below `relevanceThreshold` stay `summarized` and may be re-curated on the next pass

### 4. Spec Generation
- **Lobster step:** `lobster_list_curations.py` → `lobster_generate_specs.py`
- `lobster_list_curations.py` routes high-score curated items into the `implement` bucket
- `generate_specs.py` either:
  - Reuses existing spec files on disk (transitions to `spec_created`)
  - Sets `reviewStatus: spec_requested` if no spec exists (queues for Quinn heartbeat)
- **Heartbeat step** (Quinn) picks up `spec_requested` items via `list_spec_requests.py`, writes spec markdown to `brain/bookmarks/specs/<slug>-<key>.md`, then calls `validate_spec_output.py`
- `validate_spec_output.py` transitions item to `spec_created` and logs the transition
- `list_spec_requests.py` guards against state drift: items with `approvalStatus=approved` AND non-empty `taskIds` are skipped even if `reviewStatus` is still `spec_requested`. This is a read-only guard — it does not write state. **Side effect:** once a bookmark has been approved and tasked, it will not receive a secondary spec dispatch even if re-curated with a high score. This is intentional.

### 5. Approval
- **Lobster cron:** `bookmark-review-lobster.md` (runs `run_bookmark_review_cron.py`)
- Lobster pipeline runs to `prepare_topic_approval.py` → produces `requiresApproval` payload
- `request_topic_approval.py` receives the payload, checks for `specDocs`, sends Telegram message to Tom
- Approval message includes: spec path, approval ID, `approve / decline / revise: <changes>` prompt
- `handle_approval_reply.py` parses Tom's reply, toggles `- [x] **Approved by Tom**` in each approved bookmark spec, and calls `resolve_topic_approval.py`
- Approved bookmark specs stay under `brain/bookmarks/specs/`; approval alone never moves them into task spec folders

### 6. Task Creation
- After `approve`, `create_tasks_from_proposals.py` pushes tasks to the Tasks API
- On task creation or task reuse, the workflow moves each approved spec from `brain/bookmarks/specs/<slug>-<key>.md` to `brain/tasks/specs/in-progress/<slug>-<key>.md` and creates/repairs the task `**Spec:**` line to point at the destination
- Once moved to `brain/tasks/specs/in-progress/`, bookmark-origin specs follow the feature-task lifecycle (`in-progress/` → `done/` on task completion)
- Sets `reviewStatus: tasked` — **terminal**

### 7. Author Tweet Notification

For X-sourced bookmarks that land in `tasked` with at least one task ID created, the workflow best-effort posts a reply tweet at the original author. The goal is **building-in-public transparency**: tell the author their post made it through triage and that work has started, and invite a brief on-topic follow-up question.

- **Trigger condition:** bookmark `source == "x"` AND `next_status == "tasked"` AND `merged_task_ids` is non-empty. Non-X sources silently skip; the no-tasks branch (`next_status == "approved"`) also skips — there is no work to mention to the original author when the spec was the artifact.
- **Where it runs:** inline at the end of `lobster_resolve_spec_request.py`'s per-item approve loop, after `log_transition()` and the existing `save_state()` write. The hook site is intentionally small (~30 lines plus a small status filter).
- **Helper module:** `agents/workflows/bookmarks/scripts/x_author_tweet.py::try_post_author_tweet()`. Exposes a unified return shape (`{"status": "posted"|"skipped"|"error", ...}`) so the hook site can persist outcomes without caring about the underlying failure mode.
- **tasks-api route:** `POST /api/v1/x/tweets` (`services/tasks-api/src/routes/xTweet.ts`) is the new generic entry point that wraps the existing OAuth 1.0a `getXClient()` from `services/tasks-api/src/routes/contentSchedulerPublish.ts`. The route accepts `{ text, in_reply_to_tweet_id }` and returns `{ data: { url, postedAt } }`. It enforces the 280-char X limit and returns `503 MISSING_CREDENTIALS` when `getXClient()` is `null` — the helper catches that and records `tweetLog.status == "skipped"`.
- **Credential reuse:** no new OAuth flow. The route uses the same OAuth 1.0a credentials (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_CLIENT`, `X_HANDLE`) the content-scheduler publish path already reads. Tom does not need to re-auth — see task comment `48101f8f` (Quinn guidance) that explicitly dropped the spec's original "re-auth for `tweet.write`" pre-req.
- **`XClient` interface:** now accepts `{ text, in_reply_to_tweet_id? }`. Existing content-scheduler publish call sites (`createTweet({ text })`) continue to work unchanged. `FakeXClient` hashes `text + reply_id` so different `(text, reply)` pairs produce deterministic but distinct URLs. `RealXClient` forwards the reply id into the `reply: { in_reply_to_tweet_id }` field of the `POST https://api.twitter.com/2/tweets` body when present.
- **`tweetLog` write-back:** persisted onto the bookmark item only when the helper returned `status == "posted"`, `status == "error"`, or `status == "skipped"` with `error == "missing_credentials"`. Non-X source skips and malformed-link skips deliberately do NOT carry a `tweetLog` field — the spec is explicit that those paths must be silent (AC2). The shape written to state:
  ```
  state.items[<key>]["tweetLog"] = {
    "status": "posted" | "skipped" | "error",
    "tweetUrl"?: string,        # status == "posted"
    "postedAt"?: ISO-8601,      # status == "posted"
    "error"?: string,           # status in {"skipped", "error"}
    "authorHandle"?: string     # e.g. "somebody" — denormalised for UI surfaces
  }
  ```
- **Failure semantics (AC3):** any exception inside the helper is caught at the hook site and recorded as `tweetLog.status == "error", error == "unexpected:<reason>"`. The approval transition still resolves cleanly and `tasks-api` is unaffected. The lobster exits 0 and downstream steps run.
- **Operational notes:** the tweet step is fire-and-forget; no retry, no rate-limit cache, no human-in-the-loop. If `tasks-api` is unreachable, the helper records `tasks_api_unreachable:<reason>` and the approval still completes. The route trusts `localhost` — see the file header for the auth caveat if the lobster and `tasks-api` ever stop sharing a host.
- **Where it does NOT run:** non-X sources, `next_status == "approved"` (no tasks created), and `next_status == "declined"`. These branches never invoke `try_post_author_tweet()`.
- **Out of scope (parking lot):** reply-to-quoted-tweet threading, engagement tracking, draft-then-approve UX, `tweetAttempts[]` append-only history, `analytics.bookmark_transitions` payload column, rate-limit-aware retry/backoff, auth header on `POST /x/tweets`. See the tech design (`docs/specs/bookmark-approval-author-tweet-tech-design.md`) for the full parking lot and the open questions log.

---

## Tasked State Invariant (task 0089f4f9)

A bookmark with a non-empty `taskIds` array is authoritative-`tasked`. The
persisted `reviewStatus` field is a hint, not the contract. Every workflow
boundary that mutates or routes bookmark state must derive the routing
status from `taskIds` first, and refuse to downgrade a task-linked item to
`reviewed` / `spec_requested` / `spec_created`.

### Why this matters

Before the invariant, a late `lobster_request_spec_approval` finalize pass
could overwrite a terminal `tasked` status with `reviewed` simply because
the item fell into the routing bucket for lack of anything else to do. A
later `lobster_generate_specs` / `validate_spec_output` pass could then
re-route it to `spec_requested` / `spec_created` even though the Tasks API
had already reused or created a task for it. The author-tweet hook is only
triggered inline at the original `approval_pending → tasked` transition,
so the regression caused a silent missed tweet.

### The helper

`agents/workflows/bookmarks/scripts/bookmark_state_machine.py` exports:

- `is_task_linked(item)` — `True` when `taskIds` is non-empty.
- `effective_review_status(item)` — returns `"tasked"` when task-linked,
  otherwise the persisted status. Every routing boundary uses this instead
  of reading `item.get("reviewStatus")` directly.
- `reconcile_tasked_item(item, key, reason, transitions_path)` — repairs
  the persisted status to `tasked` and writes a transition log entry.
  Idempotent.

### Mutation boundaries that enforce the invariant

- `lobster_list_curations.py` — `route()` checks `is_task_linked` first
  and routes task-linked items to `reviewed` regardless of curation score.
- `lobster_request_spec_approval.py` — Phase 3 (finalize review cycle)
  refuses the literal `reviewed` downgrade for task-linked items and
  reconciles if the persisted status has drifted.
- `lobster_generate_specs.py` — the loop entry skips task-linked items
  with a transition log entry, refusing spec re-sync / spec re-queue.
- `validate_spec_output.py` — heartbeat spec dispatch entries for
  already-tasked items are reconciled to `tasked` and skipped, never
  promoted to `spec_created`.

### Routing bucket vs lifecycle status

The `reviewed` bucket in `lobster_list_curations` output is a *routing*
decision ("nothing for the lobster to do this pass"), not a license to
persist a literal `reviewStatus: "reviewed"` on an item that should be
terminal-tasked. The natural source of truth is the task-link invariant;
the bucket is only the routing signal.

### Tweet outcome persistence

For every newly tasked X bookmark, `tweetLog` must exist with one of:

- `status: "posted"` — tweet URL + postedAt recorded.
- `status: "skipped"` — explicit stable reason (e.g. `missing_credentials`,
  `backfill_not_posted:late_and_author_unresolved`).
- `status: "error"` — LLM or X API failure with a stable error string.

Silent skips are only allowed for non-X sources (the spec is explicit that
those paths must not write `tweetLog`). A task-linked X bookmark with no
`tweetLog` is a defect — the helper considers it and either posts or
records an explicit skip.

### Reconciliation runbook

For an item that has drifted out of `tasked` because of a stale pipeline
pass (e.g. the `d8311c3e5fc50b94` reproduction):

1. Verify the item has non-empty `taskIds` in `brain/state/bookmark-review-state.json`.
2. Run the reconciliation CLI:

   ```bash
   python3 agents/workflows/bookmarks/scripts/reconcile_tasked_state.py \
     --key <bookmarkKey> \
     --backfill-skip-reason "backfill_not_posted:late_and_author_unresolved" \
     --json
   ```

   The CLI refuses to promote any item with empty `taskIds` (invariants
   are the whole point).
3. Inspect the transition log (`brain/state/bookmark-transitions.jsonl`)
   to confirm the repair was recorded.
4. The CLI never posts externally. If a deliberate `posted` tweet is
   warranted, that is a separate, explicitly approved operation that
   goes through `x_author_tweet.py` with operator oversight.

The CLI is idempotent — re-running on an already-consistent item is a no-op
and does not emit a duplicate transition entry.

---

## State Machine

| Status | Description | Next states |
|---|---|---|
| `ingested` | Raw bookmark pulled from X; not yet summarized | → `summarized` (summarize cron) |
| `summarized` | Summary written by lobster summarize cron | curate → stays `summarized` (low score) or → `spec_requested` |
| `needs_research` | Broad reference material flagged by curation; awaiting manual review | human-gated — stays here until manually advanced or declined |
| `spec_requested` | Queued for Quinn heartbeat spec writing | → `spec_created` |
| `spec_created` | Spec file exists on disk | → `approval_pending` |
| `approval_pending` | Approval message sent to Tom | → `tasked`, `declined`, `revision_requested` |
| `revision_requested` | Tom replied `revise: ...` | → `spec_created` (Quinn rewrites spec) |
| `revision_staged` | Revision approval package rebuilt, pending delivery | → `approval_pending` |
| `tasked` | Tasks created in Tasks API | **terminal** |
| `declined` | Tom declined the spec | **terminal** — will NOT re-enter pipeline |

**Terminal statuses** (list_curations skips these even with a high curation score):
`tasked`, `declined`, `approval_pending`, `revision_staged`, `revision_requested`, `needs_research`

> **Note on `declined`:** Declining is a permanent dead-end. `handle_approval_reply.py` clears the approval claim and sets `reviewStatus: declined`; the item will not re-enter the pipeline. Use `revise: <changes>` instead of `decline` if you want to iterate on the spec.

---

## Key Files

| File | Role |
|---|---|
| `brain/state/bookmark-review-state.json` | Single source of truth for all bookmark states |
| `brain/state/bookmark-transitions.jsonl` | Append-only transition log (used by Mission Control's `/bookmarks` dashboard; authoritative source of truth) |
| `analytics.bookmark_transitions` (Postgres) | Queryable mirror of every transition; best-effort, write happens after JSONL append. See "Analytics Mirror" below. |
| `brain/state/focus-config.json` | Curation config: topics, relevanceThreshold, recurationDays, batchSize |
| `brain/state/bookmark-approval-topics.json` | Telegram delivery config: chatId + threadId per topic |
| `brain/bookmarks/x/<slug>.md` | Raw bookmark files |
| `brain/bookmarks/summaries/<slug>-<key>.md` | LLM-produced summaries |
| `brain/bookmarks/specs/<slug>-<key>.md` | Spec files written by Quinn; remain here through approval until a task is created |
| `agents/workflows/bookmarks/bookmarks.lobster.yaml` | Lobster pipeline definition |

---

## Key Scripts

| Script | Stage | Executed by | Notes |
|---|---|---|---|
| `run_x_ingest.py` | Ingest | ingest cron | Entry point via `agents/skills/bookmarks/x-ingest/` |
| `lobster_list_curate_candidates.py` | Ingest | review lobster | Collects candidate bookmarks for the pipeline |
| `lobster_summarize.py` | Summarize | review lobster | Faithful extraction; no classification |
| `list_curate_candidates.py` | Curate | heartbeat | Filter only — no LLM; outputs candidate batch for Quinn |
| `validate_curate_output.py` | Curate | heartbeat | Applies Quinn's curation verdict to state |
| `lobster_list_curations.py` | Spec | review lobster | Routes high-score curated items into the pipeline |
| `lobster_generate_specs.py` | Spec | review lobster | Reuses existing spec files or sets `spec_requested` |
| `list_spec_requests.py` | Spec | heartbeat | Returns `spec_requested` items for Quinn to write; skips items where `approvalStatus=approved` AND `taskIds` non-empty (drift guard, read-only) |
| `validate_spec_output.py` | Spec | heartbeat | Verifies spec files exist; transitions to `spec_created` |
| `lobster_request_spec_approval.py` | Approval | review lobster | Prepares packages, finalizes non-approval items, compacts payload, and pauses for approval gate |
| `run_bookmark_curate.py` | Approval | review cron | Orchestrates lobster run + `request_topic_approval.py` (in `agents/skills/bookmarks/curate/`) |
| `request_topic_approval.py` | Approval | review cron | Sends Telegram approval message; gates on `specDocs` presence |
| `handle_approval_reply.py` | Approval | openclaw extension | Parses Tom's reply; routes to approve/decline/revise (lives in `.openclaw/extensions/approval-reply/`) |
| `rebuild_revised_approval.py` | Approval | resumed lobster | Regenerates approval package after a revision request |
| `lobster_resolve_topic_approval.py` | Approval | resumed lobster | Applies approved/declined/revision state change |
| `lobster_create_tasks_from_proposals.py` | Task | resumed lobster | Creates Tasks API tasks; reads title and ACs from spec markdown; moves approved-and-tasked specs into `brain/tasks/specs/in-progress/` |
| `x_author_tweet.py` | Author tweet | resumed lobster | Best-effort reply tweet at the original X author when an X-sourced bookmark lands in `tasked` with ≥1 task ID; writes `tweetLog` back to state. Lives next to the lobster scripts. |
| `run_bookmark_state_analyzer.py` | Inspect | skill | Compact state summary without loading full JSON (in `agents/skills/bookmarks/state/`) |

---

## Curation Config (`brain/state/focus-config.json`)

- `topics` — list of topic buckets Quinn scores against
- `relevanceThreshold` — minimum score (default 7) to route into `implement`
- `recurationDays` — days before a curation verdict is considered stale and refreshed
- `batchSize` — max items per heartbeat curation pass

---

## Approval Routing (`brain/state/bookmark-approval-topics.json`)

Per-topic format: `{ "<topic>": { "chatId": "...", "threadId": "..." }, "general": { ... } }`

If a spec's topic isn't in the config, falls back to `general`. If `general` is also missing, the approval is blocked.

---

## Heartbeat Responsibilities

| Step | What Quinn does |
|---|---|
| BOOKMARK CURATION | Runs `list_curate_candidates.py`, scores batch, writes `curate-output.json`, runs `validate_curate_output.py` |
| SPEC DISPATCH | Runs `list_spec_requests.py`, writes spec markdown for up to 2 items, runs `validate_spec_output.py` |
| LOBSTER CHECK | Runs `run_bookmark_review_cron.py` (approval delivery) |
| QUINN PR REVIEW | Reviews open PRs assigned to Quinn in sindustries repo |

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| Approval never sent | `specDocs` empty or item in terminal status | Check `approvalLocks` in state; verify spec file exists on disk |
| Spec never written | Item has no `spec_requested` status or `list_spec_requests.py` skipped it | Check item's `reviewStatus` and `curation` field in state |
| Spec not dispatched for re-curated item | Item was previously approved+tasked; `list_spec_requests.py` drift guard skips it permanently | By design — tasked bookmarks don't re-enter spec dispatch. If a genuinely new spec angle is needed, create a new bookmark or task manually. |
| Curation not refreshing | `recurationDays` not elapsed or item in terminal status | Check `focus-config.json`, lower `recurationDays` or manually clear `item.curation` |
| Lobster exits 137 | OOM during lobster run | Check available memory; lobster may need to be run with a lower batch `limit` arg |
| Approved spec checkbox stayed unchecked | Approval handler failed before atomic marker write or spec file is malformed | Re-run approval handling after restoring a `- [ ] **Approved by Tom**` marker in the bookmark spec. |
| Task points at `brain/bookmarks/specs/` after task creation | Previous run created/reused a task but failed before repairing the `**Spec:**` line | Re-run `lobster_create_tasks_from_proposals.py`; destination-present/source-absent is treated as an idempotent repair path. |

---

## Analytics Mirror (Postgres)

Every call to `log_transition()` writes the JSONL line first (authoritative
source of truth) and then attempts to mirror the event into Postgres. The
mirror is **best-effort**: any failure is logged as a debug warning and
never raised, so the JSONL path is unaffected.

- **Table:** `analytics.bookmark_transitions` (created by the Prisma
  migration `services/tasks-api/prisma/migrations/20260708120000_add_analytics_transitions/migration.sql`).
- **Helper:** `agents/workflows/bookmarks/scripts/analytics_db.py::insert_transition()`.
- **Driver:** prefers `psycopg2`; falls back to `pg8000` when psycopg2 is
  not importable.
- **Connect timeout:** 2s. Inserts use a short-lived connection (no pool in
  v1).
- **No-op when `DATABASE_URL` is unset:** the helper returns `False`
  silently — the JSONL still gets the row.
- **Read path:** Pulse queries the table directly via SQL; there is no REST
  endpoint in v1. Indexes are on `occurred_at`, `bookmark_key`, and
  `to_status`.
- **Reserved table:** `analytics.task_transitions` is created by the same
  migration but stays empty until the feature-task workflow wires its
  equivalent helper. It exists now so Pulse can build queries against the
  full pipeline shape without a second migration.

---

## Related

- Task: `b179c0e3-c6b0-4c9d-97dc-982d3b841783` — Bookmark pipeline analytics — Postgres transition log
- Task: `a5a4ed8f-e7c4-4b6c-8ac9-bb962211ac44` — spec folder lifecycle and lobster sync
- Task: `55ac9240-d54a-4b2c-88c4-8bb8af85d2b2` — Bookmark approval: tweet at original X author when tasked (this PR)
- PR: https://github.com/Stoffer-Industries/sindustries/pull/216
- PR: https://github.com/Stoffer-Industries/sindustries/pull/236 (Sankey + states-over-time + retire tools dashboard tech design)
- Tech design: `docs/specs/bookmark-pipeline-analytics-postgres-transition-log-tech-design.md`
- Tech design: `docs/specs/bookmarks-tab-sankey-and-retire-tools-2026-07-16-tech-design.md`
