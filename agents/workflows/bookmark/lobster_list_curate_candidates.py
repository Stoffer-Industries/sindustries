#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from common import BOOKMARKS_ROOT, SPECS_ROOT, STATE_PATH, WORKSPACE, bookmark_record, dump_json, find_bookmark_files, load_state, log_transition, now_iso, save_state, transition_log_path

try:
    from tasks_api_client import get_base_url, list_tasks
except Exception:  # noqa: BLE001
    get_base_url = None
    list_tasks = None

try:
    from lobster_create_tasks_from_proposals import proposal_marker
except Exception:  # noqa: BLE001
    proposal_marker = None


CURRENT_REVIEW_STATUSES = {
    "ingested",
    "summarized",
    "needs_research",
    "spec_requested",
    "spec_created",
    "approval_pending",
    "revision_requested",
    "revision_staged",
    "tasked",
    "declined",
}


def _spec_doc_path(spec_doc: str) -> Path:
    spec_doc = (spec_doc or "").strip()
    if not spec_doc:
        return SPECS_ROOT
    if spec_doc.startswith("brain/bookmarks/specs/") or spec_doc.startswith("brain/specs/"):
        return WORKSPACE / spec_doc
    return SPECS_ROOT / spec_doc


def _proposal_markers(item: dict) -> set[str]:
    if proposal_marker is None:
        return set()
    markers = set()
    bookmark_key = item.get("bookmarkKey")
    spec_docs = item.get("specDocs") or []
    for proposal in item.get("specProposals") or []:
        for task in proposal.get("proposedTasks") or []:
            if bookmark_key:
                markers.add(proposal_marker(bookmark_key, spec_docs, task))
    return markers


def _reconcile_stale_pending_with_existing_tasks(items: dict) -> int:
    if not get_base_url or not list_tasks:
        return 0
    try:
        base_url = get_base_url()
        tasks = list_tasks(limit=500, base_url=base_url)
    except BaseException:  # noqa: BLE001
        return 0

    active_by_marker = {}
    for task in tasks:
        if task.get("status") == "done" or task.get("completedAt") or task.get("archivedAt"):
            continue
        for tag in task.get("tags") or []:
            if isinstance(tag, str) and tag.startswith("proposal:"):
                active_by_marker[tag] = str(task.get("id"))

    repaired = 0
    timestamp = now_iso()
    for key, item in items.items():
        if item.get("reviewStatus") not in {"approval_pending", "revision_staged"}:
            continue
        if item.get("taskIds"):
            continue
        markers = _proposal_markers(item)
        if not markers:
            continue
        matched_task_ids = [active_by_marker[m] for m in markers if m in active_by_marker]
        if not matched_task_ids:
            continue
        previous_status = item.get("reviewStatus")
        item.update({
            "approvalStatus": "approved",
            "approvalResolvedAt": timestamp,
            "approvalId": None,
            "approvalResumeToken": None,
            "reviewStatus": "tasked",
            "taskIds": sorted(dict.fromkeys(matched_task_ids)),
            "lastUpdatedAt": timestamp,
        })
        items[key] = item
        log_transition(key, previous_status, "tasked", "reconciled stale approval-pending with existing tasks", transitions_path=transition_log_path(STATE_PATH))
        repaired += 1
    return repaired


