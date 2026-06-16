#!/usr/bin/env python3
"""
Validate spec-generation artifact and apply state transitions.

Reads `brain/state/spec-output.json` (produced by Quinn's heartbeat spec
dispatch) and applies the proposed transitions to bookmark state:
  - mutates `reviewStatus` to `spec_created`
  - stores `specDocs` and `specProposals` (title + specDoc, no task data)
  - logs the transition in bookmark-transitions.jsonl
  - saves bookmark-review-state.json

Task proposals are read directly from the spec markdown at approval time
(by lobster_create_tasks_from_proposals.py). They are not stored here.

Validations:
  - each `specDoc` must exist on disk before the state is updated

Idempotent:
  - rejects entries unless the existing bookmark is awaiting a spec
  - renames the artifact to `<name>.processed` after applying so a
    re-run (or concurrent run) won't double-apply

Heartbeat's job ends at spec_created. The lobster cron detects spec_created
items (including revisions) and sends the approval request with a proper
resume token. Do not trigger approval delivery from here.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from common import (
    STATE_PATH,
    STATE_ROOT,
    WORKSPACE,
    dump_json,
    load_state,
    log_transition,
    now_iso,
    save_state,
    transition_log_path,
)

DEFAULT_OUTPUT = STATE_ROOT / "spec-output.json"
REQUIRED_SPEC_KEYS = {"title", "specDoc"}


def validate_entry_shape(entry: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not entry.get("bookmarkKey"):
        errors.append("missing bookmarkKey")
    if entry.get("requestType") not in {"new", "revision", None}:
        errors.append(f"invalid requestType: {entry.get('requestType')!r}")
    specs = entry.get("specs")
    if not isinstance(specs, list) or not specs:
        errors.append("specs must be a non-empty list")
        return errors
    for i, spec in enumerate(specs):
        missing = REQUIRED_SPEC_KEYS - set(spec.keys())
        if missing:
            errors.append(f"specs[{i}] missing keys: {sorted(missing)}")
    return errors


def build_proposals(entry: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    spec_docs: list[str] = []
    spec_proposals: list[dict[str, Any]] = []
    for spec in entry["specs"]:
        spec_doc = spec["specDoc"]
        spec_docs.append(spec_doc)
        spec_proposals.append({
            "title": spec["title"],
            "specDoc": spec_doc,
        })
    return spec_docs, spec_proposals



def main() -> int:
    p = argparse.ArgumentParser(
        description="Validate spec-output.json and apply state transitions"
    )
    p.add_argument(
        "--input",
        default=str(DEFAULT_OUTPUT),
        help="Path to spec-output.json (default: brain/state/spec-output.json)",
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
            "note": "no artifact to validate (heartbeat spec dispatch has not run since last apply)",
        }
        if args.json:
            dump_json(payload)
        else:
            print("spec-validate: no artifact found, nothing to do")
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
            print(f"spec-validate: invalid JSON: {e}", flush=True)
        return 1

    entries = artifact.get("entries", [])
    state = load_state(Path(STATE_PATH))
    items = state["items"]
    transitions_path = transition_log_path(Path(STATE_PATH))

    for entry in entries:
        shape_errors = validate_entry_shape(entry)
        if shape_errors:
            invalid.append({
                "bookmarkKey": entry.get("bookmarkKey"),
                "errors": shape_errors,
            })
            continue

        bookmark_key = entry["bookmarkKey"]
        item = items.get(bookmark_key)
        if item is None:
            invalid.append({
                "bookmarkKey": bookmark_key,
                "errors": ["bookmarkKey does not exist in review state"],
            })
            continue

        current = item.get("reviewStatus")
        if current not in {"spec_requested", "revision_requested"}:
            invalid.append({
                "bookmarkKey": bookmark_key,
                "errors": [
                    "bookmark reviewStatus must be spec_requested or revision_requested, "
                    f"got {current!r}"
                ],
            })
            continue

        spec_docs, spec_proposals = build_proposals(entry)

        # Spec files must exist on disk before we mark spec_created.
        missing_files = [
            doc for doc in spec_docs if not (WORKSPACE / doc).exists()
        ]
        if missing_files:
            invalid.append({
                "bookmarkKey": bookmark_key,
                "errors": [f"spec file(s) missing on disk: {missing_files}"],
            })
            continue

        previous_status = item.get("reviewStatus")
        item.update({
            "reviewStatus": "spec_created",
            "specDocs": spec_docs,
            "specProposals": spec_proposals,
            "lastUpdatedAt": now_iso(),
        })
        items[bookmark_key] = item
        log_transition(
            bookmark_key,
            previous_status,
            "spec_created",
            f"heartbeat spec dispatch wrote {len(spec_docs)} spec(s)",
            transitions_path=transitions_path,
        )
        applied.append({
            "bookmarkKey": bookmark_key,
            "previousStatus": previous_status,
            "specDocs": spec_docs,
            "requestType": entry.get("requestType", "new"),
        })

        # Revision approval re-send is the lobster's job — it detects spec_created
        # and sends a new approval with a proper resume token on the next cron run.

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
            f"spec-validate: applied={len(applied)} "
            f"skipped={len(skipped)} invalid={len(invalid)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
