#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    STATE_ROOT,
    WORKSPACE,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
    get_approval_topic,
)
from bookmark_state_machine import (
    effective_review_status,
    is_task_linked,
    reconcile_tasked_item,
)

# Triage queue for ambiguous-classified bookmarks (task 536e04fc WS3).
# Appended to on every run that emits ambiguous events. Consumed by the
# WS4 recurring cron (Quinn-owned registration) that surfaces them as a
# Telegram report when older than 7 days.
TRIAGE_QUEUE_PATH = STATE_ROOT / "bookmark-triage-queue.json"

# Routing decision values for the WS3 classification contract.
ROUTE_FEATURE = "feature"
ROUTE_DIRECT = "direct"
ROUTE_AMBIGUOUS = "ambiguous"

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


def _resolve_route(state_item: dict, item_input: dict) -> tuple[str, list[dict]]:
    """Return (route, per_spec_data) for the implement item.

    route is one of:
    - ROUTE_FEATURE: keep today's flow (Tom reviews + approval)
    - ROUTE_DIRECT: skip approval, downstream calls Tasks API create with
      type=classification
    - ROUTE_AMBIGUOUS: no approval, no task; emit bookmark-triage-needed
      event so WS4 cron can surface it for manual triage

    per_spec_data is a list of classification records keyed by specDoc.

    The routing priority is: ambiguous > feature > direct. If no
    classifications are present (state pre-dates WS3 contract), the item
    falls back to feature to preserve today's flow.
    """
    classifications = (
        list(state_item.get("classifications") or [])
        or list(item_input.get("classifications") or [])
    )

    if not classifications:
        return ROUTE_FEATURE, []

    per_spec: list[dict] = []
    has_ambiguous = False
    has_feature = False
    has_direct = False
    for c in classifications:
        cls = c.get("classification")
        per_spec.append({
            "specDoc": c.get("specDoc"),
            "classification": cls,
            "classification_rationale": c.get("classification_rationale"),
            "classificationError": c.get("classificationError"),
        })
        if cls == "ambiguous" or cls is None or c.get("classificationError"):
            has_ambiguous = True
        elif cls == "feature":
            has_feature = True
        elif cls in ("code", "research"):
            has_direct = True
        else:
            # Unknown enum value — treat as ambiguous so the pipeline never
            # silently coerces to a wrong route.
            has_ambiguous = True

    if has_ambiguous:
        return ROUTE_AMBIGUOUS, per_spec
    if has_feature:
        return ROUTE_FEATURE, per_spec
    if has_direct:
        return ROUTE_DIRECT, per_spec
    return ROUTE_FEATURE, per_spec  # unreachable in practice


def _append_triage_events(events: list[dict], path: Path | None = None) -> int:
    """Append triage events to bookmark-triage-queue.json. Returns the new size.

    Queue file is a JSON list. Malformed or missing files are treated as
    empty. Parent directories are created on first write.

    The default path is read from the module-level `TRIAGE_QUEUE_PATH` at
    call time (not import time) so tests can monkey-patch the target.
    """
    target = path if path is not None else TRIAGE_QUEUE_PATH
    if target.exists():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (json.JSONDecodeError, OSError):
            existing = []
    else:
        existing = []
    existing.extend(events)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return len(existing)


def _build_direct_create_item(
    item: dict, per_spec: list[dict]
) -> dict:
    """Build a directCreateItems entry from an implement item + per-spec data.

    Each spec becomes a proposed task with type=classification. The downstream
    caller (lobster or tasks-api client) reads this and creates one task per
    entry. The proposedTasks field carries the actual task list so the
    downstream doesn't need to re-parse the spec docs.
    """
    spec_titles = {
        s.get("specDoc"): s.get("title")
        for s in (item.get("specProposals") or [])
    }
    tasks = []
    for spec in per_spec:
        cls = spec.get("classification")
        spec_doc = spec.get("specDoc")
        if cls not in ("code", "research"):
            continue  # direct route only emits code/research tasks
        tasks.append({
            "title": spec_titles.get(spec_doc) or Path(spec_doc or "").stem,
            "type": cls,
            "specDoc": spec_doc,
            "bookmarkKey": item.get("bookmarkKey"),
            "classification_rationale": spec.get("classification_rationale"),
        })
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "topic": item.get("topic"),
        "title": item.get("title"),
        "specDocs": [s.get("specDoc") for s in per_spec if s.get("specDoc")],
        "tasks": tasks,
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

    # --- Phase 0: WS3 classification routing (task 536e04fc) ---
    # Divert items before the approval flow so ambiguous and direct-create
    # items never appear in readyPackages. The implement bucket is split
    # into three sub-buckets:
    #   - ambiguous: emit bookmark-triage-needed event, skip approval
    #   - direct: skip approval, output for downstream Tasks API create
    #   - feature: continue to the existing approval flow (Phase 1)
    routed_implement: list[dict] = []
    direct_create_items: list[dict] = []
    triage_events: list[dict] = []
    for item in data.get("implement", []):
        bookmark_key = item.get("bookmarkKey")
        state_item = state_items.get(bookmark_key, {})
        route, per_spec = _resolve_route(state_item, item)
        if route == ROUTE_AMBIGUOUS:
            triage_events.append({
                "bookmarkKey": bookmark_key,
                "title": item.get("title"),
                "topic": item.get("topic"),
                "specDocs": [s.get("specDoc") for s in per_spec],
                "classificationRationales": [
                    s.get("classification_rationale") for s in per_spec
                ],
                "classificationErrors": [
                    s.get("classificationError") for s in per_spec
                ],
                "emittedAt": now_iso(),
            })
            continue
        if route == ROUTE_DIRECT:
            direct_create_items.append(_build_direct_create_item(item, per_spec))
            continue
        # ROUTE_FEATURE: fall through to the existing approval flow
        routed_implement.append({**item, "_classifications": per_spec})

    # Persist triage events. WS4 cron (Quinn-owned) reads this queue.
    if triage_events:
        _append_triage_events(triage_events)

    # --- Phase 1: prepare packages (was lobster_prepare_topic_approval) ---
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
        if not bookmark_key:
            continue
        item = state_items.get(bookmark_key)
        if not item:
            continue
        # Task-linked items must NOT be downgraded to literal `reviewed`.
        # The `reviewed` output bucket is a routing decision, not a license
        # to overwrite the terminal state. Non-empty taskIds is the
        # authoritative signal for `tasked` (task 0089f4f9).
        if is_task_linked(item):
            previous_status = item.get("reviewStatus")
            repaired = reconcile_tasked_item(
                item,
                bookmark_key,
                "finalize-cycle: task-linked item refused literal reviewed downgrade",
                transitions_path=transition_log_path(state_path),
            )
            if repaired:
                finalized["reviewed"].append(bookmark_key)
            elif previous_status != "tasked":
                # Item is task-linked but persisted status was something else
                # (e.g. reviewed, spec_requested from a stale pass). We refuse
                # the downgrade but still record the routing decision; the
                # terminal status surfaces to the dashboard via the merged
                # `tasked` view even if the persisted field is stale.
                finalized["reviewed"].append(bookmark_key)
            continue
        if _update_item(state_items, bookmark_key, "finalized reviewed item", state_path, reviewStatus="reviewed"):
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

    json.dump({
        "readyPackages": compact_ready,
        "blockedPackages": compact_blocked,
        "directCreateItems": direct_create_items,
        "triageEvents": triage_events,
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
