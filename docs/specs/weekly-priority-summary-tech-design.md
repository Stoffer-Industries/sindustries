---
status: draft
task_id: fe2854f1-eb2c-443b-b84e-7ea8c6b6eb04
product_spec: brain/tasks/specs/open/weekly-priority-summary-and-bottlenecks-2026-07-22.md
shipped_pr: null
shipped_date: null
---

# Weekly summary of priority list and biggest bottlenecks — tech design

## Links

- Product spec: `brain/tasks/specs/open/weekly-priority-summary-and-bottlenecks-2026-07-22.md`
- Task: `fe2854f1-eb2c-443b-b84e-7ea8c6b6eb04` (`🔧 Weekly summary of priority list and biggest bottlenecks`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/fe2854f1-eb2c-443b-b84e-7ea8c6b6eb04`
- Tasks API client: `agents/skills/ops/tasks-api/tasks_api_client.py` (already used by Lox and the heartbeat flow)
- Existing weekly content review skill (different scope, content not task ops): `agents/skills/content/sindustries-weekly-content-review/SKILL.md`
- Tom's primary pain point: context-switching into the task system to understand current state. Two-minute read budget.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-fe2854f1-weekly-summary`
- Worktree: `~/workspaces/rowan/sindustries-task-fe2854f1-weekly-summary`
- No secondary repos. Code lands in `agents/heartbeat/` (new Python module + entry point) plus a `cron` job and a small `agents/skills/ops/` helper if the summarisation logic warrants its own skill.

## Product intent (from approved product spec, restated)

A scheduled weekly summary gives Tom a concise, decision-oriented view of the current priority list and delivery bottlenecks — without manually reading every task. It surfaces what matters, what's stuck, and where the system is dragging. Readable in under two minutes.

Spec note: the spec carries "delete me" on the "Approved by Tom" checkbox — that's a holdover placeholder, not a real action. Treat Tom approval as the gating signal; ignore the literal "delete me" annotation when reading the spec. The lobster workflow will gate on its own approval state; the spec body is the source of truth for what to build.

## Acceptance criteria recap

- **AC1** — Weekly summary format covering: top priorities, active work, blocked work, bottlenecks, recommended focus.
- **AC2** — Source inputs defined: Tasks API status/priority/blockers + minimal supporting context.
- **AC3** — First runnable version produces the summary from current task state.
- **AC4** — Delivery path chosen and implemented (heartbeat, scheduled message, note, etc.).
- **AC5** — Summary is concise and decision-oriented — not a raw task dump.

## `.openclaw` boundary

- **No new secrets or tokens.** The summary reads from the local Tasks API at `TASKS_API_BASE_URL` (default `http://localhost:4001/api/v1`) — the same boundary the heartbeat and other agents already use.
- **No `~/.openclaw/` writes.**
- **New cron job** under `agents/crons/fe2854f1-weekly-summary.cron.json` (or equivalent; the cron manager in this repo uses JSON job descriptors). Cron posts the rendered summary to Tom's Signal thread (or a Telegram channel — see AC4 decision below).
- **No LLM cost policy changes.** Optional light summarisation reuses the existing `call_bookmark_llm()`-style helper or a dedicated `call_summary_llm()` if warranted; for v1 we render server-side from task fields without an LLM pass and only call the LLM for the "recommended focus" paragraph if the data is too sparse.

## Out of scope (parking lot, deliberately)

- Building a full dashboard UI (per spec non-goal).
- Replacing the Tasks UI; this complements it.
- Per-person summary breakdowns (one operator focus: Tom).
- Trend / week-over-week deltas (add once the format stabilises).
- Cross-source aggregation (calendar, content metrics, bookmarks) — single-source for v1.
- Persisting prior weekly summaries beyond what the cron archive directory already keeps.
- LLM-generated narrative paragraphs beyond a single short "recommended focus" line. Keep it data-shaped; the model adds noise at this scope.

## Implementation plan

### Delivery path decision (AC4)

Three candidates were considered:

1. **OpenClaw heartbeat** — read by Rowan's heartbeat; rendered inline once per week. Rejected: the heartbeat is decision-routing, not delivery, and Tom already receives a steady stream of heartbeat pings. Adding a weekly payload bloats the heartbeat.
2. **Isolated cron with announce** — `cron` job that runs the summary module in an isolated agent session, with `delivery.mode: announce` to Tom's channel. Accepted.
3. **Note file under `brain/`** — committed Markdown summary dropped into a known directory. Rejected: Tom is not in `brain/` during the week; the summary would be invisible.

**Decision:** option 2 (isolated cron with announce delivery). Tom has Signal and Telegram set up in the OpenClaw config; pick whichever channel he's already on for routine system messages (default: the same channel Lox's other weekly summaries use). The cron payload runs the summary module and announces the result. The cron is silent on failure (no spam), with `notify-soft-fail` escalation per the existing playbook.

