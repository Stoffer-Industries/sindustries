# Spec — Bookmark Pipeline Visualization & Brain Path Cleanup

## Source

- **Trigger:** Tom's request in Telegram Sindustries (topic: brain), 2026-06-04 ~20:00 NZST
- **Related spec:** `brain/specs/brain/x-bookmark-review-and-tasking-workflow.md` (this is a sibling, not a replacement)
- **Spec type:** observability + housekeeping

## Intended Outcome

1. A **local-first web dashboard** that lets Tom (and me) see, at a glance, whether the bookmark cron is alive, what stage each bookmark is at, and how the pipeline is moving over time.
2. A **cleaner `brain/` tree** where bookmark-derived content lives under a single topic-organized root, so future specs, reviews, posts, and diary entries don't pile up at the brain root.

## Why This Is Its Own Spec

Two unrelated frictions, one related fix:

- **O11y gap.** The bookmark cron (`Bookmark Review Lobster` every 2h, `Bookmark Ingestion` daily 04:00) is currently `lastRunStatus: ok` whenever Tom checks, but that single boolean hides everything. He has no way to see whether 5 or 50 new bookmarks were reviewed this week, whether anything is stuck, or whether the approval queue is empty because everything was declined or because nothing reached approval. The cron is observably silent.
- **Brain sprawl.** The `brain/` root has accumulated folders (`reviews/`, `specs/`, `specs-revised/`, `posts/`, `content/`, `diary/`, `ecomm/`, `infra/`, `ops/`, `sindustries/`, `sindustries-drop/`, `state/`, `hooks.md`) on top of the `bookmarks/` intake area. When the system was small this was fine. Now that bookmarking is the primary intake for ideas, it makes more sense for derived artifacts to live near the bookmark they came from, not at a parallel top-level path.

Both are about reducing Tom's coordination overhead: the first by making the pipeline's state honest, the second by removing a category of "where does this file go?" decisions.

## Problem Statement

### Observability

The current pipeline stores end-state snapshots in `brain/state/bookmark-review-state.json`. The 133 items tracked today include only `firstSeenAt`, `reviewedAt`, and `lastUpdatedAt`. There is no record of:

- when a bookmark moved from `reviewed` → `spec_created`
- when a spec was sent for approval
- how long the approval queue has been idle
- the actual distribution of state changes over time

The state file tells you "right now". It does not tell you "what happened this week". For a pipeline that runs unattended, "right now" is not enough.

### Path sprawl

Right now a single bookmark's lifecycle touches these paths:

| Stage | Current path |
|---|---|
| Ingest | `brain/bookmarks/<topic>/<title>.md` |
| Review | `brain/reviews/<topic>/<title>-<key>.md` |
| Spec | `brain/specs/<topic>/<spec-slug>.md` |
| Post (future) | `brain/posts/<...>.md` |
| Daily note (future) | `brain/diary/<...>.md` |
| State | `brain/state/bookmark-review-state.json` (and a few siblings) |

Reviews, specs, and posts sit at the brain root as if they were independent streams. They are not. They are derived from bookmarks. The current layout makes it hard to ask "show me everything that came from bookmark `x-bookmark-xyz`" without grepping.

## Proposed Approach

### A) Add a transitions log

Treat the existing `bookmark-review-state.json` as a snapshot, and add an append-only ledger:

- **New file:** `brain/state/bookmark-transitions.jsonl`
- **One line per state change:** `{ "key": "...", "from": "pending", "to": "reviewed", "at": "2026-06-04T20:11:00+00:00", "actor": "run_bookmark_review_cron", "reason": "useful=true" }`
- **Where to write:** every script that mutates `reviewStatus` or `approvalStatus` gets a one-line `log_transition(...)` call next to the state update.

This is cheap. It does not require changing the schema of the existing state file. It does not require any new infrastructure. It just makes the existing pipeline write down what it's already doing.

### B) Build the dashboard

A single static web page that reads the snapshot + the log and renders three views.

**Mockup:**

![Bookmark pipeline dashboard mockup](assets/bookmark-dashboard-mockup.svg)

**State flow reference (what the funnel is showing):**

