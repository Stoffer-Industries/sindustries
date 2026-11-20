#!/usr/bin/env python3
"""Terminal (done/accepted) tasks completed within the last N days.

Wraps the two-status fetch + completedAt cutoff filter that factory-retro's
Step 2 used to do inline.

Usage:
  python3 get_terminal_tasks.py [--days N] [--status done --status accepted]

TASKS_API_BASE_URL is required and is read from the environment. It is the live
route, owned by `~/.openclaw/.env`; the prodlike origin is a local-dev fallback
only, so a caller running inside the OpenClaw runtime follows the live route.

Prints a JSON array of task objects to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys

from _common import fetch_terminal_tasks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default 7).")
    parser.add_argument(
        "--status",
        action="append",
        dest="statuses",
        help="Status to include (repeatable). Default: done, accepted.",
    )
    args = parser.parse_args()

    statuses = tuple(args.statuses) if args.statuses else ("done", "accepted")
    tasks = fetch_terminal_tasks(days=args.days, statuses=statuses)
    json.dump(tasks, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
