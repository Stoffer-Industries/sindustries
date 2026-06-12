#!/usr/bin/env python3
"""
Route summarized items to implement / monitoring / reviewed buckets for the
lobster pipeline. Pure state-machine routing — no LLM, no classification.

Inputs:
  - stdin: JSON from summarize.py with a `summaries` array (each entry has
    at least bookmarkKey; reviewStatus comes from state, not the summary)
  - state: brain/state/bookmark-review-state.json

Routing rules:
  - implement:
      - reviewStatus in {queued_for_spec, spec_created}  → actionable work exists
      - reviewStatus in {revision_requested} + has spec work → heartbeat handles, but
        also surfaceable here so we don't lose visibility
      - has specProposals but no taskIds → recovery: spec exists but never became tasks
  - monitoring:
      - reviewStatus == monitoring
  - reviewed:
      - everything else (summarized, tasked, declined, approval_pending,
        revision_staged, None, ...)

This is a router, not a scorer. The "is this even worth building" signal is
the curate step (heartbeat, LLM-driven), not this script.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import STATE_PATH, dump_json, load_state, now_iso

# Statuses that mean "actionable implementation work exists in some form"
IMPLEMENT_STATUSES = {"queued_for_spec", "spec_created", "revision_requested"}
# Statuses that are terminal for the lobster pipeline (heartbeat will revisit
# if needed, but the lobster run shouldn't touch them again)
TERMINAL_STATUSES = {
    "tasked",
    "declined",
    "approval_pending",
    "revision_staged",
}


def route(item: dict[str, Any], state_item: dict[str, Any]) -> str:
    status = item.get("reviewStatus") or state_item.get("reviewStatus")
    if status in IMPLEMENT_STATUSES:
        return "implement"
    # Recovery: spec work exists but never became tasks, and the item is not
    # already in a terminal state (declined, tasked, approval_pending,
    # revision_staged — those belong in reviewed, the pipeline must not
    # re-implement something Tom said no to or that's already in flight).
    has_unmaterialized_spec_work = bool(
        state_item.get("specProposals")
    ) and not state_item.get("taskIds")
    if has_unmaterialized_spec_work and status not in TERMINAL_STATUSES:
        return "implement"
    if status == "monitoring":
        return "monitoring"
    return "reviewed"


def main() -> int:
    data = json.load(__import__("sys").stdin)
    summaries = data.get("summaries") or data.get("reviews", [])
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    buckets: dict[str, list[dict[str, Any]]] = {
        "implement": [],
        "monitoring": [],
        "reviewed": [],
    }
    for item in summaries:
        bookmark_key = item.get("bookmarkKey")
        if not bookmark_key:
            continue
        state_item = items.get(bookmark_key, {})
        bucket = route(item, state_item)
        buckets[bucket].append(item)

    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "implement": buckets["implement"],
        "monitoring": buckets["monitoring"],
        "reviewed": buckets["reviewed"],
        "statePath": str(STATE_PATH),
        "stateCount": len(items),
    }
    dump_json(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
