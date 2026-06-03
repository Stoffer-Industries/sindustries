#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os

from common import dump_json, get_task, parse_lobster_state


def main() -> int:
    parser = argparse.ArgumentParser(description="Load one content task and parse Lobster state")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url
    task = get_task(args.task_id, base_url=args.base_url or None)
    state = parse_lobster_state(task)
    dump_json({"task": task, "lobster_state": state, "criteria_met": True, "already_past": False, "action_taken": "loaded_task"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
