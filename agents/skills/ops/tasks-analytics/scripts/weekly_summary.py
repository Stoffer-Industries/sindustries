#!/usr/bin/env python3
"""Weekly aggregate snapshot from the feature-task analytics rollup.

Wraps: GET /feature-task-analytics/weekly?weeks=<N>

Usage:
  python3 weekly_summary.py [--weeks N]

TASKS_API_BASE_URL is required and is read from the environment. It is the live
route, owned by `~/.openclaw/.env`; the prodlike origin is a local-dev fallback
only, so a caller running inside the OpenClaw runtime follows the live route.

Prints the raw JSON response to stdout (pipe to `jq` for extraction).
"""

from __future__ import annotations

import argparse
import json
import sys

from _common import fetch


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weeks", type=int, default=2, help="Number of weekly buckets to fetch (default 2).")
    args = parser.parse_args()

    result = fetch(f"/feature-task-analytics/weekly?weeks={args.weeks}")
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
