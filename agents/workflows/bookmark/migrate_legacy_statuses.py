#!/usr/bin/env python3
"""
Migrate legacy and malformed reviewStatus values to current equivalents.

Changes applied:
  - reviewed      → summarized  (pre-curation era items; re-enter pipeline for evaluation)
  - summarised    → summarized  (typo normalization)
  - None/missing  → summarized  (items with no status; treat as newly ingested)

Revision statuses (revision_requested, revision_staged) are NOT touched — they are
live states used by handle_approval_reply.py and generate_specs.py.

Terminal statuses (tasked, declined) are NOT touched.

Run dry-run first (default), then --apply to commit.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import STATE_PATH, log_transition, now_iso, save_state, transition_log_path

MIGRATIONS: dict[str | None, str] = {
    "reviewed": "summarized",
    "summarised": "summarized",
    None: "summarized",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write changes to disk (default: dry run)")
    args = parser.parse_args()

    state_path = Path(STATE_PATH)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    items = state.get("items", {})
    tlog = transition_log_path(state_path)

    changed: list[dict] = []
    for key, item in items.items():
        old = item.get("reviewStatus") or None
        new = MIGRATIONS.get(old)
        if new is None:
            continue
        # Items with no status but with taskIds are in a done state — use tasked.
        if old is None and item.get("taskIds"):
            new = "tasked"
        changed.append({"key": key, "title": item.get("title", key)[:60], "from": old, "to": new})

    print(f"{'DRY RUN — ' if not args.apply else ''}Found {len(changed)} item(s) to migrate:\n")
    by_pair: dict[tuple, list] = {}
    for c in changed:
        by_pair.setdefault((c["from"], c["to"]), []).append(c)
    for (old_status, new_status), entries in sorted(by_pair.items(), key=lambda x: str(x[0])):
        print(f"  {old_status!r} → {new_status!r}  ({len(entries)} items)")
        for e in entries[:5]:
            print(f"    - {e['key'][:20]}  {e['title']}")
        if len(entries) > 5:
            print(f"    ... and {len(entries) - 5} more")

    if not args.apply:
        print("\nRe-run with --apply to commit.")
        return 0

    ts = now_iso()
    for c in changed:
        item = items[c["key"]]
        item["reviewStatus"] = c["to"]
        item["lastUpdatedAt"] = ts
        log_transition(c["key"], c["from"], c["to"], "legacy status migration", transitions_path=tlog)

    save_state(state, state_path)
    print(f"\nApplied {len(changed)} migration(s) and saved state.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
