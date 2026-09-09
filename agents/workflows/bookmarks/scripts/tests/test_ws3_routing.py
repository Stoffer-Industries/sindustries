#!/usr/bin/env python3
"""Unit tests for agents/workflows/bookmarks/scripts/ws3_routing.py.

Covers the WS3 classification routing contract (task 536e04fc AC1/AC3/AC4):

- AC1: classify -> resolve_route()
- AC3: code/research -> build_direct_create_item() with correct taskType
- AC4: ambiguous -> build_triage_event() + append_triage_events()
- pre-WS3 fallback (no classifications) -> feature (preserves today)
- unknown enum values (defensive) -> ambiguous

Tests use `tempfile` and never read live brain state. The routing helper
is pure (no I/O other than the optional triage-queue append), so the
tests construct minimal dict inputs and assert on the returned shapes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Bootstrap import path so `import ws3_routing` works under plain pytest.
_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _SCRIPT_DIR.parent
_WORKSPACE = _SCRIPTS_DIR.parents[3]
sys.path.insert(0, str(_WORKSPACE))  # for `agents.lib`
sys.path.insert(0, str(_SCRIPTS_DIR))  # for `common`, `ws3_routing`

import pytest  # noqa: E402

from ws3_routing import (  # noqa: E402
    ROUTE_AMBIGUOUS,
    ROUTE_DIRECT,
    ROUTE_FEATURE,
    append_triage_events,
    build_direct_create_item,
    build_triage_event,
    resolve_route,
    route_implement_items,
)


# ---------- resolve_route ----------


def _state_item(classifications):
    return {"classifications": classifications}


def test_resolve_route_feature_only():
    state = _state_item([
        {"specDoc": "brain/specs/a.md", "classification": "feature",
         "classification_rationale": "touches product surface"},
    ])
    route, per_spec = resolve_route(state, {})
    assert route == ROUTE_FEATURE
    assert len(per_spec) == 1
    assert per_spec[0]["classification"] == "feature"
    assert per_spec[0]["specDoc"] == "brain/specs/a.md"


def test_resolve_route_code_only():
    state = _state_item([
        {"specDoc": "brain/specs/x.md", "classification": "code",
         "classification_rationale": "library refactor"},
    ])
    route, per_spec = resolve_route(state, {})
    assert route == ROUTE_DIRECT
    assert per_spec[0]["classification"] == "code"


def test_resolve_route_research_only():
    state = _state_item([
        {"specDoc": "brain/specs/r.md", "classification": "research",
         "classification_rationale": "spike to evaluate X"},
    ])
    route, per_spec = resolve_route(state, {})
    assert route == ROUTE_DIRECT
    assert per_spec[0]["classification"] == "research"


def test_resolve_route_ambiguous_first_wins_over_feature():
    """An item with mixed feature+ambiguous specs must route AMBIGUOUS, never feature."""
    state = _state_item([
        {"specDoc": "a.md", "classification": "feature"},
        {"specDoc": "b.md", "classification": "ambiguous"},
    ])
    route, _ = resolve_route(state, {})
    assert route == ROUTE_AMBIGUOUS


def test_resolve_route_feature_wins_over_direct_in_mixed_feature_direct():
    """When a batch has BOTH feature AND direct items, the item itself is
    considered feature (it has at least one feature spec). The item is
    routed to approval; the direct sub-specs are not double-counted here.
    Per-spec routing at sub-spec granularity is a future enhancement."""
    state = _state_item([
        {"specDoc": "a.md", "classification": "feature"},
        {"specDoc": "b.md", "classification": "code"},
    ])
    route, _ = resolve_route(state, {})
    assert route == ROUTE_FEATURE


def test_resolve_route_falls_back_to_feature_when_no_classifications():
    """Pre-WS3 state has no classifications field; preserve today's approval flow."""
    route, per_spec = resolve_route({}, {})
    assert route == ROUTE_FEATURE
    assert per_spec == []


def test_resolve_route_unknown_enum_is_ambiguous():
    """Defensive: enum value not in {feature, code, research, ambiguous}
    must NOT silently coerce — the pipeline never coerces (per spec)."""
    state = _state_item([{"specDoc": "x.md", "classification": "wat"}])
    route, _ = resolve_route(state, {})
    assert route == ROUTE_AMBIGUOUS


