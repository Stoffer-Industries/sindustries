#!/usr/bin/env python3
"""Best-effort author-tweet poster for the bookmark approval flow.

When Tom approves an X-sourced bookmark and at least one task ID is created,
this module composes a short reply tweet at the original author's handle and
posts it via the tasks-api `POST /api/v1/x/tweets` route. Failures are
recorded back to the bookmark state under `tweetLog` and never block the
underlying approval transition (AC3 best-effort contract).

Module surface:
    - parse_x_link(url)                       -> (handle, status_id) | None
    - parse_x_status_id(url)                  -> status_id | None (no handle required;
                                                 also matches `x.com/i/web/status/<id>`)
    - resolve_tweet_author(status_id, ...)    -> handle | None (best-effort GET via
                                                 tasks-api `/x/tweets/:id/author`)
    - compose_author_tweet(state_item)        -> str   (≤280 chars; raises TweetComposeError)
    - call_x_tweets_route(text, status_id)    -> {"url", "postedAt"} | raises XApiError
                                                 | CredentialsMissingError
                                                 | TasksApiUnreachableError
    - try_post_author_tweet(state_item, ...)  -> dict  (the tweetLog payload to merge)

AC mapping (task 55ac9240-d54a-4b2c-88c4-8bb8af85d2b2):
    AC1 — reply posted (handle + content-specific question)
    AC2 — non-X source silently skipped (no tweetLog written)
    AC3 — X API failure recorded as error, approval still resolves
    AC4 — tweetLog written back to state with status / tweetUrl / postedAt / error
    AC5 (reframed) — getXClient() == null ⇒ 503 ⇒ tweetLog.status == "skipped"

Ref: docs/specs/bookmark-approval-author-tweet-tech-design.md
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any

from common import invoke_llm_json

logger = logging.getLogger("bookmark.x_author_tweet")


# --- Public status enum (used in tweetLog.status) ------------------------

POSTED = "posted"
SKIPPED = "skipped"
ERROR = "error"


# --- Exceptions ----------------------------------------------------------

class TweetComposeError(RuntimeError):
    """Tweet composition (LLM) failed."""


class CredentialsMissingError(RuntimeError):
    """tasks-api `getXClient()` returned null — no X credentials configured."""


class XApiError(RuntimeError):
    """tasks-api `POST /x/tweets` returned a 4xx/5xx."""


class TasksApiUnreachableError(RuntimeError):
    """tasks-api itself is unreachable (DNS / connection refused / timeout)."""


# --- URL parsing ---------------------------------------------------------

# x.com / twitter.com canonical status URL — handle and status id.
_X_STATUS_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:twitter|x)\.com/(?P<handle>[A-Za-z0-9_]{1,15})/status(?:es)?/(?P<status_id>\d+)/?(?:\?.*)?(?:#.*)?$",
    re.IGNORECASE,
)


def parse_x_link(url: str | None) -> tuple[str, str] | None:
    """Parse a bookmark URL into ``(handle, status_id)`` if it's an X status URL.

    Returns ``None`` for non-X URLs, malformed paths, or empty handles. Splits
    on ``/status/`` or ``/statuses/`` (legacy alias), trims query string and
    anchor, accepts x.com / twitter.com / mobile.twitter.com variants.
    """
    if not isinstance(url, str):
        return None
    cleaned = url.strip()
    if not cleaned:
        return None
    match = _X_STATUS_RE.match(cleaned)
    if not match:
        return None
    handle = match.group("handle").strip()
    status_id = match.group("status_id").strip()
    if not handle or not status_id:
        return None
    return (handle, status_id)


# x.com host + any /status/<id> segment, regardless of what comes before it.
# Superset of _X_STATUS_RE: also matches X's generic web-intent share links
# like `x.com/i/web/status/<id>`, which don't carry the author's handle in
# the path at all (parse_x_link returns None for those).
_X_HOST_RE = re.compile(r"^https?://(?:www\.|mobile\.)?(?:twitter|x)\.com/", re.IGNORECASE)
_X_STATUS_ID_ONLY_RE = re.compile(r"/status(?:es)?/(?P<status_id>\d+)(?:/|\?|#|$)", re.IGNORECASE)


def parse_x_status_id(url: str | None) -> str | None:
    """Extract just the numeric status id from any x.com/twitter.com URL.

    Unlike ``parse_x_link``, this does not require a handle segment before
    ``/status/`` — it also matches generic share-link formats such as
    ``x.com/i/web/status/<id>`` where the author isn't in the URL at all.
    Callers that need the author must resolve it separately (see
    ``resolve_tweet_author``).
    """
    if not isinstance(url, str):
        return None
    cleaned = url.strip()
    if not cleaned or not _X_HOST_RE.match(cleaned):
        return None
    match = _X_STATUS_ID_ONLY_RE.search(cleaned)
    return match.group("status_id") if match else None


# --- Tweet composition ---------------------------------------------------

AUTHOR_TWEET_PROMPT = """You are writing a single reply tweet on behalf of @sindustries.
The tweet will be posted as a public reply to an X post we just bookmarked and started working on.

