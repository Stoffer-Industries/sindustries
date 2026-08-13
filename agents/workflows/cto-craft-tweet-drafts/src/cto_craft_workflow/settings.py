"""Typed environment configuration for the CTO Craft workflow.

A single :class:`Settings` instance is built at startup and passed to the
graph and adapters. Defaults are tuned for the documented Monday
``Pacific/Auckland`` cadence and the small weekly runtime profile, not for
high-volume use.

The module reads from ``os.environ`` directly so that ``run.py`` can build
Settings without first importing LangGraph. Anywhere that needs to behave
differently in tests does so by passing synthetic Settings, not by patching
``os.environ``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from cto_craft_workflow.state import MAX_SELECTED_ANGLES, MIN_QUALIFIED_CANDIDATES


DEFAULT_TMW_ARCHIVE_URL = "https://www.techmanagerweekly.com/"
DEFAULT_FETCH_TIMEOUT_SECONDS = 15.0
DEFAULT_MODEL_TIMEOUT_SECONDS = 30.0
DEFAULT_MIN_RESONANCE_SCORE = 0.55
DEFAULT_OPENCLAW_MODEL = "minimax-portal/MiniMax-M3"
DEFAULT_OPENCLAW_MAX_ATTEMPTS = 2
DEFAULT_MAX_ISSUE_BYTES = 1 * 1024 * 1024
DEFAULT_MAX_ARTICLE_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_REDIRECTS = 5
USER_AGENT = "sindustries-cto-craft-workflow/0.1 (+internal)"


@dataclass(frozen=True)
class Settings:
    """Static, validated configuration for one workflow invocation."""

    tmw_archive_url: str
    database_url: str | None
    content_scheduler_base_url: str
    content_scheduler_ingest_secret: str | None
    fetch_timeout_seconds: float
    model_timeout_seconds: float
    min_resonance_score: float
    openclaw_model: str
    openclaw_max_attempts: int
    max_issue_bytes: int
    max_article_bytes: int
    max_redirects: int
    require_ingest_secret: bool
    min_qualified_candidates: int = MIN_QUALIFIED_CANDIDATES
    max_selected_angles: int = MAX_SELECTED_ANGLES

    # Local-only knobs that tests use to pin time/calendar. Not read from env.
    tz_name: str = field(default="Pacific/Auckland")

    def with_overrides(self, **kwargs: object) -> "Settings":
        """Return a copy with the given fields overridden."""

        return Settings(**{**self.__dict__, **kwargs})


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"required environment variable {name!r} is not set. "
            "The cron prompt provisions this; running locally requires "
            "the same env contract."
        )
    return value


def _optional_env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _optional_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a float, got {raw!r}") from exc
    return value


def _optional_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc
    return value


def _optional_score(name: str, default: float) -> float:
    value = _optional_float(name, default)
    if not 0.0 <= value <= 1.0:
        raise RuntimeError(f"{name} must be in [0.0, 1.0], got {value}")
    return value


def _optional_model(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _optional_attempts(name: str, default: int) -> int:
    value = _optional_int(name, default)
    if value < 1 or value > 3:
        raise RuntimeError(f"{name} must be in [1, 3], got {value}")
    return value


def load_settings(*, require_secrets: bool = True) -> Settings:
    """Build a Settings instance from the current process environment.

    ``require_secrets`` is False for the ``validate`` CLI command and for
    tests, both of which should be runnable without the live cron env. The
    production ``run`` and ``replay`` commands always require secrets.
    """

    base_url = _optional_env("CONTENT_SCHEDULER_BASE_URL", "http://localhost:4000")
    secret = _optional_env("CONTENT_SCHEDULER_INGEST_SECRET", "")
    require_ingest_secret = False
    if require_secrets:
        if not secret:
            raise RuntimeError(
                "CONTENT_SCHEDULER_INGEST_SECRET is required for run/replay. "
                "Generate with `openssl rand -hex 32` and provision the same "
                "value to the workflow and the Content Scheduler API."
            )
        require_ingest_secret = True
    elif not secret:
        secret = None

    database_url = os.environ.get("CTO_CRAFT_LANGGRAPH_DATABASE_URL", "").strip() or None
    if require_secrets and not database_url:
        raise RuntimeError(
            "CTO_CRAFT_LANGGRAPH_DATABASE_URL is required for run/replay. "
            "Use a separate logical database or schema for LangGraph "
            "checkpoints; do not reuse the Content Scheduler database."
        )

    return Settings(
        tmw_archive_url=_optional_env("CTO_CRAFT_TMW_ARCHIVE_URL", DEFAULT_TMW_ARCHIVE_URL),
        database_url=database_url,
        content_scheduler_base_url=base_url,
        content_scheduler_ingest_secret=secret,
        fetch_timeout_seconds=_optional_float(
            "CTO_CRAFT_FETCH_TIMEOUT_SECONDS", DEFAULT_FETCH_TIMEOUT_SECONDS
        ),
        model_timeout_seconds=_optional_float(
            "CTO_CRAFT_MODEL_TIMEOUT_SECONDS", DEFAULT_MODEL_TIMEOUT_SECONDS
        ),
        min_resonance_score=_optional_score(
            "CTO_CRAFT_MIN_RESONANCE_SCORE", DEFAULT_MIN_RESONANCE_SCORE
        ),
        openclaw_model=_optional_model(
            "CTO_CRAFT_OPENCLAW_MODEL", DEFAULT_OPENCLAW_MODEL
        ),
        openclaw_max_attempts=_optional_attempts(
            "CTO_CRAFT_OPENCLAW_MAX_ATTEMPTS", DEFAULT_OPENCLAW_MAX_ATTEMPTS
        ),
        max_issue_bytes=_optional_int(
            "CTO_CRAFT_MAX_ISSUE_BYTES", DEFAULT_MAX_ISSUE_BYTES
        ),
        max_article_bytes=_optional_int(
            "CTO_CRAFT_MAX_ARTICLE_BYTES", DEFAULT_MAX_ARTICLE_BYTES
        ),
        max_redirects=_optional_int("CTO_CRAFT_MAX_REDIRECTS", DEFAULT_MAX_REDIRECTS),
        require_ingest_secret=require_ingest_secret,
    )


# ``_require_env`` is intentionally exported only for tests that need to
# assert a specific missing-variable error path.
__all__ = [
    "Settings",
    "load_settings",
    "DEFAULT_TMW_ARCHIVE_URL",
    "DEFAULT_FETCH_TIMEOUT_SECONDS",
    "DEFAULT_MODEL_TIMEOUT_SECONDS",
    "DEFAULT_MIN_RESONANCE_SCORE",
    "DEFAULT_OPENCLAW_MODEL",
    "DEFAULT_OPENCLAW_MAX_ATTEMPTS",
    "DEFAULT_MAX_ISSUE_BYTES",
    "DEFAULT_MAX_ARTICLE_BYTES",
    "DEFAULT_MAX_REDIRECTS",
    "USER_AGENT",
]
