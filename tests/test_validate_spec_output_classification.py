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
- Classification records carry specDoc so request_spec_approval can
  look them up by document path

Runs under the same discover command as the rest of the sindustries
test suite (which uses `unittest discover`, not pytest):
    python3 -m unittest tests.test_validate_spec_output_classification
"""
from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path


# Make sure the scripts + classification_schema are importable.
SCRIPTS_ROOT = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks" / "scripts"
CLASSIFICATION_ROOT = Path(__file__).resolve().parents[1] / "agents" / "workflows" / "bookmarks"
for _p in (SCRIPTS_ROOT, CLASSIFICATION_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def _load_validate_spec_output():
    """Import the script as a module. Skip the whole class if absent."""
    try:
        return importlib.import_module("validate_spec_output")
    except Exception as exc:  # noqa: BLE001
        raise unittest.SkipTest(
            f"validate_spec_output not importable in this checkout: {exc}"
        )


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


class TestValidateEntryShapeRejectsBadClassification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vso = _load_validate_spec_output()

    def test_missing_classification_field_rejected(self):
        spec = _spec()
        del spec["classification"]
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertTrue(any("classification" in e for e in errors), errors)

    def test_unknown_classification_enum_rejected(self):
        spec = _spec(classification="bugfix")
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertTrue(any("classification" in e for e in errors), errors)

    def test_empty_classification_rationale_rejected_for_feature(self):
        spec = _spec(classification="feature", classification_rationale="   ")
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertTrue(any("classification_rationale" in e for e in errors), errors)

    def test_empty_classification_rationale_rejected_for_code(self):
        spec = _spec(classification="code", classification_rationale="")
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertTrue(any("classification_rationale" in e for e in errors), errors)

    def test_ambiguous_rationale_may_be_empty(self):
        # Ambiguous is reserved for malformed-LLM-output. Rationale is
        # optional in that case because the parse error key carries the
        # diagnostic. Pipeline behaviour: the bookmark is surfaced for
        # manual triage via the WS3 triage queue, so we should not block
        # the validator on rationale here.
        spec = _spec(classification="ambiguous", classification_rationale="")
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertFalse(any("classification_rationale" in e for e in errors), errors)


class TestBuildProposalsCapturesClassifications(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vso = _load_validate_spec_output()

    def test_emits_one_classification_record_per_spec(self):
        specs = [
            _spec(title="S1", spec_doc="brain/bookmarks/specs/x-abc123.md", classification="feature"),
            _spec(title="S2", spec_doc="brain/bookmarks/specs/y-abc123.md", classification="code"),
            _spec(title="S3", spec_doc="brain/bookmarks/specs/z-abc123.md", classification="research"),
        ]
        spec_docs, spec_proposals, classifications = self.vso.build_proposals(_entry(specs))
        self.assertEqual(spec_docs, [s["specDoc"] for s in specs])
        self.assertEqual(len(spec_proposals), 3)
        self.assertEqual([c["specDoc"] for c in classifications], spec_docs)
        self.assertEqual([c["classification"] for c in classifications], ["feature", "code", "research"])

    def test_unknown_enum_value_rejected_before_build_proposals(self):
        """validate_entry_shape is the single gate for the four-value enum;
        build_proposals trusts that gate and passes values through. This test
        pins the contract: build_proposals does NOT re-validate and would
        propagate an unknown enum verbatim if it ever slipped through, so the
        only safe behaviour is to refuse unknown values upstream."""
        spec = _spec(classification="bugfix", classification_rationale="Stale pipeline")
        errors = self.vso.validate_entry_shape(_entry([spec]))
        self.assertTrue(any("classification" in e for e in errors), errors)

    def test_classification_records_carry_specDoc_for_routing_lookup(self):
        """lobster_request_spec_approval reads `item.classifications` keyed by
        specDoc so it can decide per-item whether all specs are
        code/research (→ direct create), any are feature (→ approval),
        or any are ambiguous (→ triage)."""
        spec = _spec(spec_doc="brain/bookmarks/specs/specific-abc123.md")
        _docs, _proposals, classifications = self.vso.build_proposals(_entry([spec]))
        self.assertEqual(classifications[0]["specDoc"], "brain/bookmarks/specs/specific-abc123.md")
        self.assertIsNone(classifications[0]["classificationError"])
