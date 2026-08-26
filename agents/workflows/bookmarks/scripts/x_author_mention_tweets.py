#!/usr/bin/env python3
"""Best-effort bookmark-mention draft queuer for the approval flow.

When Tom approves an X-sourced bookmark and at least one task ID is created,
this module composes TWO Content Scheduler drafts and POSTs them to
``services/content-scheduler-api``:

1. A standalone "build in public" tweet (kind ``scheduled``) that announces
   work has started on the bookmarked idea.
2. A manual-reply draft (kind ``manual_reply``) that references the
   standalone tweet and asks an on-topic question — Tom copies it into X
   himself and records the resulting URL against the item via the
   dedicated ``PATCH /content-scheduler/items/:id/posted-url`` endpoint
   (already shipped via PR #515 of task 5279b310).

The helper NEVER raises. Each step is wrapped so a failure in one draft
does not abort the other, and the caller (``lobster_resolve_spec_request``)
can persist the result as ``state_item["contentDrafts"]`` without blocking
the approval transition (AC6).

Module surface:
    - parse_x_link(url)                                  -> (handle, status_id) | None
        (re-exported from x_author_tweet for convenience)
    - compose_build_in_public_tweet(state_item)          -> str   (≤280 chars;
                                                                 raises TweetComposeError)
    - compose_reply_tweet(state_item, standalone_id)    -> str   (≤280 chars;
                                                                 raises TweetComposeError)
    - post_item(payload, *, base_url, actor)             -> dict[str, Any]
                                                            (the created item row)
                                                            raises ItemsApiError
                                                            | ItemsApiUnreachableError
    - queue_bookmark_mention_drafts(state_item, ...)    -> dict  (the contentDrafts payload)

AC mapping (task 5279b310):
    AC1 — standalone "build-in-public" draft queued (kind=scheduled).
    AC2 — manual-reply draft queued (kind=manual_reply, references standalone).
    AC3 — handle correctly identified even when link lacks it (uses
          parse_x_link + parse_x_status_id + resolve_tweet_author fallback).
    AC4 — manual_reply draft is never auto-published; surfaced for Tom via
          the dedicated UI section (added by the Mission Control PR).
    AC5 — URL capture flow is via PATCH /items/:id/posted-url (PR #515);
          this helper just creates the row with kind=manual_reply.
    AC6 — failures isolated: helper never raises; hook wraps in
          defense-in-depth try/except.

Ref: docs/specs/bookmark-approval-author-mention-tweet-2026-08-23-refresh.md
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from common import invoke_llm_json
from x_author_tweet import parse_x_link

logger = logging.getLogger("bookmark.x_author_mention_tweets")


# --- Public status enum (used in contentDrafts.{queuedDraftIds|errors|skipped}) ----

QUEUED = "queued"
SKIPPED = "skipped"
ERROR = "error"


# --- Exceptions ----------------------------------------------------------

class TweetComposeError(RuntimeError):
    """Tweet composition (LLM) failed."""


class ItemsApiError(RuntimeError):
    """content-scheduler-api returned a 4xx/5xx."""


class ItemsApiUnreachableError(RuntimeError):
    """content-scheduler-api itself is unreachable (DNS / connection refused / timeout)."""


# --- Re-exports / surface -----------------------------------------------

__all__ = [
    "parse_x_link",
    "QUEUED",
    "SKIPPED",
    "ERROR",
    "TweetComposeError",
    "ItemsApiError",
    "ItemsApiUnreachableError",
    "compose_build_in_public_tweet",
    "compose_reply_tweet",
    "post_item",
    "queue_bookmark_mention_drafts",
]


# --- Env / config --------------------------------------------------------

DEFAULT_CONTENT_SCHEDULER_API_BASE_URL = "http://localhost:4003/api/v1"
_TIMEOUT_SECONDS = 10
_ACTOR = "bookmark-mention-helper"


def _base_url(override: str | None = None) -> str:
    base = (override or os.getenv("CONTENT_SCHEDULER_API_BASE_URL") or DEFAULT_CONTENT_SCHEDULER_API_BASE_URL).strip()
    return base.rstrip("/")


# --- Tweet composition (LLM) --------------------------------------------

# Standalone "build-in-public" tweet. Announces that work has started on the
# bookmarked idea and tells the audience what's being built. Posted on
# Tom's own timeline by the Content Scheduler auto-post worker.
_BUILD_IN_PUBLIC_PROMPT = """You are writing a single standalone tweet on behalf of @sindustries.
The tweet will be posted to Tom's own X timeline to publicly announce that work has begun on a bookmarked idea.

