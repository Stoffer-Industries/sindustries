#!/usr/bin/env python3
"""
Validate spec-generation artifact and apply state transitions.

Reads `brain/state/spec-output.json` (produced by Quinn's heartbeat spec
dispatch) and applies the proposed transitions to bookmark state:
  - mutates `reviewStatus` to `spec_created`
  - stores `specDocs` and `specProposals`
  - logs the transition in bookmark-transitions.jsonl
  - saves bookmark-review-state.json

Validations:
  - each `specDoc` must exist on disk before the state is updated
  - each entry's `proposedTasks` (if present) must be a list of
    well-formed task dicts (title, priority, summary, deliverable,
    acceptanceCriteria list)

Idempotent:
  - rejects entries unless the existing bookmark is awaiting a spec
  - renames the artifact to `<name>.processed` after applying so a
    re-run (or concurrent run) won't double-apply

For revision entries, also calls `rebuild_revised_approval.py` to
regenerate the approval package for Tom — same behavior as the old
inline call from heartbeat.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
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
VALID_PRIORITIES = {"high", "medium", "low"}
REQUIRED_TASK_KEYS = {"title", "priority", "summary", "deliverable", "acceptanceCriteria"}
REQUIRED_SPEC_KEYS = {"title", "specDoc", "proposedTasks"}


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
            continue
        tasks = spec.get("proposedTasks") or []
        for j, task in enumerate(tasks):
            task_missing = REQUIRED_TASK_KEYS - set(task.keys())
            if task_missing:
                errors.append(
                    f"specs[{i}].proposedTasks[{j}] missing keys: {sorted(task_missing)}"
                )
            if task.get("priority") not in VALID_PRIORITIES:
                errors.append(
                    f"specs[{i}].proposedTasks[{j}].priority must be one of "
                    f"{sorted(VALID_PRIORITIES)}, got {task.get('priority')!r}"
                )
            if not isinstance(task.get("acceptanceCriteria"), list):
                errors.append(
                    f"specs[{i}].proposedTasks[{j}].acceptanceCriteria must be a list"
                )
    return errors


def build_proposals(entry: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    spec_docs: list[str] = []
    spec_proposals: list[dict[str, Any]] = []
    review_doc = entry.get("reviewDoc", "")
    for spec in entry["specs"]:
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
    return spec_docs, spec_proposals


def rebuild_revised_approval(bookmark_key: str) -> tuple[bool, str]:
    """Call rebuild_revised_approval.py for revision entries."""
    script = (
        Path(__file__).resolve().parent / "rebuild_revised_approval.py"
    )
    if not script.exists():
        return False, f"rebuild_revised_approval.py not found at {script}"
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--bookmark-key",
                bookmark_key,
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return False, f"exit {result.returncode}: {result.stderr.strip()}"
        return True, "ok"
    except subprocess.TimeoutExpired:
        return False, "timed out"
    except Exception as e:  # pragma: no cover - defensive
        return False, str(e)


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
    revision_rebuilds: list[dict[str, Any]] = []

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

        if entry.get("requestType") == "revision":
            ok, detail = rebuild_revised_approval(bookmark_key)
            revision_rebuilds.append({
                "bookmarkKey": bookmark_key,
                "ok": ok,
                "detail": detail,
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
        "revisionRebuilds": revision_rebuilds,
    }
    if args.json:
        dump_json(payload)
    else:
        print(
            f"spec-validate: applied={len(applied)} "
            f"skipped={len(skipped)} invalid={len(invalid)} "
            f"revisions={len(revision_rebuilds)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
