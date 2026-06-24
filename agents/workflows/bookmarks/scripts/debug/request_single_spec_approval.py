#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[7]
BOOKMARKS_DIR = Path(__file__).resolve().parent.parent
if str(BOOKMARKS_DIR) not in sys.path:
    sys.path.insert(0, str(BOOKMARKS_DIR))

from common import SPECS_ROOT, STATE_PATH, load_state
PREPARE_TOPIC_APPROVAL = BOOKMARKS_DIR / "prepare_topic_approval.py"
REQUEST_TOPIC_APPROVAL = BOOKMARKS_DIR / "request_topic_approval.py"
GENERATE_SPECS = BOOKMARKS_DIR / "generate_specs.py"
BUILD_TASK_PROPOSALS = BOOKMARKS_DIR / "build_task_proposals.py"


def run_json(args: list[str], stdin_payload: dict | None = None) -> dict:
    completed = subprocess.run(
        args,
        input=(json.dumps(stdin_payload) if stdin_payload is not None else None),
        text=True,
        capture_output=True,
        cwd=str(WORKSPACE),
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(args)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"invalid json from {' '.join(args)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        ) from exc


def _spec_path(spec_doc: str) -> Path | None:
    spec_doc = (spec_doc or "").strip()
    if not spec_doc:
        return None
    if spec_doc.startswith("brain/specs/"):
        return WORKSPACE / spec_doc
    return Path(SPECS_ROOT) / spec_doc


def reset_to_approval_ready(bookmark_key: str) -> dict:
    state_path = Path(STATE_PATH)
    state = load_state(state_path)
    item = state.get("items", {}).get(bookmark_key)
    if not item:
        raise SystemExit(f"bookmarkKey not found: {bookmark_key}")

    stale_spec_docs = set(item.get("specDocs") or [])
    for proposal in item.get("specProposals") or []:
        spec_doc = proposal.get("specDoc")
        if spec_doc:
            stale_spec_docs.add(spec_doc)
    for spec_doc in stale_spec_docs:
        spec_path = _spec_path(spec_doc)
        if spec_path and spec_path.exists() and spec_path.is_file():
            spec_path.unlink()

    for key in [
        "approvalId", "approvals", "approvalStatus", "approvalRequestedAt", "approvalResumeToken",
        "approvalMessageId", "approvalThreadId", "approvalResolvedAt", "latestApprovalResumeToken",
        "latestRevisionRequest", "revisionRequests", "previousApprovalIds",
        "specDocs", "specProposals", "proposedTasks", "taskProposalPayload",
    ]:
        item.pop(key, None)
    item["reviewStatus"] = "reviewed"
    state["items"][bookmark_key] = item
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    payload = {
        "implement": [{
            "bookmarkKey": item["bookmarkKey"],
            "path": item.get("path"),
            "topic": item.get("topic") or "general",
            "title": item.get("title"),
            "source": item.get("source") or "unknown",
            "link": item.get("link") or "",
            "tags": item.get("tags") or [],
            "bodyExcerpt": item.get("bodyExcerpt") or "",
            "body": item.get("body") or "",
            "analysis": item.get("analysis") or {},
            "reviewDoc": item.get("reviewDoc") or "",
            "specDocs": [],
            "specProposals": [],
        }],
        "monitoring": [],
        "reviewed": [],
    }
    generated = run_json([sys.executable, str(GENERATE_SPECS), "--json"], payload)
    proposed = run_json([sys.executable, str(BUILD_TASK_PROPOSALS), "--json"], generated)
    refreshed = load_state(state_path).get("items", {}).get(bookmark_key, {})
    return {
        "ok": True,
        "bookmarkKey": bookmark_key,
        "reviewStatus": refreshed.get("reviewStatus"),
        "specDocs": refreshed.get("specDocs") or [],
        "specProposals": refreshed.get("specProposals") or [],
        "taskProposalPayload": proposed,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Request approval for a single bookmark item already in spec_created or revision_requested state")
    p.add_argument("bookmark_key", help="bookmarkKey from brain/state/bookmark-review-state.json")
    p.add_argument("--reset-to-approval-ready", action="store_true", help="reset the bookmark to a clean approval-ready state for cron")
    p.add_argument("--topic", help="override approval topic")
    p.add_argument("--resume-token", help="optional Lobster resume token to persist with the approval")
    p.add_argument("--dry-run", action="store_true", help="show the prepared package without sending the approval")
    p.add_argument("--allow-revision-requested", action="store_true", help="also allow items currently in revision_requested")
    args = p.parse_args()

    state = load_state(Path(STATE_PATH))
    item = state.get("items", {}).get(args.bookmark_key)
    if not item:
        raise SystemExit(f"bookmarkKey not found: {args.bookmark_key}")

    if args.reset_to_approval_ready:
        print(json.dumps(reset_to_approval_ready(args.bookmark_key), indent=2))
        return 0

    if item.get("reviewStatus") == "approval_pending":
        existing_id = item.get("approvalId")
        existing_message_id = item.get("approvalMessageId")
        existing_thread_id = item.get("approvalThreadId")
        print(json.dumps({
            "ok": True,
            "status": "already_pending",
            "bookmarkKey": args.bookmark_key,
            "approvalId": existing_id,
            "approvalMessageId": existing_message_id,
            "approvalThreadId": existing_thread_id,
        }, indent=2))
        return 0

    allowed_statuses = {"spec_created"}
    if args.allow_revision_requested:
        allowed_statuses.add("revision_requested")

    if item.get("reviewStatus") not in allowed_statuses:
        raise SystemExit(
            f"bookmark {args.bookmark_key} is in reviewStatus={item.get('reviewStatus')!r}, expected one of {sorted(allowed_statuses)!r}"
        )

    approval_topic = args.topic or item.get("approvalTopic") or item.get("topic") or "general"

    implement_item = dict(item)
    implement_item["topic"] = approval_topic
    implement_item["approvalTopic"] = approval_topic
    if args.resume_token:
        implement_item["resumeToken"] = args.resume_token
        implement_item["lobsterResumeToken"] = args.resume_token

    payload = {
        "implement": [implement_item],
        "monitoring": [],
        "reviewed": [],
    }

    prepared = run_json(
        [sys.executable, str(PREPARE_TOPIC_APPROVAL), "--approval-topic", approval_topic, "--json"],
        payload,
    )

    if args.resume_token:
        prepared["resumeToken"] = args.resume_token
        for pkg in prepared.get("readyPackages", []) or []:
            pkg["resumeToken"] = args.resume_token

    if args.dry_run:
        print(json.dumps(prepared, indent=2))
        return 0

    result = run_json([sys.executable, str(REQUEST_TOPIC_APPROVAL), "--json"], prepared)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
