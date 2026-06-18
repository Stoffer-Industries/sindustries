#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (
    STATE_PATH,
    WORKSPACE,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
    get_approval_topic,
)

# Compact preview helpers — keeps payload under lobster's 2000-char preview cap.
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


def _update_item(state_items: dict, bookmark_key: str, reason: str, state_path: Path, **fields: object) -> bool:
    item = state_items.get(bookmark_key)
    if not item:
        return False
    previous_status = item.get("reviewStatus")
    item.update(fields)
    item["lastUpdatedAt"] = now_iso()
    state_items[bookmark_key] = item
    log_transition(
        bookmark_key,
        previous_status,
        item.get("reviewStatus"),
        reason,
        transitions_path=transition_log_path(state_path),
    )
    return True


def main() -> int:
    p = argparse.ArgumentParser(description="Build, finalize, and dispatch spec approval request")
    p.add_argument("--approval-topic", default="general")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(sys.stdin)
    state = load_state(Path(STATE_PATH))
    state_items = state.get("items", {})
    state_path = Path(STATE_PATH)

    # --- Phase 1: prepare packages (was lobster_prepare_topic_approval) ---
    pending_topics = {
        get_approval_topic(item)
        for item in state_items.values()
        if item.get("reviewStatus") in {"approval_pending", "revision_staged"}
    }

    candidate_packages: list[dict] = []
    blocked_packages: list[dict] = []

    for item in data.get("implement", []):
        bookmark_key = item.get("bookmarkKey")
        state_item = state_items.get(bookmark_key, {})
        # get_approval_topic reads curation.topic first — the authoritative source.
        topic = get_approval_topic({**state_item, **item})
        if not topic or topic == "general":
            topic = args.approval_topic or "general"
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

    # --- Phase 2: slot check (was lobster_ensure_topic_slot_available) ---
    # Re-read pending topics from state to guard against races; uses same per-topic
    # logic as phase 1 so different topics can run concurrently.
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

    # --- Phase 3: finalize review cycle (was lobster_finalize_review_cycle) ---
    # Commits state for items that are NOT going to approval this run.
    finalized: dict[str, list] = {"reviewed": [], "monitoring": [], "queued": []}

    for review in data.get("reviewed", []):
        bookmark_key = review.get("bookmarkKey")
        if bookmark_key and _update_item(state_items, bookmark_key, "finalized reviewed item", state_path, reviewStatus="reviewed"):
            finalized["reviewed"].append(bookmark_key)

    for review in data.get("monitoring", []):
        # reviewStatus="monitoring" is retired — curation score is the signal.
        bookmark_key = review.get("bookmarkKey")
        item = state_items.get(bookmark_key) if bookmark_key else None
        if item and item.get("reviewStatus") == "monitoring":
            _update_item(state_items, bookmark_key, "heal: retired monitoring status → summarized", state_path, reviewStatus="summarized")
            finalized["monitoring"].append(bookmark_key)

    for package in blocked_packages:
        reason = package.get("reason") or package.get("blockedReason") or "approval already pending globally"
        for summary in package.get("items", []):
            bookmark_key = summary.get("bookmarkKey")
            if not bookmark_key:
                continue
            if _update_item(state_items, bookmark_key, f"queued because approval blocked: {reason}", state_path, reviewStatus="spec_created"):
                finalized["queued"].append(bookmark_key)

    save_state(state, state_path)

    # --- Phase 4: compact preview (was lobster_compact_approval_preview) ---
    # Strips heavy fields to keep payload under lobster's 2000-char preview cap.
    # Validates that spec docs actually exist on disk.
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

    json.dump({"readyPackages": compact_ready, "blockedPackages": compact_blocked}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
