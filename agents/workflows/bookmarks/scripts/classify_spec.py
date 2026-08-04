#!/usr/bin/env python3
"""Spec type classifier for bookmark-pipeline-sourced task proposals.

Task: `536e04fc` (Bookmark specs get a task type, only feature-typed ones
need Tom's approval). Companion to `agents/workflows/bookmarks/scripts/`.

The classifier is the deterministic fallback described in the task's tech
design (`docs/specs/bookmark-specs-task-type-classification-tech-design.md`):
given a spec body, return one of:

- ``"feature"``   — user-visible product change (Tom reviews and approves
                   via the existing approval message before any task is
                   created).
- ``"code"``      — infra / test / refactor / chore. Task created directly
                   with type=code, approval message skipped.
- ``"research"``  — spike / one-pager / investigation. Task created
                   directly with type=research, approval message skipped.
- ``None``        — ambiguous. No type is set, no task is auto-created,
                   the spec is surfaced for manual triage.

The classifier reads structural signals from the spec body so the rules are
unit-testable without an LLM call. The LLM-driven path will be added in a
follow-up commit; this fallback is the deterministic floor that catches the
"model returned nothing usable" case per the tech design.

Signals used (in order, first match wins):

1. A ``## Spec type`` heading whose body matches an allowed value
   (``feature`` / ``code`` / ``research``).
2. An explicit ``type: <value>`` frontmatter key.
3. Body keywords — presence of user-facing product terms signals ``feature``;
   absence with test/refactor/spike terms signals ``code``/``research``.
4. Otherwise ``None`` (ambiguous).
"""

from __future__ import annotations

import re
from typing import Optional

# Allowed values per the task description and tech design.
ALLOWED_TYPES = ("feature", "code", "research")

# Keywords that strongly indicate a user-visible product change. These are
# checked case-insensitively against the spec body.
_FEATURE_KEYWORDS = (
    "user-facing",
    "user visible",
    "customer-facing",
    "ui change",
    "ui flow",
    "ux",
    "product change",
    "feature flag",
    "rollout",
    "a/b test",
    "onboarding",
    "pricing",
    "billing change",
)

# Keywords that strongly indicate an infra/refactor/test/chore. Mapped to
# "code" classification.
_CODE_KEYWORDS = (
    "refactor",
    "rename",
    "extraction",
    "decompose",
    "split into",
    "merge into",
    "test coverage",
    "test plan",
    "unit test",
    "e2e test",
    "ci gate",
    "lint",
    "typecheck",
    "formatting",
    "build",
    "compile",
    "typescript",
    "rust migration",
    "tooling",
    "ci/cd",
    "deploy pipeline",
)

# Keywords that strongly indicate a spike / investigation / one-pager.
# Mapped to "research" classification.
_RESEARCH_KEYWORDS = (
    "spike",
    "investigation",
    "explore",
    "evaluate",
    "benchmark",
    "compare",
    "research",
    "one-pager",
    "one pager",
    "rfc",
    "literature review",
    "proof of concept",
    "poc",
    "feasibility",
)


def _strip_frontmatter(body: str) -> tuple[dict[str, str], str]:
    """Return (frontmatter kv pairs, body without frontmatter)."""
    if not body.startswith("---\n"):
        return {}, body
    end = body.find("\n---\n", 4)
    if end < 0:
        return {}, body
    fm_block = body[4:end]
    rest = body[end + 5 :]
    pairs: dict[str, str] = {}
    for line in fm_block.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        pairs[key.strip()] = value.strip()
    return pairs, rest


def _classify_heading(body: str) -> Optional[str]:
    """Look for ``## Spec type`` heading and return the allowed value beneath."""
    match = re.search(
        r"^##\s*Spec\s*type\s*\n+(?P<value>[^\n]+)",
        body,
        flags=re.MULTILINE | re.IGNORECASE,
    )
    if not match:
        return None
    raw = match.group("value").strip().lower()
    raw = raw.strip("*_`. ").rstrip(".")
    return raw if raw in ALLOWED_TYPES else None


def _classify_keywords(body: str) -> Optional[str]:
    """Return classification based on keyword frequency in the body."""
    text = body.lower()
    feature_hits = sum(1 for kw in _FEATURE_KEYWORDS if kw in text)
    code_hits = sum(1 for kw in _CODE_KEYWORDS if kw in text)
    research_hits = sum(1 for kw in _RESEARCH_KEYWORDS if kw in text)

    scores = {
        "feature": feature_hits,
        "code": code_hits,
        "research": research_hits,
    }
    best_type = max(scores, key=scores.get)  # type: ignore[arg-type]
    best_score = scores[best_type]
    if best_score == 0:
        return None  # no signal — ambiguous

    # Require the best signal to beat the runner-up by at least 1 to avoid
    # ties. If tied, treat as ambiguous.
    sorted_scores = sorted(scores.values(), reverse=True)
    if len(sorted_scores) >= 2 and sorted_scores[0] == sorted_scores[1]:
        return None

    return best_type


def classify_spec(spec_body: str) -> Optional[str]:
    """Classify a bookmark spec body.

    Returns one of ``"feature"``, ``"code"``, ``"research"``, or ``None``
    (ambiguous). See module docstring for the precedence order.
    """
    if not isinstance(spec_body, str) or not spec_body.strip():
        return None

    fm, body = _strip_frontmatter(spec_body)

    # 1) ``## Spec type`` heading — explicit override that beats frontmatter.
    heading_type = _classify_heading(body)
    if heading_type is not None:
        return heading_type

    # 2) Explicit ``type: <value>`` frontmatter key.
    raw_type = fm.get("type", "").strip().lower()
    if raw_type in ALLOWED_TYPES:
        return raw_type

    # 3) Keyword scoring.
    return _classify_keywords(body)


__all__ = ["ALLOWED_TYPES", "classify_spec"]