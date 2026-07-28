---
name: tasks-analytics
description: "Endpoint guide + scripts for reading the feature-task analytics event stream (task f170e344): weekly rollups, terminal-task lookback, and per-task gate-failure tallies."
---

# Tasks Analytics

Thin data-plumbing layer over `/api/v1/feature-task-analytics/*` and the tasks list
endpoints. Consumers (like `factory-retro`) should call these scripts instead of
re-implementing the curl/parse logic inline.

All scripts read `TASKS_API_BASE_URL` from the environment (same convention as
`agents/skills/ops/tasks-api/tasks_api_client.py`) and print JSON to stdout — pipe to `jq`
for extraction.

## Which script for what

| Need | Script | Backing endpoint |
|---|---|---|
| Headline weekly numbers (terminal count, gate-failure rate, quality/capacity split, PR cycle time, evidence mix) | `scripts/weekly_summary.py` | `GET /feature-task-analytics/weekly?weeks=N` |
| List of tasks that reached `done`/`accepted` in the last N days (titles, for reports) | `scripts/get_terminal_tasks.py` | `GET /tasks?status=done`, `GET /tasks?status=accepted` |
| Per-gate / per-cause / per-message breakdown of `gate_failure` events, for "top N suggestions" style reports | `scripts/tally_events.py` | `GET /feature-task-analytics/tasks/:taskId/events` (looped) |

## Usage

```bash
export TASKS_API_BASE_URL=http://localhost:4001/api/v1

python3 agents/skills/ops/tasks-analytics/scripts/weekly_summary.py --weeks 2 | jq '.data[0]'
python3 agents/skills/ops/tasks-analytics/scripts/get_terminal_tasks.py --days 7 | jq 'length'
python3 agents/skills/ops/tasks-analytics/scripts/tally_events.py --days 7 | jq '.byMessage'
```

## When the global aggregation endpoint supersedes `tally_events.py`

`tally_events.py` does a **per-task** loop over `GET
/feature-task-analytics/tasks/:taskId/events` — it fetches the in-window candidate task set
(active `feature`-type tasks in `doing`/`ready`/`acceptance`, plus this week's terminal
tasks) and tallies gate-failure events client-side. This does not scale past a modest
in-window task count.

Task **6a5783a7** ("Log gate-failure analytics for post-merge") is building a global
aggregation endpoint — a Postgres rollup fed by the same `gate_failure` events, queryable
directly without the per-task loop. **Once that endpoint ships and is documented here, prefer
it for gate-failure breakdowns and reserve `tally_events.py` for targeted/ad-hoc per-task
digging.** Until then, `tally_events.py` is the only path to a gate-failure breakdown by
gate/cause/message.

`weekly_summary.py` already comes from an aggregate endpoint (`/weekly`) — it is not affected
by this supersession note; use it for headline numbers regardless.

## Script details

### `scripts/weekly_summary.py`

```
python3 weekly_summary.py [--weeks N]
```
Default `--weeks 2` (current + prior bucket, for trend comparison). Prints the raw
`/feature-task-analytics/weekly` response — a `{"data": [...]}` envelope, most recent bucket
first.

### `scripts/get_terminal_tasks.py`

```
python3 get_terminal_tasks.py [--days N] [--status done --status accepted]
```
Default `--days 7`, default statuses `done` + `accepted`. Filters by `completedAt` against
the cutoff. Some deployments don't support every status filter (e.g. `accepted`) — a failed
status fetch is skipped, not fatal, so partial results are still returned. Prints a JSON
array of task objects.

### `scripts/tally_events.py`

```
python3 tally_events.py [--days N]
```
Default `--days 7`. Builds the in-window candidate task set, fetches each task's analytics
events, and tallies `gate_failure` events by `gate`, `cause`, and `message` (verbatim message
text — grouping/bucketing into known patterns is a report-authoring concern, not this
script's job). Prints:

```json
{
  "total": 38,
  "byGate": [["ready_checks", 26], ["spec_check", 8], ...],
  "byCause": [["quality", 34], ["capacity", 4]],
  "byMessage": [["Missing task comment `[tech-design] <url>`.", 9], ...]
}
```

### `scripts/_common.py`

Shared helpers (`fetch`, `fetch_terminal_tasks`, `cutoff_utc`, `parse_iso`, `get_base_url`).
Not a standalone entry point — imported by the sibling scripts.
