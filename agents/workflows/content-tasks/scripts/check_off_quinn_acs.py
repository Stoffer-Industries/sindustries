#!/usr/bin/env python3
"""Mark Quinn's ACs as done in a content task after merging her PR."""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# Add common.py to path
sys.path.insert(0, str(Path(__file__).parent))
from common import get_task, mark_quinn_acs_done, patch_task

def main() -> int:
    parser = argparse.ArgumentParser(description="Mark Quinn ACs as done in a content task")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--base-url", default=os.getenv("TASKS_API_BASE_URL", ""))
    args = parser.parse_args()

    task = get_task(args.task_id, base_url=args.base_url or None)
    description = task.get("description") or ""

    updated = mark_quinn_acs_done(args.task_id, description, base_url=args.base_url or None)
    changed = updated != description

    print(f"Task: {args.task_id}")
    print(f"Changed: {changed}")
    if changed:
        print("Updated description (first 200 chars):")
        print(updated[:200])
    else:
        print("No unchecked Quinn ACs found — nothing to do.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())