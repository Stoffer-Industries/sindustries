#!/usr/bin/env python3
"""List bookmarks needing spec work for Quinn's heartbeat dispatch.

Covers two cases:
- spec_requested: fresh spec needed, no existing spec on disk
- revision_requested: existing spec needs revision per latestRevisionRequest
"""
from __future__ import annotations

import sys
from pathlib import Path

from common import (
    STATE_PATH,
    WORKSPACE,
    dump_json,
    get_approval_topic,
    load_state,
)

TASKS_CLIENT_DIRS = [
    WORKSPACE / "codebases" / "sindustries" / "agents" / "skills" / "tasks-api-ops",
    Path(__file__).resolve().parents[2] / "skills" / "tasks-api-ops",
]
for tasks_client_dir in TASKS_CLIENT_DIRS:
    if tasks_client_dir.exists() and str(tasks_client_dir) not in sys.path:
        sys.path.insert(0, str(tasks_client_dir))
        break

try:
    from tasks_api_client import get_base_url, get_task  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001
    get_base_url = None
    get_task = None

APPROVED_STATUSES = {"approved", "approval_resolved"}
REQUEST_STATUSES = {"spec_requested", "revision_requested"}


def _active_task(task_id: str, base_url: str) -> bool:
    if get_task is None:
        return False
    try:
        task = get_task(task_id, base_url=base_url)
    except Exception as exc:  # noqa: BLE001
        print(f"[list_spec_requests] could not resolve task {task_id}: {exc}", file=sys.stderr)
        return False
    if not task:
        return False
    return not (task.get("archivedAt") or task.get("completedAt") or task.get("status") == "done")


def _already_tasked(item: dict, base_url: str | None) -> bool:
    if item.get("approvalStatus") not in APPROVED_STATUSES:
        return False
    task_ids = [str(task_id).strip() for task_id in item.get("taskIds") or [] if str(task_id).strip()]
    if not task_ids or not base_url:
        return False
    return all(_active_task(task_id, base_url) for task_id in task_ids)


def _request_payload(key: str, item: dict, status: str) -> dict | None:
    if status == "spec_requested":
        return {
            "bookmarkKey": key,
            "title": item.get("title", ""),
            "topic": get_approval_topic(item),
            "path": item.get("path", ""),
            "reviewDoc": item.get("reviewDoc", ""),
            "curation": item.get("curation"),
            "link": item.get("link", ""),
            "tags": item.get("tags", []),
            "requestType": "new",
            "existingSpecDocs": [],
            "revisionRequest": None,
        }
    if status == "revision_requested":
        revision_text = str(item.get("latestRevisionRequest") or "").strip()
        if not revision_text:
            return None
        return {
            "bookmarkKey": key,
            "title": item.get("title", ""),
            "topic": get_approval_topic(item),
            "path": item.get("path", ""),
            "reviewDoc": item.get("reviewDoc", ""),
            "curation": item.get("curation"),
            "link": item.get("link", ""),
            "tags": item.get("tags", []),
            "requestType": "revision",
            "existingSpecDocs": item.get("specDocs") or [],
            "revisionRequest": revision_text,
        }
    return None


def main() -> int:
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})
    requests = []
    base_url = None
    if get_base_url is not None:
        try:
            base_url = get_base_url()
        except BaseException as exc:  # noqa: BLE001
            print(f"[list_spec_requests] Tasks API unavailable; skip-tasked guard disabled: {exc}", file=sys.stderr)
    for key, item in items.items():
        status = item.get("reviewStatus")
        # Human-gated states such as needs_research are intentionally excluded.
        if status not in REQUEST_STATUSES:
            continue
        request = _request_payload(key, item, status)
        if request is None:
            continue
        if _already_tasked(item, base_url):
            continue
        requests.append(request)
    dump_json({"ok": True, "specRequests": requests, "count": len(requests)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
