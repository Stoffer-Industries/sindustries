#!/usr/bin/env python3
"""Pure routing step for the WS3 classification contract (task 536e04fc).

Runs AHEAD of the YAML `approval: required` halt on `request_spec_approval`,
producing the routed sub-buckets that downstream steps consume:

- `readyPackages`        — feature items still needing Tom's approval
- `blockedPackages`      — items missing spec / topic-pending / single-per-run
- `directCreateItems`    — code/research items → tasks-api direct-create
- `triageEvents`         — ambiguous items → bookmark-triage-queue.json
- `routedImplement`      — feature sub-bucket (for downstream state mutation)
- `routedReviewed`       — pass-through so finalize cycle keeps working
- `routedMonitoring`     — pass-through so finalize cycle keeps working

AC3 reliability fix (Quinn 2026-09-08 handoff): the YAML `approval: required`
flag on the previous combined `lobster_request_spec_approval.py` step halted
the pipeline in `--mode tool` even when `readyPackages` was empty (only-
direct batch). By splitting routing from the approval-halt step, we let
`create_tasks_from_direct` run unconditionally while still gating the
Telegram approval delivery on `readyPackages` being non-empty.

This script does **no state mutations**. The downstream
`lobster_request_spec_approval.py` keeps Phases 3 (finalize cycle) plus
the Telegram approval delivery; it reads the routed output from this
step instead of re-running Phases 0-2 + 4 itself.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (
    STATE_PATH,
    WORKSPACE,
    dump_json,
    get_approval_topic,
    load_state,
)
from ws3_routing import (
    ROUTE_DIRECT,
    ROUTE_FEATURE,
    append_triage_events,
    route_implement_items,
)

# Reused from the prior combined script. Keeps message payloads compact
# so they stay under lobster's 2000-char preview cap.
_ITEM_KEEP = {"bookmarkKey", "specDocs", "topic", "approvalTopic", "title"}
_PACKAGE_KEEP = {"approvalTopic", "topic", "resumeToken", "lobsterResumeToken"}


def _compact_task(task: dict) -> dict:
    title = task.get("title")
    return {"title": title} if title else {}


def _compact_item(item: dict) -> dict:
    result = {k: v for k, v in item.items() if k in _ITEM_KEEP and v is not None}
    tasks = [_compact_task(t) for t in (item.get("proposedTasks") or []) if t.get("title")]
    if tasks:
        result["proposedTasks"] = tasks
    return result


def _build_item_summary(item: dict) -> dict:
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


def _build_packages(
    routed_implement: list[dict],
    state_items: dict,
    approval_topic_arg: str,
) -> tuple[list[dict], list[dict]]:
    """Phase 1+2: build readyPackages (capped at 1) and blockedPackages.

    Mirrors the package-prep logic in the prior combined
    `lobster_request_spec_approval.py`. State mutations here are still
    NONE — we only READ state to detect already-pending topics.
    """
    pending_topics = {
        get_approval_topic(item)
        for item in state_items.values()
        if item.get("reviewStatus") in {"approval_pending", "revision_staged"}
    }

    candidate_packages: list[dict] = []
    blocked_packages: list[dict] = []

    for item in routed_implement:
        bookmark_key = item.get("bookmarkKey")
        state_item = state_items.get(bookmark_key, {})
        topic = get_approval_topic({**state_item, **item})
        if not topic or topic == "general":
            topic = approval_topic_arg or "general"
        package_item = _build_item_summary(item)
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
            blocked_packages.append({**package, "reason": "approval already pending for topic"})
            continue
        candidate_packages.append(package)

    # Hard cap: one approval package per run.
    ready_packages: list[dict] = []
    if candidate_packages:
        ready_packages.append(candidate_packages[0])
        for pkg in candidate_packages[1:]:
            blocked_packages.append({**pkg, "reason": "single approval per run policy"})

    # Phase 2: slot check (race re-read; uses same per-topic logic).
    approval_pending_topics = {
        str(get_approval_topic(v))
        for v in state_items.values()
        if v.get("reviewStatus") in {"approval_pending", "revision_staged"}
    }

    final_ready: list[dict] = []
    for package in ready_packages:
        topic = package.get("approvalTopic") or package.get("topic") or "general"
        if topic in approval_pending_topics:
            blocked_packages.append({**package, "blockedReason": "approval already pending for topic"})
        else:
            final_ready.append(package)

    return final_ready, blocked_packages


def _compact_packages(
    final_ready: list[dict],
    blocked_packages: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Phase 4: compact preview shape and validate spec docs on disk."""
    compact_ready: list[dict] = []
    compact_blocked: list[dict] = []
    for package in blocked_packages:
        reason = package.get("reason") or package.get("blockedReason") or "approval already pending globally"
        items = [_compact_item(item) for item in package.get("items", [])]
        base = {k: v for k, v in package.items() if k in _PACKAGE_KEEP}
        compact_blocked.append({**base, "items": items, "reason": reason})
    for package in final_ready:
        items_with_specs = []
        items_missing_specs = []
        for item in package.get("items", []):
            spec_docs = item.get("specDocs") or []
            missing = [doc for doc in spec_docs if not (WORKSPACE / doc).exists()]
            if missing:
                items_missing_specs.append({**_compact_item(item), "missingSpecDocs": missing})
            else:
                items_with_specs.append(_compact_item(item))
        if items_missing_specs:
            base = {k: v for k, v in package.items() if k in _PACKAGE_KEEP}
            compact_blocked.append({**base, "items": items_missing_specs, "reason": "spec docs missing on disk — cannot propose for approval"})
        if items_with_specs:
            base = {k: v for k, v in package.items() if k in _PACKAGE_KEEP}
            compact_ready.append({**base, "items": items_with_specs})
    return compact_ready, compact_blocked


def main() -> int:
    p = argparse.ArgumentParser(description="WS3 pure routing step (task 536e04fc)")
    p.add_argument("--approval-topic", default="general")
    p.add_argument("--json", action="store_true")
    p.add_argument("--no-triage-append", action="store_true",
                   help="Skip appending to bookmark-triage-queue.json (tests).")
    args = p.parse_args()

    data = json.load(sys.stdin)
    state = load_state(Path(STATE_PATH))
    state_items = state.get("items", {})

    routed_implement, direct_create_items, triage_events = route_implement_items(
        data.get("implement", []),
        state_items,
    )

    # Persist triage events unless the caller opts out (tests, dry runs).
    if triage_events and not args.no_triage_append:
        append_triage_events(triage_events)

    final_ready, blocked_packages = _build_packages(
        routed_implement,
        state_items,
        args.approval_topic,
    )
    compact_ready, compact_blocked = _compact_packages(final_ready, blocked_packages)

    # Carry through lists the downstream finalize cycle (Phase 3 inside
    # lobster_request_spec_approval.py) needs to update state for non-
    # implement items. Phase 3 itself still runs there.
    payload = {
        "readyPackages": compact_ready,
        "blockedPackages": compact_blocked,
        "directCreateItems": direct_create_items,
        "triageEvents": triage_events,
        "routedImplement": routed_implement,
        "routedReviewed": data.get("reviewed", []),
        "routedMonitoring": data.get("monitoring", []),
    }
    dump_json(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
