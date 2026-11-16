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

# Tweet types the filter model classifies candidates into. Each maps to a
# skill directory under ``agents/skills/content/`` (PR #1007) whose raw
# ``SKILL.md`` text is the writer model's sole style guidance — including
# that skill's own per-article link-inclusion judgment. The pipeline does
# not enforce a URL policy of its own; see ``_SKILL_DIR_BY_TWEET_TYPE``.
TWEET_TYPES = ("short_tip", "personal_philosophy", "personality_post")

_SKILL_DIR_BY_TWEET_TYPE = {
    "short_tip": "tweet-short-tip",
    "personal_philosophy": "tweet-personal-philosophy",
    "personality_post": "tweet-personality-post",
}


# Locating the prompt files relative to the package avoids any
# CWD-dependent lookup. The package layout is:
#   src/cto_craft_workflow/angle_model.py
#   ../../prompts/angle-evaluator.md
#   ../../prompts/tom-worldview.md
_PACKAGE_DIR = Path(__file__).resolve().parent
_PROMPTS_DIR = _PACKAGE_DIR.parent.parent / "prompts"
_REPO_ROOT = _PACKAGE_DIR.parents[4]
_SKILLS_DIR = _REPO_ROOT / "agents" / "skills" / "content"


class AngleOutput(BaseModel):
    """Strict schema for one angle emitted by the filter model.

    The filter's job is relevance/worldview scoring and tweet-type
    classification only. It never writes final tweet copy — that is the
    writer model's job (see :class:`TweetWriterOutput` below), driven by
    the per-type skill named in ``suggested_tweet_type``.
    """

    model_config = ConfigDict(extra="forbid")

    canonical_url: str = Field(min_length=1)
    angle: str = Field(min_length=1, max_length=200)
    suggested_tweet_type: str = Field(min_length=1)
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
        "suggested_tweet_type": "one of: short_tip, personal_philosophy, personality_post",
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


def _load_prompt_or_raise(path: Path) -> str:
    """Read a prompt file at module import time, raising on missing files.

    Mirrors the original ``load_prompts()`` fail-fast contract: a missing
    prompt file becomes a ``RuntimeError`` with the same message format.
    Called once per prompt at module import so the result is cached and
    no synchronous file I/O occurs on the LangGraph Studio request path.
    """
    if not path.exists():
        raise RuntimeError(
            f"missing prompt file: {path}. "
            "The CTO Craft package must ship prompts/"
            f"{path.name}."
        )
    return path.read_text(encoding="utf-8")


# Loaded once at import; cached for the lifetime of the process.
# This is the key behaviour change vs the previous load_prompts()
# implementation: callers on async request paths (e.g. LangGraph Studio's
# graph inspection via get_assistant_subgraphs) no longer trigger
# blockbuster.BlockingError on a synchronous Path.read_text() call.
_ANGLE_EVALUATOR_PROMPT: str = _load_prompt_or_raise(
    _PROMPTS_DIR / "angle-evaluator.md"
)
_TOM_WORLDVIEW_PROFILE: str = _load_prompt_or_raise(
    _PROMPTS_DIR / "tom-worldview.md"
)


def load_prompts() -> tuple[str, str]:
    """Return the angle-evaluator and Tom-worldview prompts.

    Returns a tuple ``(system_prompt, worldview_profile)``. The system
    prompt is the literal contents of ``angle-evaluator.md``; the profile
    is the literal contents of ``tom-worldview.md``.

    The strings are loaded once at module import time and cached in
    module-level constants, so callers on the LangGraph Studio request
    path (which runs on an async loop) do not trigger the ``blockbuster``
    guard on a synchronous ``Path.read_text()``. The wrapper preserves
    the original tuple signature so existing call-sites do not change.
    """

    return _ANGLE_EVALUATOR_PROMPT, _TOM_WORLDVIEW_PROFILE


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
    "TWEET_TYPES",
    "load_prompts",
    "load_skill_text",
    "TweetWriterOutput",
    "WriterPrompt",
    "TweetWriter",
    "FakeTweetWriter",
    "OpenClawWriterConfig",
    "OpenClawTweetWriter",
    "DEFAULT_WRITER_COMMAND",
    "DEFAULT_WRITER_MODEL",
    "DEFAULT_WRITER_FALLBACK_MODEL",
    "DEFAULT_WRITER_THINKING_LEVEL",
    "DEFAULT_WRITER_MAX_ATTEMPTS",
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


