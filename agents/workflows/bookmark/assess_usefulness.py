#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, now_iso


def main() -> int:
    data = json.load(__import__("sys").stdin)
    reviews = data.get("summaries") or data.get("reviews", [])
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    implement = []
    monitoring = []
    reviewed = []
    for review in reviews:
        bookmark_key = review.get("bookmarkKey")
        state_item = items.get(bookmark_key, {})
        status = review.get("reviewStatus") or state_item.get("reviewStatus")
        classification = str((review.get("analysis") or {}).get("classification") or (state_item.get("analysis") or {}).get("classification") or "").strip().lower()

        # Recovery-friendly routing:
        # - queued_for_spec is the normal post-review actionable state for implement-classified bookmarks.
        # - spec_created means implementation-worthy work already exists and should flow to approval packaging.
        # - items with spec proposals but no tasks/approval also need to re-enter implement flow.
        has_unmaterialized_spec_work = bool(state_item.get("specProposals")) and not state_item.get("taskIds")
        if status in {"queued_for_spec", "spec_created"} or has_unmaterialized_spec_work or (classification == "implement" and status not in {"tasked", "declined", "approval_pending", "revision_staged"}):
            implement.append(review)
        elif status == "monitoring":
            monitoring.append(review)
        else:
            reviewed.append(review)

    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "implement": implement,
        "monitoring": monitoring,
        "reviewed": reviewed,
        "statePath": str(STATE_PATH),
        "stateCount": len(items),
    }
    dump_json(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
