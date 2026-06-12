#!/usr/bin/env python3
"""
Curation pass — scores bookmark relevance against active focus topics.

Runs in Quinn's heartbeat. Reads summarized items (and monitoring items due
for re-curation after 14d) and assigns relevance scores. Items that clear
the threshold for an active focus topic are queued for spec generation.

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
    invoke_llm_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
)

FOCUS_CONFIG_PATH = WORKSPACE / "brain" / "state" / "focus-config.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "activeTopics": ["brain", "infra"],
    "relevanceThreshold": 7,
    "recurationDays": 14,
    "batchSize": 5,
}

CURATION_PROMPT = """You are scoring the relevance of a bookmark summary against a set of active focus topics.

For each focus topic, score relevance 0-10:
- 0: completely unrelated
- 3: loosely adjacent, tangential connection
- 5: relevant but not directly actionable for this focus area now
- 7: clearly relevant — meaningfully touches this area in a way worth building on
- 9-10: directly actionable for this focus area right now

Be specific in your reasoning. Don't inflate scores for vague connections.
Return the highest-scoring topic as the primary match."""

CURATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "score": {"type": "number"},
                    "reasoning": {"type": "string"},
                },
                "required": ["topic", "score", "reasoning"],
            },
        },
        "primaryTopic": {"type": "string"},
        "primaryScore": {"type": "number"},
        "summary": {"type": "string"},
    },
    "required": ["scores", "primaryTopic", "primaryScore", "summary"],
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


def score_relevance(item: dict[str, Any], active_topics: list[str]) -> dict[str, Any]:
    summary = item.get("summary") or {}
    payload = {
        "bookmark": {
            "title": item.get("title", ""),
            "topic": item.get("topic", "general"),
            "headline": summary.get("headline", ""),
            "problem": summary.get("problem", ""),
            "approach": summary.get("approach", ""),
            "valueProposition": summary.get("valueProposition", ""),
            "keyDetails": summary.get("keyDetails", []),
            "relevantTo": summary.get("relevantTo", ""),
            "signalQuality": summary.get("signalQuality", "medium"),
        },
        "activeTopics": active_topics,
        "instruction": "Score this bookmark's relevance to each active focus topic.",
    }
    return invoke_llm_json(CURATION_PROMPT, payload, CURATION_SCHEMA)


def main() -> int:
    p = argparse.ArgumentParser(description="Curate summarised bookmarks by relevance")
    p.add_argument("--json", action="store_true")
    p.add_argument("--dry-run", action="store_true")
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

    queued = []
    monitoring = []

    for item in batch:
        bookmark_key = item["bookmarkKey"]
        previous_status = item.get("reviewStatus")

        try:
            result = score_relevance(item, active_topics)
        except Exception as e:
            print(f"[curate] Failed to score {bookmark_key}: {e}", flush=True)
            continue

        primary_score = float(result.get("primaryScore", 0))
        primary_topic = result.get("primaryTopic", item.get("topic", "general"))

        now = now_iso()
        item["lastCuratedAt"] = now
        item["relevanceScore"] = primary_score
        item["relevanceTopic"] = primary_topic
        item["relevanceScores"] = result.get("scores", [])
        item["lastUpdatedAt"] = now

        if primary_score >= threshold and primary_topic in active_topics:
            new_status = "queued_for_spec"
            item["reviewStatus"] = new_status
            item["approvalTopic"] = primary_topic
            queued.append(bookmark_key)
        else:
            new_status = "monitoring"
            item["reviewStatus"] = new_status
            monitoring.append(bookmark_key)

        items[bookmark_key] = item

        if not args.dry_run:
            log_transition(
                bookmark_key,
                previous_status,
                new_status,
                f"relevance={primary_score:.1f} topic={primary_topic}",
                transitions_path=transition_log_path(Path(STATE_PATH)),
            )

    if not args.dry_run:
        save_state(state, Path(STATE_PATH))

    payload = {
        "ok": True,
        "curatedAt": now_iso(),
        "config": {
            "activeTopics": active_topics,
            "threshold": threshold,
            "recurationDays": recuration_days,
            "batchSize": batch_size,
        },
        "processed": len(batch),
        "remaining": max(0, len(candidates) - batch_size),
        "queued_for_spec": queued,
        "monitoring": monitoring,
        "dryRun": args.dry_run,
    }
    if args.json:
        dump_json(payload)
    else:
        print(f"curated {len(batch)}: {len(queued)} queued for spec, {len(monitoring)} monitoring")
        if payload["remaining"]:
            print(f"  {payload['remaining']} more items pending (next heartbeat)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
