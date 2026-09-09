#!/usr/bin/env python3
"""WS3 classification routing helpers (task 536e04fc).

Pure routing logic — no state mutation, no I/O other than the optional
triage-queue append via `_append_triage_events`. Shared between
`lobster_request_spec_approval.py` (Phase 0) and the new
`lobster_route_specs.py` step that lifts direct/ambiguous routing ahead of
the YAML `approval: required` halt.

Three sub-buckets per implement item:
- ROUTE_FEATURE   — keep today's flow (Tom reviews + approval)
- ROUTE_DIRECT    — skip approval, downstream calls Tasks API create with
                    taskType=classification (code | research)
- ROUTE_AMBIGUOUS — no approval, no task; emit bookmark-triage-needed
                    event so WS4 cron can surface it for manual triage

Routing priority is: ambiguous > feature > direct. If no classifications
are present (state pre-dates WS3 contract), the item falls back to feature
to preserve today's flow.

Invalid-output handling (malformed JSON, wrong enum, missing field, LLM
error, empty spec) maps to `ambiguous` so the pipeline never silently
coerces to a wrong route.

AC3 reliability fix (2026-09-08 Quinn handoff): the YAML `approval: required`
flag on the `request_spec_approval` step halts the pipeline in `--mode tool`
even when `readyPackages` is empty (only-direct batch). To make AC3
reliably reachable, route_specs.py runs the routing + triage-append +
compact-preview steps here, ahead of the approval halt. The approval-halt
step then only fires when a feature item is actually present in
`readyPackages`. The downstream `create_tasks_from_direct` is wired to
read `directCreateItems` from this step's output — bypassing the approval
halt entirely so a code/research-only batch creates its tasks without
needing an unrelated feature approval to resume the pipeline.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common import STATE_ROOT, now_iso

# Routing decision values for the WS3 classification contract.
ROUTE_FEATURE = "feature"
ROUTE_DIRECT = "direct"
ROUTE_AMBIGUOUS = "ambiguous"

# Triage queue for ambiguous-classified bookmarks. Appended on every run
# that emits ambiguous events; consumed by the WS4 recurring cron
# (Quinn-owned registration) that surfaces them as a Telegram report when
# older than 7 days.
TRIAGE_QUEUE_PATH = STATE_ROOT / "bookmark-triage-queue.json"


def resolve_route(state_item: dict, item_input: dict) -> tuple[str, list[dict]]:
    """Return (route, per_spec_data) for the implement item.

    route is one of:
      - ROUTE_FEATURE: keep today's flow (Tom reviews + approval)
      - ROUTE_DIRECT: skip approval, downstream calls Tasks API create with
        type=classification
      - ROUTE_AMBIGUOUS: no approval, no task; emit bookmark-triage-needed
        event so WS4 cron can surface it for manual triage

    per_spec_data is a list of classification records keyed by specDoc.
    """
    classifications = (
        list(state_item.get("classifications") or [])
        or list(item_input.get("classifications") or [])
    )

    if not classifications:
        return ROUTE_FEATURE, []

    per_spec: list[dict] = []
    has_ambiguous = False
    has_feature = False
    has_direct = False
    for c in classifications:
        cls = c.get("classification")
        per_spec.append({
            "specDoc": c.get("specDoc"),
            "classification": cls,
            "classification_rationale": c.get("classification_rationale"),
            "classificationError": c.get("classificationError"),
        })
        if cls == "ambiguous" or cls is None or c.get("classificationError"):
            has_ambiguous = True
        elif cls == "feature":
            has_feature = True
        elif cls in ("code", "research"):
            has_direct = True
        else:
            # Unknown enum value — treat as ambiguous so the pipeline never
            # silently coerces to a wrong route.
            has_ambiguous = True

    if has_ambiguous:
        return ROUTE_AMBIGUOUS, per_spec
    if has_feature:
        return ROUTE_FEATURE, per_spec
    if has_direct:
        return ROUTE_DIRECT, per_spec
    return ROUTE_FEATURE, per_spec  # unreachable in practice


def build_direct_create_item(item: dict, per_spec: list[dict]) -> dict:
    """Build a directCreateItems entry from an implement item + per-spec data.

    Each spec becomes a proposed task with type=classification. The
    downstream caller (lobster or tasks-api client) reads this and creates
    one task per entry. The proposedTasks field carries the actual task
    list so the downstream doesn't need to re-parse the spec docs.
    """
    spec_titles = {
        s.get("specDoc"): s.get("title")
        for s in (item.get("specProposals") or [])
    }
    tasks = []
    for spec in per_spec:
        cls = spec.get("classification")
        spec_doc = spec.get("specDoc")
        if cls not in ("code", "research"):
            continue  # direct route only emits code/research tasks
        tasks.append({
            "title": spec_titles.get(spec_doc) or Path(spec_doc or "").stem,
            "type": cls,
            "specDoc": spec_doc,
            "bookmarkKey": item.get("bookmarkKey"),
            "classification_rationale": spec.get("classification_rationale"),
        })
    return {
        "bookmarkKey": item.get("bookmarkKey"),
        "topic": item.get("topic"),
        "title": item.get("title"),
        "specDocs": [s.get("specDoc") for s in per_spec if s.get("specDoc")],
        "tasks": tasks,
    }


def build_triage_event(bookmark_key: str, item: dict, per_spec: list[dict]) -> dict:
    """Build a bookmark-triage-needed event for an ambiguous item."""
    return {
        "bookmarkKey": bookmark_key,
        "title": item.get("title"),
        "topic": item.get("topic"),
        "specDocs": [s.get("specDoc") for s in per_spec],
        "classificationRationales": [
            s.get("classification_rationale") for s in per_spec
        ],
        "classificationErrors": [
            s.get("classificationError") for s in per_spec
        ],
        "emittedAt": now_iso(),
    }


def append_triage_events(events: list[dict], path: Path | None = None) -> int:
    """Append triage events to bookmark-triage-queue.json. Returns new size.

    Queue file is a JSON list. Malformed or missing files are treated as
    empty. Parent directories are created on first write. Test paths can
    override the default `TRIAGE_QUEUE_PATH`.
    """
    target = path if path is not None else TRIAGE_QUEUE_PATH
    if target.exists():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (json.JSONDecodeError, OSError):
            existing = []
    else:
        existing = []
    existing.extend(events)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return len(existing)


def route_implement_items(
    data_implement: list[dict],
    state_items: dict,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Split a list of implement items into the three sub-buckets.

    Returns (routed_feature_implement, direct_create_items, triage_events).
    Feature items carry their classifications forward as `_classifications`
    so `lobster_request_spec_approval.py` (or any downstream) can still
    audit the routing decision.

    State is only READ here — no mutation. The caller persists if needed.
    """
    routed_implement: list[dict] = []
    direct_create_items: list[dict] = []
    triage_events: list[dict] = []
    for item in data_implement:
        bookmark_key = item.get("bookmarkKey")
        state_item = state_items.get(bookmark_key, {})
        route, per_spec = resolve_route(state_item, item)
        if route == ROUTE_AMBIGUOUS:
            triage_events.append(build_triage_event(bookmark_key, item, per_spec))
            continue
        if route == ROUTE_DIRECT:
            direct_create_items.append(build_direct_create_item(item, per_spec))
            continue
        # ROUTE_FEATURE: fall through to the existing approval flow
        routed_implement.append({**item, "_classifications": per_spec})
    return routed_implement, direct_create_items, triage_events