![Bookmark pipeline state flow](assets/bookmark-pipeline-states.svg)

**Tech shape (intentionally minimal):**

- One `index.html` in `brain/specs/brain/assets/dashboard/` (sibling of the spec).
- Inline CSS + vanilla JS. No framework. No build step. No npm.
- One small charting helper (D3 from a vendored copy, or hand-rolled SVG if the chart is simple enough). Avoid Mermaid for the funnel — it's slow to render and ugly at this size.
- Reads JSON via a tiny Python static server (`python3 -m http.server 8765 --bind 127.0.0.1`) or, better, a 30-line FastAPI stub that serves `index.html` and proxies JSON from `brain/state/`. FastAPI gives us a "live" mode (file-watcher refresh) for free, but a static server with a manual refresh button is acceptable for the MVP.
- No auth. No remote. No persistence. Tom runs it on his Mac mini the way he already runs other local tools.

**The three views:**

1. **KPI strip** — current counts per state. Tells you "is the cron alive" at a glance: if `pending` is growing unboundedly, something is broken.
2. **Pipeline funnel** — current snapshot, filtered by time window and topic. Shows drop-off between stages. This is the "how far does each bookmark get?" view Tom asked for.
3. **State counts over time** — line chart of state counts across the transitions log. This is the "over time" view. A separate line per state. Same time-window filter.
4. **Recent transitions** — last 20 lines of `bookmark-transitions.jsonl`, formatted. Useful for sanity checking that the log is actually being written.

Optional but cheap: a per-bookmark detail view that shows the full transition history for a key. This is `jq` + a tiny table, not a full timeline component.

### C) Reorganize `brain/`

Move to a **topic-first** layout under `brain/bookmarks/`:

```
brain/
├── bookmarks/                    # intake + topic-organized content
│   ├── <topic>/                  # e.g. infra, brain, app-tasks, crypto, design
│   │   ├── <bookmark-slug>.md    # the original bookmark file
│   │   ├── reviews/              # generated reviews for bookmarks in this topic
│   │   ├── specs/                # generated specs for bookmarks in this topic
│   │   ├── posts/                # public-facing content derived from this topic
│   │   └── diary/                # daily notes for this topic (when applicable)
│   ├── x/                        # X-bookmark intake staging (still flat for cron)
│   ├── self/                     # self-saved bookmarks (still flat for cron)
│   ├── specs/                    # cross-topic specs (kept for now)
│   └── assets/                   # dashboard, diagrams
├── state/                        # pipeline state, transitions log, topics map
└── README.md                     # short orientation
```

The migration is mostly `git mv` with path updates in:

- `brain/state/bookmark-review-state.json` — every `path` and `reviewDoc` field
- `scripts/bookmarks/*.py` — any hard-coded path constants
- `agents/workflows/bookmark/x-bookmarks-review-pipeline.lobster.yaml` — same

I do **not** propose deleting the old top-level `brain/reviews/`, `brain/specs/`, etc. in the same PR. Instead:

- Phase 1: create the new structure, add new path helpers in `scripts/bookmarks/common.py`, generate into the new paths, **read from old paths with a deprecation warning**, write to new paths.
- Phase 2: backfill by moving existing files (git mv), update state file paths.
- Phase 3: flip reads to new paths, delete the old top-level folders.

The reason for phasing: a single mega-move that breaks every script and every state record is exactly the kind of "I'll get to it later" change that sits in main for weeks. The phased version can be one PR per phase, each small enough to merge without ceremony.

## Stack Touchpoints

- `scripts/bookmarks/common.py` (add `log_transition()` helper)
- `scripts/bookmarks/generate_reviews.py` (log transition into `reviewed` / `monitoring`)
- `scripts/bookmarks/generate_specs.py` (log transition into `spec_created`)
- `scripts/bookmarks/request_topic_approval.py` (log transition into `approval_pending`)
- `scripts/bookmarks/resolve_topic_approval.py` (log transition into `tasked` / `declined`)
- `scripts/bookmarks/finalize_review_cycle.py` (log any final-state transitions)
- `brain/state/bookmark-transitions.jsonl` (new)
- `brain/specs/brain/assets/dashboard/` (new — the web app)
- `brain/state/bookmark-review-state.json` (no schema change; just path updates in item records)
- `brain/reviews/<topic>/` → `brain/bookmarks/<topic>/reviews/`
- `brain/specs/<topic>/` → `brain/bookmarks/<topic>/specs/`
- `brain/posts/` → `brain/bookmarks/posts/` (or per-topic; see Scope)
- `brain/specs-revised/` → delete or fold into `brain/bookmarks/<topic>/specs/revised/`
- `agents/workflows/bookmark/x-bookmarks-review-pipeline.lobster.yaml` (path updates)