def test_resolve_route_none_classification_is_ambiguous():
    """Missing classification field maps to ambiguous (not a parse-error fallback)."""
    state = _state_item([{"specDoc": "x.md"}])
    route, _ = resolve_route(state, {})
    assert route == ROUTE_AMBIGUOUS


def test_resolve_route_classification_error_field_is_ambiguous():
    """When the LLM emitted a classificationError (e.g. malformed JSON),
    the spec is treated as ambiguous so the pipeline never silently
    coerces to a wrong route."""
    state = _state_item([
        {"specDoc": "x.md", "classification": "code",
         "classificationError": "JSON parse error at char 42"},
    ])
    route, _ = resolve_route(state, {})
    assert route == ROUTE_AMBIGUOUS


def test_resolve_route_input_overrides_state_when_state_empty():
    """State might be stale (e.g. just-classified); pass input directly."""
    route, _ = resolve_route(
        {"classifications": []},
        {"classifications": [{"specDoc": "x.md", "classification": "research"}]},
    )
    assert route == ROUTE_DIRECT


# ---------- build_direct_create_item ----------


def test_build_direct_create_item_emits_only_code_and_research():
    """Feature/ambiguous specs must NOT be emitted; only code/research become tasks."""
    per_spec = [
        {"specDoc": "a.md", "classification": "feature",
         "classification_rationale": "touches product"},
        {"specDoc": "b.md", "classification": "code",
         "classification_rationale": "library refactor"},
        {"specDoc": "c.md", "classification": "research",
         "classification_rationale": "spike"},
        {"specDoc": "d.md", "classification": "ambiguous"},
    ]
    item = {
        "bookmarkKey": "key-1",
        "topic": "infra",
        "title": "My Bookmark",
        "specProposals": [
            {"title": "A spec", "specDoc": "a.md"},
            {"title": "B spec", "specDoc": "b.md"},
            {"title": "C spec", "specDoc": "c.md"},
            {"title": "D spec", "specDoc": "d.md"},
        ],
    }
    result = build_direct_create_item(item, per_spec)
    assert result["bookmarkKey"] == "key-1"
    assert result["topic"] == "infra"
    # specDocs echoes every per-spec (so downstream can audit the routing),
    # but only code/research make it into tasks.
    assert result["specDocs"] == ["a.md", "b.md", "c.md", "d.md"]
    titles = [t["title"] for t in result["tasks"]]
    assert "B spec" in titles
    assert "C spec" in titles
    # taskType matches classification
    types = {t["type"] for t in result["tasks"]}
    assert types == {"code", "research"}


def test_build_direct_create_item_handles_missing_title():
    """When specProposals lacks a title, fall back to specDoc stem."""
    item = {"bookmarkKey": "k", "topic": "t", "specProposals": []}
    per_spec = [{"specDoc": "brain/specs/cool-feature.md", "classification": "code"}]
    result = build_direct_create_item(item, per_spec)
    assert len(result["tasks"]) == 1
    # Path("...md").stem strips the .md extension — the title fallback.
    assert result["tasks"][0]["title"] == "cool-feature"


def test_build_direct_create_item_empty_per_spec():
    """When the routed item has no code/research specs (e.g. all feature),
    directCreateItems entry has empty tasks list — downstream sees no-op."""
    item = {"bookmarkKey": "k"}
    result = build_direct_create_item(item, [])
    assert result["tasks"] == []
    assert result["specDocs"] == []


# ---------- build_triage_event ----------


def test_build_triage_event_emits_required_fields():
    per_spec = [
        {"specDoc": "brain/specs/x.md", "classification": "ambiguous",
         "classification_rationale": "could be feature or code", "classificationError": None},
    ]
    event = build_triage_event("k-1", {"title": "My Book", "topic": "infra"}, per_spec)
    assert event["bookmarkKey"] == "k-1"
    assert event["title"] == "My Book"
    assert event["topic"] == "infra"
    assert event["specDocs"] == ["brain/specs/x.md"]
    assert "could be feature or code" in event["classificationRationales"]
    assert "emittedAt" in event


# ---------- append_triage_events ----------


def test_append_triage_events_creates_file(tmp_path: Path):
    target = tmp_path / "triage.json"
    event = {"bookmarkKey": "k", "title": "t", "emittedAt": "now"}
    size = append_triage_events([event], path=target)
    assert size == 1
    parsed = json.loads(target.read_text())
    assert parsed == [event]


