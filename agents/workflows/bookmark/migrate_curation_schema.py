#!/usr/bin/env python3
"""
One-time migration: move top-level curation fields into item.curation.

Old schema (per item):
  {
    bookmarkKey, title, topic, summary,
    reviewStatus,
    lastCuratedAt, relevanceScore, relevanceTopic, relevanceScores,
    approvalTopic, ...
  }

New schema:
  {
    bookmarkKey, title, topic, summary,
    reviewStatus,
    curation: { createdAt, topic, score, reasoning, relevanceScores, activeTopics, threshold } | null,
    ...
  }

Status changes:
  - queued_for_spec → summarized   (the verdict now lives in curation, not status)
  - monitoring      → summarized   (same reason)
  - everything else preserved

`approvalTopic` is dropped at top level. Readers that need the topic for the
approval gate should call the shared get_approval_topic() helper, which
checks curation.topic first then falls back to item.topic.

Idempotent — running it on already-migrated state is a no-op.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    STATE_ROOT,
    TRANSITIONS_PATH,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
)

# Statuses that encode a curate verdict — they collapse to "summarized" because
# the verdict now lives in item.curation.
STATUSES_TO_RESET = {"queued_for_spec", "monitoring"}

# Top-level fields that move into the curation sub-object.
CURATION_FIELDS = (
    "lastCuratedAt",
    "relevanceScore",
    "relevanceTopic",
    "relevanceScores",
    "approvalTopic",
)

# Fields needed to build a curation sub-object. If none of these are present
# on an item, the migration leaves its curation alone (likely already null).
CURATION_INPUT_FIELDS = ("lastCuratedAt", "relevanceScore", "relevanceTopic")


def build_curation(item: dict[str, Any]) -> dict[str, Any] | None:
    """Extract a curation sub-object from a legacy item. Returns None if the
    item has no curation data to migrate."""
    if item.get("curation") is not None:
        return None  # already migrated (curation exists, even if empty)
    if not any(item.get(k) is not None for k in CURATION_INPUT_FIELDS):
        return None  # no curation data; leave as-is
    return {
        "createdAt": item.get("lastCuratedAt") or now_iso(),
        "topic": item.get("relevanceTopic") or item.get("approvalTopic") or "general",
        "score": float(item.get("relevanceScore") or 0),
        "reasoning": "",  # legacy data doesn't carry per-decision reasoning
        "relevanceScores": item.get("relevanceScores") or [],
        "activeTopics": [],  # not stored in legacy schema
        "threshold": 7,  # default; legacy data didn't capture this
    }


def migrate_item(item: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Return (migrated_item, was_changed). Pure: doesn't mutate the input."""
    out = dict(item)
    changed = False

    curation = build_curation(item)
    if curation is not None:
        out["curation"] = curation
        changed = True

    # Drop top-level curation fields (they're now in item.curation)
    for f in CURATION_FIELDS:
        if f in out:
            del out[f]
            changed = True

    # Reset status if it encoded a curate verdict
    if out.get("reviewStatus") in STATUSES_TO_RESET:
        out["reviewStatus"] = "summarized"
        changed = True

    return out, changed


def main() -> int:
    p = argparse.ArgumentParser(description="Migrate bookmark state to curation sub-object schema")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})
    transitions_path = transition_log_path(Path(STATE_PATH))

    migrated_items: list[str] = []
    reset_status_items: list[str] = []
    skipped: list[str] = []

    new_items: dict[str, Any] = {}
    for key, item in items.items():
        new_item, changed = migrate_item(item)
        new_items[key] = new_item
        if changed:
            if item.get("curation") is None and any(item.get(k) is not None for k in CURATION_INPUT_FIELDS):
                migrated_items.append(key)
            if item.get("reviewStatus") in STATUSES_TO_RESET:
                reset_status_items.append(key)
        else:
            skipped.append(key)

    state["items"] = new_items

    if not args.dry_run and (migrated_items or reset_status_items):
        # Log transitions for the status resets
        for key in reset_status_items:
            old_status = items[key].get("reviewStatus")
            log_transition(
                key,
                old_status,
                "summarized",
                f"schema migration: {old_status} → summarized (verdict now in curation)",
                transitions_path=transitions_path,
            )
        save_state(state, Path(STATE_PATH))

    payload = {
        "ok": True,
        "dryRun": args.dry_run,
        "totalItems": len(items),
        "migratedCurations": len(migrated_items),
        "resetStatuses": len(reset_status_items),
        "skipped": len(skipped),
    }
    if args.json:
        dump_json(payload)
    else:
        print(
            f"migrated: {len(migrated_items)} curations, "
            f"{len(reset_status_items)} status resets, "
            f"{len(skipped)} already current"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
