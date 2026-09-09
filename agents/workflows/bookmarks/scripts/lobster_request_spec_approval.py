#!/usr/bin/env python3
"""Build, finalize, and dispatch spec approval request (task 536e04fc).

Runs AFTER the pure-routing step `lobster_route_specs.py`. Its job is now
narrow: apply state mutations for the finalize cycle (Phase 3), preserve
the routed sub-buckets, and emit a compact JSON preview that the lobster
captures as `requiresApproval.preview` when this step (configured with
`approval: required`) halts in `--mode tool`.

The heavy lifting — Phase 0 (route), Phases 1-2 (build packages + slot
check), Phase 4 (compact preview), triage-queue append — moved to
`lobster_route_specs.py` so it can run AHEAD of the YAML approval halt.
This split is the AC3 reliability fix (Quinn 2026-09-08 handoff): the
combined step previously halted the pipeline in tool mode even when
`readyPackages` was empty (only-direct batch), preventing
`create_tasks_from_direct` from ever running on code/research-only
input.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (
    STATE_PATH,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
)
from bookmark_state_machine import (
    is_task_linked,
    reconcile_tasked_item,
)


def _update_item(
    state_items: dict,
    bookmark_key: str,
    reason: str,
    state_path: Path,
    **fields: object,
) -> bool:
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
    p = argparse.ArgumentParser(description="Finalize spec cycle and emit approval preview")
    p.add_argument("--approval-topic", default="general",
                   help="Ignored — kept for backward compatibility; routing now happens upstream in lobster_route_specs.py")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(sys.stdin)
    state = load_state(Path(STATE_PATH))
    state_items = state.get("items", {})
    state_path = Path(STATE_PATH)

    # Pull routed sub-buckets out of the upstream route_specs.json.
    ready_packages = data.get("readyPackages") or []
    blocked_packages = data.get("blockedPackages") or []
    direct_create_items = data.get("directCreateItems") or []
    triage_events = data.get("triageEvents") or []
    routed_implement = data.get("routedImplement") or []
    routed_reviewed = data.get("routedReviewed") or data.get("reviewed") or []
    routed_monitoring = data.get("routedMonitoring") or data.get("monitoring") or []

    # --- Phase 3: finalize review cycle (state mutations) ---
    finalized: dict[str, list] = {"reviewed": [], "monitoring": [], "queued": []}

    for review in routed_reviewed:
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
                # Item is task-linked but persisted status was something
                # else (e.g. reviewed, spec_requested from a stale pass).
                # We refuse the downgrade but still record the routing
                # decision; the terminal status surfaces to the dashboard
                # via the merged `tasked` view even if the persisted
                # field is stale.
                finalized["reviewed"].append(bookmark_key)
            continue
        if _update_item(state_items, bookmark_key, "finalized reviewed item", state_path, reviewStatus="reviewed"):
            finalized["reviewed"].append(bookmark_key)

    for review in routed_monitoring:
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

    # Pass-through for the lobster preview (`approval: required` step
    # captures this). The shape matches what `request_topic_approval.py`
    # and `lobster_create_tasks_from_proposals.py` already consume.
    json.dump({
        "readyPackages": ready_packages,
        "blockedPackages": blocked_packages,
        "directCreateItems": direct_create_items,
        "triageEvents": triage_events,
        "routedImplement": routed_implement,
        "routedReviewed": routed_reviewed,
        "routedMonitoring": routed_monitoring,
        "finalized": finalized,
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