## Scope Boundaries

- **Do not** add a database, Postgres, SQLite, or any persistence layer. JSON + JSONL only.
- **Do not** add user accounts, auth, or remote hosting. Local-only web app.
- **Do not** rewrite the bookmark review pipeline. The transitions log is a side effect, not a new source of truth.
- **Do not** visualize everything. The MVP is the four views above plus a detail panel. No analytics, no charts beyond state counts over time.
- **Do not** migrate diary, ops, sindustries, sindustries-drop, ecomm, infra, content, hooks.md in this spec. They sit at the brain root for reasons independent of bookmarking. They are out of scope.
- **Do not** rename the `bookmarks/x/` and `bookmarks/self/` intake subfolders. The cron writes there; that surface is stable.

## Risks / Unknowns

- **Transitions log drift.** If a script forgets to call `log_transition()`, the dashboard will silently misrepresent reality. Mitigation: write a tiny self-check script (`scripts/bookmarks/check_transitions.py`) that compares transition log entries against current state and flags any item whose `lastUpdatedAt` is later than its last logged transition.
- **Path migration churn.** If we move `brain/specs/brain/x-bookmark-review-and-tasking-workflow.md` mid-spec, the spec link inside it breaks. Mitigation: the spec is the artifact the migration refers to, so do the file move in a dedicated commit and update wiki links in the same commit.
- **Dashboard build scope creep.** A "real" dashboard wants filters, drilldowns, export, comparison views, dark mode. Tom explicitly asked for "functional, not perfect". Mitigation: hard cap the build at the four views. Anything else goes in a follow-up spec.
- **The cron may genuinely be broken in a way the dashboard reveals.** If the dashboard shows `pending` climbing, that's not a dashboard problem; that's a real signal we need to act on. We should not be surprised by this; we should treat it as the whole point.

## Incremental Rollout

1. **Transitions log helper + first call site.** Add `log_transition()` to `common.py` and call it from `generate_reviews.py`. Ship that. Verify the log file is being written.
2. **Wire the rest of the call sites.** `generate_specs.py`, `request_topic_approval.py`, `resolve_topic_approval.py`, `finalize_review_cycle.py`. Each is a one-line addition.
3. **Self-check script.** `check_transitions.py` flags any state item whose `lastUpdatedAt` is newer than the latest transition log line.
4. **Dashboard MVP.** Static page, three views + recent transitions, local server, no auth. Ships as `brain/specs/brain/assets/dashboard/index.html` plus a `serve.py` launcher.
5. **Brain path migration phase 1.** New path helpers in `common.py`. Generate into new paths, read from old with a deprecation log line.
6. **Brain path migration phase 2.** `git mv` the existing files. Update state records.
7. **Brain path migration phase 3.** Flip reads to new paths, delete old top-level folders.

## Success Checks

- Tom can open a single URL on his Mac mini and see, within one screen, how many bookmarks are in each pipeline state, what the drop-off looks like, and what moved in the last 24 hours.
- When a script mutates state, the transition is recorded in the JSONL log within the same commit as the mutation, and the dashboard reflects it on next refresh.
- A bookmark can be traced from `brain/bookmarks/<topic>/<slug>.md` to its review and spec without leaving that topic folder.
- The `scripts/bookmarks/` code no longer hard-codes the old top-level `brain/reviews/` or `brain/specs/` paths.
- The cron shows green; the dashboard shows the truth. If those ever disagree, we know which one to trust.

## Proposed Tasks

### Wire the transitions log into the bookmark pipeline

