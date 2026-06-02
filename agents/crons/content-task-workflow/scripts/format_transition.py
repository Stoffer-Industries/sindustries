#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
from typing import Any

from common import add_comment, dump_json, is_at, is_past, move_task, now_iso, patch_task, read_first_json_value, refresh_task, status, transition_result, write_lobster_state

REVIEW_LINK_RE = re.compile(r"(?:/Users/quinnstoffer/\.openclaw/workspace/)?brain/reviews/[^\s)\]]+\.md|https?://[^\s)\]]+", re.I)
PR_HEADING_RE = re.compile(r"^\s{0,3}#{1,4}\s+.*\bPR\b.*$", re.I | re.M)
CHECKBOX_RE = re.compile(r"^\s*-\s*\[[ xX]\]\s+\S+", re.M)


def pr_heading_blocks(description: str) -> list[str]:
    matches = list(PR_HEADING_RE.finditer(description or ""))
    blocks: list[str] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(description)
        blocks.append(description[start:end])
    return blocks


def check_format(task: dict[str, Any]) -> tuple[bool, list[str]]:
    description = task.get("description") or ""
    failures: list[str] = []
    if not description.strip():
        failures.append("Task body is empty.")
        return False, failures
    if not REVIEW_LINK_RE.search(description):
        failures.append("Task body must include a review file link, usually `brain/reviews/...md`.")
    blocks = pr_heading_blocks(description)
    if not blocks:
        failures.append("Task body must include one or more headings containing `PR`.")
    elif not all(CHECKBOX_RE.search(block) for block in blocks):
        failures.append("Each PR heading must have acceptance criteria checkbox lines beneath it.")
    return not failures, failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Open -> Ready transition for content task formatting")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--dry-run", default="false")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.base_url:
        os.environ["TASKS_API_BASE_URL"] = args.base_url

    data = read_first_json_value(sys.stdin)
    task = data["task"]
    state = data.get("lobster_state") or data.get("lobsterState") or {}
    criteria_met, failures = check_format(task)
    already_past = is_past(task, "open")
    action = "none"

    if criteria_met and is_at(task, "open"):
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_open_to_ready"
        else:
            state = dict(state)
            state.setdefault("workflow", "content-task-workflow")
            state.setdefault("ivyAssignmentId", f"ivy-assignment-{uuid.uuid4()}")
            state["lastOrchestratedAt"] = now_iso()
            patch_task(str(task["id"]), {"status": "ready", "assignee": "Ivy"})
            comment = add_comment(str(task["id"]), "Content task workflow moved `open` -> `ready`. Format criteria are met; assigned to Ivy.")
            data_comment = comment.get("data") if isinstance(comment, dict) and isinstance(comment.get("data"), dict) else comment
            if isinstance(data_comment, dict) and data_comment.get("id"):
                state["assignmentCommentId"] = str(data_comment["id"])
            write_lobster_state(str(task["id"]), state, note="Recorded Ivy assignment metadata.")
            task = refresh_task(str(task["id"]))
            action = "moved_open_to_ready_assigned_ivy"
    elif not criteria_met and already_past:
        if str(args.dry_run).lower() == "true":
            action = "dry_run_move_back_to_open"
        else:
            task = move_task(task, "open", "Format criteria are no longer met: " + "; ".join(failures), state)
            action = "moved_back_to_open"
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
