#!/usr/bin/env python3
"""
find_similar_tasks.py — pre-creation similarity check.

Given a candidate task (title, description, tags), list existing open tasks
and recently-active tasks that look similar. Returns a JSON-serializable
list of candidates with similarity scores and one-line reasons.

Used by the task-creation dedup gate (spec at docs/specs/task-creation-dedup-gate-2026-07-27.md).
This is the *primitive* — the create flow decides what to do with candidates
(surface, refuse, allow). This script only reports.

Usage:
    python3 find_similar_tasks.py \\
        --title "🔧 Log gate failure analytics" \\
        --tags rowan analytics \\
        --window-days 14

Exit codes:
    0 — success (candidates may or may not be present)
    2 — usage error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Iterable

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Similarity weights. Title is the strongest signal, tags are tiebreaker,
# description is weakest (free-form prose has low precision).
_W_TITLE = 0.5
_W_TAGS = 0.3
_W_DESC = 0.2


def tokenize(text: str) -> set[str]:
    if not text:
        return set()
    return set(_TOKEN_RE.findall(text.lower()))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    union = a | b
    return len(a & b) / len(union) if union else 0.0


def _api_get(base: str, path: str) -> dict:
    url = f"{base.rstrip('/')}{path}"
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_candidate_tasks(
    base_url: str, statuses: list[str], limit_per_status: int = 200
) -> list[dict]:
    """Fetch all open + active tasks we want to dedup against."""
    tasks: list[dict] = []
    for status in statuses:
        try:
            data = _api_get(base_url, f"/tasks?status={status}&limit={limit_per_status}")
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
            print(f"warning: failed to list {status} tasks: {e}", file=sys.stderr)
            continue
        tasks.extend(data.get("data", []))
    return tasks


def _extract_topic_tags(tags: list[str] | None) -> set[str]:
    """Tags that look like topic:foo or domain markers (not personal/workstream)."""
    if not tags:
        return set()
    return {t for t in tags if t.startswith("topic:") or ":" in t}


def score(
    task: dict,
    *,
    title: str,
    description: str,
    tags: list[str] | None,
) -> tuple[float, list[str]]:
    """Return (score in [0, 1], reasons) for a candidate task."""
    reasons: list[str] = []
    s = 0.0

    title_tokens = tokenize(title)
    cand_title = tokenize(task.get("title", ""))
    if title_tokens and cand_title:
        sim = jaccard(title_tokens, cand_title)
        if sim > 0.0:
            s += _W_TITLE * sim
            reasons.append(f"title overlap {sim:.2f}")

    cand_tags = set(task.get("tags") or [])
    new_tags = set(tags or [])
    if cand_tags and new_tags:
        common = cand_tags & new_tags
        if common:
            tag_sim = len(common) / len(cand_tags | new_tags)
            s += _W_TAGS * tag_sim
            reasons.append(f"shared tags {sorted(common)}")
        # Topic tags are the strongest tag signal — both tasks touching the
        # same domain are very likely duplicates.
        cand_topics = _extract_topic_tags(list(cand_tags))
        new_topics = _extract_topic_tags(list(new_tags))
        if cand_topics and new_topics and (cand_topics & new_topics):
            s += 0.15
            reasons.append(f"same topic {sorted(cand_topics & new_topics)}")

    # Description overlap is the first paragraph only — full body has too
    # much noise. If neither side has a description, skip.
    desc_tokens = tokenize(description)
    cand_desc = task.get("description") or ""
    cand_desc_first = cand_desc.split("\n", 1)[0] if cand_desc else ""
    cand_desc_tokens = tokenize(cand_desc_first)
    if desc_tokens and cand_desc_tokens:
        sim = jaccard(desc_tokens, cand_desc_tokens)
        if sim > 0.0:
            s += _W_DESC * sim
            reasons.append(f"description overlap {sim:.2f}")

    return min(s, 1.0), reasons


def find_similar(
    *,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    base_url: str | None = None,
    statuses: list[str] | None = None,
    threshold: float = 0.25,
    limit: int = 10,
) -> list[dict]:
    """Library entry point. Returns a list of candidate dicts."""
    base = base_url or os.environ.get(
        "TASKS_API_BASE_URL", "http://localhost:4001/api/v1"
    )
    statuses = statuses or ["open", "ready", "doing", "acceptance"]
    tasks = fetch_candidate_tasks(base, statuses)
    matches: list[dict] = []
    for t in tasks:
        s, reasons = score(t, title=title, description=description, tags=tags)
        if s >= threshold:
            matches.append(
                {
                    "id": t.get("id"),
                    "title": t.get("title"),
                    "status": t.get("status"),
                    "assignee": t.get("assignee"),
                    "taskType": t.get("taskType"),
                    "score": round(s, 3),
                    "reasons": reasons,
                }
            )
    matches.sort(key=lambda m: m["score"], reverse=True)
    return matches[:limit]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--title", required=True, help="Candidate task title")
    p.add_argument("--description", default="", help="Candidate task description (first paragraph used)")
    p.add_argument("--tags", nargs="*", default=[], help="Candidate task tags")
    p.add_argument("--base-url", default=None, help="Tasks API base URL (default: $TASKS_API_BASE_URL)")
    p.add_argument(
        "--statuses",
        nargs="*",
        default=["open", "ready", "doing", "acceptance"],
        help="Statuses to dedup against",
    )
    p.add_argument("--threshold", type=float, default=0.25, help="Minimum similarity score to surface")
    p.add_argument("--limit", type=int, default=10, help="Max candidates to return")
    args = p.parse_args()

    try:
        candidates = find_similar(
            title=args.title,
            description=args.description,
            tags=args.tags,
            base_url=args.base_url,
            statuses=args.statuses,
            threshold=args.threshold,
            limit=args.limit,
        )
    except Exception as e:
        print(f"error: dedup check failed: {e}", file=sys.stderr)
        return 2

    out = {"candidates": candidates, "count": len(candidates)}
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
