#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, log_transition, now_iso, save_state, transition_log_path, get_approval_topic


def update_item(state_items: dict, bookmark_key: str, reason: str, state_path: Path, **fields: object) -> bool:
    item = state_items.get(bookmark_key)
    if not item:
        return False
    previous_status = item.get("reviewStatus")
    item.update(fields)
    item["lastUpdatedAt"] = now_iso()
    state_items[bookmark_key] = item
    log_transition(
        bookmark_key,
        previous_status,
        item.get("reviewStatus"),
        reason,
        transitions_path=transition_log_path(state_path),
    )
    return True


def main() -> int:
    data = json.load(__import__("sys").stdin)
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})
    timestamp = now_iso()

    finalized = {
        "reviewed": [],
        "monitoring": [],
        "queued": [],
    }

    for review in data.get("reviewed", []):
        bookmark_key = review.get("bookmarkKey")
        if bookmark_key and update_item(
            items,
            bookmark_key,
            "finalized reviewed item",
            Path(STATE_PATH),
            reviewStatus="reviewed",
        ):
            finalized["reviewed"].append(bookmark_key)

    for review in data.get("monitoring", []):
        bookmark_key = review.get("bookmarkKey")
        if bookmark_key and update_item(
            items,
            bookmark_key,
            "finalized monitoring item",
            Path(STATE_PATH),
            reviewStatus="monitoring",
        ):
            finalized["monitoring"].append(bookmark_key)

    for package in data.get("blockedPackages", []):
        topic = package.get("approvalTopic") or package.get("topic") or "general"
        reason = package.get("reason") or package.get("blockedReason") or "approval already pending for topic"
        for summary in package.get("items", []):
            bookmark_key = summary.get("bookmarkKey")
            if not bookmark_key:
                continue
            if update_item(
                items,
                bookmark_key,
                f"queued because approval blocked: {reason}",
                Path(STATE_PATH),
                reviewStatus="spec_created",

            ):
                finalized["queued"].append(bookmark_key)

    save_state(state, Path(STATE_PATH))
    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "finalized": finalized,
        "blockedPackages": data.get("blockedPackages", []),
        "approvals": data.get("approvals", []),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