Your job is to announce the work has started, give a short outline of what's being built, and reference
the source material (the original post we bookmarked) so the audience can find it.

Constraints:
- Length: 1-280 characters (hard cap). Short is better — one or two sentences.
- SHOULD mention the original author by `@<handle>` exactly as provided (so the chain reply we also draft makes sense).
- SHOULD reference the bookmark content (title or body excerpt) so the announcement is recognisable.
- SHOULD give a one-line outline of what we're building or exploring off the back of the post.
- MUST NOT include hashtags, links, or @-mentions other than the original author handle.
- MUST NOT promise delivery dates, scope, or outcomes.
- MUST NOT use marketing language ("excited to announce", "thrilled", "love").
- MUST stay factual and quiet in tone; the goal is builder-in-public transparency, not self-promotion.

Output format: the tweet text and nothing else. No markdown. No quotes. No leading labels.
"""

_BUILD_IN_PUBLIC_SCHEMA = {
    "tweet": "string, 1-280 characters, plain text, no hashtags or links"
}


# Manual-reply tweet. Replies to the original X post; references the
# standalone tweet we just queued so the chain makes sense; asks an
# on-topic question. NEVER auto-published — Tom copies it into X himself.
_REPLY_TWEET_PROMPT = """You are writing a single reply tweet on behalf of @sindustries.
The tweet will be posted manually as a public reply to the original X post we bookmarked and started working on.
A SEPARATE standalone tweet has already been queued to Tom's own timeline announcing the work — this tweet
needs to point at it (so the original author can find the announcement), reference the original post,
and ask one on-topic question specific to the bookmark's content.

Your job is to notify the original author that their post made it through triage, that work has begun,
that we posted a standalone announcement on our own timeline, and to invite a brief on-topic follow-up
question that fits the content of the bookmark.

Constraints:
- Length: 1-280 characters (hard cap). Short is better — one or two sentences.
- MUST mention the original author by `@<handle>` exactly as provided.
- MUST reference the standalone tweet we already posted (e.g. "details in our announcement:" — DO NOT
  fabricate a URL; the URL capture flow is a separate step Tom performs after he posts).
- SHOULD reference the bookmark content (title or body excerpt) so the reply is recognisable.
- MUST end with exactly one on-topic question.
- MUST NOT include hashtags, links, or @-mentions other than the original author handle.
- MUST NOT promise delivery dates, scope, or outcomes.
- MUST NOT use marketing language ("excited to announce", "thrilled", "love").
- MUST stay factual and quiet in tone; the goal is builder-in-public transparency, not self-promotion.

