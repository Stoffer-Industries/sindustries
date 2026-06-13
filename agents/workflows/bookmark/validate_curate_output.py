#!/usr/bin/env python3
"""
Validate curate decisions artifact and apply curations to state.

Reads `brain/state/curate-output.json` (produced by Quinn's heartbeat BOOKMARK
CURATION step) and applies the proposed curations to bookmark state:
  - writes `item.curation` (a living take: createdAt, topic, score, reasoning,
    relevanceScores, threshold)
  - does NOT change reviewStatus  (the verdict lives in curation now;
    the lobster's filter_curation step reads the curation on every run)
  - logs a no-op "curation refresh" transition for audit

Idempotent:
  - skips decisions whose bookmark already has an identical curation
    (same topic + score + createdAt)
  - renames the artifact to `<output>.processed` after applying so a
    re-run (or concurrent run) won't double-apply

This is the lobster-side state machine step for the curation phase. It
mirrors the architecture used by validate_spec_output.py.
"""
from __future__ import annotations

import argparse
import datetime as dt
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

REQUIRED_DECISION_KEYS = {
    "bookmarkKey",
    "topic",
    "score",
    "reasoning",
    "threshold",
    "createdAt",
}


def validate_decision_shape(decision: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty = valid)."""
    errors: list[str] = []
    missing = REQUIRED_DECISION_KEYS - set(decision.keys())
    if missing:
        errors.append(f"missing keys: {sorted(missing)}")
    score = decision.get("score")
    if not isinstance(score, (int, float)):
        errors.append(f"score must be a number, got {type(score).__name__}")
    if not isinstance(decision.get("threshold"), (int, float)):
        errors.append("threshold must be a number")
    return errors


def build_curation(decision: dict[str, Any]) -> dict[str, Any]:
    """Convert a decision into a curation sub-object."""
    return {
        "createdAt": decision["createdAt"],
        "topic": decision["topic"],
        "score": float(decision["score"]),
        "reasoning": decision.get("reasoning", ""),
        "relevanceScores": decision.get("relevanceScores", []),
        "threshold": float(decision["threshold"]),
    }


def curation_equals(a: dict[str, Any] | None, b: dict[str, Any]) -> bool:
    """True if the proposed curation is the same as the current one.

    Compares topic, score, and createdAt — the three fields that actually
    affect downstream routing. Reasoning and relevanceScores can vary
    (e.g. LLM non-determinism) without changing the verdict.
    """
    if not a:
        return False
    return (
        a.get("topic") == b.get("topic")
        and _approx_eq(a.get("score"), b.get("score"))
        and a.get("createdAt") == b.get("createdAt")
    )


def _approx_eq(a, b, tol: float = 1e-6) -> bool:
    try:
        return abs(float(a) - float(b)) < tol
    except (TypeError, ValueError):
        return a == b


def apply_curation(state: dict[str, Any], decision: dict[str, Any]) -> tuple[str, str]:
    """Apply one decision to state. Returns (curation_topic, action)."""
    bookmark_key = decision["bookmarkKey"]
    items = state["items"]
    item = items.get(bookmark_key)
    if item is None:
        item = {"bookmarkKey": bookmark_key}

    new_curation = build_curation(decision)
    old_curation = item.get("curation")
    item["curation"] = new_curation
    item["lastUpdatedAt"] = now_iso()
    items[bookmark_key] = item
    return (
        new_curation["topic"],
        "unchanged" if curation_equals(old_curation, new_curation) else "refreshed",
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Validate curate-output.json and apply curations to state"
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
        new_curation = build_curation(decision)
        old_curation = items.get(bookmark_key, {}).get("curation")

        # Idempotency: if the proposed curation matches the current one, skip.
        if curation_equals(old_curation, new_curation):
            skipped.append({
                "bookmarkKey": bookmark_key,
                "reason": "curation already current",
                "topic": new_curation["topic"],
            })
            continue

        topic, action = apply_curation(state, decision)
        log_transition(
            bookmark_key,
            None,
            None,
            f"curation {action} (topic={topic} score={new_curation['score']})",
            transitions_path=transitions_path,
        )
        applied.append({
            "bookmarkKey": bookmark_key,
            "action": action,
            "topic": topic,
            "score": new_curation["score"],
        })

    if applied:
        save_state(state, Path(STATE_PATH))

    if applied and not args.keep_artifact:
        processed_path = input_path.with_name(input_path.name + ".processed")
        try:
            input_path.rename(processed_path)
        except OSError:
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