def main() -> int:
    # Clean up stale reviewDoc and specDoc references (files that no longer exist)
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})
    # Index spec files by bookmark key suffix in filename (*-<bookmarkKey>.md)
    inferred_specs_by_key = {}
    for spec_path in SPECS_ROOT.glob("**/*.md"):
        stem = spec_path.stem
        if "-" not in stem:
            continue
        candidate_key = stem.rsplit("-", 1)[-1].lower()
        if len(candidate_key) == 16 and all(c in "0123456789abcdef" for c in candidate_key):
            inferred_specs_by_key.setdefault(candidate_key, []).append(str(spec_path.relative_to(WORKSPACE)))

    cleaned = 0
    repaired_pending = _reconcile_stale_pending_with_existing_tasks(items)
    cleaned += repaired_pending
    for key, item in items.items():
        # Check reviewDoc - if it exists but file is gone, clear everything
        if item.get("reviewDoc"):
            review_path = WORKSPACE / item["reviewDoc"]
            if not review_path.exists():
                item.pop("reviewDoc", None)
                item.pop("analysis", None)
                item.pop("reviewProvenance", None)
                item.pop("reviewedAt", None)
                if item.get("reviewStatus") not in CURRENT_REVIEW_STATUSES and not item.get("summaryDoc") and not item.get("taskIds"):
                    item.pop("reviewStatus", None)
                cleaned += 1
        # Also check if reviewStatus exists but reviewDoc doesn't.
        # In the new curation pipeline, items in summarized/monitoring/spec states
        # don't need a reviewDoc — curation score is the signal. Only clear status
        # on items that used the old review classification system and now have no doc.
        elif item.get("reviewStatus"):
            if item.get("reviewStatus") not in CURRENT_REVIEW_STATUSES and not item.get("summaryDoc") and not item.get("taskIds"):
                item.pop("reviewStatus", None)
                cleaned += 1
        # Check specDocs - keep only valid paths
        if item.get("specDocs"):
            valid_specs = [s for s in item.get("specDocs", []) if _spec_doc_path(s).exists()]
            if len(valid_specs) != len(item.get("specDocs", [])):
                item["specDocs"] = valid_specs
                # If specs are missing but review exists, keep the review - just allow specs to regenerate
                # Only clear reviewStatus if there's no reviewDoc either
                if (
                    not valid_specs
                    and not item.get("reviewDoc")
                    and not item.get("summaryDoc")
                    and item.get("reviewStatus") not in CURRENT_REVIEW_STATUSES
                ):
                    item.pop("reviewStatus", None)
                cleaned += 1

        # Recovery: if specs exist on disk but state lost specDocs, restore linkage and move back to spec_created.
        if not item.get("specDocs"):
            inferred = inferred_specs_by_key.get(key, [])
            if inferred:
                item["specDocs"] = sorted(inferred)
                if (item.get("specProposals") or []) and item.get("reviewStatus") not in {"approval_pending", "revision_staged"} and not item.get("taskIds"):
                    previous_status = item.get("reviewStatus")
                    item["reviewStatus"] = "spec_created"
                    log_transition(key, previous_status, "spec_created", "inferred specs found on disk; restoring spec_created", transitions_path=transition_log_path(STATE_PATH))
                cleaned += 1
    if cleaned:
        save_state(state, Path(STATE_PATH))
        import sys
        parts = []
        if repaired_pending:
            parts.append(f"reconciled {repaired_pending} stale approval-pending item(s)")
        stale_count = cleaned - repaired_pending
        if stale_count:
            parts.append(f"cleared {stale_count} stale file reference(s)")
        print(f"[CLEANUP] {'; '.join(parts)}", file=sys.stderr)

    p = argparse.ArgumentParser(description="List bookmark review candidates")
    p.add_argument("--source-root", default=str(BOOKMARKS_ROOT / "x"))
    p.add_argument("--source", default="any")
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    root = Path(args.source_root)
    if not root.is_absolute():
        root = (WORKSPACE / root).resolve()
    state = load_state(Path(STATE_PATH))
    items = state.get("items", {})

    candidates = []
    for path in find_bookmark_files(root):
        record = bookmark_record(path)
        if args.source != "any" and record["source"] != args.source:
            continue
        existing = items.get(record["bookmarkKey"], {})
        
        # Check if we have a valid review on disk - if so, skip (never rewrite)
        if existing.get("reviewDoc"):
            review_path = WORKSPACE / existing["reviewDoc"]
            if review_path.exists():
                # Review exists - check content to see if it's "implement" but no specs.
                # Two signals: old explicit classification OR new curation score.
                content = review_path.read_text()
                has_implement_classification = (
                    "Classified as 'implement'" in content
                    or str((existing.get('analysis') or {}).get('classification') or '').strip().lower() == 'implement'
                )
                curation = existing.get('curation') or {}
                curation_score = float(curation.get('score') or 0)
                curation_threshold = float(curation.get('threshold') or 7)
                has_high_signal_curation = curation_score >= curation_threshold

                if has_implement_classification or has_high_signal_curation:
                    # Check if specs exist
                    valid_specs = [s for s in existing.get("specDocs", []) if _spec_doc_path(s).exists()]
                    if not valid_specs:
                        # Has implement classification but no specs - allow spec generation but skip review regeneration
                        record["skipReview"] = True
                    else:
                        # Recovery path: if spec/proposal work exists but approval/task materialization
                        # hasn't happened yet, keep bookmark in pipeline for approval packaging.
                        has_unmaterialized_spec_work = (
                            (existing.get("specProposals") or [])
                            and existing.get("reviewStatus") not in {"approval_pending", "revision_staged", "declined"}
                            and existing.get("approvalStatus") != "declined"
                            and not (existing.get("taskIds") or [])
                        )
                        if has_unmaterialized_spec_work:
                            record["skipReview"] = True
                        else:
                            continue  # fully processed: has specs and no remaining approval/task work
                else:
                    # Not implement - skip entirely, review already exists
                    continue
        
        # If no review on disk, allow processing
        
        record["existingState"] = existing
        candidates.append(record)
        if len(candidates) >= args.limit:
            break

    payload = {
        "ok": True,
        "generatedAt": now_iso(),
        "count": len(candidates),
        "statePath": str(Path(STATE_PATH)),
        "candidates": candidates,
    }
    if args.json:
        dump_json(payload)
    else:
        print(f"{len(candidates)} candidates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
