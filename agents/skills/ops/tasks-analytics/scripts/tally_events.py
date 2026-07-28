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

from _common import cutoff_utc, fetch, fetch_terminal_tasks, parse_iso


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
            events = fetch(f"/feature-task-analytics/tasks/{tid}/events").get("data", [])
        except Exception:  # noqa: BLE001
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
