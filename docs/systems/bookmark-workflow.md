# Bookmark Workflow

**Type:** System reference (keep updated as the pipeline evolves)
**Last updated:** 2026-06-26
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
- `handle_approval_reply.py` parses Tom's reply and calls `resolve_topic_approval.py`

### 6. Task Creation
- After `approve`, `create_tasks_from_proposals.py` pushes tasks to the Tasks API
- Sets `reviewStatus: tasked` — **terminal**

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
| `brain/state/bookmark-transitions.jsonl` | Append-only transition log (used by dashboard; authoritative source of truth) |
| `analytics.bookmark_transitions` (Postgres) | Queryable mirror of every transition; best-effort, write happens after JSONL append. See "Analytics Mirror" below. |
| `brain/state/focus-config.json` | Curation config: topics, relevanceThreshold, recurationDays, batchSize |
| `brain/state/bookmark-approval-topics.json` | Telegram delivery config: chatId + threadId per topic |
| `brain/bookmarks/x/<slug>.md` | Raw bookmark files |
| `brain/bookmarks/summaries/<slug>-<key>.md` | LLM-produced summaries |
| `brain/bookmarks/specs/<slug>-<key>.md` | Spec files written by Quinn |
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
| `lobster_create_tasks_from_proposals.py` | Task | resumed lobster | Creates Tasks API tasks; reads title and ACs from spec markdown |
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
- PR: https://github.com/Stoffer-Industries/sindustries/pull/216
- Tech design: `docs/specs/bookmark-pipeline-analytics-postgres-transition-log-tech-design.md`
