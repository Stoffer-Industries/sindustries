#!/usr/bin/env python3
"""Recurring visibility check for untyped bookmark-origin tasks (AC5).

Task: 536e04fc (Bookmark specs get a task type, only feature-typed ones need
Tom's approval). AC5: bookmark-origin tasks that end up without a type are
visible in a recurring check, so they don't sit unnoticed the way today's
untyped bookmark tasks do.

This script:
  1. Queries the Tasks API for tasks tagged `bookmarks` (bookmark-origin).
  2. Filters client-side for `taskType IS NULL` (untyped) AND `status == open`
     AND `createdAt < now - STALE_AFTER_DAYS` days.
  3. If any match, posts a Telegram message via the direct Bot API to a
     configured chat id, listing each stale untyped task with its id, age in
     days, and a one-line snippet of the description.

Wiring: Quinn registers this script as a cron (`.openclaw` boundary). The
script is intentionally standalone so Quinn can wire it without further code
changes — see `[openclaw-needed]` comment on task 536e04fc.

Design choices:
  - Tag filter via the API (`tag=bookmarks`) is the canonical "bookmark-origin"
    marker; the bookmark pipeline tags every task it creates with `bookmarks`.
  - `taskType` filter is intentionally absent: the Tasks API rejects `null`
    / empty values for `taskType` (see `services/tasks-api/src/routes/tasks.ts`),
    so we fetch all bookmark-tagged tasks and filter client-side.
  - Stale window defaults to 7 days, matching the spec; override with
    `--stale-after-days` for tests.
  - Telegram delivery uses the direct Bot API call (matching
    `agents/workflows/bookmarks/scripts/request_topic_approval.py`'s fallback
    pattern) so the script runs without going through the gateway CLI — cron
    jobs must not depend on interactive infrastructure.
  - `--dry-run` prints the would-be message to stdout and exits 0 without
    touching Telegram. Used in unit tests and the one-shot smoke run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

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

DEFAULT_STALE_AFTER_DAYS = 7
DEFAULT_LIMIT = 100
DEFAULT_TAG = "bookmarks"
DEFAULT_STATUS = "open"
TELEGRAM_API_BASE = "https://api.telegram.org"


def _api_base_url() -> str:
    base = (os.getenv("TASKS_API_BASE_URL") or "").strip().rstrip("/")
    if not base:
        raise SystemExit("TASKS_API_BASE_URL is required")
    return base


def _auth_headers() -> dict:
    token = (os.getenv("TASKS_API_APPROVAL_TOKEN") or "").strip()
    if not token:
        raise SystemExit("TASKS_API_APPROVAL_TOKEN is required")
    return {"authorization": f"Bearer {token}"}


def fetch_bookmark_tasks(
    *,
    api_base: str | None = None,
    tag: str = DEFAULT_TAG,
    status: str = DEFAULT_STATUS,
    limit: int = DEFAULT_LIMIT,
    timeout: float = 20.0,
) -> list[dict]:
    """Fetch bookmark-tagged tasks via the Tasks API.

    The API does not support filtering for `taskType IS NULL` directly (the
    `taskType` query parameter rejects null / empty values), so we fetch the
    full bookmark-tagged set and filter client-side in `select_stale_untyped`.
    """
    base = (api_base or _api_base_url()).rstrip("/")
    params = urllib.parse.urlencode({"tag": tag, "status": status, "limit": str(limit)})
    url = f"{base}/tasks?{params}"
    req = urllib.request.Request(url, headers=_auth_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    payload = json.loads(body) if body else {}
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    return []


def select_stale_untyped(
    tasks: list[dict],
    *,
    now: datetime | None = None,
    stale_after_days: int = DEFAULT_STALE_AFTER_DAYS,
) -> list[dict]:
    """Return tasks that are untyped, status==open, and created >= N days ago.

    `taskType` is the API field; in our schema a missing/empty value means
    "untyped" (bookmark pipeline intentionally skips type-set when the LLM
    classifier returns `ambiguous` — see task 536e04fc WS3).
    """
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=stale_after_days)
    stale: list[dict] = []
    for t in tasks or []:
        # Status filter — the API filter narrows the initial fetch, but we
        # re-check defensively in case the caller passes a pre-fetched set.
        if (t.get("status") or "").strip() != "open":
            continue
        # Type filter — empty string, missing field, and explicit None all mean
        # "untyped" in the schema. Any populated value (feature/code/research/
        # content) excludes the task from the report.
        task_type = t.get("taskType")
        if task_type is not None and str(task_type).strip() != "":
            continue
        # Age filter — createdAt is ISO-8601. Tasks without a parseable
        # createdAt are excluded (treated as not-yet-stale).
        created_raw = t.get("createdAt")
        if not created_raw:
            continue
        try:
            # The API returns ISO-8601 with a trailing Z; normalise to +00:00
            # so fromisoformat can parse both shapes.
            normalised = str(created_raw).replace("Z", "+00:00")
            created = datetime.fromisoformat(normalised)
        except ValueError:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created > cutoff:
            continue
        stale.append(t)
    # Oldest first — easier to triage.
    stale.sort(key=lambda t: t.get("createdAt") or "")
    return stale


def _age_days(task: dict, *, now: datetime | None = None) -> int:
    created_raw = task.get("createdAt") or ""
    normalised = str(created_raw).replace("Z", "+00:00")
    try:
        created = datetime.fromisoformat(normalised)
    except ValueError:
        return -1
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return max(0, ((now or datetime.now(timezone.utc)) - created).days)


def _snippet(text: str | None, *, limit: int = 120) -> str:
    if not text:
        return ""
    compact = " ".join(str(text).split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def format_report(
    stale_tasks: list[dict],
    *,
    stale_after_days: int = DEFAULT_STALE_AFTER_DAYS,
    now: datetime | None = None,
) -> str:
    """Format the Telegram message body for the stale-untyped report.

    Plain text (no Markdown parse mode) so the message renders correctly on
    Telegram regardless of which client surfaces it. Uses emoji bullets only.
    """
    now = now or datetime.now(timezone.utc)
    header = (
        f"📋 Bookmark-triage: {len(stale_tasks)} untyped bookmark task(s) "
        f"older than {stale_after_days} days"
    )
    if not stale_tasks:
        return f"{header}\n\nNo action needed."
    lines = [header, ""]
    for t in stale_tasks:
        tid = t.get("id") or "?"
        title = (t.get("title") or "(untitled)").strip()
        age = _age_days(t, now=now)
        snippet = _snippet(t.get("description"))
        lines.append(f"• {title}  (age {age}d)")
        lines.append(f"  id: {tid}")
        if snippet:
            lines.append(f"  {snippet}")
        lines.append("")
    lines.append("Action: classify each as feature/code/research or archive. "
                 "See task 536e04fc (WS4 / AC5).")
    return "\n".join(lines).rstrip()


def send_telegram(message: str, *, chat_id: str, bot_token: str, timeout: float = 20.0) -> dict:
    """Send `message` to `chat_id` via the direct Telegram Bot API.

    Returns the parsed JSON response on success. Raises RuntimeError on HTTP or
    API errors so the cron caller can surface the failure path. Mirrors the
    fallback delivery in `request_topic_approval.py`.
    """
    if not bot_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required for telegram delivery")
    if not chat_id:
        raise RuntimeError("chat_id is required for telegram delivery")
    url = f"{TELEGRAM_API_BASE}/bot{bot_token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": message}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise RuntimeError(f"telegram api http {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"telegram api unreachable: {exc.reason}") from exc
    if not result.get("ok"):
        raise RuntimeError(f"telegram api returned not-ok: {result}")
    return result


def run(
    *,
    api_base: str | None = None,
    chat_id: str | None = None,
    bot_token: str | None = None,
    tag: str = DEFAULT_TAG,
    status: str = DEFAULT_STATUS,
    limit: int = DEFAULT_LIMIT,
    stale_after_days: int = DEFAULT_STALE_AFTER_DAYS,
    dry_run: bool = False,
    now: datetime | None = None,
    _fetch=fetch_bookmark_tasks,
    _send=send_telegram,
) -> dict:
    """Run one pass and return a structured result dict.

    `_fetch` and `_send` default to the module-level functions and are
    injectable for unit tests. The default values are evaluated at function
    definition time; callers that replace them via `_fetch=...` only need
    the public callable, not a reference to this module.
    """
    now = now or datetime.now(timezone.utc)
    tasks = _fetch(api_base=api_base, tag=tag, status=status, limit=limit)
    stale = select_stale_untyped(tasks, now=now, stale_after_days=stale_after_days)
    message = format_report(stale, stale_after_days=stale_after_days, now=now)
    delivered = False
    delivery_error: str | None = None
    if stale:
        if dry_run:
            delivery_error = None
        else:
            if not chat_id:
                delivery_error = "BOOKMARK_TRIAGE_CHAT_ID is required when stale tasks exist"
            elif not bot_token:
                delivery_error = "TELEGRAM_BOT_TOKEN is required when stale tasks exist"
            else:
                try:
                    _send(message, chat_id=chat_id, bot_token=bot_token)
                    delivered = True
                except RuntimeError as exc:
                    delivery_error = str(exc)
    return {
        "fetched": len(tasks),
        "stale": [t.get("id") for t in stale],
        "staleCount": len(stale),
        "message": message,
        "delivered": delivered,
        "deliveryError": delivery_error,
        "dryRun": dry_run,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Report stale untyped bookmark-origin tasks to Telegram (AC5 of 536e04fc)."
    )
    p.add_argument("--api-base", default=None,
                   help="Tasks API base URL (defaults to TASKS_API_BASE_URL env)")
    p.add_argument("--chat-id", default=None,
                   help="Telegram chat id to receive the report (defaults to "
                        "BOOKMARK_TRIAGE_CHAT_ID env). Required when stale tasks "
                        "exist and --dry-run is not set.")
    p.add_argument("--bot-token", default=None,
                   help="Telegram bot token (defaults to TELEGRAM_BOT_TOKEN env). "
                        "Required when stale tasks exist and --dry-run is not set.")
    p.add_argument("--tag", default=DEFAULT_TAG,
                   help=f"Tag filter for bookmark-origin tasks (default: {DEFAULT_TAG})")
    p.add_argument("--status", default=DEFAULT_STATUS,
                   help=f"Status filter (default: {DEFAULT_STATUS})")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                   help=f"Max tasks to fetch from the API (default: {DEFAULT_LIMIT})")
    p.add_argument("--stale-after-days", type=int, default=DEFAULT_STALE_AFTER_DAYS,
                   help=f"Tasks older than N days are reported (default: {DEFAULT_STALE_AFTER_DAYS})")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the would-be Telegram message to stdout and skip "
                        "delivery. Exit 0 regardless of stale count.")
    p.add_argument("--json", action="store_true",
                   help="Emit the structured run report as JSON on stdout.")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    chat_id = (args.chat_id or os.getenv("BOOKMARK_TRIAGE_CHAT_ID") or "").strip()
    bot_token = (args.bot_token or os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    try:
        result = run(
            api_base=args.api_base,
            chat_id=chat_id,
            bot_token=bot_token,
            tag=args.tag,
            status=args.status,
            limit=args.limit,
            stale_after_days=args.stale_after_days,
            dry_run=args.dry_run,
            _fetch=fetch_bookmark_tasks,
            _send=send_telegram,
        )
    except SystemExit as exc:
        # Raised by the API base/header validators when required env vars are
        # missing. Re-emit the message and exit non-zero so cron surfaces it.
        print(str(exc), file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.dry_run:
        # In dry-run mode, echo the would-be Telegram message to stdout for
        # human inspection during the post-deploy smoke run.
        print(result["message"])
    # Non-dry-run mode stays silent on stdout; delivery result is in the JSON
    # mode and (when configured) on the Telegram side.
    if result["deliveryError"]:
        print(f"telegram delivery failed: {result['deliveryError']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
