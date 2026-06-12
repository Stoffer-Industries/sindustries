#!/usr/bin/env python3
"""
Route items to implement / monitoring / reviewed buckets for the lobster
pipeline. Pure verdict-reading — no freshness check, no LLM, no classification.

A "curation" is the living take on each summary, written by the heartbeat.
This script reads the latest curation and decides where the item goes in
the pipeline. Freshness is the heartbeat's concern, not ours — if the
curation is stale, the heartbeat will refresh it; this script trusts
the verdict on disk.

Inputs:
  - stdin: JSON from summarize.py with a `summaries` array (each entry has
    at least bookmarkKey; everything else comes from state)
  - state: brain/state/bookmark-review-state.json

Routing rules:
  - reviewed:
      - reviewStatus in {tasked, declined, approval_pending,
        revision_staged, revision_requested}  → terminal, no action
  - implement:
      - reviewStatus == spec_created  → spec exists, awaiting approval
      - has specProposals and not taskIds and not in terminal state
        → recovery: spec exists but never became tasks
      - has curation AND curation.score >= threshold
        → curator said "act on this", request a spec
  - monitoring:
      - no curation  → heartbeat will create one on its next pass
      - has curation AND score < threshold
        → curator said "not now", respect the verdict
  - everything else (unusual state) → reviewed
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    dump_json,
    load_state,
    now_iso,
)

DEFAULT_THRESHOLD = 7

TERMINAL_STATUSES = {
    "tasked",
    "declined",
    "approval_pending",
    "revision_staged",
    "revision_requested",
}


def route(item: dict[str, Any], state_item: dict[str, Any]) -> str:
    """Decide which bucket this item falls into. Pure function, no I/O.

    Order of checks matters:
      1. Terminal status wins (even with high-score curation).
      2. spec_created wins (curation ignored — spec already exists).
      3. Recovery branch (specProposals + no taskIds + not terminal).
      4. Curation verdict: high score → implement, low score → monitoring.
      5. No curation → monitoring (heartbeat will create one).
    """
    status = item.get("reviewStatus") or state_item.get("reviewStatus")

    # 1. Terminal: skip regardless of curation
    if status in TERMINAL_STATUSES:
        return "reviewed"

    # 2. Spec already exists and is awaiting approval
    if status == "spec_created":
        return "implement"

    # 3. Recovery: spec work exists but never became tasks.
    #    Handled before curation check so a low-score curation doesn't shadow it.
    has_unmaterialized_spec_work = bool(
        state_item.get("specProposals")
    ) and not state_item.get("taskIds")
    if has_unmaterialized_spec_work:
        return "implement"

    # 4 & 5. Read the curation verdict.
    curation = state_item.get("curation")
    if not curation:
        return "monitoring"

    threshold = float(curation.get("threshold") or DEFAULT_THRESHOLD)
    if float(curation.get("score") or 0) >= threshold:
        return "implement"
    return "monitoring"


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