# ---------------------------------------------------------------------------
# Writer model — turns one filtered angle into final tweet copy.
#
# Per Tom (2026-11-17): the matching skill's SKILL.md raw text is passed
# directly into the writer's raw model call as literal prompt text — the
# same mechanism ``angle-evaluator.md`` uses for the filter call above. No
# skill-loading runtime, no agent session. The skill owns voice, structure,
# AND the per-article judgment on whether to include the source URL; this
# module does not second-guess that judgment or enforce a link rule of its
# own.

DEFAULT_WRITER_COMMAND = "openclaw"
DEFAULT_WRITER_MODEL = "openai/gpt-5.6-luna"
# MiniMax is the only model confirmed always-reachable via the gateway
# (OpenAI/Anthropic models intermittently fail on auth/rate-limit/billing —
# see task 2e724316). Falling back to it keeps a week's batch from being
# dropped entirely when the better writer model is unavailable.
DEFAULT_WRITER_FALLBACK_MODEL = DEFAULT_OPENCLAW_MODEL
# gpt-5.6-luna has no "off" thinking level; "low" is the cheapest supported.
DEFAULT_WRITER_THINKING_LEVEL = "low"
DEFAULT_WRITER_MAX_ATTEMPTS = 2


class TweetWriterOutput(BaseModel):
    """Strict schema for the writer model's final tweet copy."""

    model_config = ConfigDict(extra="forbid")

    tweet_body: str = Field(min_length=1, max_length=280)


@dataclass(frozen=True)
class WriterPrompt:
    """Everything the writer model needs for one angle."""

    skill_text: str
    angle: str
    evidence_excerpt: str
    canonical_url: str


def load_skill_text(tweet_type: str) -> str:
    """Read the raw ``SKILL.md`` text for the given tweet type.

    Raises ``RuntimeError`` for an unknown type or a missing skill file —
    both are configuration errors, not per-article failures, so they are
    not swallowed the way a single bad model response is.
    """

    skill_dir = _SKILL_DIR_BY_TWEET_TYPE.get(tweet_type)
    if skill_dir is None:
        raise RuntimeError(
            f"unknown tweet type {tweet_type!r}; expected one of {TWEET_TYPES}"
        )
    skill_path = _SKILLS_DIR / skill_dir / "SKILL.md"
    if not skill_path.exists():
        raise RuntimeError(f"missing skill file: {skill_path}")
    return skill_path.read_text(encoding="utf-8")


