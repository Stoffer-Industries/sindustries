#!/usr/bin/env python3
"""Build Telegram button payloads for common Tasks API flows.

Usage examples:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_telegram_buttons.py entry
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_telegram_buttons.py list-filters
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_telegram_buttons.py patch-fields --id <task-id>
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_telegram_buttons.py patch-values --id <task-id> --field status

Outputs JSON with:
- text: human-facing prompt
- buttons: Telegram inline keyboard rows
- fallbackText: typed-command fallback when buttons are unavailable/expired
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import urllib.request
from typing import Any

BASE_URL_ENV = "TASKS_API_BASE_URL"
DEFAULT_PATCH_LIMIT = 8


def api_request(method: str, base_url: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    headers = {"content-type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def get_base_url() -> str:
    base = (os.getenv(BASE_URL_ENV) or "").strip()
    if not base:
        raise SystemExit(f"{BASE_URL_ENV} is required")
    return base


def button(text: str, callback: str, style: str = "primary") -> dict[str, str]:
    item = {"text": text, "callback_data": callback}
    if style:
        item["style"] = style
    return item


def print_payload(text: str, buttons: list[list[dict[str, str]]], fallback: str | list[str]) -> None:
    if isinstance(fallback, list):
        fallback_text = "\n".join(f"- {line}" for line in fallback)
    else:
        fallback_text = fallback
    print(json.dumps({"text": text, "buttons": buttons, "fallbackText": fallback_text}, indent=2))


def fetch_tasks(limit: int = DEFAULT_PATCH_LIMIT, status: str | None = None) -> list[dict[str, Any]]:
    base = get_base_url()
    query = {"limit": str(limit)}
    if status:
        query["status"] = status
    data = api_request("GET", base, "/tasks?" + urllib.parse.urlencode(query))
    return data.get("data", []) if isinstance(data, dict) else []


def fetch_task(task_id: str) -> dict[str, Any]:
    base = get_base_url()
    data = api_request("GET", base, f"/tasks/{task_id}")
    return data.get("data", {}) if isinstance(data, dict) else {}


def cmd_entry(_: argparse.Namespace) -> None:
    print_payload(
        "Tasks: choose an action.",
        [
            [button("Create", "/tasks create", "success")],
            [button("List", "/tasks list", "primary"), button("Patch", "/tasks patch", "primary")],
        ],
        ["/tasks create", "/tasks list", "/tasks patch"],
    )


def cmd_list_filters(_: argparse.Namespace) -> None:
    print_payload(
        "List tasks by the most common filters.",
        [
            [button("Todo", "/tasks list --status todo"), button("Doing", "/tasks list --status doing")],
            [button("Blocked", "/tasks list --blocked true"), button("Ready", "/tasks list --ready true")],
            [button("Priority: high", "/tasks list --priority high"), button("Priority: medium", "/tasks list --priority medium")],
            [button("Assignee: Rowan", "/tasks list --assignee Rowan"), button("All tasks", "/tasks list")],
        ],
        [
            "/tasks list --status todo",
            "/tasks list --status doing",
            "/tasks list --blocked true",
            "/tasks list --ready true",
            "/tasks list --priority high",
            "/tasks list --assignee Rowan",
        ],
    )


def cmd_patch_tasks(args: argparse.Namespace) -> None:
    tasks = fetch_tasks(limit=args.limit, status=args.status)
    buttons = []
    fallback = []
    for task in tasks:
        task_id = task.get("id", "")
        title = (task.get("title") or "Untitled task").strip()
        short = title[:48] + ("…" if len(title) > 48 else "")
        buttons.append([button(short, f"/tasks patch --id {task_id}")])
        fallback.append(f"/tasks patch --id {task_id}  # {title}")
    if not buttons:
        buttons = [[button("Refresh task list", "/tasks patch", "primary")]]
        fallback = ["/tasks patch"]
    prompt = "Pick a task to update." if tasks else "No tasks found for that filter."
    print_payload(prompt, buttons, fallback)


def cmd_patch_fields(args: argparse.Namespace) -> None:
    task = fetch_task(args.id)
    title = task.get("title") or args.id
    print_payload(
        f"Update ‘{title}’. Which field do you want to change?",
        [
            [button("Status", f"/tasks patch --id {args.id} --field status"), button("Priority", f"/tasks patch --id {args.id} --field priority")],
            [button("Blocked", f"/tasks patch --id {args.id} --field blocked"), button("Ready", f"/tasks patch --id {args.id} --field ready")],
            [button("Assignee", f"/tasks patch --id {args.id} --field assignee")],
        ],
        [
            f"/tasks patch --id {args.id} --field status",
            f"/tasks patch --id {args.id} --field priority",
            f"/tasks patch --id {args.id} --field blocked",
            f"/tasks patch --id {args.id} --field ready",
            f"/tasks patch --id {args.id} --field assignee",
        ],
    )


def cmd_patch_values(args: argparse.Namespace) -> None:
    field = args.field
    task_id = args.id
    if field == "status":
        buttons = [[button("Todo", f"/tasks patch --id {task_id} --status todo"), button("Doing", f"/tasks patch --id {task_id} --status doing")], [button("Done", f"/tasks patch --id {task_id} --status done")]]
        fallback = [f"/tasks patch --id {task_id} --status todo", f"/tasks patch --id {task_id} --status doing", f"/tasks patch --id {task_id} --status done"]
    elif field == "priority":
        buttons = [[button("Low", f"/tasks patch --id {task_id} --priority low"), button("Medium", f"/tasks patch --id {task_id} --priority medium")], [button("High", f"/tasks patch --id {task_id} --priority high")]]
        fallback = [f"/tasks patch --id {task_id} --priority low", f"/tasks patch --id {task_id} --priority medium", f"/tasks patch --id {task_id} --priority high"]
    elif field == "blocked":
        buttons = [[button("Blocked", f"/tasks patch --id {task_id} --blocked true", "danger"), button("Unblocked", f"/tasks patch --id {task_id} --blocked false", "success")]]
        fallback = [f"/tasks patch --id {task_id} --blocked true", f"/tasks patch --id {task_id} --blocked false"]
    elif field == "ready":
        buttons = [[button("Ready", f"/tasks patch --id {task_id} --ready true", "success"), button("Not ready", f"/tasks patch --id {task_id} --ready false")]]
        fallback = [f"/tasks patch --id {task_id} --ready true", f"/tasks patch --id {task_id} --ready false"]
    elif field == "assignee":
        buttons = [[button("Rowan", f"/tasks patch --id {task_id} --assignee Rowan"), button("Unassigned", f"/tasks patch --id {task_id} --assignee ''")]]
        fallback = [f"/tasks patch --id {task_id} --assignee Rowan", f"/tasks patch --id {task_id} --assignee ''"]
    else:
        raise SystemExit(f"Unsupported field: {field}")
    print_payload(f"Pick a new {field} value.", buttons, fallback)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    entry = sub.add_parser("entry")
    entry.set_defaults(func=cmd_entry)

    list_filters = sub.add_parser("list-filters")
    list_filters.set_defaults(func=cmd_list_filters)

    patch_tasks = sub.add_parser("patch-tasks")
    patch_tasks.add_argument("--limit", type=int, default=DEFAULT_PATCH_LIMIT)
    patch_tasks.add_argument("--status")
    patch_tasks.set_defaults(func=cmd_patch_tasks)

    patch_fields = sub.add_parser("patch-fields")
    patch_fields.add_argument("--id", required=True)
    patch_fields.set_defaults(func=cmd_patch_fields)

    patch_values = sub.add_parser("patch-values")
    patch_values.add_argument("--id", required=True)
    patch_values.add_argument("--field", required=True, choices=["status", "priority", "blocked", "ready", "assignee"])
    patch_values.set_defaults(func=cmd_patch_values)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
