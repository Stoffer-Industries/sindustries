"""Shared helpers for the tasks-analytics scripts.

Not a public entry point — imported by the sibling scripts in this
directory. Keeps the `TASKS_API_BASE_URL` convention consistent with
`agents/skills/ops/tasks-api/tasks_api_client.py`.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
import urllib.request


def get_base_url() -> str:
    base = (os.getenv("TASKS_API_BASE_URL") or "").strip()
    if not base:
        raise SystemExit("TASKS_API_BASE_URL is required")
    return base.rstrip("/")


def fetch(path: str, base_url: str | None = None) -> dict:
    base = base_url or get_base_url()
    url = f"{base}{path}"
    try:
        # The OpenClaw secret-egress proxy (HTTP_PROXY/HTTPS_PROXY) exists to
        # substitute protected secret sentinels into requests bound for
        # approved *external* destinations. The Tasks API is a local service
        # call and never carries a secret sentinel, but urllib's default
        # opener honours the ambient proxy env vars unconditionally, so the
        # proxy refuses this non-allowlisted local destination with HTTP 502
        # ("Secret egress proxy refused the request.") — indistinguishable
        # from a real Tasks API outage. Use a proxy-free opener so Tasks API
        # calls never traverse that proxy, whatever the caller's environment.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except Exception as e:  # noqa: BLE001
        print(f"GET {path} failed: {e}", file=sys.stderr)
        raise


def cutoff_utc(days: int) -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)


def parse_iso(ts: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def fetch_terminal_tasks(
    days: int = 7,
    statuses: tuple[str, ...] = ("done", "accepted"),
    base_url: str | None = None,
) -> list[dict]:
    """Tasks that completed within the last `days` days, across `statuses`.

    Some deployments don't support every status filter (e.g. `accepted`) —
    skip failures per-status rather than aborting the whole call.
    """
    cutoff = cutoff_utc(days).isoformat()
    out: list[dict] = []
    for status in statuses:
        try:
            data = fetch(f"/tasks?status={status}&limit=50", base_url).get("data", [])
        except Exception:  # noqa: BLE001
            continue
        for t in data:
            if t.get("completedAt", "") >= cutoff:
                out.append(t)
    return out
