#!/usr/bin/env python3
"""
List bookmark summaries that need a fresh curation.

Pure filter step. A "curation" is the living take on a summary — it lives
in state as `item.curation = { createdAt, topic, score, ... }`. The heartbeat
keeps it fresh by re-curating any summary whose curation is missing or
older than `recurationDays`.

Eligibility (the only signal that matters):
  - item has a `summary`  (and is not a brand-new ingest; summarizer writes
    this and the lobster pipeline is the only writer)
  - item.curation is missing  OR  now - item.curation.createdAt > recurationDays

That's it. The reviewStatus is irrelevant here — a summary with a stale
curation needs a refresh whether it's in flight, monitored, or fresh from
the summarizer. The lobster's filter_curation step will read the latest
curation and decide what to do with the item.

The heartbeat BOOKMARK CURATION step:
  1. runs this script to get a discrete batch of candidates
  2. reasons about each candidate's relevance against the focus config
  3. writes `brain/state/curate-output.json` with proposed curations
  4. runs `validate_curate_output.py` to apply the curations to state

Focus config lives in brain/state/focus-config.json:
  {
    "topics": ["brain", "infra", "crypto", "app-tasks", "app-assistant", "outreach", "design", "personal", "general"],
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
    FOCUS_CONFIG_PATH,
    STATE_PATH,
    WORKSPACE,
    dump_json,
    load_state,
)

DEFAULT_CONFIG: dict[str, Any] = {
    "topics": ["brain", "infra", "crypto", "app-tasks", "app-assistant", "outreach", "design", "personal", "general"],
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
    """True iff the item has been through summarize AND its curation is missing or stale.

    "Has been through summarize" = has a `summary` in state OR a `reviewDoc`
    path on disk. The summary cache in state is optional (summarize writes
    the review doc to disk; the state cache is for fast lookup).
    """
    if not (item.get("summary") or item.get("reviewDoc")):
        return False
    curation = item.get("curation")
    if not curation:
        return True
    last = curation.get("createdAt")
    if not last:
        return True
    try:
        last_dt = dt.datetime.fromisoformat(last)
        age = dt.datetime.now(dt.timezone.utc) - last_dt
        return age.days >= recuration_days
    except Exception:
        # Unparseable timestamp — treat as needs curation so it gets refreshed
        return True


def hydrate_candidate(item: dict[str, Any]) -> dict[str, Any]:
    """Strip down to what Quinn needs to score, dropping bulky analysis."""
    curation = item.get("curation") or {}
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "title": item.get("title", ""),
        "topic": item.get("topic", "general"),
        "reviewStatus": item.get("reviewStatus"),
        "curationAgeDays": _curation_age_days(curation) if curation else None,
        "reviewDoc": item.get("reviewDoc", ""),
        "summary": item.get("summary") or {},
        "previousCuration": curation if curation else None,
    }


def _curation_age_days(curation: dict[str, Any]) -> int | None:
    last = curation.get("createdAt")
    if not last:
        return None
    try:
        last_dt = dt.datetime.fromisoformat(last)
        return (dt.datetime.now(dt.timezone.utc) - last_dt).days
    except Exception:
        return None


def main() -> int:
    p = argparse.ArgumentParser(
        description="List bookmark summaries that need a fresh curation"
    )
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    config = load_focus_config()
    topics: list[str] = config.get("topics", DEFAULT_CONFIG["topics"])
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
            "topics": topics,
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
            age = _curation_age_days(c.get("curation") or {})
            print(
                f"  - {c.get('bookmarkKey')}  "
                f"{c.get('title', '')[:60]}  "
                f"[{c.get('reviewStatus')}]  "
                f"curation_age={age}d"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
