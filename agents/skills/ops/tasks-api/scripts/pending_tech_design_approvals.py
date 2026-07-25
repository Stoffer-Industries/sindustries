#!/usr/bin/env python3
"""List feature and code tasks that have a [tech-design] comment but no
proper [tech-design-approved] true comment, so Quinn can review them
during heartbeat and post approvals on Tom's behalf.

Mirrors the lobster's parser in agents/workflows/feature-task/src/main.rs
(`tagged_values` + `tech_design_approved`):

  - [tech-design] tag: any comment whose TRIMMED TEXT STARTS WITH the tag
    contributes the rest (after the tag, trimmed). First non-empty value
    wins.
  - [tech-design-approved] tag: same prefix rule; a comment counts as
    approval only if the first whitespace-separated token after the tag
    is "true" (case-insensitive). Rationale text after "true" is allowed
    and ignored.

This is the parser heartbeat should use. The previous ad-hoc substring
check (`'[tech-design-approved]' in comment_text`) was a false positive
on the lobster's own progress-checklist complaints
(`Missing task comment [tech-design-approved] true`).

Usage:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 \\
    python3 agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py \\
    --status ready --status doing --status acceptance
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL_ENV = "TASKS_API_BASE_URL"
DEFAULT_PAGE_SIZE = 100


def api_request(method: str, base_url: str, path: str, payload=None) -> dict:
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
    base = (os.getenv(DEFAULT_BASE_URL_ENV) or "").strip()
    if not base:
        raise SystemExit(f"{DEFAULT_BASE_URL_ENV} is required")
    return base


def needs_tech_design_review(task: dict) -> bool:
    """Feature and code tasks both go through a [tech-design]/[tech-design-approved]
    gate (see agents/workflows/feature-task/src/main.rs ready_checks and
    code_task_ready_checks). Code tasks were previously excluded here, which let
    approved-but-unreviewed code-task designs sit unapproved indefinitely."""
    if task.get("taskType") in ("feature", "code"):
        return True
    tags = task.get("tags") or []
    return any(t == "feature-factory" for t in tags)


def tagged_values(comments: list[dict], tag: str) -> list[str]:
    """Mirror agents/workflows/feature-task/src/main.rs tagged_values.

    Comment text is trimmed; if it STARTS WITH `tag`, the rest (trimmed) is
    returned. Substring matches that are not at the start are ignored — this
    is what skips the lobster's `Missing task comment [tech-design-approved]`
    checklist complaints.
    """
    out: list[str] = []
    for comment in comments:
        text = (comment.get("text") or "").strip()
        if not text:
            continue
        if text.startswith(tag):
            out.append(text[len(tag):].strip())
    return out


def tech_design_url(task: dict) -> str | None:
    for value in tagged_values(task.get("comments") or [], "[tech-design]"):
        if value:
            return value
    return None


def tech_design_approved(task: dict) -> bool:
    """Mirror agents/workflows/feature-task/src/main.rs tech_design_approved."""
    for value in tagged_values(task.get("comments") or [], "[tech-design-approved]"):
        token = value.strip().split(maxsplit=1)[0] if value.strip() else ""
        if token.lower() == "true":
            return True
    return False


def list_tasks(base_url: str, statuses: list[str]) -> list[dict]:
    """Fetch all non-archived tasks, paginated via the API's nextCursor.

    The list endpoint returns `{ data: [...], page: { nextCursor, hasNextPage } }`.
    `includeArchived=false` excludes archived tasks. Multi-status filtering
    isn't supported server-side, so we filter client-side.
    """
    status_filter = set(statuses) if statuses else None
    out: list[dict] = []
    cursor: str | None = None
    while True:
        params: list[tuple[str, str]] = [
            ("includeArchived", "false"),
            ("limit", str(DEFAULT_PAGE_SIZE)),
        ]
        if cursor:
            params.append(("cursor", cursor))
        path = "/tasks?" + urllib.parse.urlencode(params)
        response = api_request("GET", base_url, path)
        page = response.get("data") or []
        out.extend(page)
        page_meta = response.get("page") or {}
        if not page_meta.get("hasNextPage"):
            break
        cursor = page_meta.get("nextCursor")
        if not cursor:
            break

    if status_filter is not None:
        out = [t for t in out if (t.get("status") or "") in status_filter]
    return out


def fetch_task_detail(base_url: str, task_id: str) -> dict:
    """GET /tasks/:id has comments included; GET /tasks (list) does not.

    services/tasks-api/src/routes/tasks.ts only adds `include: { comments }`
    on the single-task route, so tagged_values() on a list-endpoint task
    always sees an empty comments array. Any tech-design-approval check must
    hydrate comments per task via this endpoint before evaluating tags.
    """
    response = api_request("GET", base_url, f"/tasks/{task_id}")
    return response.get("data") or {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--status",
        action="append",
        default=None,
        help="Filter to tasks with this status. May be passed multiple times. "
        "Default: no status filter (only the is_feature_task filter applies).",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help=f"Override ${DEFAULT_BASE_URL_ENV}.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of a human summary.",
    )
    args = parser.parse_args()

    base = (args.base_url or get_base_url()).rstrip("/")
    statuses = args.status or []

    candidates = [t for t in list_tasks(base, statuses) if needs_tech_design_review(t)]
    tasks = [fetch_task_detail(base, t["id"]) for t in candidates]
    pending = []
    for task in tasks:
        url = tech_design_url(task)
        if not url:
            continue
        if tech_design_approved(task):
            continue
        pending.append(
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "status": task.get("status"),
                "assignee": task.get("assignee"),
                "techDesignUrl": url,
            }
        )

    if args.json:
        json.dump({"pendingApprovals": pending, "count": len(pending)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    if not pending:
        print(f"No feature/code tasks pending tech-design approval ({len(tasks)} checked).")
        return 0

    print(f"{len(pending)} feature/code task(s) pending tech-design approval:")
    for item in pending:
        print(f"  - [{item['status']:11s}] {item['id'][:8]}  {item['title'][:60]}")
        print(f"      design: {item['techDesignUrl']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