- **Priority:** `high`
- **Assignee:** _blank_
- **Why:** Make the existing pipeline write down its state changes so we can see what the cron is actually doing, not just that it ran without errors.
- **Deliverable:** `scripts/bookmarks/common.py` gains a `log_transition(key, from_status, to_status, reason)` helper backed by `brain/state/bookmark-transitions.jsonl`. Every script that mutates `reviewStatus` or `approvalStatus` calls it. A `check_transitions.py` self-check script flags drift.
- **Acceptance Criteria:**
  - `log_transition()` appends a single JSONL line with `key`, `from`, `to`, `at`, `actor`, `reason`, and is safe to call concurrently.
  - `generate_reviews.py`, `generate_specs.py`, `request_topic_approval.py`, `resolve_topic_approval.py`, and `finalize_review_cycle.py` all call `log_transition()` when they change state.
  - `check_transitions.py` reads `bookmark-review-state.json` and `bookmark-transitions.jsonl`, then emits a list of items whose `lastUpdatedAt` is newer than the most recent logged transition for that key, and exits non-zero if any are found.
  - Historical state items with no transition log are flagged but do not fail the check.

### Build the bookmark pipeline dashboard MVP

- **Priority:** `high`
- **Assignee:** _blank_
- **Why:** Give Tom a single local URL that shows pipeline state, drop-off, and recent activity so he can answer "is the cron alive" and "what got reviewed this week" without grepping JSON.
- **Deliverable:** A static web app at `brain/specs/brain/assets/dashboard/index.html` plus a `serve.py` launcher, rendering four views: KPI strip, pipeline funnel, state counts over time, recent transitions. Time and topic filters. Manual refresh.
- **Acceptance Criteria:**
  - Opening `http://127.0.0.1:8765/` in a browser shows the four views using current data from `brain/state/bookmark-review-state.json` and `brain/state/bookmark-transitions.jsonl`.
  - Time-window filter (`7d`, `30d`, `90d`, `all`) re-renders the funnel and time-series without a page reload.
  - Topic filter narrows the funnel and the recent-transitions list.
  - "Refresh" button re-reads the JSON files and re-renders.
  - No build step, no npm, no framework. Plain HTML + JS + (optionally) one small vendored charting helper. The page loads in under a second on the local Mac mini.
  - Running the dashboard does not mutate any state file.

### Migrate brain paths under a topic-first bookmarks tree

- **Priority:** `medium`
- **Assignee:** _blank_
- **Why:** Stop scattering bookmark-derived content (reviews, specs, posts) at the brain root and consolidate under `brain/bookmarks/<topic>/` so each bookmark's full lifecycle is visible from one folder.
- **Deliverable:** A new layout under `brain/bookmarks/<topic>/{reviews,specs,posts}/`, with phased migration so the pipeline never breaks mid-move.
- **Acceptance Criteria:**
  - Phase 1: `scripts/bookmarks/common.py` exposes `review_path()`, `spec_path()`, `bookmark_path()` helpers. New artifacts write to the new paths. Reads still work from the old paths with a deprecation log line.
  - Phase 2: existing files are moved with `git mv`. `bookmark-review-state.json` `path` and `reviewDoc` fields are updated. State is rewritten atomically.
  - Phase 3: reads flip to new paths. Old top-level `brain/reviews/`, `brain/specs/` (other than `brain/specs/brain/x-bookmark-review-and-tasking-workflow.md` and this spec), and `brain/specs-revised/` are deleted.
  - No script or doc reference to the old top-level paths survives phase 3, except in this spec's history.

### Add a per-bookmark detail panel to the dashboard

- **Priority:** `low`
- **Assignee:** _blank_
- **Why:** The transitions log is more useful when you can see a single bookmark's full journey without leaving the dashboard.
- **Deliverable:** A clickable bookmark key in the recent-transitions list opens a side panel showing the full transition history for that key plus links to the review and spec docs.
- **Acceptance Criteria:**
  - Clicking a recent-transition row loads the bookmark's full transition history from `bookmark-transitions.jsonl`.
  - The panel shows source, topic, current state, and links to the review doc, spec doc, and any tasks created.
  - The panel is keyboard-navigable and closes on Escape.