def _build_writer_message(prompt: WriterPrompt) -> str:
    schema = {"tweet_body": "the finished tweet, 1-280 raw characters, no markdown"}
    return (
        "You are writing one tweet for the CTO Craft weekly batch.\n"
        "Follow the skill below exactly — it defines voice, structure, and\n"
        "whether this tweet should include the source URL. Do not apply any\n"
        "link rule other than the one stated in the skill.\n"
        "Return exactly one JSON object matching the schema below and nothing\n"
        "else. Do not wrap it in markdown fences. Do not call tools.\n\n"
        f"Skill:\n{prompt.skill_text}\n\n"
        f"Angle: {prompt.angle}\n"
        f"Evidence excerpt: {prompt.evidence_excerpt}\n"
        f"Source URL: {prompt.canonical_url}\n\n"
        f"Required JSON shape:\n{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def _safe_load_writer_output(raw: str) -> TweetWriterOutput | None:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        return TweetWriterOutput.model_validate(data)
    except ValidationError:
        return None


@runtime_checkable
class TweetWriter(Protocol):
    """Protocol the graph uses to write final tweet copy for one angle."""

    def write_one(
        self,
        *,
        prompt: WriterPrompt,
        timeout_seconds: float,
    ) -> str | None:
        """Return the finished tweet body, or ``None`` on unrecoverable failure."""


class FakeTweetWriter:
    """Deterministic writer for tests: appends a marker to the angle text."""

    def __init__(self, by_url: dict[str, str] | None = None) -> None:
        self._by_url = by_url or {}

    def write_one(self, *, prompt: WriterPrompt, timeout_seconds: float) -> str | None:
        if prompt.canonical_url in self._by_url:
            return self._by_url[prompt.canonical_url]
        return f"{prompt.angle} ({prompt.canonical_url})"[:280]


@dataclass(frozen=True)
class OpenClawWriterConfig:
    """Runtime configuration for the production writer adapter."""

    model: str = DEFAULT_WRITER_MODEL
    fallback_model: str = DEFAULT_WRITER_FALLBACK_MODEL
    thinking_level: str = DEFAULT_WRITER_THINKING_LEVEL
    openclaw_command: str = DEFAULT_WRITER_COMMAND
    max_attempts: int = DEFAULT_WRITER_MAX_ATTEMPTS
    cwd: str = str(_REPO_ROOT)


class OpenClawTweetWriter:
    """Production adapter: raw model call with the skill text as the prompt.

    Tries ``model`` for ``max_attempts`` attempts; if every attempt fails
    (timeout, process error, or invalid structured output), retries once
    against ``fallback_model`` before giving up. The fallback keeps a
    model outage on the primary writer from dropping the week's batch —
    see AC3 on task 2e724316.
    """

    def __init__(
        self,
        *,
        config: OpenClawWriterConfig,
        runner: Runner | None = None,
    ) -> None:
        attempts = max(1, min(config.max_attempts, MAX_OPENCLAW_MAX_ATTEMPTS))
        self._config = OpenClawWriterConfig(
            model=config.model.strip() or DEFAULT_WRITER_MODEL,
            fallback_model=config.fallback_model.strip() or DEFAULT_WRITER_FALLBACK_MODEL,
            thinking_level=config.thinking_level.strip() or DEFAULT_WRITER_THINKING_LEVEL,
            openclaw_command=config.openclaw_command.strip() or DEFAULT_WRITER_COMMAND,
            max_attempts=attempts,
            cwd=config.cwd,
        )
        self._runner = runner or _run_openclaw

    def write_one(self, *, prompt: WriterPrompt, timeout_seconds: float) -> str | None:
        for model in (self._config.model, self._config.fallback_model):
            result = self._try_model(model=model, prompt=prompt, timeout_seconds=timeout_seconds)
            if result is not None:
                return result
            log.warning(
                "writer model exhausted attempts, trying next model",
                extra={"canonicalUrl": prompt.canonical_url, "model": model},
            )
        return None

    def _try_model(self, *, model: str, prompt: WriterPrompt, timeout_seconds: float) -> str | None:
        message = _build_writer_message(prompt)
        args = [
            self._config.openclaw_command,
            "infer", "model", "run",
            "--gateway", "--json",
            "--thinking", self._config.thinking_level,
            "--model", model,
            "--prompt", "__PROMPT__",
        ]
        for attempt in range(1, self._config.max_attempts + 1):
            try:
                completed = self._runner(args, message, timeout_seconds, self._config.cwd)
            except subprocess.TimeoutExpired:
                log.warning(
                    "writer model timed out",
                    extra={"canonicalUrl": prompt.canonical_url, "model": model, "attempt": attempt},
                )
                if attempt < self._config.max_attempts:
                    continue
                return None
            except FileNotFoundError:
                log.error("writer model command missing", extra={"command": self._config.openclaw_command})
                return None
            except subprocess.CalledProcessError as exc:
                detail = _process_error_detail(exc)
                log.warning(
                    "writer model invocation failed",
                    extra={"canonicalUrl": prompt.canonical_url, "model": model, "attempt": attempt, "detail": detail[:240]},
                )
                if attempt < self._config.max_attempts and _is_retryable_process_error(detail):
                    continue
                return None

            raw = _extract_model_text((completed.stdout or "").strip())
            if not raw:
                if attempt < self._config.max_attempts:
                    continue
                return None

            parsed = _safe_load_writer_output(raw)
            if parsed is not None:
                log.info("writer model succeeded", extra={"canonicalUrl": prompt.canonical_url, "model": model, "attempt": attempt})
                return parsed.tweet_body

            if attempt < self._config.max_attempts:
                continue
            return None

        return None
