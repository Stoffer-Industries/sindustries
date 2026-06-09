#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, now_iso


def build_proposals(item: dict, state_items: dict) -> list[dict]:
    state_item = state_items.get(item.get("bookmarkKey"), {})
    proposals = []
    for spec in item.get("specProposals") or state_item.get("specProposals") or []:
        proposals.extend(spec.get("proposedTasks") or [])
    return proposals


def approval_recoverable_items(state_items: dict, seen_keys: set[str]) -> list[dict]:
    recovered = []
    for bookmark_key, item in state_items.items():
        if bookmark_key in seen_keys:
            continue
        if item.get("reviewStatus") != "spec_created":
            continue
        if item.get("approvalStatus") == "declined":
            continue
        if item.get("taskIds"):
            continue
        if not (item.get("specProposals") or []):
            continue
        recovered.append({
            "bookmarkKey": bookmark_key,
            "path": item.get("path"),
            "topic": item.get("topic"),
            "title": item.get("title"),
            "reviewStatus": "queued_for_spec",
            "reviewDoc": item.get("reviewDoc"),
            "analysis": item.get("analysis") or {},
            "specDocs": item.get("specDocs") or [],
            "specProposals": item.get("specProposals") or [],
            "recoveredForApproval": True,
        })
    return recovered


def main() -> int:
    data = json.load(__import__("sys").stdin)
    implement = data.get("implement", [])
    state = load_state(Path(STATE_PATH))
    state_items = state.get("items", {})
    seen_keys = {item.get("bookmarkKey") for item in implement if item.get("bookmarkKey")}
    recovered = approval_recoverable_items(state_items, seen_keys)

    proposals = []
    for item in [*implement, *recovered]:
        proposals.append({**item, "proposedTasks": build_proposals(item, state_items)})
    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "implement": proposals,
        "monitoring": data.get("monitoring", []),
        "reviewed": data.get("reviewed", []),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
