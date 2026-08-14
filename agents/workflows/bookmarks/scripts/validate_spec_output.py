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
import re
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
from bookmark_state_machine import (
    effective_review_status,
    is_task_linked,
    reconcile_tasked_item,
)

WIKI_SCRIPT_ROOT = Path(__file__).resolve().parents[2] / "wiki"
if str(WIKI_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(WIKI_SCRIPT_ROOT))

from wiki_catalog import (
    configure_workspace as configure_wiki_workspace,
    event_key_for_payload,
    upsert_entry as wiki_upsert_entry,
)

H1_RE = re.compile(r"^#\s+(?:Spec\s*[—–-]+\s*)?(.*\S)\s*$", re.MULTILINE)
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)

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



def extract_spec_title_and_summary(spec_doc: str) -> tuple[str, str]:
    text = (WORKSPACE / spec_doc).read_text(encoding="utf-8")

    title_match = H1_RE.search(text)
    if title_match and title_match.group(1).strip():
        title = title_match.group(1).strip()
    else:
        title = Path(spec_doc).stem.replace("-", " ").strip().title()

    outcome_summary = ""
    match = re.search(r"^##\s+Outcome\s*$", text, re.MULTILINE)
    if match:
        tail = text[match.end() :]
        next_heading = SECTION_RE.search(tail)
        body = tail[: next_heading.start()] if next_heading else tail
        outcome_summary = normalize_summary_excerpt(body)

    if not outcome_summary:
        body_without_frontmatter = text
        if text.startswith("---\n"):
            _, _, remainder = text.partition("---\n")
            _, _, body_without_frontmatter = remainder.partition("---\n")
        outcome_summary = normalize_summary_excerpt(body_without_frontmatter)

    return title, outcome_summary or "Spec catalog entry"



def normalize_summary_excerpt(text: str, *, limit: int = 220) -> str:
    lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("- ["):
            line = re.sub(r"^- \[[ xX]\]\s*", "", line)
        elif line.startswith("- "):
            line = line[2:].strip()
        lines.append(line)
        if lines:
            break
    excerpt = re.sub(r"\s+", " ", " ".join(lines)).strip()
    if len(excerpt) > limit:
        excerpt = excerpt[: limit - 1].rstrip() + "…"
    return excerpt



def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = ["--json"]
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
    args = p.parse_args(argv)

    input_path = Path(args.input)
    configure_wiki_workspace(WORKSPACE)
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

        # Task-linked guard (task 0089f4f9): items with non-empty taskIds
        # are authoritatively `tasked`. A heartbeat spec dispatch that
        # arrives for an already-tasked item (e.g. stale Quinn re-dispatch
        # after a late spec_output.json write) must not overwrite the
        # terminal state. Reconcile and skip instead.
        if is_task_linked(item):
            repaired = reconcile_tasked_item(
                item,
                bookmark_key,
                "spec-validate: task-linked item refused spec_created transition",
                transitions_path=transitions_path,
            )
            if repaired:
                items[bookmark_key] = item
            skipped.append({
                "bookmarkKey": bookmark_key,
                "reason": "task-linked: effective reviewStatus is tasked; refusing spec_created",
                "effectiveStatus": effective_review_status(item),
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

        for spec_doc in spec_docs:
            spec_title, spec_summary = extract_spec_title_and_summary(spec_doc)
            wiki_upsert_entry(
                "spec",
                spec_doc,
                spec_title,
                spec_summary,
                event_key=event_key_for_payload(
                    "spec-ingest",
                    {
                        "source": spec_doc,
                        "title": spec_title,
                        "summary": spec_summary,
                    },
                ),
            )

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
    raise SystemExit(main(sys.argv[1:]))