Your job is to notify the original author that their post made it through triage,
that work has begun, and to invite a brief on-topic follow-up question that fits
the content of the bookmark.

Constraints:
- Length: 1-280 characters (hard cap). Short is better — one or two sentences.
- MUST mention the author by `@<handle>` exactly as provided.
- MUST reference the bookmark content (title or body excerpt) so the reply is
  recognisable to the author and the audience, not a generic ping.
- MUST end with exactly one on-topic question.
- MUST NOT include hashtags, links, or @-mentions other than the original
  author handle.
- MUST NOT promise delivery dates, scope, or outcomes.
- MUST NOT use marketing language ("excited to announce", "thrilled", "love").
- MUST stay factual and quiet in tone; the goal is builder-in-public transparency,
  not self-promotion.

Output format: the tweet text and nothing else. No markdown. No quotes. No
leading labels.
"""

_AUTHOR_TWEET_SCHEMA = {
    "tweet": "string, 1-280 characters, plain text, no hashtags or links"
}


def compose_author_tweet(state_item: dict[str, Any]) -> str:
    """Compose a tweet body for an approved X bookmark.

    Raises ``TweetComposeError`` if the LLM call fails or returns empty text.
    The composed string is trimmed; caller is responsible for length validation
    (the route enforces the 280-char cap server-side).
    """
    if not isinstance(state_item, dict):
        raise TweetComposeError("state_item must be a dict")
    parsed = parse_x_link(state_item.get("link"))
    handle = parsed[0] if parsed else (state_item.get("authorHandle") or "")
    if not handle:
        raise TweetComposeError("no author handle available for tweet composition")
    title = (state_item.get("title") or "").strip()
    body_excerpt = (state_item.get("bodyExcerpt") or "")[:300].strip()
    tags = state_item.get("tags") or []

    input_payload = {
        "handle": handle,
        "title": title,
        "bodyExcerpt": body_excerpt,
        "tags": tags,
    }
    try:
        result = invoke_llm_json(
            AUTHOR_TWEET_PROMPT,
            input_payload,
            _AUTHOR_TWEET_SCHEMA,
        )
    except Exception as exc:  # common.invoke_llm_json raises LLMInvocationError on failure
        raise TweetComposeError(f"llm_compose_failed:{exc}") from exc

    tweet = ""
    if isinstance(result, dict):
        raw = result.get("tweet")
        if isinstance(raw, str):
            tweet = raw.strip()
    if not tweet:
        raise TweetComposeError("llm_compose_failed:empty_output")
    return tweet


# --- tasks-api HTTP helper -----------------------------------------------

DEFAULT_TASKS_API_BASE_URL = "http://localhost:4001/api/v1"
_TIMEOUT_SECONDS = 10


def _tasks_api_base_url(override: str | None = None) -> str:
    base = (override or os.getenv("TASKS_API_BASE_URL") or DEFAULT_TASKS_API_BASE_URL).strip()
    return base.rstrip("/")


def call_x_tweets_route(
    text: str,
    status_id: str,
    *,
    base_url: str | None = None,
) -> dict[str, Any]:
    """POST to ``{base}/x/tweets`` and return ``{"url", "postedAt"}``.

    Raises:
        CredentialsMissingError — 503 MISSING_CREDENTIALS (AC5 reframed).
        XApiError               — other 4xx/5xx (AC3).
        TasksApiUnreachableError— connection / DNS / timeout failures.
    """
    url = f"{_tasks_api_base_url(base_url)}/x/tweets"
    body = json.dumps({"text": text, "in_reply_to_tweet_id": status_id}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            data = payload.get("data") or {}
            return {"url": data.get("url"), "postedAt": data.get("postedAt")}
    except urllib.error.HTTPError as exc:
        # The body is small JSON; read it once and translate the error code.
        try:
            payload = json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
        err = (payload.get("error") or {}) if isinstance(payload, dict) else {}
        code = err.get("code") or ""
        message = err.get("message") or exc.reason or "unknown"
        if exc.code == 503 or code == "MISSING_CREDENTIALS":
            raise CredentialsMissingError(f"missing_credentials:{message}") from exc
        raise XApiError(f"x_api_{exc.code}:{message}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        # Tasks-api down / DNS / refused / timeout — degrade gracefully.
        reason = getattr(exc, "reason", None) or str(exc) or exc.__class__.__name__
        raise TasksApiUnreachableError(f"tasks_api_unreachable:{reason}") from exc


def resolve_tweet_author(status_id: str, *, base_url: str | None = None) -> str | None:
    """Best-effort GET of a tweet's author handle via tasks-api.

    Returns ``None`` on any failure (missing credentials, tweet not found,
    X API error, tasks-api unreachable) rather than raising — callers use
    this to fill in a handle for links like `x.com/i/web/status/<id>` that
    don't carry one, and fall back to the existing `missing_x_link` skip
    when resolution doesn't produce a usable handle.
    """
    url = f"{_tasks_api_base_url(base_url)}/x/tweets/{status_id}/author"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            handle = (payload.get("data") or {}).get("handle")
            return handle if isinstance(handle, str) and handle else None
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return None


# --- Integration entry point ---------------------------------------------

def _skipped(reason: str) -> dict[str, Any]:
    return {"status": SKIPPED, "error": reason}


def _error(reason: str) -> dict[str, Any]:
    return {"status": ERROR, "error": reason}


def try_post_author_tweet(
    state_item: dict[str, Any],
    *,
    tasks_api_base_url: str | None = None,
) -> dict[str, Any]:
    """Return the ``tweetLog`` payload to merge into a bookmark state item.

    Behaviour by branch (mapped from the spec AC1-AC5):
        - source != "x"                → skipped, no tweetLog required upstream
        - missing/malformed link      → skipped
        - LLM compose failure         → error
        - 503 MISSING_CREDENTIALS     → skipped (AC5 reframed)
        - other 4xx/5xx               → error (AC3)
        - tasks-api unreachable       → error
        - success                     → posted (url + postedAt)

    The caller is responsible for persisting the returned dict as
    ``state_item["tweetLog"]``; non-X / missing-link cases that skip *before*
    any HTTP attempt return ``{"status": "skipped", ...}`` so the caller can
    decide whether to write the field at all (per the spec, no ``tweetLog``
    is written for non-X sources).
    """
    if not isinstance(state_item, dict):
        return _skipped("invalid_state_item")

    source = (state_item.get("source") or "").strip().lower()
    if source != "x":
        return _skipped("non_x_source")

    parsed = parse_x_link(state_item.get("link"))
    if parsed is not None:
        _handle, status_id = parsed
    else:
        # Handle-less share links (e.g. `x.com/i/web/status/<id>`) still
        # carry a resolvable status id — look up the author instead of
        # skipping outright.
        status_id = parse_x_status_id(state_item.get("link"))
        if status_id is None:
            return _skipped("missing_x_link")
        resolved_handle = resolve_tweet_author(status_id, base_url=tasks_api_base_url)
        if not resolved_handle:
            return _skipped("missing_x_link")
        state_item = {**state_item, "authorHandle": resolved_handle}

    try:
        text = compose_author_tweet(state_item)
    except Exception as exc:  # noqa: BLE001 — best-effort; never bubble up
        # Defensive: compose_author_tweet already wraps LLM failures in
        # TweetComposeError, but if any unexpected exception slips through
        # (e.g. an OS error during attribute access) we still want to record
        # a structured error rather than crash the lobster approval flow.
        return _error(f"llm_compose_failed:{exc}")

    if not isinstance(text, str) or len(text) == 0:
        return _error("llm_compose_failed:empty_output")
    if len(text) > 280:
        # Defensive: LLM prompt enforces the cap, but if it ever slips we
        # record the failure rather than posting an over-length tweet.
        return _error(f"llm_compose_failed:over_280_chars:{len(text)}")

    try:
        result = call_x_tweets_route(text, status_id, base_url=tasks_api_base_url)
    except CredentialsMissingError:
        return _skipped("missing_credentials")
    except XApiError as exc:
        return _error(str(exc))
    except TasksApiUnreachableError as exc:
        return _error(str(exc))

    return {
        "status": POSTED,
        "tweetUrl": result.get("url"),
        "postedAt": result.get("postedAt"),
    }


__all__ = [
    "POSTED",
    "SKIPPED",
    "ERROR",
    "TweetComposeError",
    "CredentialsMissingError",
    "XApiError",
    "TasksApiUnreachableError",
    "parse_x_link",
    "parse_x_status_id",
    "compose_author_tweet",
    "call_x_tweets_route",
    "resolve_tweet_author",
    "try_post_author_tweet",
]