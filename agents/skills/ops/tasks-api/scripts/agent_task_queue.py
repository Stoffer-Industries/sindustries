#!/usr/bin/env python3
"""Retrieve and classify an agent's active task queue.

The Tasks API and Lobster remain the source of truth for task state. This
read-only adapter makes task state useful to heartbeat agents by distinguishing
work that can be advanced now from dependency blocks and external waits.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
from typing import Any

CLIENT_PATH = pathlib.Path(__file__).parents[1] / "tasks_api_client.py"
SPEC = importlib.util.spec_from_file_location("tasks_api_client", CLIENT_PATH)
tasks_api_client = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tasks_api_client)

IMPLEMENTATION_TYPES = {"feature", "code"}
DELIVERY_TAGS = ("[implementer-prs]", "[rowan-prs]")
TECH_DESIGN_TAG = "[tech-design]"
TECH_DESIGN_APPROVAL_TAG = "[tech-design-approved]"
TECH_DESIGN_WAIVER_TAG = "[tech-design-not-required]"
PROGRESS_TAGS = ("[feature-task-progress-checklist]", "[code-task-progress-checklist]")


def _comment_texts(task: dict[str, Any]) -> list[str]:
    return [
        str(comment.get("text") or comment.get("body") or "").strip()
        for comment in task.get("comments") or []
    ]


def _has_prefix(texts: list[str], prefixes: tuple[str, ...]) -> bool:
    return any(text.lstrip().startswith(prefix) for text in texts for prefix in prefixes)


def _latest_progress_comment(texts: list[str]) -> str:
    for text in reversed(texts):
        if any(tag in text for tag in PROGRESS_TAGS):
            return text
    return ""


def _tech_design_approved(texts: list[str]) -> bool:
    """Mirror Lobster's starts-with tag and exact first-token approval rule."""
    for text in texts:
        stripped = text.strip()
        if not stripped.startswith(TECH_DESIGN_APPROVAL_TAG):
            continue
        value = stripped[len(TECH_DESIGN_APPROVAL_TAG):].strip()
        token = value.split(maxsplit=1)[0] if value else ""
        if token.lower() == "true":
            return True
    return False


def classify_task(task: dict[str, Any]) -> tuple[str, str]:
    """Return (classification, reason) for one full Tasks API task object."""
    if task.get("dependencyBlocked"):
        return "DEPENDENCY_BLOCKED", "one or more task dependencies are incomplete"
    if task.get("blocked"):
        return "BLOCKED", "task blocked flag is set"

    status = str(task.get("status") or "").lower()
    task_type = str(task.get("taskType") or "").lower()
    texts = _comment_texts(task)
    latest_progress = _latest_progress_comment(texts)

    if status == "ready" and task_type in IMPLEMENTATION_TYPES:
        has_design = _has_prefix(texts, (TECH_DESIGN_TAG,))
        has_approval = _tech_design_approved(texts)
        has_waiver = _has_prefix(texts, (TECH_DESIGN_WAIVER_TAG,))
        if not has_design and not has_waiver:
            return "ACTIONABLE", "tech design or explicit waiver is missing"
        if has_approval or has_waiver:
            return "WAITING_EXTERNAL", "delivery is ready for Lobster promotion to doing"
        return "WAITING_EXTERNAL", "tech design is waiting for approval"

    if status == "doing" and task_type in IMPLEMENTATION_TYPES:
        has_design = _has_prefix(texts, (TECH_DESIGN_TAG,))
        has_approval = _tech_design_approved(texts)
        has_waiver = _has_prefix(texts, (TECH_DESIGN_WAIVER_TAG,))
        if not has_design and not has_waiver:
            return "ACTIONABLE", "tech design or explicit waiver is missing"
        if not has_approval and not has_waiver:
            return "WAITING_EXTERNAL", "tech design is waiting for approval"
        if _has_prefix(texts, DELIVERY_TAGS):
            return "WAITING_EXTERNAL", "implementer delivery posted; verify PR review and CI state"
        if "missing `[implementer-prs]`" in latest_progress.lower():
            return "ACTIONABLE", "progress checklist says implementer delivery is missing"
        return "ACTIONABLE", "implementation PR delivery has not been posted"

    if status == "acceptance":
        if task_type in IMPLEMENTATION_TYPES and _has_prefix(texts, DELIVERY_TAGS):
            return "WAITING_EXTERNAL", "implementer delivery posted; verify review, QA, and post-merge state"
        if "missing `[implementer-prs]`" in latest_progress.lower():
            return "ACTIONABLE", "progress checklist says implementer delivery is missing"
        return "WAITING_EXTERNAL", "task is in acceptance; verify review, QA, and post-merge state"

    if status in {"ready", "doing"}:
        return "ACTIONABLE", f"{task_type or 'task'} task is in {status}"

    return "WAITING_EXTERNAL", f"task state {status or 'unknown'} has no agent action rule"


def build_queue(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    items = []
    for task in tasks:
        classification, reason = classify_task(task)
        items.append(
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "taskType": task.get("taskType"),
                "status": task.get("status"),
                "priority": task.get("priority"),
                "classification": classification,
                "reason": reason,
            }
        )

    order = {"ACTIONABLE": 0, "WAITING_EXTERNAL": 1, "DEPENDENCY_BLOCKED": 2, "BLOCKED": 3}
    items.sort(key=lambda item: (order.get(item["classification"], 99), item.get("title") or ""))
    return {
        "actionableCount": sum(item["classification"] == "ACTIONABLE" for item in items),
        "items": items,
    }


def fetch_agent_tasks(assignee: str, base_url: str | None = None) -> list[dict[str, Any]]:
    base = base_url or tasks_api_client.get_base_url()
    summaries = tasks_api_client.list_tasks(
        limit=50,
        status=["ready", "doing", "acceptance"],
        assignee=assignee,
        base_url=base,
    )
    return [tasks_api_client.get_task(task["id"], base_url=base) for task in summaries]


def print_human(queue: dict[str, Any], assignee: str) -> None:
    print(f"{assignee} actionable tasks: {queue['actionableCount']}")
    for item in queue["items"]:
        print(
            f"{item['classification']:18} [{str(item['id'])[:8]}] "
            f"{item['status']}/{item['taskType']}: {item['title']} — {item['reason']}"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assignee", required=True, help="Tasks API assignee name, e.g. Rowan")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    queue = build_queue(fetch_agent_tasks(args.assignee))
    if args.json:
        print(json.dumps(queue, indent=2))
    else:
        print_human(queue, args.assignee)


if __name__ == "__main__":
    main()
