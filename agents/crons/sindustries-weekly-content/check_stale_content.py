#!/usr/bin/env python3
"""
Heartbeat stale-content check.

Flags experiments and systems in the sindustries content files where
updatedAt is more than 30 days ago and status is active/building/operating.

Called from heartbeat. Prints stale items to stdout; exits 0 either way.
"""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]
CONTENT_ROOT = WORKSPACE / "codebases" / "sindustries" / "apps" / "website" / "src" / "content"
THRESHOLD_DAYS = 30
ACTIVE_STATUSES = {"active", "building", "operating"}


def check_file(path: Path, threshold: datetime.date) -> list[dict]:
    stale = []
    try:
        items = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return stale

    if not isinstance(items, list):
        return stale

    for item in items:
        if item.get("status") not in ACTIVE_STATUSES:
            continue
        updated = item.get("updatedAt") or item.get("startedAt")
        if not updated:
            stale.append({
                "file": path.name,
                "slug": item.get("slug", "?"),
                "status": item.get("status"),
                "reason": "missing updatedAt",
            })
            continue
        try:
            d = datetime.date.fromisoformat(str(updated)[:10])
            if d < threshold:
                stale.append({
                    "file": path.name,
                    "slug": item.get("slug", "?"),
                    "status": item.get("status"),
                    "updatedAt": str(updated),
                    "days_stale": (datetime.date.today() - d).days,
                })
        except ValueError:
            pass

    return stale


def main() -> None:
    threshold = datetime.date.today() - datetime.timedelta(days=THRESHOLD_DAYS)

    if not CONTENT_ROOT.exists():
        print("STALE_CHECK_SKIP: sindustries content root not found", file=sys.stderr)
        sys.exit(0)

    all_stale = []
    for fname in ("experiments.json", "systems.json"):
        fpath = CONTENT_ROOT / fname
        if fpath.exists():
            all_stale.extend(check_file(fpath, threshold))

    if all_stale:
        print(f"STALE_CONTENT: {len(all_stale)} item(s) not updated in >{THRESHOLD_DAYS} days:")
        for item in all_stale:
            days = item.get("days_stale", "?")
            print(f"  - {item['file']} / {item['slug']} ({item['status']}, {days} days)")
    else:
        print(f"STALE_CHECK_OK: all active experiments/systems updated within {THRESHOLD_DAYS} days")


if __name__ == "__main__":
    main()
