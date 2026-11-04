#!/usr/bin/env python3
"""Per-task gate-failure event tally for the in-window task set.

Wraps factory-retro's Step 3: pull the in-window candidate task set (active
feature-task states + this week's terminal tasks), fetch each task's
analytics events, and tally `gate_failure` events by gate / cause / message.

**Supersession note:** this does a per-task `GET
/feature-task-analytics/tasks/:taskId/events` loop, which does not scale.
Once task 6a5783a7 (global gate-failure aggregation endpoint) ships, prefer
that endpoint for the breakdown and reserve this script for one-off /
targeted per-task digging. Until then this is the only path to a
gate-failure breakdown.

**Pagination note (task 75032fad):** the per-task events endpoint is
bounded — it returns at most one page of events per response and reports
the rest through `pagination.nextCursor` / `pagination.hasMore`. This
script follows the cursor to the end and concatenates the pages in order,
so its `total` / `byGate` / `byCause` / `byMessage` output is identical to
the pre-pagination output on the same events. A server that does not send
a `pagination` object is treated as a single-page response.

Usage:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 tally_events.py [--days N]

Prints JSON to stdout:
  {
    "total": <int>,
    "byGate": [[gate, count], ...],
    "byCause": [[cause, count], ...],
    "byMessage": [[message, count], ...]   # sorted most-common first
  }
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import urllib.parse

from _common import cutoff_utc, fetch, fetch_terminal_tasks, parse_iso

# Upper bound on the number of pages fetched for a single task. The
# endpoint's own page cap (2,000 events) means a task with a pathological
# event history still terminates; this bound only exists so a misbehaving
# server that keeps handing out fresh cursors cannot spin forever.
MAX_EVENT_PAGES = 1_000


class PaginationError(RuntimeError):
    """The events endpoint returned a pagination envelope we cannot follow.

    Raised instead of silently truncating the task's history: a caller that
    stops after one page would under-count gate failures, and a caller that
    loops on a repeated cursor would hang. The script treats this as fatal
    (non-zero exit) because a partial tally is worse than no tally.
    """


def _has_more(pagination: dict) -> bool:
    """Read `pagination.hasMore` defensively (bool-ish, string-tolerant)."""
    raw = pagination.get("hasMore")
    if isinstance(raw, str):
        return raw.strip().lower() in ("true", "1", "yes")
    return bool(raw)


def fetch_task_events(task_id: str) -> list[dict]:
    """Fetch every analytics event for one task, following the cursor.

    The endpoint is bounded: one response carries at most one page of
    events plus a `pagination` envelope. While `pagination.hasMore` is
    true we request the next page with `?cursor=<nextCursor>` and append
    its `data` in order, so the concatenated list is the task's complete
    event history in the server's chronological order.

    A response without a `pagination` object is treated as a single-page
    response (pre-pagination server behaviour).
    """
    events: list[dict] = []
    seen_cursors: set[str] = set()
    cursor: str | None = None

    for _ in range(MAX_EVENT_PAGES):
        path = f"/feature-task-analytics/tasks/{task_id}/events"
        if cursor is not None:
            path += f"?cursor={urllib.parse.quote(cursor, safe='')}"
        payload = fetch(path)

        page = payload.get("data")
        if page is None:
            page = []
        if not isinstance(page, list):
            raise PaginationError(f"events response for task {task_id} has a non-list `data`")
        events.extend(page)

        pagination = payload.get("pagination")
        if pagination is None:
            # Pre-pagination server: the whole history came in one response.
            return events
        if not isinstance(pagination, dict):
            raise PaginationError(
                f"events response for task {task_id} has a non-object `pagination`"
            )
        if not _has_more(pagination):
            return events

        next_cursor = pagination.get("nextCursor")
        if not isinstance(next_cursor, str) or not next_cursor.strip():
            raise PaginationError(
                f"events response for task {task_id} reports hasMore without a nextCursor"
            )
        if next_cursor in seen_cursors:
            raise PaginationError(
                f"events response for task {task_id} repeated cursor {next_cursor!r}"
            )
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    raise PaginationError(
        f"events response for task {task_id} exceeded {MAX_EVENT_PAGES} pages"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default 7).")
    args = parser.parse_args()

    cutoff = cutoff_utc(args.days)
    terminal_tasks = fetch_terminal_tasks(days=args.days)

    # In-window candidate tasks: active feature-task states, plus this
    # week's terminal tasks.
    task_ids: set[str] = set()
    for status in ("doing", "ready", "acceptance"):
        for t in fetch(f"/tasks?status={status}&limit=100").get("data", []):
            if t.get("taskType") == "feature":
                task_ids.add(t["id"])
    for t in terminal_tasks:
        task_ids.add(t["id"])

    gate_counts: collections.Counter = collections.Counter()
    cause_counts: collections.Counter = collections.Counter()
    message_counts: collections.Counter = collections.Counter()
    total = 0

    for tid in task_ids:
        try:
            events = fetch_task_events(tid)
        except PaginationError as exc:
            # A malformed pagination envelope means the history would be
            # silently truncated. Fail loudly instead of reporting a
            # partial tally.
            print(f"error: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        except Exception:  # noqa: BLE001
            # Transport/decoding failure for one task: skip it, as before.
            continue
        for e in events:
            if e.get("eventType") != "gate_failure":
                continue
            occurred_raw = e.get("occurredAt")
            if not occurred_raw:
                continue
            occurred = parse_iso(occurred_raw)
            if occurred < cutoff:
                continue
            total += 1
            gate_counts[e.get("gate", "unknown")] += 1
            cause_counts[e.get("cause", "unknown")] += 1
            msg = (e.get("message") or "").strip()
            message_counts[msg] += 1

    result = {
        "total": total,
        "byGate": gate_counts.most_common(),
        "byCause": cause_counts.most_common(),
        "byMessage": message_counts.most_common(),
    }
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