def test_append_triage_events_appends_to_existing(tmp_path: Path):
    target = tmp_path / "triage.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps([{"bookmarkKey": "old"}]))
    size = append_triage_events([{"bookmarkKey": "new"}], path=target)
    assert size == 2
    parsed = json.loads(target.read_text())
    assert [e["bookmarkKey"] for e in parsed] == ["old", "new"]


def test_append_triage_events_recovers_from_malformed_file(tmp_path: Path):
    target = tmp_path / "triage.json"
    target.write_text("{not-json")
    size = append_triage_events([{"bookmarkKey": "fresh"}], path=target)
    assert size == 1
    parsed = json.loads(target.read_text())
    assert parsed == [{"bookmarkKey": "fresh"}]


# ---------- route_implement_items (integration) ----------


def test_route_implement_items_code_only_batch():
    """Code/research-only batch produces direct items, NO routed feature
    implement, NO triage events. This is the AC3 reliability case — the
    direct path must light up without needing any approval flow."""
    implement = [
        {"bookmarkKey": "k1",
         "specProposals": [{"title": "Code Spec", "specDoc": "brain/specs/x.md"}],
         "specDocs": ["brain/specs/x.md"]},
    ]
    state_items = {
        "k1": {"classifications": [{"specDoc": "brain/specs/x.md",
                                     "classification": "code",
                                     "classification_rationale": "lib refactor"}]},
    }
    routed, direct, triage = route_implement_items(implement, state_items)
    assert routed == []
    assert len(direct) == 1
    assert direct[0]["bookmarkKey"] == "k1"
    assert len(direct[0]["tasks"]) == 1
    assert direct[0]["tasks"][0]["type"] == "code"
    assert triage == []


def test_route_implement_items_feature_only_batch():
    implement = [{"bookmarkKey": "k1", "specDocs": ["a.md"]}]
    state_items = {"k1": {"classifications": [{"specDoc": "a.md",
                                                 "classification": "feature"}]}}
    routed, direct, triage = route_implement_items(implement, state_items)
    assert len(routed) == 1
    assert direct == []
    assert triage == []
    # The routed feature item carries its classifications forward for
    # auditability in the approve flow.
    assert "_classifications" in routed[0]


def test_route_implement_items_ambiguous_only_batch():
    implement = [{"bookmarkKey": "k1", "title": "My Book", "topic": "infra",
                  "specDocs": ["a.md"]}]
    state_items = {"k1": {"classifications": [{"specDoc": "a.md",
                                                 "classification": "ambiguous"}]}}
    routed, direct, triage = route_implement_items(implement, state_items)
    assert routed == []
    assert direct == []
    assert len(triage) == 1
    assert triage[0]["bookmarkKey"] == "k1"


def test_route_implement_items_mixed_batch_with_feature():
    """Mixed (feature + direct on the SAME item) routes to feature at the
    item level, per priority: ambiguous > feature > direct. Splitting per
    spec into different items is a future enhancement; today an item is
    the unit of routing."""
    implement = [
        {"bookmarkKey": "feature-item", "specDocs": ["a.md"]},
        {"bookmarkKey": "code-item", "specDocs": ["b.md"],
         "specProposals": [{"title": "B", "specDoc": "b.md"}]},
    ]
    state_items = {
        "feature-item": {"classifications": [{"specDoc": "a.md",
                                                "classification": "feature"}]},
        "code-item": {"classifications": [{"specDoc": "b.md",
                                             "classification": "code",
                                             "classification_rationale": "lib"}]},
    }
    routed, direct, triage = route_implement_items(implement, state_items)
    assert {r["bookmarkKey"] for r in routed} == {"feature-item"}
    assert {d["bookmarkKey"] for d in direct} == {"code-item"}
    assert triage == []


def test_route_implement_items_falls_back_to_feature_for_unclassified():
    """Pre-WS3 items with no classifications: feature (preserves today's flow)."""
    implement = [{"bookmarkKey": "k1", "specDocs": ["a.md"]}]
    state_items = {"k1": {}}
    routed, direct, triage = route_implement_items(implement, state_items)
    assert len(routed) == 1
    assert direct == []
    assert triage == []
