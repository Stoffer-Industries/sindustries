#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, log_transition, now_iso, save_state, transition_log_path


def task_ids_for_bookmark(created: list[dict], bookmark_key: str) -> list[str]:
    task_ids = []
    for task in created:
        if task.get("bookmarkKey") != bookmark_key:
            continue
        task_id = task.get("taskId")
        if task_id:
            task_ids.append(str(task_id))
    return task_ids


def main() -> int:
    p = argparse.ArgumentParser(description="Resolve bookmark approval state after approve/decline")
    p.add_argument("--decision", required=True, choices=["approve", "decline"])
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    data = json.load(__import__("sys").stdin)
    approvals = data.get("approvals")
    if approvals is None:
        approvals = data.get("readyPackages", [])
    created = data.get("created", [])
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    resolved = []
    skipped = []
    resolution_status = "approved" if args.decision == "approve" else "declined"
    timestamp = now_iso()
    for approval in approvals:
        topic = approval.get("topic") or "general"
        resolved_items = []
        for summary in approval.get("items", []):
            bookmark_key = summary.get("bookmarkKey")
            if not bookmark_key:
                continue
            state_item = items.get(bookmark_key)
            if not state_item:
                skipped.append({"bookmarkKey": bookmark_key, "topic": topic, "reason": "state item not found"})
                continue
            if state_item.get("reviewStatus") != "approval_pending":
                skipped.append({"bookmarkKey": bookmark_key, "topic": topic, "reason": "item is not currently approval_pending"})
                continue
            state_topic = state_item.get("approvalTopic") or state_item.get("topic") or "general"
            if state_topic != topic:
                skipped.append({
                    "bookmarkKey": bookmark_key,
                    "topic": topic,
                    "reason": f"approval topic mismatch (state={state_topic}, input={topic})",
                })
                continue

            previous_status = state_item.get("reviewStatus")
            task_ids = task_ids_for_bookmark(created, bookmark_key)
            merged_task_ids = list(dict.fromkeys([*state_item.get("taskIds", []), *task_ids]))
            if args.decision == "decline":
                next_status = "declined"
            else:
                next_status = "tasked" if merged_task_ids else "spec_created"
            state_item.update({
                "approvalStatus": resolution_status,
                "approvalResolvedAt": timestamp,
                "approvalId": None,
                "approvalResumeToken": None,
                "reviewStatus": next_status,
                "taskIds": merged_task_ids,
                "lastUpdatedAt": timestamp,
            })
            items[bookmark_key] = state_item
            log_transition(
                bookmark_key,
                previous_status,
                next_status,
                f"approval {resolution_status}; taskIds={len(merged_task_ids)}",
                transitions_path=transition_log_path(Path(STATE_PATH)),
            )
            resolved_items.append({
                "bookmarkKey": bookmark_key,
                "reviewStatus": next_status,
                "taskIds": merged_task_ids,
            })

        resolved.append({
            "topic": topic,
            "decision": resolution_status,
            "items": resolved_items,
        })

    save_state(state, Path(STATE_PATH))
    dump_json({
        "ok": True,
        "generatedAt": now_iso(),
        "decision": resolution_status,
        "resolved": resolved,
        "skipped": skipped,
        "created": created,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

if __name__ == "__main__":
    raise SystemExit(main())
