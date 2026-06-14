#!/usr/bin/env python3
"""List bookmarks needing spec work for Quinn's heartbeat dispatch.

Covers two cases:
- spec_requested: fresh spec needed, no existing spec on disk
- revision_requested: existing spec needs revision per latestRevisionRequest
"""
from __future__ import annotations

from pathlib import Path

from common import STATE_PATH, dump_json, get_approval_topic, load_state


def main() -> int:
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})
    requests = []
    for key, item in items.items():
        status = item.get("reviewStatus")
        # Human-gated states such as needs_research are intentionally excluded.
        if status == "spec_requested":
            requests.append({
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
            })
        elif status == "revision_requested":
            revision_text = str(item.get("latestRevisionRequest") or "").strip()
            if not revision_text:
                continue
            requests.append({
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
            })
    dump_json({"ok": True, "specRequests": requests, "count": len(requests)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