The cron schedule is **Mondays 09:00 NZST** (Tom's local morning, end of his week per US calendar quirks). `schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Pacific/Auckland" }`.

### File / module scope

#### 1. Summary module — `agents/heartbeat/weekly_summary.py` *(new)*

A small Python module with one public entry point — `render_weekly_summary(*, tasks_api_base_url: str | None = None, now: datetime | None = None) -> str` — that returns the rendered Markdown summary as a string. Internal sections (each a private function returning a `str`):

- `top_priorities_section(tasks)` — sorts by priority (`urgent`, then high, then medium, then low) and assignee load; renders the top 5–7 with one-line title + status + assignee.
- `active_work_section(tasks)` — `status == "doing"` tasks, grouped by assignee; counts per person; lists task titles inline.
- `blocked_work_section(tasks)` — `status == "doing"` AND (`blocked == true` OR `dependencyBlocked == true` OR has outstanding workflow-gate owners). Lists the top blockers with one-line context.
- `bottlenecks_section(tasks)` — derived: tasks in `doing` for >7 days with no recent `[implementer-prs]` update; tasks where Tom or Quinn has an outstanding workflow-gate; tasks in `open` >30 days (zombie backlog). Computed cheaply from `createdAt` and `updatedAt` + comments.
- `recommended_focus_section(tasks)` — short (≤3 sentences) LLM-generated paragraph, OR deterministic fallback ("No new blockers; attention on WS3 of task 66054ab4 and the priority-link backlog-maintenance rollout.") when LLM unavailable. The fallback is preferred for v1 to avoid LLM cost and drift; LLM paragraph behind a feature flag if added later.

Inputs:

- `list_tasks(filters={"status": ["open", "doing", "acceptance"], "assignee": None})` via `tasks_api_client.py`. Returns the same Task shape the queue script uses.
- For "blocked": use the existing `blocked` and `dependencyBlocked` boolean fields + the new `workflowGateOwners` field that landed in PR #405 / #410.

Length target: ≤40 lines of Markdown. Hard cap; trim past 40 lines by dropping lowest-priority items until under cap.

#### 2. Cron job descriptor — `agents/crons/fe2854f1-weekly-summary.cron.json` *(new)*

- `schedule`: `{ kind: "cron", expr: "0 9 * * 1", tz: "Pacific/Auckland" }`
- `payload`: `{ kind: "agentTurn", message: "Run the weekly summary module and announce to Tom's channel. Use `python3 agents/heartbeat/weekly_summary.py` or call the module directly." }`
- `sessionTarget`: `"isolated"`
- `delivery`: `{ mode: "announce", channel: <telegram-or-signal>, bestEffort: true }` — channel matches the rest of the system messages.
- `failureAlert`: `{ after: 2, channel: <lox>, mode: "announce" }` so Lox is notified if the job silently fails twice in a row.

The cron job is added by Quinn (the OpenClaw cron registry is human-managed) — implementation task lists "register cron job in OpenClaw config" as an explicit PR step.

#### 3. Tests — `agents/heartbeat/tests/test_weekly_summary.py` *(new)*

- Snapshot-style tests: feed the renderer a fixed list of fake Task dicts (no real Tasks API), assert the output contains the expected section headings + ≤40 lines + includes the top-priority task titles.
- Edge cases: empty backlog, all-`urgent` backlog, single-task backlog, no-`doing` backlog.
- AC verification:
  - AC1 — assert all five headings present in rendered Markdown.
  - AC2 — assert the renderer only reads from the supplied `tasks_api_base_url` (mocked) and no other network.
  - AC3 — integration test: run the renderer against the live Tasks API on a quiet task day, assert output is valid Markdown + length cap.
  - AC4 — assert the cron descriptor file parses + has the expected `delivery.mode == "announce"`.
  - AC5 — assert output length cap holds across the edge cases above.

#### 4. Documentation — `docs/systems/` and inline

- **`docs/systems/tasks.md`** *(modified)* — short subsection "Weekly summary" linking to this tech design and to the cron descriptor. Notes the data is read-only; no writes to Tasks API.
- **`agents/heartbeat/README.md`** *(modified or new)* — explains the module + how to trigger an ad-hoc run for testing.
- **`agents/crons/README.md`** *(modified if present)* — pointer to the new cron file.

### Data model summary

No schema changes. The summary module reads existing Task fields only. The bottleneck heuristic uses `createdAt`, `updatedAt`, and comment timestamps — all already present.

### Cross-context coordination

- **Module → Tasks API:** HTTP GET via `tasks_api_client.py`. Same pattern Lox uses.
- **Cron → announce:** standard OpenClaw cron announce path.
- **No new IPC, no `postMessage`, no LLM cost changes for v1.**

### Workflow / cron / skill changes

- **Cron:** new `fe2854f1-weekly-summary.cron.json` as above.
- **Skill:** none new. The existing `tasks-api` skill covers the read path; the summarisation is small enough to live in the cron payload's prompt without a dedicated skill.

### Design system usage

Not applicable. Backend Python + Markdown rendering; no UI changes.

### Service boundary notes

- **Domain owner:** Rowan owns the summary module. Quinn owns the cron registration step.
- **Why a Python module instead of a TS route:** Lox and the heartbeat already speak Python for Tasks API access. Adding a TS route would force every cron-caller through tasks-api and require an HTTP client in the cron. Python in-process is simpler.
- **Extraction / migration plan:** if the summary ever needs real-time UI rendering, hoist `weekly_summary.py` into a tasks-api route (`GET /reports/weekly`) and have the cron call it. **Not done in this PR.**

## Test plan

- **Unit (Python):** `test_weekly_summary.py` covers all five section renderers + edge cases + length cap. Run via `python3 -m pytest agents/heartbeat/tests/test_weekly_summary.py`.
- **Integration:** run against live Tasks API on a non-busy day, confirm output is valid Markdown and ≤40 lines.
- **Manual smoke:**
  1. Run `python3 agents/heartbeat/weekly_summary.py` from the worktree root — confirm output renders, all five headings present, length cap holds.
  2. Inspect the cron descriptor: parse + validate fields.
  3. After merge, Quinn registers the cron. Confirm one dry run lands in Tom's channel and the content matches the manual smoke.
- **CI:** Python CI workflow stays green.

## AC verification matrix

| AC | Strategy | New tests |
|---|---|---|
| AC1 | Module renders five sections with stable headings (`## Top priorities`, `## Active work`, `## Blocked work`, `## Bottlenecks`, `## Recommended focus`). | Snapshot tests assert heading presence; manual smoke checks rendered output. |
| AC2 | Module takes a `tasks_api_base_url` arg and calls only `list_tasks` via `tasks_api_client.py`. No other network access. | Unit test mocks `list_tasks` and asserts no other HTTP client is instantiated. |
| AC3 | Module is runnable from CLI; integration test invokes it against live Tasks API. | Integration test asserts output is valid Markdown and length cap holds. |
| AC4 | Cron descriptor registers an isolated agentTurn with `delivery.mode == "announce"`. Quinn adds the descriptor file to OpenClaw config. | Unit test parses the JSON descriptor; manual smoke confirms the cron fires post-merge. |
| AC5 | Module caps rendered output at 40 lines; drops lowest-priority items past cap; omits raw task dumps. | Edge-case tests assert length cap; snapshot tests assert format (no raw task lists, only one-line summaries). |

## Open questions / risks

- **Q1 — Channel choice.** "Tom's channel" is ambiguous (Signal vs Telegram). Decision: piggy-back on whatever channel Lox's other weekly summary uses (currently Telegram direct chat 6435140143). If Lox's pick shifts, follow.
- **Q2 — Length cap is opinionated.** 40 lines might be too short for weeks with many blockers. Mitigation: cap is a soft warning in v1; if a real run exceeds it, we bump to 60 or split blockers into a separate "details" appendix.
- **Q3 — LLM paragraph drift.** The "recommended focus" paragraph (if added later) could surface task-internal context Tom doesn't want in his chat. Mitigation: the paragraph is constrained to one sentence referencing task titles only; no body content. v1 uses deterministic fallback to avoid the risk entirely.
- **Q4 — Data freshness.** The Tasks API is local-only. If Tom runs the summary from a non-local context (e.g. during travel), it will fail. Mitigation: `bestEffort: true` on the cron delivery; `notify-soft-fail` escalation catches repeated failures.
- **Q5 — Spec "delete me" annotation.** The product spec has a "delete me" placeholder on the Tom-approval checkbox. Treating it as a non-action; gating on actual Tom approval state. If Quinn flags this differently on review, I'll resync.

## Companion doc updates

- `docs/systems/tasks.md` — short "Weekly summary" subsection.
- `agents/heartbeat/README.md` — pointer to the new module + how to run ad-hoc.

## Later todos (parking lot)

- Week-over-week trend deltas (blocker count change, average days-in-`doing`).
- Per-assignee breakdown section for Tom's leadership view.
- Cross-source summary (calendar + content metrics + tasks).
- LLM-generated narrative if the deterministic fallback proves too sparse.
- Move the module into tasks-api as `GET /reports/weekly` once a UI consumer exists.