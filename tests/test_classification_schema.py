#!/usr/bin/env python3
"""Unit tests for ``agents/workflows/bookmarks/classification_schema.py``.

Task: ``536e04fc`` (Bookmark specs get a task type, only feature-typed ones
need Tom's approval). Validates the LLM-driven classification contract:

  4 happy paths (feature / code / research / ambiguous) assert the right
  classification is returned with ``error=None``.
  4 invalid paths (empty / malformed_json / wrong_enum / missing_field)
  map to ``ambiguous`` with an explicit error key.

Plus additional invariants: empty ``spec_markdown`` is a separate
``empty_spec`` error; the validator never raises; pre-decoded dicts
work; ``payload_is_actionable`` matches the enum contract.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Resolve the module-under-test the same way the project tests do
# (load by file path so we don't depend on a package install).
ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "agents" / "workflows" / "bookmarks"
sys.path.insert(0, str(SCRIPTS.parent.parent))  # repo root, for `agents.*` import

from agents.workflows.bookmarks.classification_schema import (  # noqa: E402
    ACTIONABLE_VALUES,
    ALL_VALUES,
    ERR_EMPTY_PAYLOAD,
    ERR_EMPTY_SPEC,
    ERR_MALFORMED_JSON,
    ERR_MISSING_FIELD,
    ERR_NOT_DICT,
    ERR_WRONG_ENUM,
    Classification,
    parse_classification_payload,
    payload_is_actionable,
)


def _spec_body() -> str:
    return (
        "# Some spec\n\n"
        "## Problem\n\nLong enough to pass the empty-spec guard.\n\n"
        "## Approach\n\nBuild it carefully.\n"
    )


class HappyPathTests(unittest.TestCase):
    """All 4 valid classifications parse cleanly with error=None."""

    def test_feature_payload_parses_cleanly(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "feature", '
            '"classification_rationale": "user-visible product change"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "feature")
        self.assertEqual(result["error"], None)
        self.assertIn("## Approach", result["spec_markdown"])
        self.assertEqual(
            result["classification_rationale"], "user-visible product change"
        )
        self.assertTrue(payload_is_actionable(result))

    def test_code_payload_parses_cleanly(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "code", '
            '"classification_rationale": "refactor only"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "code")
        self.assertEqual(result["error"], None)
        self.assertTrue(payload_is_actionable(result))

    def test_research_payload_parses_cleanly(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "research", '
            '"classification_rationale": "spike + benchmark"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "research")
        self.assertEqual(result["error"], None)
        self.assertTrue(payload_is_actionable(result))

    def test_ambiguous_payload_parses_cleanly(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "ambiguous", '
            '"classification_rationale": "could go either way"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], None)
        # Ambiguous is a first-class routing target — NOT actionable, the
        # pipeline surfaces it for manual triage.
        self.assertFalse(payload_is_actionable(result))


class InvalidPayloadTests(unittest.TestCase):
    """The 4 invalid paths map to ``ambiguous`` with explicit error keys."""

    def test_empty_payload_maps_to_ambiguous(self) -> None:
        # Each of these represents the same logical case: "nothing came back".
        for empty in ("", "   ", "\n\t", b"", None):
            with self.subTest(value=empty):
                result = parse_classification_payload(empty)
                self.assertEqual(result["classification"], "ambiguous")
                self.assertEqual(result["error"], ERR_EMPTY_PAYLOAD)
                self.assertEqual(result["spec_markdown"], "")
                self.assertEqual(result["classification_rationale"], "")
                self.assertFalse(payload_is_actionable(result))

    def test_malformed_json_maps_to_ambiguous(self) -> None:
        bad = '{"spec_markdown": "x", "classification": "code", '  # missing brace
        result = parse_classification_payload(bad)
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], ERR_MALFORMED_JSON)

    def test_wrong_enum_maps_to_ambiguous(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "spike", '  # not in the 4-value enum
            '"classification_rationale": "wrong enum"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], ERR_WRONG_ENUM)
        # Error paths wipe the body — callers retain the original raw
        # payload for triage if they need to re-extract the spec.
        self.assertEqual(result["spec_markdown"], "")
        self.assertEqual(result["classification_rationale"], "")

    def test_missing_field_maps_to_ambiguous(self) -> None:
        # Missing classification_rationale (but spec_markdown + classification present).
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": "code"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], ERR_MISSING_FIELD)


class EmptySpecTests(unittest.TestCase):
    """``empty_spec`` is a separate error so callers can distinguish it."""

    def test_empty_spec_body_maps_to_ambiguous(self) -> None:
        raw = (
            '{"spec_markdown": "   \\n\\t  ", '
            '"classification": "feature", '
            '"classification_rationale": "looks like a feature"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], ERR_EMPTY_SPEC)


class ShapeContractTests(unittest.TestCase):
    """Invariants the pipeline and tests depend on."""

    def test_top_level_must_be_dict(self) -> None:
        # Top-level list — well-formed JSON, wrong shape.
        result = parse_classification_payload('[1, 2, 3]')
        self.assertEqual(result["classification"], "ambiguous")
        self.assertEqual(result["error"], ERR_NOT_DICT)

    def test_predecoded_dict_works(self) -> None:
        body = _spec_body()
        pre = {
            "spec_markdown": body,
            "classification": "code",
            "classification_rationale": "refactor",
        }
        result = parse_classification_payload(pre)
        self.assertEqual(result["classification"], "code")
        self.assertEqual(result["error"], None)

    def test_non_string_spec_markdown_is_missing_field(self) -> None:
        raw = '{"spec_markdown": 123, "classification": "code", "classification_rationale": "x"}'
        result = parse_classification_payload(raw)
        self.assertEqual(result["error"], ERR_MISSING_FIELD)

    def test_non_string_classification_is_wrong_enum(self) -> None:
        body = _spec_body()
        raw = (
            '{"spec_markdown": "' + body.replace("\n", "\\n") + '", '
            '"classification": 1, '
            '"classification_rationale": "x"}'
        )
        result = parse_classification_payload(raw)
        self.assertEqual(result["error"], ERR_WRONG_ENUM)

    def test_actionable_values_contract(self) -> None:
        # Actionable = feature/code/research, NOT ambiguous.
        self.assertEqual(
            ACTIONABLE_VALUES,
            {"feature", "code", "research"},
        )
        self.assertEqual(
            ALL_VALUES,
            {"feature", "code", "research", "ambiguous"},
        )
        self.assertEqual(
            {c.value for c in Classification},
            ALL_VALUES,
        )

    def test_validator_never_raises(self) -> None:
        # Catastrophically bad inputs — validator must always return a dict.
        for bad in (object(), 42, 3.14, True, Exception("nope"), b"\x00\xff"):
            with self.subTest(value=type(bad).__name__):
                result = parse_classification_payload(bad)
                self.assertIsInstance(result, dict)
                self.assertEqual(result["classification"], "ambiguous")
                self.assertIsNotNone(result["error"])


if __name__ == "__main__":
    unittest.main()