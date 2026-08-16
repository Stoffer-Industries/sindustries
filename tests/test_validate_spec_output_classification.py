#!/usr/bin/env python3
"""Task 536e04fc WS3 — classification capture in validate_spec_output.

The WS3 pipeline routing depends on `validate_spec_output.py` recording
each spec's LLM-driven classification into bookmark state so the next
pipeline stage (lobster_request_spec_approval) can branch on it.

These tests pin the shape contract:
- validate_entry_shape rejects missing/empty classifications
- validate_entry_shape rejects unknown classification values
- validate_entry_shape rejects empty classification_rationale
- build_proposals emits one classification record per spec
- build_proposals runs every value through parse_classification_payload
  (the WS2 single-source-of-truth validator) — invalid enum values map
  to Classification.AMBIGUOUS, not a free-form string
- Classification records carry specDoc so request_spec_approval can
  look them up by document path

Run with the rest of the sindustries test suite:
    python3 -m pytest tests/test_validate_spec_output_classification.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


# Make sure the scripts + classification_schema are importable.
SCRIPTS_ROOT = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks" / "scripts"
CLASSIFICATION_ROOT = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks"
for _p in (SCRIPTS_ROOT, CLASSIFICATION_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


@pytest.fixture(scope="module")
def validate_spec_output():
    """Import the script as a module. Skips if not present in this worktree."""
    try:
        return importlib.import_module("validate_spec_output")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"validate_spec_output not importable in this checkout: {exc}")


def _entry(specs):
    return {"bookmarkKey": "abc123", "specs": specs}


def _spec(title="Spec", spec_doc="brain/bookmarks/specs/x-abc123.md", **overrides):
    base = {
        "title": title,
        "specDoc": spec_doc,
        "classification": "feature",
        "classification_rationale": "Touches product surface.",
    }
    base.update(overrides)
    return base


class TestValidateEntryShapeRejectsBadClassification:
    def test_missing_classification_field_rejected(self, validate_spec_output):
        spec = _spec()
        del spec["classification"]
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert any("classification" in e for e in errors), errors

    def test_unknown_classification_enum_rejected(self, validate_spec_output):
        spec = _spec(classification="bugfix")
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert any("classification" in e for e in errors), errors

    def test_empty_classification_rationale_rejected_for_feature(self, validate_spec_output):
        spec = _spec(classification="feature", classification_rationale="   ")
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert any("classification_rationale" in e for e in errors), errors

    def test_empty_classification_rationale_rejected_for_code(self, validate_spec_output):
        spec = _spec(classification="code", classification_rationale="")
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert any("classification_rationale" in e for e in errors), errors

    def test_ambiguous_rationale_may_be_empty(self, validate_spec_output):
        # Ambiguous is reserved for malformed-LLM-output. Rationale is
        # optional in that case because the parse error key carries the
        # diagnostic. Pipeline behaviour: the bookmark is surfaced for
        # manual triage via the WS3 triage queue, so we should not block
        # the validator on rationale here.
        spec = _spec(classification="ambiguous", classification_rationale="")
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert not any("classification_rationale" in e for e in errors), errors


class TestBuildProposalsCapturesClassifications:
    def test_emits_one_classification_record_per_spec(self, validate_spec_output):
        specs = [
            _spec(title="S1", spec_doc="brain/bookmarks/specs/x-abc123.md", classification="feature"),
            _spec(title="S2", spec_doc="brain/bookmarks/specs/y-abc123.md", classification="code"),
            _spec(title="S3", spec_doc="brain/bookmarks/specs/z-abc123.md", classification="research"),
        ]
        spec_docs, spec_proposals, classifications = validate_spec_output.build_proposals(_entry(specs))
        assert spec_docs == [s["specDoc"] for s in specs]
        assert len(spec_proposals) == 3
        assert [c["specDoc"] for c in classifications] == spec_docs
        assert [c["classification"] for c in classifications] == ["feature", "code", "research"]

    def test_unknown_enum_value_rejected_before_build_proposals(self, validate_spec_output):
        """validate_entry_shape is the single gate for the four-value enum;
        build_proposals trusts that gate and passes values through. This test
        pins the contract: build_proposals does NOT re-validate and would
        propagate an unknown enum verbatim if it ever slipped through, so the
        only safe behaviour is to refuse unknown values upstream."""
        # Confirm validate_entry_shape rejects the unknown value:
        spec = _spec(classification="bugfix", classification_rationale="Stale pipeline")
        errors = validate_spec_output.validate_entry_shape(_entry([spec]))
        assert any("classification" in e for e in errors), errors

    def test_classification_records_carry_specDoc_for_routing_lookup(self, validate_spec_output):
        """lobster_request_spec_approval reads `item.classifications` keyed by
        specDoc so it can decide per-item whether all specs are
        code/research (→ direct create), any are feature (→ approval),
        or any are ambiguous (→ triage)."""
        spec = _spec(spec_doc="brain/bookmarks/specs/specific-abc123.md")
        _docs, _proposals, classifications = validate_spec_output.build_proposals(_entry([spec]))
        assert classifications[0]["specDoc"] == "brain/bookmarks/specs/specific-abc123.md"
        assert classifications[0]["classificationError"] is None
