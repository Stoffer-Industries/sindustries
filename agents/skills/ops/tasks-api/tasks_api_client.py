#!/usr/bin/env python3
"""Minimal Tasks API client for workspace automations.

Usage examples:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py list --limit 50
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py create --title "Test" --priority high
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py patch --id <task-id> --status doing
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py approve --id <task-id> --type tech_design
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py revoke-approval --id <task-id> --type tech_design
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/tasks_api_client.py archive --id <task-id>
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request


def api_request(method: str, base_url: str, path: str, payload=None):
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    headers = {"content-type": "application/json"}
    service_token = (os.getenv("TASKS_API_APPROVAL_TOKEN") or "").strip()
    if service_token:
        headers["authorization"] = f"Bearer {service_token}"
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
    status: str | list[str] | None = None,
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
    # If multiple statuses requested, fan out one call per status and merge.
    if isinstance(status, list):
        results = []
        for s in status:
            results.extend(list_tasks(limit=limit, status=s, assignee=assignee,
                                       blocked=blocked, ready=ready, priority=priority,
                                       q=q, base_url=base_url, **extra_params))
        return results
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


def _blocking_comment(task: dict) -> str | None:
    """Return the text of the latest [feature-task-progress-checklist] comment, if any."""
    for comment in reversed(task.get("comments") or []):
        text = comment.get("text") or comment.get("body") or ""
        if "[feature-task-progress-checklist]" in text:
            # Return just the failure lines, not the tag itself
            lines = [l for l in text.splitlines() if l.strip() and "[feature-task-progress-checklist]" not in l]
            return " | ".join(lines[:3]) if lines else None
    return None


def _fetch_tasks_multi_status(statuses: list[str], base: str, limit: int, extra_q: dict) -> list:
    """Fetch tasks across multiple statuses, one API call per status."""
    seen: set[str] = set()
    result = []
    for status in statuses:
        q = {"limit": str(limit), "status": status, **extra_q}
        path = "/tasks?" + urllib.parse.urlencode(q)
        resp = api_request("GET", base, path)
        for task in (resp.get("data") if isinstance(resp, dict) else []) or []:
            tid = task.get("id", "")
            if tid and tid not in seen:
                seen.add(tid)
                result.append(task)
    return result


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

    extra_q: dict = {}
    if args.priority:
        extra_q["priority"] = args.priority
    if args.q:
        extra_q["q"] = args.q
    if getattr(args, "assignee", None):
        extra_q["assignee"] = args.assignee
    if getattr(args, "blocked", None):
        extra_q["blocked"] = args.blocked
    if getattr(args, "ready", None):
        extra_q["ready"] = args.ready

    statuses: list[str] = args.status or []

    if len(statuses) > 1:
        # Multi-status: group output by status, include blocking comment per task
        groups: dict[str, list] = {}
        for status in statuses:
            q = {"limit": str(args.limit), "status": status, **extra_q}
            path = "/tasks?" + urllib.parse.urlencode(q)
            resp = api_request("GET", base, path)
            groups[status] = (resp.get("data") if isinstance(resp, dict) else []) or []

        if getattr(args, "summary", False):
            for status, tasks in groups.items():
                if not tasks:
                    continue
                print(f"\n=== {status.upper()} ({len(tasks)}) ===")
                for t in tasks:
                    # Fetch full task to get comments (list endpoint omits them)
                    full = get_task(t["id"], base_url=base)
                    blocker = _blocking_comment(full)
                    blocker_str = f"\n    ⛔ {blocker}" if blocker else ""
                    print(f"  [{t.get('id','')[:8]}] {t.get('title','')}{blocker_str}")
        else:
            all_tasks = [t for tasks in groups.values() for t in tasks]
            print(json.dumps({"data": all_tasks}, indent=2))
    elif statuses:
        q = {"limit": str(args.limit), "status": statuses[0], **extra_q}
        path = "/tasks?" + urllib.parse.urlencode(q)
        print(json.dumps(api_request("GET", base, path), indent=2))
    else:
        q = {"limit": str(args.limit), **extra_q}
        path = "/tasks?" + urllib.parse.urlencode(q)
        print(json.dumps(api_request("GET", base, path), indent=2))


def cmd_create(args):
    base = get_base_url()
    payload = {
        "title": args.title,
        "priority": args.priority,
        "status": args.status,
    }
    if getattr(args, "assignee", None):
        payload["assignee"] = args.assignee
    description = args.description or ""
    spec_path = getattr(args, "spec", None)
    workstreams_path = getattr(args, "workstreams", None)

    # If --spec is provided and the description doesn't already have one,
    # prepend the standard '**Spec:** <path>' line so the lobster's
    # ready_checks stage can parse it.
    if spec_path and "**Spec:**" not in description:
        description = f"**Spec:** {spec_path}\n\n{description}"

    # If --workstreams is provided, append the YAML contents as a Workstreams
    # section. Skipped if the description already has one so the caller's
    # explicit content wins.
    if workstreams_path:
        ws_text = pathlib.Path(workstreams_path).read_text().rstrip()
        if "**Workstreams**" not in description:
            if description and not description.endswith("\n\n"):
                description = description.rstrip() + "\n\n"
            description = f"{description}**Workstreams**\n\n{ws_text}\n"

    # Non-fatal warning when the final description has no Spec line. The
    # lobster hard-blocks ready_checks for feature tasks without one, but
    # we don't want to break bug/chore task creation here.
    if "**Spec:**" not in description:
        sys.stderr.write(
            "warning: task description has no '**Spec:**' line; lobster will "
            "block ready_checks for feature tasks until you add one (use "
            "--spec to set it automatically).\n"
        )

    if description:
        payload["description"] = description
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


def cmd_approve(args):
    base = get_base_url()
    payload = {"type": args.type}
    if args.note is not None:
        payload["note"] = args.note
    print(json.dumps(api_request("POST", base, f"/tasks/{args.id}/approvals", payload), indent=2))


def cmd_revoke_approval(args):
    base = get_base_url()
    print(json.dumps(api_request("DELETE", base, f"/tasks/{args.id}/approvals/{args.type}"), indent=2))


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

    g = sub.add_parser("get", help="Fetch one task with full details including comments")
    g.add_argument("--id", required=True, dest="id", help="Full task UUID")
    g.set_defaults(func=cmd_get)

    l = sub.add_parser("list", help="List tasks with optional filters")
    l.add_argument("--limit", type=int, default=20, help="Max results per status (default 20)")
    l.add_argument("--status", action="append", default=[], metavar="STATUS",
                   help="Filter by status; repeat for multiple: --status doing --status ready")
    l.add_argument("--priority", help="Filter by priority: urgent|high|medium|low")
    l.add_argument("--q", help="Free-text search against title/description")
    l.add_argument("--assignee", help="Filter by assignee name e.g. Rowan")
    l.add_argument("--blocked", choices=["true", "false"], help="Filter by blocked flag")
    l.add_argument("--ready", choices=["true", "false"], help="Filter by ready flag")
    l.add_argument("--heartbeat", action="store_true",
                   help="All acceptance/doing/ready tasks + 10 open — useful for agent heartbeat passes")
    l.add_argument("--summary", action="store_true",
                   help="Human-readable grouped output per status with latest blocking comment inline")
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("create", help="Create a new task")
    c.add_argument("--title", required=True, help="Task title")
    c.add_argument("--description", help="Task body (plain text or markdown)")
    c.add_argument("--spec", help="Spec file path — prepended as '**Spec:** <path>' if not already in description")
    c.add_argument("--workstreams", help="YAML file path — appended as **Workstreams** section if missing")
    c.add_argument("--status", default="open", help="Initial status (default: open)")
    c.add_argument("--priority", default="medium", help="Priority: urgent|high|medium|low (default: medium)")
    c.add_argument("--tags", nargs="*", help="Tags to apply")
    c.add_argument("--type", help="Task type: feature|content|code|research. See agents/skills/ops/tasks-create/SKILL.md for selection rules.")
    c.add_argument("--assignee", help="Assignee name e.g. Rowan")
    c.set_defaults(func=cmd_create)

    u = sub.add_parser("patch", help="Update fields on an existing task")
    u.add_argument("--id", required=True, help="Full task UUID")
    u.add_argument("--field", choices=["status", "priority", "blocked", "ready", "assignee", "title", "description", "tags"],
                   help="Single-field shortcut; pair with the matching value flag")
    u.add_argument("--title", help="New title")
    u.add_argument("--description", help="Replace full description (not appended)")
    u.add_argument("--status", help="New status: open|ready|doing|acceptance|done")
    u.add_argument("--priority", help="New priority: urgent|high|medium|low")
    u.add_argument("--assignee", help="New assignee")
    u.add_argument("--tags", nargs="*", help="Replace tags")
    u.add_argument("--depends-on", nargs="+", dest="depends_on", help="Replace dependencies with these task IDs")
    u.add_argument("--clear-dependencies", action="store_true", help="Remove all dependencies")
    u.add_argument("--blocked", choices=["true", "false"], help="Set blocked flag")
    u.add_argument("--ready", choices=["true", "false"], help="Set ready flag")
    u.set_defaults(func=cmd_patch)

    approve = sub.add_parser("approve", help="Grant a structured task approval as the authenticated service actor")
    approve.add_argument("--id", required=True, help="Full task UUID")
    approve.add_argument("--type", required=True, choices=["spec", "tech_design", "qa"])
    approve.add_argument("--note", help="Optional approval rationale")
    approve.set_defaults(func=cmd_approve)

    revoke = sub.add_parser("revoke-approval", help="Revoke a structured task approval as the authenticated service actor")
    revoke.add_argument("--id", required=True, help="Full task UUID")
    revoke.add_argument("--type", required=True, choices=["spec", "tech_design", "qa"])
    revoke.set_defaults(func=cmd_revoke_approval)

    a = sub.add_parser("archive", help="Archive (soft-delete) a task")
    a.add_argument("--id", required=True, help="Full task UUID")
    a.set_defaults(func=cmd_archive)

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
