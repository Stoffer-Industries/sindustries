"""Structured angle model adapter for the CTO Craft pipeline.

The graph is model-agnostic. It only knows about the
:class:`StructuredAngleModel` protocol and the :class:`AngleOutput` Pydantic
schema. The production adapter embeds a one-shot OpenClaw model invocation
that returns strict JSON only. The fake adapter is deterministic and
offline-capable so CI never needs API keys or network access.

The angle-evaluator system prompt is loaded from
``prompts/angle-evaluator.md`` and is versioned alongside the workflow so
changes are tracked in git. The Tom worldview profile is loaded from
``prompts/tom-worldview.md`` and is appended to the system prompt.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol, runtime_checkable

# Bootstrap `agents.lib` so `from agents.lib import safe_run` works under plain
# `python3 <this>.py` invocations. Walks up from `__file__` looking for a
# directory containing `agents/lib/`.
import sys as _sys
from pathlib import Path as _p
_w = next(
    (a for a in [_p(__file__).resolve().parent, *_p(__file__).resolve().parents]
     if (a / "agents" / "lib").is_dir()), None)
if _w is not None and str(_w) not in _sys.path:
    _sys.path.insert(0, str(_w))
del _sys, _p, _w

from agents.lib import safe_run

from pydantic import BaseModel, ConfigDict, Field, ValidationError


log = logging.getLogger("cto_craft_workflow.angle_model")

DEFAULT_OPENCLAW_COMMAND = "openclaw"
DEFAULT_OPENCLAW_MODEL = "minimax-portal/MiniMax-M3"
DEFAULT_OPENCLAW_MAX_ATTEMPTS = 2
MAX_OPENCLAW_MAX_ATTEMPTS = 3


# Locating the prompt files relative to the package avoids any
# CWD-dependent lookup. The package layout is:
#   src/cto_craft_workflow/angle_model.py
#   ../../prompts/angle-evaluator.md
#   ../../prompts/tom-worldview.md
_PACKAGE_DIR = Path(__file__).resolve().parent
_PROMPTS_DIR = _PACKAGE_DIR.parent.parent / "prompts"
_REPO_ROOT = _PACKAGE_DIR.parents[4]


class AngleOutput(BaseModel):
    """Strict schema for one angle emitted by the model."""

    model_config = ConfigDict(extra="forbid")

    canonical_url: str = Field(min_length=1)
    angle: str = Field(min_length=1, max_length=200)
    tweet_body: str = Field(min_length=1, max_length=280)
    evidence_excerpt: str = Field(min_length=1, max_length=500)
    resonance_score: float = Field(ge=0.0, le=1.0)
    evidence_strength: float = Field(ge=0.0, le=1.0)
    worldview_axes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class AnglePrompt:
    """Rendered prompt for one angle call."""

    system_prompt: str
    user_message: str


Runner = Callable[[list[str], str, float, str], subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class OpenClawInvocationConfig:
    """Runtime configuration for the production OpenClaw adapter."""

    model: str = DEFAULT_OPENCLAW_MODEL
    openclaw_command: str = DEFAULT_OPENCLAW_COMMAND
    max_attempts: int = DEFAULT_OPENCLAW_MAX_ATTEMPTS
    cwd: str = str(_REPO_ROOT)


class OpenClawStructuredAngleModel:
    """Production adapter backed by a one-shot OpenClaw model call."""

    def __init__(
        self,
        *,
        config: OpenClawInvocationConfig,
        runner: Runner | None = None,
    ) -> None:
        attempts = max(1, min(config.max_attempts, MAX_OPENCLAW_MAX_ATTEMPTS))
        self._config = OpenClawInvocationConfig(
            model=config.model.strip() or DEFAULT_OPENCLAW_MODEL,
            openclaw_command=config.openclaw_command.strip() or DEFAULT_OPENCLAW_COMMAND,
            max_attempts=attempts,
            cwd=config.cwd,
        )
        self._runner = runner or _run_openclaw

    def evaluate_one(
        self,
        *,
        prompt: AnglePrompt,
        canonical_url: str,
        timeout_seconds: float,
    ) -> AngleOutput | None:
        message = _build_openclaw_message(prompt)
        for attempt in range(1, self._config.max_attempts + 1):
            try:
                completed = self._runner(
                    self._command_args(),
                    message,
                    timeout_seconds,
                    self._config.cwd,
                )
            except subprocess.TimeoutExpired:
                log.warning(
                    "angle model timed out",
                    extra={
                        "canonicalUrl": canonical_url,
                        "model": self._config.model,
                        "path": "openclaw-infer",
                        "attempt": attempt,
                        "maxAttempts": self._config.max_attempts,
                    },
                )
                if attempt < self._config.max_attempts:
                    continue
                return None
            except FileNotFoundError:
                log.error(
                    "angle model command missing",
                    extra={
                        "canonicalUrl": canonical_url,
                        "model": self._config.model,
                        "path": "openclaw-infer",
                        "command": self._config.openclaw_command,
                    },
                )
                return None
            except subprocess.CalledProcessError as exc:
                detail = _process_error_detail(exc)
                log.warning(
                    "angle model invocation failed",
                    extra={
                        "canonicalUrl": canonical_url,
                        "model": self._config.model,
                        "path": "openclaw-infer",
                        "attempt": attempt,
                        "maxAttempts": self._config.max_attempts,
                        "detail": detail[:240],
                    },
                )
                if attempt < self._config.max_attempts and _is_retryable_process_error(detail):
                    continue
                return None

            raw = _extract_model_text((completed.stdout or "").strip())
            if not raw:
                log.warning(
                    "angle model returned empty output",
                    extra={
                        "canonicalUrl": canonical_url,
                        "model": self._config.model,
                        "path": "openclaw-infer",
                        "attempt": attempt,
                        "maxAttempts": self._config.max_attempts,
                    },
                )
                if attempt < self._config.max_attempts:
                    continue
                return None

            if raw == "null":
                return None

            parsed = _safe_load_angle_output(raw)
            if parsed is not None and parsed.canonical_url == canonical_url:
                log.info(
                    "angle model succeeded",
                    extra={
                        "canonicalUrl": canonical_url,
                        "model": self._config.model,
                        "path": "openclaw-infer",
                        "attempt": attempt,
                    },
                )
                return parsed

            log.warning(
                "angle model returned invalid structured output",
                extra={
                    "canonicalUrl": canonical_url,
                    "model": self._config.model,
                    "path": "openclaw-infer",
                    "attempt": attempt,
                    "maxAttempts": self._config.max_attempts,
                    "urlMatched": parsed is not None and parsed.canonical_url == canonical_url,
                },
            )
            if attempt < self._config.max_attempts:
                continue
            return None

        return None

    def _command_args(self) -> list[str]:
        return [
            self._config.openclaw_command,
            "infer",
            "model",
            "run",
            "--gateway",
            "--json",
            "--thinking",
            "off",
            "--model",
            self._config.model,
            "--prompt",
            "__PROMPT__",
        ]


def _run_openclaw(
    args: list[str],
    message: str,
    timeout_seconds: float,
    cwd: str,
) -> subprocess.CompletedProcess[str]:
    command = [message if part == "__PROMPT__" else part for part in args]
    return safe_run(
        command,
        check=True,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=timeout_seconds,
    )


def _extract_model_text(raw: str) -> str:
    """Extract the sole text payload from ``openclaw infer model run --json``."""

    try:
        envelope = json.loads(raw)
        outputs = envelope.get("outputs") if isinstance(envelope, dict) else None
        if not isinstance(outputs, list) or len(outputs) != 1:
            return ""
        text = outputs[0].get("text") if isinstance(outputs[0], dict) else None
        return text.strip() if isinstance(text, str) else ""
    except (json.JSONDecodeError, AttributeError):
        return ""


def _process_error_detail(exc: subprocess.CalledProcessError) -> str:
    return ((exc.stderr or "") + "\n" + (exc.stdout or "")).strip() or str(exc)


def _is_retryable_process_error(detail: str) -> bool:
    haystack = detail.lower()
    transient_markers = (
        "internal error",
        "timed out",
        "timeout",
        "429",
        "502",
        "503",
        "504",
        "rate limit",
        "overloaded",
        "temporarily unavailable",
        "connection reset",
        "connection refused",
        "econnreset",
        "try again",
    )
    return any(marker in haystack for marker in transient_markers)


def _build_openclaw_message(prompt: AnglePrompt) -> str:
    schema = {
        "canonical_url": "https://example.com/the-article",
        "angle": "short one-sentence description of the claim",
        "tweet_body": "tweet body, 1-280 chars, no links",
        "evidence_excerpt": "1-2 sentence excerpt from the article",
        "resonance_score": 0.0,
        "evidence_strength": 0.0,
        "worldview_axes": ["builder_architect"],
    }
    return (
        "You are performing a structured CTO Craft angle evaluation.\n"
        "Return exactly one JSON value and nothing else.\n"
        "Allowed outputs:\n"
        "- a single JSON object matching the schema below\n"
        "- null if no angle qualifies\n"
        "Do not wrap the JSON in markdown fences.\n"
        "Do not call tools or request follow-up input.\n\n"
        f"System prompt:\n{prompt.system_prompt}\n\n"
        f"User message:\n{prompt.user_message}\n\n"
        f"Required JSON shape:\n{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


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
        also return ``None`` after retry exhaustion rather than raise.
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
    "OpenClawInvocationConfig",
    "OpenClawStructuredAngleModel",
    "DEFAULT_OPENCLAW_COMMAND",
    "DEFAULT_OPENCLAW_MODEL",
    "DEFAULT_OPENCLAW_MAX_ATTEMPTS",
    "MAX_OPENCLAW_MAX_ATTEMPTS",
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
