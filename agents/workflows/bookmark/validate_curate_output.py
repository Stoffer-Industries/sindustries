#!/usr/bin/env python3
"""
Validate curate decisions artifact and apply state transitions.

Reads `brain/state/curate-output.json` (produced by Quinn's heartbeat BOOKMARK CURATION step) and applies
the proposed transitions to bookmark state:
  - mutates `lastCuratedAt`, `relevanceScore`, `relevanceTopic`,
    `relevanceScores`, `reviewStatus`, and optionally `approvalTopic`
  - logs the transition in bookmark-transitions.jsonl
  - saves bookmark-review-state.json

Idempotent:
  - skips decisions whose bookmark is already in the target `reviewStatus`
  - renames the artifact to `<output>.processed` after applying so a
    re-run (or concurrent run) won't double-apply

This is the lobster-side state machine step for the curation phase. It
mirrors the architecture used by validate_spec_output.py.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    STATE_ROOT,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
)

DEFAULT_OUTPUT = STATE_ROOT / "curate-output.json"

VALID_NEW_STATUSES = {"queued_for_spec", "monitoring"}
REQUIRED_DECISION_KEYS = {
    "bookmarkKey",
    "newStatus",
    "primaryScore",
    "primaryTopic",
    "lastCuratedAt",
}


def validate_decision_shape(decision: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty = valid)."""
    errors: list[str] = []
    missing = REQUIRED_DECISION_KEYS - set(decision.keys())
    if missing:
        errors.append(f"missing keys: {sorted(missing)}")
    if decision.get("newStatus") not in VALID_NEW_STATUSES:
        errors.append(
            f"newStatus must be one of {sorted(VALID_NEW_STATUSES)}, "
            f"got {decision.get('newStatus')!r}"
        )
    score = decision.get("primaryScore")
    if not isinstance(score, (int, float)):
        errors.append(f"primaryScore must be a number, got {type(score).__name__}")
    return errors


def apply_decision(state: dict[str, Any], decision: dict[str, Any]) -> str:
    """Apply one decision to state. Returns the new reviewStatus."""
    bookmark_key = decision["bookmarkKey"]
    items = state["items"]
    item = items.get(bookmark_key)
    if item is None:
        # No state row yet — create a minimal one so the transition is still logged.
        item = {"bookmarkKey": bookmark_key}

    new_status = decision["newStatus"]

    item["lastCuratedAt"] = decision["lastCuratedAt"]
    item["relevanceScore"] = float(decision["primaryScore"])
    item["relevanceTopic"] = decision["primaryTopic"]
    if "relevanceScores" in decision:
        item["relevanceScores"] = decision["relevanceScores"]
    item["reviewStatus"] = new_status
    if new_status == "queued_for_spec" and decision.get("approvalTopic"):
        item["approvalTopic"] = decision["approvalTopic"]
    item["lastUpdatedAt"] = now_iso()

    items[bookmark_key] = item
    return new_status


def main() -> int:
    p = argparse.ArgumentParser(
        description="Validate curate-output.json and apply state transitions"
    )
    p.add_argument(
        "--input",
        default=str(DEFAULT_OUTPUT),
        help="Path to curate-output.json (default: brain/state/curate-output.json)",
    )
    p.add_argument(
        "--keep-artifact",
        action="store_true",
        help="Do not rename the input to <name>.processed after applying.",
    )
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    input_path = Path(args.input)
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []

    if not input_path.exists():
        payload = {
            "ok": True,
            "input": str(input_path),
            "applied": [],
            "skipped": [],
            "invalid": [],
            "note": "no artifact to validate (heartbeat curate has not run since last apply)",
        }
        if args.json:
            dump_json(payload)
        else:
            print("curate: no artifact found, nothing to do")
        return 0

    try:
        artifact = json.loads(input_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        payload = {
            "ok": False,
            "input": str(input_path),
            "error": f"artifact is not valid JSON: {e}",
        }
        if args.json:
            dump_json(payload)
        else:
            print(f"curate-validate: invalid JSON: {e}", flush=True)
        return 1

    decisions = artifact.get("decisions", [])
    state = load_state(Path(STATE_PATH))
    items = state["items"]
    transitions_path = transition_log_path(Path(STATE_PATH))

    for decision in decisions:
        shape_errors = validate_decision_shape(decision)
        if shape_errors:
            invalid.append({
                "bookmarkKey": decision.get("bookmarkKey"),
                "errors": shape_errors,
            })
            continue

        bookmark_key = decision["bookmarkKey"]
        new_status = decision["newStatus"]
        previous_status = (
            decision.get("previousStatus")
            or items.get(bookmark_key, {}).get("reviewStatus")
        )

        # Idempotency: if the bookmark is already in the target state, skip.
        current = items.get(bookmark_key, {}).get("reviewStatus")
        if current == new_status:
            skipped.append({
                "bookmarkKey": bookmark_key,
                "reason": "already in target reviewStatus",
                "reviewStatus": current,
            })
            continue

        apply_decision(state, decision)
        log_transition(
            bookmark_key,
            previous_status,
            new_status,
            decision.get("reason", ""),
            transitions_path=transitions_path,
        )
        applied.append({
            "bookmarkKey": bookmark_key,
            "previousStatus": previous_status,
            "newStatus": new_status,
            "primaryScore": decision.get("primaryScore"),
            "primaryTopic": decision.get("primaryTopic"),
        })

    if applied:
        save_state(state, Path(STATE_PATH))

    if applied and not args.keep_artifact:
        processed_path = input_path.with_name(input_path.name + ".processed")
        try:
            input_path.rename(processed_path)
        except OSError:
            # Last-resort: leave the file in place. Next run will be a no-op
            # because every decision will be skipped.
            pass

    payload = {
        "ok": True,
        "input": str(input_path),
        "applied": applied,
        "skipped": skipped,
        "invalid": invalid,
    }
    if args.json:
        dump_json(payload)
    else:
        print(
            f"curate-validate: applied={len(applied)} "
            f"skipped={len(skipped)} invalid={len(invalid)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
