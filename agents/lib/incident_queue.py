"""Deterministic operator-queue summary over the unified incident registry.

Heartbeat used to hand-count the incident queue each pass, reading only Quinn's
own state file. That under-reported the real queue (every Lox-owned incident was
invisible) and let a CRITICAL disk incident sit unescalated for days. Counting is
now a library call, not a reading habit, so the numbers in a heartbeat cannot
drift from the registry again.

Usage::

    python3 -m agents.lib.incident_queue            # heartbeat-ready text lines
    python3 -m agents.lib.incident_queue --json     # full structured queue

The text output is exactly what workspace ``HEARTBEAT.md`` asks for:

    Incident queue: 16 actionable, 12 monitored.
    16 incident(s) waiting on you.
    🔴 Top unblock: <what it is and what Tom has to do>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # pragma: no cover - direct `python3 incident_queue.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    from agents.lib.incident_state import (  # type: ignore[no-redef]
        load_all_incidents,
        needs_tom,
        reportable_incidents,
    )
else:
    from .incident_state import load_all_incidents, needs_tom, reportable_incidents

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
SEVERITY_EMOJI = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵"}

__all__ = [
    "SEVERITY_EMOJI",
    "SEVERITY_ORDER",
    "build_queue",
    "render_text",
    "main",
]


def _sort_key(inc: dict) -> tuple:
    """Severity first (critical → low), then oldest first."""
    return (
        SEVERITY_ORDER.get(inc.get("severity"), len(SEVERITY_ORDER)),
        inc.get("firstSeen") or "",
        inc.get("key") or inc.get("_slug") or "",
    )


def _identity(inc: dict) -> str:
    for field in ("key", "_slug", "slug", "id"):
        value = inc.get(field)
        if isinstance(value, str) and value:
            return value
    title = inc.get("title") or inc.get("lastAction") or "untitled incident"
    return title.splitlines()[0][:80]


def _describe(inc: dict) -> str:
    """One line saying what the incident is and what is being asked for."""
    trigger = inc.get("trigger")
    title = inc.get("title")
    if not title:
        title = (inc.get("lastAction") or trigger or "").splitlines()[0].strip()
    parts = [f"{_identity(inc)} ({inc.get('owner', '?')})"]
    if title:
        parts.append(title)
    details = inc.get("details")
    if isinstance(details, dict):
        options = details.get("fix_options_ranked")
        if isinstance(options, list) and options and isinstance(options[0], dict):
            summary = options[0].get("summary")
            if summary:
                parts.append(f"→ {summary}")
    return " — ".join(parts)


def build_queue(
    incidents: list[dict] | None = None,
    *,
    workspace: Path | str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build the reportable queue split into actionable vs monitored findings.

    ``actionable`` is ``needs_tom()`` over the reportable set (needsTom true OR
    severity high/critical); everything else reportable is ``monitored``.
    ``reportable_incidents()`` already drops resolved, false-positive, archived,
    task-scoped, and stale (>72h since lastCheckedAt) records, so both counts
    read straight from the registry instead of a hand-maintained tally.
    """
    records = load_all_incidents(Path(workspace) if workspace else None)
    if incidents is not None:
        records = incidents
    records = reportable_incidents(records, now=now)
    actionable = sorted(needs_tom(records, now=now), key=_sort_key)
    actionable_ids = {id(inc) for inc in actionable}
    monitored = [inc for inc in records if id(inc) not in actionable_ids]
    owners: dict[str, int] = {}
    for inc in records:
        owner = inc.get("owner") or "unknown"
        owners[owner] = owners.get(owner, 0) + 1
    return {
        "generatedAt": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "counts": {
            "reportable": len(records),
            "actionable": len(actionable),
            "monitored": len(monitored),
            "byOwner": dict(sorted(owners.items())),
        },
        "actionable": [
            {
                "identity": _identity(inc),
                "severity": inc.get("severity"),
                "owner": inc.get("owner"),
                "needsTom": bool(inc.get("needsTom")),
                "escalatedAt": inc.get("escalatedAt"),
                "firstSeen": inc.get("firstSeen"),
                "lastCheckedAt": inc.get("lastCheckedAt"),
                "summary": _describe(inc),
            }
            for inc in actionable
        ],
        "monitored": [
            {
                "identity": _identity(inc),
                "severity": inc.get("severity"),
                "owner": inc.get("owner"),
                "lastCheckedAt": inc.get("lastCheckedAt"),
                "summary": _describe(inc),
            }
            for inc in sorted(monitored, key=_sort_key)
        ],
    }


def render_text(queue: dict[str, Any], *, verbose: bool = False) -> str:
    """Render the heartbeat queue summary lines."""
    counts = queue["counts"]
    actionable = counts["actionable"]
    monitored = counts["monitored"]
    if counts["reportable"] == 0:
        return "No active incident findings."
    lines = [f"Incident queue: {actionable} actionable, {monitored} monitored."]
    if actionable:
        lines.append(f"{actionable} incident(s) waiting on you.")
        top = queue["actionable"][0]
        emoji = SEVERITY_EMOJI.get(top.get("severity"), "🔵")
        lines.append(f"{emoji} Top unblock: {top['summary']}")
    if verbose:
        for entry in queue["actionable"]:
            lines.append(
                f"  [{entry.get('severity')}] {entry['identity']}"
                f" — escalatedAt={entry.get('escalatedAt') or 'never'}"
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--workspace", default=None, help="workspace root holding brain/state/")
    parser.add_argument("--json", action="store_true", help="emit the structured queue")
    parser.add_argument("--verbose", action="store_true", help="list every actionable entry")
    args = parser.parse_args(argv)

    queue = build_queue(workspace=args.workspace)
    if args.json:
        print(json.dumps(queue, indent=2))
    else:
        print(render_text(queue, verbose=args.verbose))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())