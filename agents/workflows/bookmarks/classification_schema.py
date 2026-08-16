#!/usr/bin/env python3
"""Structured classification schema for bookmark spec generation.

Task: ``536e04fc`` (Bookmark specs get a task type, only feature-typed ones
need Tom's approval).

Per the 2026-08-06 NZST direction from Tom (LLM-driven classification as
part of Ivy's spec-generation call), Ivy's prompt returns a structured
``{spec_markdown, classification, classification_rationale}`` payload
alongside the spec markdown. This module is the durable, well-tested
contract between that LLM call and the bookmark pipeline's routing
decision.

The four values are intentionally narrow (``feature | code | research |
ambiguous``) — we do not allow custom types in v1. ``ambiguous`` is a
first-class enum value: when classification is genuinely ambiguous, no
type is set and no task is auto-created or approval-skipped. The spec
is surfaced for manual triage.

Invalid LLM output (malformed JSON, wrong enum, missing field,
transport error) maps to ``ambiguous``. The pipeline never crashes or
coerces. The schema validator is the single source of truth for what
counts as "valid" LLM output; the pipeline asks it
``payload_is_actionable(parsed)`` to decide whether to route.
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Any, Optional


class Classification(str, Enum):
    """The four classification values Ivy may return.

    Inherits from ``str`` so values are JSON-serialisable as themselves.
    """

    FEATURE = "feature"
    CODE = "code"
    RESEARCH = "research"
    AMBIGUOUS = "ambiguous"


# Set of values that count as "actionable" — i.e. we should create a task
# with this type and route accordingly. ``AMBIGUOUS`` is excluded because
# ambiguous payloads surface for manual triage instead of auto-creating.
ACTIONABLE_VALUES = frozenset(
    {Classification.FEATURE.value, Classification.CODE.value, Classification.RESEARCH.value}
)
ALL_VALUES = frozenset(c.value for c in Classification)


# Error keys returned in the parse result so callers can log them.
ERR_EMPTY_PAYLOAD = "empty_payload"
ERR_MALFORMED_JSON = "malformed_json"
ERR_NOT_DICT = "not_dict"
ERR_MISSING_FIELD = "missing_field"
ERR_WRONG_ENUM = "wrong_enum"
ERR_EMPTY_SPEC = "empty_spec"


def _empty_result(error: str) -> dict:
    return {
        "spec_markdown": "",
        "classification": Classification.AMBIGUOUS.value,
        "classification_rationale": "",
        "error": error,
    }


def parse_classification_payload(
    payload: Any,
) -> dict:
    """Parse an LLM-produced classification payload.

    The payload is expected to be a JSON string that decodes to::

        {
            "spec_markdown": "<markdown body>",
            "classification": "feature" | "code" | "research" | "ambiguous",
            "classification_rationale": "<short string>"
        }

    ``payload`` may also be a pre-decoded dict for callers that already
    parsed the JSON. Any other shape maps to ``ambiguous`` with an
    explicit ``error`` key.

    The function never raises. Callers can inspect ``error`` to log the
    reason and ``classification`` to drive routing.

    Returns:
        dict with keys ``spec_markdown``, ``classification``,
        ``classification_rationale``, and ``error`` (one of the ``ERR_*``
        constants, or ``None`` when the payload was valid).
    """
    # Empty / None payload — explicit guard before any parsing.
    if payload is None:
        return _empty_result(ERR_EMPTY_PAYLOAD)
    if isinstance(payload, (str, bytes)) and not payload:
        return _empty_result(ERR_EMPTY_PAYLOAD)
    if isinstance(payload, (str, bytes)) and not payload.strip():  # type: ignore[arg-type]
        return _empty_result(ERR_EMPTY_PAYLOAD)

    # Decode JSON if we got a string/bytes.
    if isinstance(payload, (str, bytes)):
        try:
            decoded = json.loads(payload)
        except (ValueError, json.JSONDecodeError):
            return _empty_result(ERR_MALFORMED_JSON)
    else:
        decoded = payload

    # Must be a dict at the top level.
    if not isinstance(decoded, dict):
        return _empty_result(ERR_NOT_DICT)

    # Required fields.
    required = ("spec_markdown", "classification", "classification_rationale")
    for field in required:
        if field not in decoded:
            return _empty_result(ERR_MISSING_FIELD)

    spec_markdown = decoded["spec_markdown"]
    classification = decoded["classification"]
    rationale = decoded["classification_rationale"]

    if not isinstance(spec_markdown, str):
        return _empty_result(ERR_MISSING_FIELD)
    if not isinstance(rationale, str):
        return _empty_result(ERR_MISSING_FIELD)

    # Empty spec body is unambiguous — no markdown means nothing to route.
    if not spec_markdown.strip():
        return _empty_result(ERR_EMPTY_SPEC)

    if not isinstance(classification, str):
        return _empty_result(ERR_WRONG_ENUM)
    if classification not in ALL_VALUES:
        return _empty_result(ERR_WRONG_ENUM)

    return {
        "spec_markdown": spec_markdown,
        "classification": classification,
        "classification_rationale": rationale,
        "error": None,
    }


def payload_is_actionable(parsed: dict) -> bool:
    """Return True when ``parsed`` should drive task creation.

    Actionable = classification is one of ``feature``, ``code``,
    ``research``. ``ambiguous`` and any error path are non-actionable
    and route to manual triage.
    """
    if not isinstance(parsed, dict):
        return False
    return parsed.get("classification") in ACTIONABLE_VALUES


__all__ = [
    "ACTIONABLE_VALUES",
    "ALL_VALUES",
    "Classification",
    "ERR_EMPTY_PAYLOAD",
    "ERR_EMPTY_SPEC",
    "ERR_MALFORMED_JSON",
    "ERR_MISSING_FIELD",
    "ERR_NOT_DICT",
    "ERR_WRONG_ENUM",
    "parse_classification_payload",
    "payload_is_actionable",
]