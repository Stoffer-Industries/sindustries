#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, log_transition, now_iso, save_state, transition_log_path, get_approval_topic
from x_author_tweet import try_post_author_tweet

logger = logging.getLogger("bookmark.lobster_resolve_spec_request")

# Default tasks-api base URL — same default the x_author_tweet module
# uses internally. Override via TASKS_API_BASE_URL env var when the
# lobster runs against a non-local tasks-api (CI, prod).
_TASKS_API_BASE_URL = os.getenv("TASKS_API_BASE_URL", "http://localhost:4001/api/v1")


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
    resolved_topics: set[str] = set()
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
            state_topic = get_approval_topic(state_item)
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
                # Approve path. `tasked` means the spec has proposals and
                # task IDs were created — work is in flight. `approved` is
                # the terminal state for specs that Tom approved but
                # generated no tasks (the spec is the artifact, no work
                # needs to happen downstream). The dashboard buckets these
                # distinctly so Tom can see at a glance what's done vs
                # what's actively being worked.
                next_status = "tasked" if merged_task_ids else "approved"
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

            # AC1 / AC2 / AC5: best-effort reply tweet at the original X
            # author when the bookmark was X-sourced AND landed in `tasked`
            # AND produced at least one task ID. The `tasked` gate is
            # critical: if no tasks were created (the spec was the artifact),
            # we must NOT post a tweet because there is no work to mention
            # to the original author. Non-X sources are filtered at the
            # helper boundary and the resulting `skipped / non_x_source`
            # payload is intentionally NOT persisted — AC2 says non-X
            # sources MUST skip without writing a tweetLog. Any exception
            # inside the tweet helper is swallowed so the approval always
            # resolves cleanly (AC3).
            if next_status == "tasked" and (state_item.get("source") or "").lower() == "x":
                try:
                    tweet_log = try_post_author_tweet(
                        state_item,
                        tasks_api_base_url=_TASKS_API_BASE_URL,
                    )
                except Exception as exc:  # pragma: no cover - defensive guard
                    logger.warning("author-tweet step raised for %s: %s", bookmark_key, exc)
                    tweet_log = {"status": "error", "error": f"unexpected:{exc}"}
                # Every outcome from an X-source attempt is operationally
                # relevant, including malformed/missing links. Persist it so
                # a skipped attempt is visible rather than silently lost.
                # Non-X sources still never enter this branch (AC2).
                if tweet_log:
                    # Carry over the author handle for downstream surfaces
                    # that want to render the @-mention without re-parsing
                    # `link`. Canonical /i/web/status links have no handle,
                    # so preserve any denormalised authorHandle from ingest.
                    parsed = None
                    try:
                        from x_author_tweet import parse_x_link
                        parsed = parse_x_link(state_item.get("link"))
                    except Exception:
                        parsed = None
                    author_handle = (parsed[0] if parsed else None) or state_item.get("authorHandle")
                    if author_handle and "authorHandle" not in tweet_log:
                        tweet_log["authorHandle"] = author_handle
                    state_item["tweetLog"] = tweet_log

            resolved_items.append({
                "bookmarkKey": bookmark_key,
                "reviewStatus": next_status,
                "taskIds": merged_task_ids,
            })

        # Track topics we resolved so we can release the global lock entry.
        # below. Track even if no items were actually resolved (a topic
        # can appear in the input without any in-flight items, and the
        # caller still expects the slot to be free for the next run).
        if resolved_items:
            resolved_topics.add(topic)
        resolved.append({
            "topic": topic,
            "decision": resolution_status,
            "items": resolved_items,
        })

    # Release the global approval lock entry for the approval we just resolved,
    # so the topic slot becomes available again for the next package.
    locks = state.setdefault("approvalLocks", {})
    for topic in resolved_topics:
        locks.pop(topic, None)

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
