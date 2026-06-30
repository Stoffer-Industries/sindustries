#!/usr/bin/env python3
"""Minimal Tasks API client for workspace automations.

Usage examples:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py list --limit 50
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py create --title "Test" --priority high
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py patch --id <task-id> --status doing
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py patch --id <task-id> --depends-on <dependency-id>
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py archive --id <task-id>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request


def api_request(method: str, base_url: str, path: str, payload=None):
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    headers = {"content-type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except Exception as e:  # noqa: BLE001
        print(f"API {method} {path} failed: {e}", file=sys.stderr)
        raise


def get_base_url() -> str:
    base = (os.getenv("TASKS_API_BASE_URL") or "").strip()
    if not base:
        raise SystemExit("TASKS_API_BASE_URL is required")
    return base


def get_task(task_id: str, base_url: str | None = None) -> dict:
    """Fetch a single task by ID. Returns task dict; unwraps API 'data'."""
    base = base_url or get_base_url()
    resp = api_request("GET", base, f"/tasks/{task_id}")
    if isinstance(resp, dict) and "data" in resp:
        return resp["data"]
    return resp if isinstance(resp, dict) else {}


def list_tasks(
    limit: int = 20,
    status: str | None = None,
    assignee: str | None = None,
    blocked: bool | None = None,
    ready: bool | None = None,
    priority: str | None = None,
    q: str | None = None,
    base_url: str | None = None,
    **extra_params,
) -> list:
    """List tasks with optional filters. Returns list of task dicts."""
    base = base_url or get_base_url()
    params = {"limit": str(limit)}
    if status is not None:
        params["status"] = status
    if assignee is not None:
        params["assignee"] = assignee
    if blocked is not None:
        params["blocked"] = "true" if blocked else "false"
    if ready is not None:
        params["ready"] = "true" if ready else "false"
    if priority is not None:
        params["priority"] = priority
    if q is not None:
        params["q"] = q
    params.update(extra_params)
    path = "/tasks?" + urllib.parse.urlencode(params)
    resp = api_request("GET", base, path)
    if isinstance(resp, dict) and "data" in resp:
        return resp["data"] if isinstance(resp["data"], list) else []
    return []


def cmd_list(args):
    base = get_base_url()
    # Heartbeat view: all Acceptance, Doing, Ready, plus 10 from Open
    if getattr(args, "heartbeat", False):
        tasks = []
        for status in ["acceptance", "doing", "ready"]:
            tasks.extend(list_tasks(limit=args.limit, status=status, base_url=base))
        tasks.extend(list_tasks(limit=10, status="open", base_url=base))
        print(json.dumps({"data": tasks}, indent=2))
        return

    q = {"limit": str(args.limit)}
    if args.status:
        q["status"] = args.status
    if args.priority:
        q["priority"] = args.priority
    if args.q:
        q["q"] = args.q
    if getattr(args, "assignee", None):
        q["assignee"] = args.assignee
    if getattr(args, "blocked", None):
        q["blocked"] = args.blocked
    if getattr(args, "ready", None):
        q["ready"] = args.ready
    path = "/tasks?" + urllib.parse.urlencode(q)
    print(json.dumps(api_request("GET", base, path), indent=2))


def cmd_create(args):
    base = get_base_url()
    payload = {
        "title": args.title,
        "priority": args.priority,
        "status": args.status,
    }
    if args.description is not None:
        payload["description"] = args.description
    if args.tags:
        payload["tags"] = args.tags
    if getattr(args, "type", None) is not None:
        payload["taskType"] = args.type
    print(json.dumps(api_request("POST", base, "/tasks", payload), indent=2))


def cmd_patch(args):
    base = get_base_url()
    payload = {}
    if args.depends_on is not None and args.clear_dependencies:
        raise SystemExit("--depends-on and --clear-dependencies are mutually exclusive")

    # Support --field as a shortcut for picking field + value in one go
    # This enables telegram button flows like: /tasks patch --id <id> --field status
    if args.field:
        field = args.field
        value = getattr(args, field, None)
        if value is None:
            raise SystemExit(f"--field {field} requires --{field} value")
        if field in ["blocked", "ready"]:
            payload[field] = value == "true"
        else:
            payload[field] = value
    else:
        # Original behavior: explicit field flags
        for key in ["title", "priority", "status", "assignee"]:
            value = getattr(args, key)
            if value is not None:
                payload[key] = value

        # Handle blocked/ready: convert string "true"/"false" to boolean
        for key in ["blocked", "ready"]:
            value = getattr(args, key)
            if value is not None:
                payload[key] = value == "true"
    if args.tags is not None:
        payload["tags"] = args.tags
    if args.depends_on is not None:
        payload["dependsOnIds"] = args.depends_on
    if args.clear_dependencies:
        payload["dependsOnIds"] = []

    # Handle description: replace, not concatenate. The Tasks API supports
    # partial-PATCH and stores whatever description string it receives;
    # previously this branch concatenated the new value onto the existing one,
    # which caused repeated patches to multiply the description content.
    if args.description is not None:
        payload["description"] = args.description

    print(json.dumps(api_request("PATCH", base, f"/tasks/{args.id}", payload), indent=2))


def cmd_archive(args):
    base = get_base_url()
    print(json.dumps(api_request("DELETE", base, f"/tasks/{args.id}"), indent=2))


def cmd_get(args):
    base = get_base_url()
    task = get_task(args.id, base_url=base)
    print(json.dumps(task, indent=2))


def build_parser():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("get")
    g.add_argument("--id", required=True, dest="id", help="Task ID")
    g.set_defaults(func=cmd_get)

    l = sub.add_parser("list")
    l.add_argument("--limit", type=int, default=20)
    l.add_argument("--status")
    l.add_argument("--priority")
    l.add_argument("--q")
    l.add_argument("--assignee")
    l.add_argument("--blocked", choices=["true", "false"])
    l.add_argument("--ready", choices=["true", "false"])
    l.add_argument("--heartbeat", action="store_true", help="Return heartbeat view: Acceptance, Doing, Ready, and 10 from Todo")
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("create")
    c.add_argument("--title", required=True)
    c.add_argument("--description")
    c.add_argument("--status", default="open")
    c.add_argument("--priority", default="medium")
    c.add_argument("--tags", nargs="*")
    c.add_argument("--type")
    c.set_defaults(func=cmd_create)

    u = sub.add_parser("patch")
    u.add_argument("--id", required=True)
    u.add_argument("--field", choices=["status", "priority", "blocked", "ready", "assignee", "title", "description", "tags"])
    u.add_argument("--title")
    u.add_argument("--description")
    u.add_argument("--status")
    u.add_argument("--priority")
    u.add_argument("--assignee")
    u.add_argument("--tags", nargs="*")
    u.add_argument("--depends-on", nargs="+", dest="depends_on", help="Replace task dependencies with these task IDs")
    u.add_argument("--clear-dependencies", action="store_true", help="Clear all task dependencies")
    u.add_argument("--blocked", choices=["true", "false"])
    u.add_argument("--ready", choices=["true", "false"])
    u.set_defaults(func=cmd_patch)

    a = sub.add_parser("archive")
    a.add_argument("--id", required=True)
    a.set_defaults(func=cmd_archive)

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
