#!/usr/bin/env python3
"""
Route items to implement / monitoring / reviewed buckets for the lobster
pipeline. Pure state-machine filtering — no LLM, no classification.

A "curation" is the living take on each summary, written by the heartbeat.
This script reads the latest curation and decides where the item goes in
the pipeline. The verdict lives in the curation, not the status.

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
      - reviewStatus == spec_requested  → already requested, skip
        (actually this should never come in here; it stays in spec_requested
        until the heartbeat writes the spec and transitions to spec_created)
      - has specProposals and not taskIds and not in terminal state
        → recovery: spec exists but never became tasks
      - has FRESH curation AND score >= threshold
        → request a spec
  - monitoring:
      - has FRESH curation AND score < threshold
        → curator said "not now", respect the verdict
      - has NO curation OR curation is STALE
        → heartbeat will refresh; lobster has nothing to act on
  - everything else (no summary, or unusual state) → reviewed

A curation is "fresh" if (now - curation.createdAt) <= recurationDays.
The recurationDays default comes from the focus config; we read it from
state-of-the-world so the freshness window stays in sync with the heartbeat.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from common import (
    FOCUS_CONFIG_PATH,
    STATE_PATH,
    dump_json,
    load_state,
    now_iso,
)

DEFAULT_RECURATION_DAYS = 14
DEFAULT_THRESHOLD = 7

TERMINAL_STATUSES = {
    "tasked",
    "declined",
    "approval_pending",
    "revision_staged",
    "revision_requested",
}


def _load_focus_config() -> dict[str, Any]:
    if FOCUS_CONFIG_PATH.exists():
        try:
            return json.loads(FOCUS_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def curation_age_days(curation: dict[str, Any] | None) -> float | None:
    if not curation:
        return None
    last = curation.get("createdAt")
    if not last:
        return None
    try:
        last_dt = dt.datetime.fromisoformat(last)
        return (dt.datetime.now(dt.timezone.utc) - last_dt).total_seconds() / 86400
    except Exception:
        return None


def route(item: dict[str, Any], state_item: dict[str, Any], *, recuration_days: int) -> str:
    status = item.get("reviewStatus") or state_item.get("reviewStatus")

    # Terminal: skip regardless of curation
    if status in TERMINAL_STATUSES:
        return "reviewed"

    # Spec already exists and is awaiting approval → implement
    if status == "spec_created":
        return "implement"

    # Recovery: spec work exists but never became tasks → implement
    # (handled before curation check so a stale curation doesn't shadow it)
    has_unmaterialized_spec_work = bool(
        state_item.get("specProposals")
    ) and not state_item.get("taskIds")
    if has_unmaterialized_spec_work:
        return "implement"

    # Read the curation verdict
    curation = state_item.get("curation")
    age_days = curation_age_days(curation)

    # No curation or stale curation → heartbeat will refresh
    if not curation or age_days is None or age_days > recuration_days:
        return "monitoring"

    # Fresh curation with high score → request a spec
    threshold = float(curation.get("threshold") or DEFAULT_THRESHOLD)
    if float(curation.get("score") or 0) >= threshold:
        return "implement"

    # Fresh curation with low score → respect the verdict, don't act
    return "monitoring"


def main() -> int:
    data = json.load(__import__("sys").stdin)
    summaries = data.get("summaries") or data.get("reviews", [])
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    config = _load_focus_config()
    recuration_days = int(config.get("recurationDays", DEFAULT_RECURATION_DAYS))

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
        bucket = route(item, state_item, recuration_days=recuration_days)
        buckets[bucket].append(item)

    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "implement": buckets["implement"],
        "monitoring": buckets["monitoring"],
        "reviewed": buckets["reviewed"],
        "statePath": str(STATE_PATH),
        "stateCount": len(items),
        "config": {"recurationDays": recuration_days},
    }
    dump_json(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