Output format: the tweet text and nothing else. No markdown. No quotes. No leading labels.
"""

_REPLY_TWEET_SCHEMA = {
    "tweet": "string, 1-280 characters, plain text, no hashtags or links"
}


def _extract_handle(state_item: dict[str, Any]) -> str:
    """Pull an author handle from state_item, falling back across sources.

    Order:
      1. parse_x_link(link) -> handle
      2. state_item["authorHandle"] (set by upstream helpers like
         resolve_tweet_author when the link is handle-less)

    Returns empty string if no handle is resolvable; the LLM prompt
    degrades by referring to "the original poster" in that case.
    """
    parsed = parse_x_link(state_item.get("link"))
    if parsed:
        return parsed[0]
    fallback = state_item.get("authorHandle")
    if isinstance(fallback, str) and fallback.strip():
        return fallback.strip()
    return ""


def _compose(
    prompt: str,
    schema: dict[str, str],
    state_item: dict[str, Any],
    *,
    empty_error: str,
    over_error_prefix: str = "over_280_chars",
) -> str:
    """Shared LLM invocation + length guard for both tweet composers.

    Raises ``TweetComposeError`` on any failure; callers decide whether to
    surface the error in the returned ``contentDrafts.errors`` payload.
    """
    if not isinstance(state_item, dict):
        raise TweetComposeError("state_item must be a dict")
    handle = _extract_handle(state_item)
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
        result = invoke_llm_json(prompt, input_payload, schema)
    except Exception as exc:  # common.invoke_llm_json raises LLMInvocationError on failure
        raise TweetComposeError(f"llm_compose_failed:{exc}") from exc

    tweet = ""
    if isinstance(result, dict):
        raw = result.get("tweet")
        if isinstance(raw, str):
            tweet = raw.strip()
    if not tweet:
        raise TweetComposeError(f"llm_compose_failed:{empty_error}")
    if len(tweet) > 280:
        raise TweetComposeError(f"llm_compose_failed:{over_error_prefix}:{len(tweet)}")
    return tweet


def compose_build_in_public_tweet(state_item: dict[str, Any]) -> str:
    """Compose the standalone "build in public" tweet (≤280 chars).

    Raises ``TweetComposeError`` on LLM failure or empty output. Caller
    captures the error in ``contentDrafts.errors`` rather than letting
    it bubble up (AC6).
    """
    return _compose(
        _BUILD_IN_PUBLIC_PROMPT,
        _BUILD_IN_PUBLIC_SCHEMA,
        state_item,
        empty_error="empty_output_build_in_public",
    )


def compose_reply_tweet(state_item: dict[str, Any], *, standalone_item_id: str) -> str:
    """Compose the manual-reply tweet (≤280 chars).

    ``standalone_item_id`` is the ContentSchedulerItem id of the standalone
    "build in public" tweet we just queued; it's surfaced to the LLM so the
    reply draft can reference "details in our announcement" coherently, and
    later set on the manual-reply item's ``linksToItemId`` so the UI can
    cross-link the two rows.

    Raises ``TweetComposeError`` on LLM failure or empty output.
    """
    if not isinstance(standalone_item_id, str) or not standalone_item_id.strip():
        raise TweetComposeError("standalone_item_id is required for reply composition")
    state_with_link = {**(state_item or {}), "standaloneItemId": standalone_item_id}
    return _compose(
        _REPLY_TWEET_PROMPT,
        _REPLY_TWEET_SCHEMA,
        state_with_link,
        empty_error="empty_output_reply",
    )


# --- content-scheduler-api HTTP helper -----------------------------------

def post_item(
    payload: dict[str, Any],
    *,
    base_url: str | None = None,
    actor: str = _ACTOR,
) -> dict[str, Any]:
    """POST ``{base}/content-scheduler/items`` and return the created row.

    Raises:
        ItemsApiError             — 4xx/5xx (validation, etc.).
        ItemsApiUnreachableError  — connection / DNS / timeout failures.
    """
    url = f"{_base_url(base_url)}/content-scheduler/items"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-actor": actor,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            payload_resp = json.loads(resp.read().decode("utf-8"))
            return payload_resp.get("data") or {}
    except urllib.error.HTTPError as exc:
        # The body is small JSON; read it once and translate the error code.
        try:
            payload_resp = json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            payload_resp = {}
        err = (payload_resp.get("error") or {}) if isinstance(payload_resp, dict) else {}
        code = err.get("code") or ""
        message = err.get("message") or exc.reason or "unknown"
        raise ItemsApiError(f"items_api_{exc.code}:{code}:{message}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        reason = getattr(exc, "reason", None) or str(exc) or exc.__class__.__name__
        raise ItemsApiUnreachableError(f"items_api_unreachable:{reason}") from exc


# --- Integration entry point ---------------------------------------------

def _skipped(reason: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": SKIPPED, "reason": reason}
    payload.update(extra)
    return payload


def _error_payload(step: str, reason: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": ERROR, "step": step, "error": reason}
    payload.update(extra)
    return payload


def queue_bookmark_mention_drafts(
    state_item: dict[str, Any],
    *,
    content_scheduler_api_base_url: str | None = None,
) -> dict[str, Any]:
    """Return the ``contentDrafts`` payload to merge into a bookmark state item.

    Behaviour by branch (mapped from the spec AC1-AC6):

      - source != "x"                → skipped, no contentDrafts payload required upstream
      - missing/malformed link      → skipped
      - LLM #1 (build-in-public)
          compose failure           → error captured; no items queued
      - content-scheduler-api
          POST kind=scheduled fail  → error captured; no items queued
                                       (manual_reply depends on standalone id)
      - LLM #2 (reply)
          compose failure           → error captured; standalone item still queued
      - content-scheduler-api
          POST kind=manual_reply
          fail                      → error captured; standalone item still queued
      - success                     → queuedDraftIds contains both item ids

    The caller is responsible for persisting the returned dict as
    ``state_item["contentDrafts"]``. Non-X / missing-link cases return
    a ``skipped`` payload so the caller can decide whether to write the
    field at all (per the spec, no contentDrafts are written for non-X
    sources).

    This function NEVER raises. Every step is wrapped so a single failure
    does not abort the rest of the queue. The hook layer adds a
    defense-in-depth try/except around this call (AC6).
    """
    queued_draft_ids: list[str] = []
    errors: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    if not isinstance(state_item, dict):
        skipped.append(_skipped("invalid_state_item"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    source = (state_item.get("source") or "").strip().lower()
    if source != "x":
        skipped.append(_skipped("non_x_source"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    parsed = parse_x_link(state_item.get("link"))
    if parsed is not None:
        handle, status_id = parsed
    else:
        # Handle-less share links (e.g. `x.com/i/web/status/<id>`) may still
        # carry a resolvable status id — look up the author instead of
        # skipping outright. resolve_tweet_author is best-effort and returns
        # None on any failure (AC3 degradation: handle missing → body uses
        # "the original poster" instead of `@handle`).
        from x_author_tweet import parse_x_status_id, resolve_tweet_author
        status_id = parse_x_status_id(state_item.get("link"))
        if status_id is None:
            skipped.append(_skipped("missing_x_link"))
            return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
        resolved_handle = resolve_tweet_author(status_id, base_url=_base_url(content_scheduler_api_base_url))
        if not resolved_handle:
            skipped.append(_skipped("missing_x_link"))
            return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
        handle = resolved_handle
        # Persist for downstream surfaces that read authorHandle without re-parsing.
        state_item = {**state_item, "authorHandle": handle}

    bookmark_key = state_item.get("bookmarkKey") or ""

    # --- Step 1: compose build-in-public tweet (LLM #1) --------------------
    try:
        build_in_public_body = compose_build_in_public_tweet(state_item)
    except TweetComposeError as exc:
        errors.append(_error_payload("compose_build_in_public", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except Exception as exc:  # pragma: no cover - defensive guard
        errors.append(_error_payload("compose_build_in_public", f"unexpected:{exc}"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    # --- Step 2: POST kind=scheduled -> standalone item id ----------------
    scheduled_payload = {
        "body": build_in_public_body,
        "source": "manual",
        "sourceRef": bookmark_key or None,
        "kind": "scheduled",
    }
    try:
        scheduled_item = post_item(scheduled_payload, base_url=content_scheduler_api_base_url)
    except ItemsApiError as exc:
        errors.append(_error_payload("create_scheduled_draft", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except ItemsApiUnreachableError as exc:
        errors.append(_error_payload("create_scheduled_draft", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except Exception as exc:  # pragma: no cover - defensive guard
        errors.append(_error_payload("create_scheduled_draft", f"unexpected:{exc}"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    standalone_item_id = (scheduled_item or {}).get("id")
    if not isinstance(standalone_item_id, str) or not standalone_item_id.strip():
        errors.append(_error_payload("create_scheduled_draft", "missing_id_in_response"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    queued_draft_ids.append(standalone_item_id)

    # --- Step 3: compose reply tweet (LLM #2, references standalone id) ----
    try:
        reply_body = compose_reply_tweet(state_item, standalone_item_id=standalone_item_id)
    except TweetComposeError as exc:
        errors.append(_error_payload("compose_reply", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except Exception as exc:  # pragma: no cover - defensive guard
        errors.append(_error_payload("compose_reply", f"unexpected:{exc}"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    # --- Step 4: POST kind=manual_reply + linksToItemId -------------------
    reply_payload = {
        "body": reply_body,
        "source": "manual",
        "sourceRef": bookmark_key or None,
        "kind": "manual_reply",
        "linksToItemId": standalone_item_id,
    }
    try:
        reply_item = post_item(reply_payload, base_url=content_scheduler_api_base_url)
    except ItemsApiError as exc:
        errors.append(_error_payload("create_manual_reply_draft", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except ItemsApiUnreachableError as exc:
        errors.append(_error_payload("create_manual_reply_draft", str(exc)))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
    except Exception as exc:  # pragma: no cover - defensive guard
        errors.append(_error_payload("create_manual_reply_draft", f"unexpected:{exc}"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    reply_item_id = (reply_item or {}).get("id")
    if not isinstance(reply_item_id, str) or not reply_item_id.strip():
        errors.append(_error_payload("create_manual_reply_draft", "missing_id_in_response"))
        return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}

    queued_draft_ids.append(reply_item_id)

    return {"queuedDraftIds": queued_draft_ids, "errors": errors, "skipped": skipped}
