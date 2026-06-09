#!/usr/bin/env python3
"""Update bookmark state after Quinn writes a spec from heartbeat dispatch.

Reads JSON from stdin:
{
  "bookmarkKey": "...",
  "reviewDoc": "...",
  "specs": [
    {
      "title": "...",
      "specDoc": "brain/specs/<topic>/<slug>-<key>.md",
      "proposedTasks": [
        {
          "title": "...",
          "priority": "high|medium|low",
          "summary": "...",
          "deliverable": "...",
          "acceptanceCriteria": ["..."]
        }
      ]
    }
  ]
}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from common import STATE_PATH, dump_json, load_state, now_iso, save_state


def render_task_description(task: dict, spec_doc: str, review_doc: str) -> str:
    ac_lines = "\n".join(f"- [ ] {line}" for line in task["acceptanceCriteria"])
    return (
        f"**What:** {task['title']}\n"
        f"**Why:** {task['summary']}\n\n"
        f"**Deliverable:** {task['deliverable']}\n\n"
        f"**AC:**\n{ac_lines}\n\n"
        f"**Spec:** {spec_doc}\n"
        f"**Source Review:** {review_doc}"
    )


def main() -> int:
    data = json.load(sys.stdin)
    bookmark_key = data["bookmarkKey"]
    review_doc = data.get("reviewDoc", "")
    specs = data["specs"]

    state = load_state(Path(STATE_PATH))
    items = state["items"]
    item = items.get(bookmark_key, {})

    spec_docs = []
    spec_proposals = []
    for spec in specs:
        spec_doc = spec["specDoc"]
        spec_docs.append(spec_doc)
        proposed_tasks = []
        for task in spec.get("proposedTasks") or []:
            proposed_tasks.append({
                "title": task["title"],
                "priority": task["priority"],
                "assignee": None,
                "description": render_task_description(task, spec_doc, review_doc),
            })
        spec_proposals.append({
            "title": spec["title"],
            "specDoc": spec_doc,
            "proposedTasks": proposed_tasks,
        })

    item.update({
        "reviewStatus": "spec_created",
        "specDocs": spec_docs,
        "specProposals": spec_proposals,
        "lastUpdatedAt": now_iso(),
    })
    items[bookmark_key] = item
    save_state(state, Path(STATE_PATH))

    dump_json({"ok": True, "bookmarkKey": bookmark_key, "specDocs": spec_docs})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
