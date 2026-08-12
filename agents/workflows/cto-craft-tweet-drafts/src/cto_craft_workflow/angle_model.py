"""Structured angle model adapter for the CTO Craft pipeline.

The graph is model-agnostic. It only knows about the
:class:`StructuredAngleModel` protocol and the :class:`AngleOutput` Pydantic
schema. The production adapter (out of scope for the POC's first PR —
this PR ships the fake) embeds the existing OpenClaw structured-agent
invocation path. The fake adapter is deterministic and offline-capable so
CI never needs API keys or network access.

The angle-evaluator system prompt is loaded from
``prompts/angle-evaluator.md`` and is versioned alongside the workflow so
tweaks are tracked in git. The Tom worldview profile is loaded from
``prompts/tom-worldview.md`` and is appended to the system prompt.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, ValidationError


# Locating the prompt files relative to the package avoids any
# CWD-dependent lookup. The package layout is:
#   src/cto_craft_workflow/angle_model.py
#   ../../prompts/angle-evaluator.md
#   ../../prompts/tom-worldview.md
_PACKAGE_DIR = Path(__file__).resolve().parent
_PROMPTS_DIR = _PACKAGE_DIR.parent.parent / "prompts"


class AngleOutput(BaseModel):
    """Strict schema for one angle emitted by the model."""

    model_config = ConfigDict(extra="forbid")

    canonical_url: str = Field(min_length=1)
    angle: str = Field(min_length=1)
    tweet_body: str = Field(min_length=1, max_length=1000)
    evidence_excerpt: str = Field(min_length=1)
    resonance_score: float = Field(ge=0.0, le=1.0)
    evidence_strength: float = Field(ge=0.0, le=1.0)
    worldview_axes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class AnglePrompt:
    """Rendered prompt for one angle call."""

    system_prompt: str
    user_message: str


def load_prompts() -> tuple[str, str]:
    """Load the angle-evaluator and Tom-worldview prompts from disk.

    Returns a tuple ``(system_prompt, worldview_profile)``. The system
    prompt is the literal contents of ``angle-evaluator.md``; the profile
    is the literal contents of ``tom-worldview.md``.
    """

    evaluator_path = _PROMPTS_DIR / "angle-evaluator.md"
    worldview_path = _PROMPTS_DIR / "tom-worldview.md"
    if not evaluator_path.exists():
        raise RuntimeError(
            f"missing prompt file: {evaluator_path}. "
            "The CTO Craft package must ship prompts/angle-evaluator.md."
        )
    if not worldview_path.exists():
        raise RuntimeError(
            f"missing prompt file: {worldview_path}. "
            "The CTO Craft package must ship prompts/tom-worldview.md."
        )
    return (evaluator_path.read_text(encoding="utf-8"), worldview_path.read_text(encoding="utf-8"))


@runtime_checkable
class StructuredAngleModel(Protocol):
    """Protocol the graph uses to request an angle from a model."""

    def evaluate_one(
        self,
        *,
        prompt: AnglePrompt,
        canonical_url: str,
        timeout_seconds: float,
    ) -> AngleOutput | None:
        """Return one angle for the given article, or ``None`` if no angle qualifies.

        The graph treats ``None`` as "skip this article" — the reducer
        simply will not append. Any structural validation failure should
        also return ``None`` after retry exhaustion (the graph logs a
        diagnostic) rather than raise.
        """


class FakeAngleModel:
    """Deterministic angle model used in tests and offline CI.

    The fake reads a JSON file supplied at construction time and returns
    the matching entry for the requested ``canonical_url``. URLs that do
    not match a fixture return ``None``. The fake is intentionally
    side-effect-free: it does not touch the network.
    """

    def __init__(self, fixtures: list[AngleOutput]) -> None:
        self._by_url: dict[str, AngleOutput] = {
            f.canonical_url: f for f in fixtures if f.canonical_url
        }

    def evaluate_one(
        self,
        *,
        prompt: AnglePrompt,
        canonical_url: str,
        timeout_seconds: float,
    ) -> AngleOutput | None:
        return self._by_url.get(canonical_url)


__all__ = [
    "AngleOutput",
    "AnglePrompt",
    "StructuredAngleModel",
    "FakeAngleModel",
    "load_prompts",
]


def _safe_load_angle_output(raw: str) -> AngleOutput | None:
    """Best-effort JSON parse + Pydantic validation. Used by adapters."""

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        return AngleOutput.model_validate(data)
    except ValidationError:
        return None
