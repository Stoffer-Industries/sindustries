#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, now_iso


def build_item_summary(item: dict) -> dict:
    spec_docs = item.get("specDocs") or []
    proposed_tasks = item.get("proposedTasks") or []
    analysis = item.get("analysis", {})
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "path": item.get("path"),
        "topic": item.get("topic"),
        "title": item.get("title"),
        "reviewDoc": item.get("reviewDoc"),
        "specDocs": spec_docs,
        "proposedTasks": proposed_tasks,
        "headline": analysis.get("headline"),
        "decisionRationale": analysis.get("decisionRationale"),
        "stackJudgment": analysis.get("stackJudgment"),
        "recommendation": analysis.get("recommendation"),
        "whyItMatters": analysis.get("stackJudgment") or analysis.get("decisionRationale") or item.get("whyItMatters"),
        "summary": analysis.get("summary") or item.get("summary"),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Prepare approval packages grouped by topic")
    p.add_argument("--approval-topic", default="general")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(__import__("sys").stdin)
    state = load_state(Path(STATE_PATH))
    state_items = state.get("items", {})

    # Single source of truth for approval lock is an active approval state.
    pending_topics = {
        (item.get("approvalTopic") or item.get("topic") or "general")
        for item in state_items.values()
        if item.get("reviewStatus") in {"approval_pending", "revision_staged"}
    }

    # One-spec-per-approval model: each implement item becomes its own package.
    candidate_packages = []
    blocked_packages = []

    for item in data.get("implement", []):
        topic = item.get("topic") or args.approval_topic or "general"
        package_item = build_item_summary(item)
        package = {
            "topic": topic,
            "approvalTopic": topic or "general",
            "items": [package_item],
            "proposedTasks": list(package_item.get("proposedTasks") or []),
            "planCount": 1,
            "taskCount": len(package_item.get("proposedTasks") or []),
        }
        if not package_item.get("specDocs"):
            blocked_packages.append({
                **package,
                "reason": "no spec — approval requires a spec to exist first; bookmark must complete spec generation before requesting approval",
            })
            continue

        if topic in pending_topics:
            blocked_packages.append({
                **package,
                "reason": "approval already pending for topic",
            })
            continue

        candidate_packages.append(package)

    # Hard cap: one approval package per run (as requested).
    ready_packages = []
    if candidate_packages:
        ready_packages.append(candidate_packages[0])
        for pkg in candidate_packages[1:]:
            blocked_packages.append({
                **pkg,
                "reason": "single approval per run policy",
            })

    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "readyPackages": ready_packages,
        "blockedPackages": blocked_packages,
        "monitoring": data.get("monitoring", []),
        "reviewed": data.get("reviewed", []),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
