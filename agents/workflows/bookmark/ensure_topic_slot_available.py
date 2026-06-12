#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, now_iso, get_approval_topic


def main() -> int:
    data = json.load(__import__("sys").stdin)
    packages = data.get("readyPackages")
    if packages is None:
        packages = data.get("packages", [])
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    approval_pending_topics = {
        str(get_approval_topic(v))
        for v in items.values()
        if v.get("reviewStatus") in {"approval_pending", "revision_staged"}
    }

    ready = []
    blocked = []
    for package in packages:
        topic = package.get("approvalTopic") or package.get("topic") or "general"
        if topic in approval_pending_topics:
            blocked.append({**package, "blockedReason": "approval already pending for topic"})
        else:
            ready.append(package)

    inherited_blocked = data.get("blockedPackages", [])
    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "readyPackages": ready,
        "blockedPackages": [*inherited_blocked, *blocked],
        "pendingTopics": sorted(approval_pending_topics),
        "monitoring": data.get("monitoring", []),
        "reviewed": data.get("reviewed", []),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
