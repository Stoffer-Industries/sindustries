#!/usr/bin/env python3
"""
List bookmark candidates that need curation.

Pure filter step. Reads state, finds items in `summarized` (never curated)
or `monitoring` (stale — past recurationDays), and outputs a batch with
the full context Quinn needs to score them. Does NOT call the LLM and
does NOT mutate state — that's Quinn's job in the heartbeat prompt.

The heartbeat BOOKMARK CURATION step:
  1. runs this script to get a discrete batch of candidates
  2. reasons about each candidate's relevance against the focus config
  3. writes `brain/state/curate-output.json` with proposed decisions
  4. runs `validate_curate_output.py` to apply the state transitions

Focus config lives in brain/state/focus-config.json:
  {
    "activeTopics": ["brain", "infra"],
    "relevanceThreshold": 7,
    "recurationDays": 14,
    "batchSize": 5
  }
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    WORKSPACE,
    dump_json,
    load_state,
)

FOCUS_CONFIG_PATH = WORKSPACE / "brain" / "state" / "focus-config.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "activeTopics": ["brain", "infra"],
    "relevanceThreshold": 7,
    "recurationDays": 14,
    "batchSize": 5,
}


def load_focus_config() -> dict[str, Any]:
    if FOCUS_CONFIG_PATH.exists():
        try:
            return {**DEFAULT_CONFIG, **json.loads(FOCUS_CONFIG_PATH.read_text(encoding="utf-8"))}
        except Exception:
            pass
    return DEFAULT_CONFIG


def needs_curation(item: dict[str, Any], recuration_days: int) -> bool:
    status = item.get("reviewStatus", "")
    if status == "summarized":
        return True
    if status == "monitoring":
        last = item.get("lastCuratedAt")
        if not last:
            return True
        try:
            last_dt = dt.datetime.fromisoformat(last)
            age = dt.datetime.now(dt.timezone.utc) - last_dt
            return age.days >= recuration_days
        except Exception:
            return True
    return False


def hydrate_candidate(item: dict[str, Any]) -> dict[str, Any]:
    """Strip down to what Quinn needs to score, dropping bulky analysis."""
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "title": item.get("title", ""),
        "topic": item.get("topic", "general"),
        "reviewStatus": item.get("reviewStatus"),
        "lastCuratedAt": item.get("lastCuratedAt"),
        "reviewDoc": item.get("reviewDoc", ""),
        "summary": item.get("summary") or {},
    }


def main() -> int:
    p = argparse.ArgumentParser(
        description="List bookmark candidates that need curation"
    )
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    config = load_focus_config()
    active_topics: list[str] = config.get("activeTopics", DEFAULT_CONFIG["activeTopics"])
    threshold: int = int(config.get("relevanceThreshold", DEFAULT_CONFIG["relevanceThreshold"]))
    recuration_days: int = int(config.get("recurationDays", DEFAULT_CONFIG["recurationDays"]))
    batch_size: int = int(config.get("batchSize", DEFAULT_CONFIG["batchSize"]))

    state = load_state(Path(STATE_PATH))
    items = state["items"]

    candidates = [
        item for item in items.values()
        if needs_curation(item, recuration_days)
    ]
    batch = candidates[:batch_size]

    payload = {
        "ok": True,
        "config": {
            "activeTopics": active_topics,
            "relevanceThreshold": threshold,
            "recurationDays": recuration_days,
            "batchSize": batch_size,
        },
        "count": len(batch),
        "remaining": max(0, len(candidates) - batch_size),
        "batch": [hydrate_candidate(item) for item in batch],
    }
    if args.json:
        dump_json(payload)
    else:
        print(f"{len(batch)} candidates ({payload['remaining']} more pending)")
        for c in batch:
            print(f"  - {c.get('bookmarkKey')}  {c.get('title', '')[:60]}  [{c.get('reviewStatus')}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
