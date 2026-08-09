#!/usr/bin/env python3
"""Reconcile a bookmark's persisted reviewStatus to `tasked` (task 0089f4f9).

Operational runbook for AC4: repair the bookmark-review-state.json entry for
``d8311c3e5fc50b94`` (and any future task-linked bookmark that has drifted
out of `tasked` because of a stale pipeline pass) without hand-editing the
JSON or risking duplicate transition entries.

The script is intentionally narrow:
  - Verifies non-empty taskIds for the target bookmark.
  - Reconciles reviewStatus to `tasked` with a transition log entry.
  - Optionally records a `tweetLog` backfill skip reason (e.g.
    "backfill_not_posted:late_and_author_unresolved") for AC4.
  - Never posts externally. The companion ``x_author_tweet.py`` helper is
    the only path that can post to X.

Usage:
    reconcile_tasked_state.py --key <bookmarkKey> [--backfill-skip-reason <reason>]
    reconcile_tasked_state.py --key <bookmarkKey> --dry-run

Exit codes:
  0  repair applied (or no-op when already consistent)
  1  bookmark not found
  2  taskIds empty — refuse to reconcile, the invariant is the whole point
  3  unexpected I/O / parse error
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
    save_state,
    transition_log_path,
)
from bookmark_state_machine import (
    is_task_linked,
    reconcile_tasked_item,
)


def reconcile(
    bookmark_key: str,
    *,
    backfill_skip_reason: str | None = None,
    state_path: Path = Path(STATE_PATH),
    dry_run: bool = False,
) -> dict:
    """Reconcile a single bookmark. Returns a summary dict.

    Idempotent: a second call on the same bookmark is a no-op.
    """
    state = load_state(state_path)
    items = state.get("items", {})
    item = items.get(bookmark_key)
    if item is None:
        return {"ok": False, "bookmarkKey": bookmark_key, "error": "bookmark not found in state"}

    if not is_task_linked(item):
        return {
            "ok": False,
            "bookmarkKey": bookmark_key,
            "error": "taskIds is empty; refuse to mark as tasked (invariant violation)",
            "reviewStatus": item.get("reviewStatus"),
            "taskIds": item.get("taskIds", []),
        }

    previous_status = item.get("reviewStatus")
    transitions_path = transition_log_path(state_path)
    will_repair = previous_status != "tasked"
    summary = {
        "ok": True,
        "bookmarkKey": bookmark_key,
        "previousStatus": previous_status,
        "repaired": will_repair,
        "taskIds": list(item.get("taskIds") or []),
        "settings": {
            "statePath": str(state_path),
            "dryRun": dry_run,
        },
    }

    if backfill_skip_reason:
        existing_tweet_log = item.get("tweetLog")
        if isinstance(existing_tweet_log, dict) and existing_tweet_log.get("status") in {"posted", "skipped", "error"}:
            summary["tweetLog"] = {
                "action": "preserved",
                "status": existing_tweet_log.get("status"),
            }
        else:
            summary["tweetLog"] = {
                "action": "would_set" if dry_run else "set",
                "status": "skipped",
                "error": backfill_skip_reason,
            }
            if not dry_run:
                item["tweetLog"] = {
                    "status": "skipped",
                    "error": backfill_skip_reason,
                }

    if dry_run:
        summary["dryRun"] = True
        return summary

    repaired = reconcile_tasked_item(
        item,
        bookmark_key,
        "reconcile_tasked_state.py: explicit operator reconciliation",
        transitions_path=transitions_path,
    )
    summary["repaired"] = repaired or summary["repaired"]
    if repaired or backfill_skip_reason:
        items[bookmark_key] = item
        save_state(state, state_path)
    return summary


def main() -> int:
    p = argparse.ArgumentParser(description="Reconcile a bookmark's reviewStatus to tasked")
    p.add_argument("--key", required=True, help="Bookmark key (16-char hex digest) to reconcile")
    p.add_argument(
        "--backfill-skip-reason",
        default=None,
        help="Persisted tweetLog backfill skip reason (e.g. backfill_not_posted:late_and_author_unresolved). "
             "Only writes when no terminal tweetLog already exists.",
    )
    p.add_argument(
        "--state-path",
        default=str(STATE_PATH),
        help="Override path to bookmark-review-state.json (testing only).",
    )
    p.add_argument("--dry-run", action="store_true", help="Compute the diff without writing")
    p.add_argument("--json", action="store_true", help="Emit JSON result")
    args = p.parse_args()

    summary = reconcile(
        args.key,
        backfill_skip_reason=args.backfill_skip_reason,
        state_path=Path(args.state_path),
        dry_run=args.dry_run,
    )

    if args.json:
        dump_json(summary)
    else:
        if not summary.get("ok"):
            print(f"refused: {summary.get('error')}", file=sys.stderr)
            return 2 if "taskIds is empty" in (summary.get("error") or "") else 1
        action = "repaired" if summary.get("repaired") else "no-op"
        print(f"{action}: {args.key} (previous={summary.get('previousStatus')!r})")
        if "tweetLog" in summary:
            print(f"  tweetLog: {summary['tweetLog']}")

    if not summary.get("ok"):
        if "taskIds is empty" in (summary.get("error") or ""):
            return 2
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
