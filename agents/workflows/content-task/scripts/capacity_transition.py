#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
import uuid
from typing import Any

from common import dump_json, is_at, is_past, list_tasks, move_task, now_iso, read_first_json_value, status, transition_result


def check_capacity(task: dict[str, Any], capacity_limit: int) -> tuple[bool, list[str]]:
    assignee = (task.get("assignee") or "").strip()
    if assignee.lower() != "ivy":
        return False, ["Task must be assigned to Ivy before it can move to Doing."]
    doing = list_tasks(limit=100, status="doing", assignee="Ivy", taskType="content")
    unblocked = [t for t in doing if t.get("blocked") is not True and str(t.get("id")) != str(task.get("id"))]
    if len(unblocked) >= capacity_limit:
        return False, [f"{assignee} already has {len(unblocked)} unblocked content task(s) in Doing; capacity limit is {capacity_limit}."]
    return True, []


def main() -> int:
    parser = argparse.ArgumentParser(description="Ready -> Doing transition for content task capacity")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--capacity-limit", type=int, default=1)
    parser.add_argument("--ivy-capacity-limit", type=int)
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url

    data = read_first_json_value(sys.stdin)
    task = data["task"]
    state = data.get("lobster_state") or {}
    capacity_limit = args.ivy_capacity_limit if args.ivy_capacity_limit is not None else args.capacity_limit
    criteria_met, failures = check_capacity(task, max(1, capacity_limit))
    already_past = is_past(task, "ready")
    action = "none"

    if criteria_met and is_at(task, "ready"):
        state = dict(state)
        state.setdefault("workflow", "content-task-workflow")
        state.setdefault("workflowRunId", f"content-workflow-{uuid.uuid4()}")
        state["lastOrchestratedAt"] = now_iso()
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_ready_to_doing"
        else:
            task = move_task(task, "doing", "Ivy capacity criteria are met; recorded workflowRunId.", state)
            action = "moved_ready_to_doing"
    elif not criteria_met and already_past:
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_back_to_ready"
        else:
            task = move_task(task, "ready", "Capacity criteria are no longer met: " + "; ".join(failures), state)
            action = "moved_back_to_ready"
    elif criteria_met and already_past:
        action = "already_past"
    elif criteria_met:
        action = "criteria_met"
    else:
        action = "criteria_not_met"

    dump_json(transition_result(criteria_met, already_past, action, task, lobster_state=state, failures=failures, current_status=status(task)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
