#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from common import STATE_PATH, load_state


def iso_sort_key(value: Any) -> str:
    if isinstance(value, str):
        return value
    return ""


def compact_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "title": item.get("title"),
        "topic": item.get("topic"),
        "source": item.get("source"),
        "reviewStatus": item.get("reviewStatus"),
        "approvalStatus": item.get("approvalStatus"),
        "taskCount": len(item.get("taskIds") or []),
        "specCount": len(item.get("specDocs") or []),
        "path": item.get("path"),
        "reviewDoc": item.get("reviewDoc"),
        "lastUpdatedAt": item.get("lastUpdatedAt"),
    }


def analyze(items: dict[str, dict[str, Any]]) -> dict[str, Any]:
    status_counts: Counter[str] = Counter()
    topic_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    approval_counts: Counter[str] = Counter()
    tasked_items: list[dict[str, Any]] = []
    spec_items: list[dict[str, Any]] = []
    approval_pending_items: list[dict[str, Any]] = []
    stale_candidates: list[dict[str, Any]] = []
    by_topic_status: dict[str, Counter[str]] = defaultdict(Counter)

    for item in items.values():
        review_status = item.get("reviewStatus") or "unknown"
        topic = item.get("topic") or "general"
        source = item.get("source") or "unknown"
        approval_status = item.get("approvalStatus") or "none"
        status_counts[review_status] += 1
        topic_counts[topic] += 1
        source_counts[source] += 1
        approval_counts[approval_status] += 1
        by_topic_status[topic][review_status] += 1

        compact = compact_item(item)
        if item.get("taskIds"):
            tasked_items.append(compact)
        if item.get("specDocs"):
            spec_items.append(compact)
        if review_status in {"approval_pending", "revision_staged"} or approval_status == "pending":
            approval_pending_items.append(compact)
        if review_status in {"queued_for_spec", "spec_created", "approval_pending", "revision_staged"}:
            stale_candidates.append(compact)

    latest_updates = sorted(
        (compact_item(item) for item in items.values()),
        key=lambda x: iso_sort_key(x.get("lastUpdatedAt")),
        reverse=True,
    )[:10]

    by_topic_status_out = {
        topic: dict(sorted(counter.items()))
        for topic, counter in sorted(by_topic_status.items())
    }

    return {
        "statePath": str(STATE_PATH),
        "bookmarkCount": len(items),
        "statusCounts": dict(sorted(status_counts.items())),
        "topicCounts": dict(sorted(topic_counts.items())),
        "sourceCounts": dict(sorted(source_counts.items())),
        "approvalCounts": dict(sorted(approval_counts.items())),
        "byTopicStatus": by_topic_status_out,
        "taskedCount": len(tasked_items),
        "specCount": len(spec_items),
        "approvalPendingCount": len(approval_pending_items),
        "staleCandidateCount": len(stale_candidates),
        "taskedItems": sorted(tasked_items, key=lambda x: (x.get("topic") or "", x.get("title") or "")),
        "specItems": sorted(spec_items, key=lambda x: (x.get("topic") or "", x.get("title") or "")),
        "approvalPendingItems": sorted(approval_pending_items, key=lambda x: (x.get("topic") or "", x.get("title") or "")),
        "staleCandidates": sorted(stale_candidates, key=lambda x: (x.get("topic") or "", x.get("title") or "")),
        "latestUpdates": latest_updates,
    }


def render_text(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"Bookmark state summary ({report['bookmarkCount']} bookmarks)")
    lines.append(f"State file: {report['statePath']}")
    lines.append("")

    lines.append("Status counts")
    for key, value in report["statusCounts"].items():
        lines.append(f"- {key}: {value}")
    lines.append("")

    lines.append("Topic counts")
    for key, value in report["topicCounts"].items():
        lines.append(f"- {key}: {value}")
    lines.append("")

    lines.append("Approval counts")
    for key, value in report["approvalCounts"].items():
        lines.append(f"- {key}: {value}")
    lines.append("")

    lines.append("Attention buckets")
    lines.append(f"- with specs: {report['specCount']}")
    lines.append(f"- with tasks: {report['taskedCount']}")
    lines.append(f"- approval pending: {report['approvalPendingCount']}")
    lines.append(f"- likely workflow follow-up candidates: {report['staleCandidateCount']}")
    lines.append("")

    if report["staleCandidates"]:
        lines.append("Workflow follow-up candidates")
        for item in report["staleCandidates"]:
            lines.append(
                f"- [{item.get('reviewStatus')}] {item.get('topic')}/{item.get('title')}"
                + (f" (approval={item.get('approvalStatus')})" if item.get("approvalStatus") else "")
            )
        lines.append("")

    if report["taskedItems"]:
        lines.append("Tasked bookmarks")
        for item in report["taskedItems"]:
            lines.append(
                f"- {item.get('topic')}/{item.get('title')} — tasks={item.get('taskCount')} specs={item.get('specCount')}"
            )
        lines.append("")

    if report["latestUpdates"]:
        lines.append("Latest updates")
        for item in report["latestUpdates"][:5]:
            lines.append(
                f"- {item.get('lastUpdatedAt') or 'unknown'} — [{item.get('reviewStatus')}] {item.get('topic')}/{item.get('title')}"
            )

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize bookmark-review state without loading the whole JSON into context")
    parser.add_argument("--state-path", default=str(STATE_PATH), help="Path to bookmark-review-state.json")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--topic", help="Filter to a single topic")
    parser.add_argument("--status", help="Filter to a single review status")
    args = parser.parse_args()

    state_path = Path(args.state_path)
    state = load_state(state_path)
    items: dict[str, dict[str, Any]] = state.get("items", {})

    if args.topic:
        items = {k: v for k, v in items.items() if (v.get("topic") or "general") == args.topic}
    if args.status:
        items = {k: v for k, v in items.items() if (v.get("reviewStatus") or "unknown") == args.status}

    report = analyze(items)
    report["statePath"] = str(state_path)
    if args.topic:
        report["filterTopic"] = args.topic
    if args.status:
        report["filterStatus"] = args.status

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(render_text(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
