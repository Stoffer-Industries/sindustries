#!/usr/bin/env python3
from __future__ import annotations

import json
import sys

from common import WORKSPACE

# Only these fields are needed from each item. Everything else (summary,
# whyItMatters, reviewDoc, specProposals, etc.) is hydrated from the state
# file by request_topic_approval.py. proposedTasks is kept as title-only
# stubs so the package-level task-count guard in request_topic_approval.py
# still works (it checks len > 0). Full task descriptions are NOT needed
# here — task creation reads from the pipeline step directly.
# Keeping the payload well under lobster's 2000-char preview cap is the goal.
_ITEM_KEEP = {"bookmarkKey", "specDocs", "topic", "approvalTopic", "title"}

# Only these fields are needed at the package level.
_PACKAGE_KEEP = {"approvalTopic", "topic", "resumeToken", "lobsterResumeToken"}


def _compact_task(task: dict) -> dict:
    """Keep only the task title — enough for the approval message and count guard."""
    title = task.get("title")
    return {"title": title} if title else {}


def _compact_item(item: dict) -> dict:
    result = {k: v for k, v in item.items() if k in _ITEM_KEEP and v is not None}
    tasks = [_compact_task(t) for t in (item.get("proposedTasks") or []) if t.get("title")]
    if tasks:
        result["proposedTasks"] = tasks
    return result


def main() -> int:
    data = json.load(sys.stdin)
    ready = []
    blocked = []
    for package in data.get("readyPackages", []):
        items_with_specs = []
        items_missing_specs = []
        for item in package.get("items", []):
            spec_docs = item.get("specDocs") or []
            # Validate spec docs actually exist on disk before accepting this item.
            missing = [doc for doc in spec_docs if not (WORKSPACE / doc).exists()]
            if missing:
                items_missing_specs.append({
                    **_compact_item(item),
                    "missingSpecDocs": missing,
                })
            else:
                items_with_specs.append(_compact_item(item))
        if items_missing_specs:
            base = {k: v for k, v in package.items() if k in _PACKAGE_KEEP}
            blocked.append({
                **base,
                "items": items_missing_specs,
                "reason": "spec docs missing on disk — cannot propose for approval",
            })
        if items_with_specs:
            base = {k: v for k, v in package.items() if k in _PACKAGE_KEEP}
            ready.append({**base, "items": items_with_specs})
    json.dump({"readyPackages": ready, "blockedPackages": blocked}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
