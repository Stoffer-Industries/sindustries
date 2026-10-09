#!/usr/bin/env python3
"""Archive task-derived and stale incident records without deleting them.

The state files live outside the repository. This utility defaults to a dry
run; use ``--apply`` to make a timestamped backup and atomically update each
changed file.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


INACTIVE = {"resolved", "false_positive", "archived"}
TASK_PREFIXES = (
    "agent-task-",
    "backlog-",
    "code-task-",
    "content-task",
    "feature-factory-",
    "feature-task-",
    "lobster-attentionowners-",
    "pending-tech-design-",
    "task-lobsters-",
    "verify-delivery-",
)


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def is_task_record(slug: str, entry: dict) -> bool:
    return entry.get("scope") == "task" or slug.startswith(TASK_PREFIXES)


def is_stale(entry: dict, cutoff: datetime) -> bool:
    checked = parse_time(entry.get("lastCheckedAt"))
    if checked is None:
        checked = parse_time(entry.get("firstSeen"))
    if checked is None:
        checked = parse_time(entry.get("dailyReviewDate"))
    return checked is not None and checked < cutoff


def archive_reason(slug: str, entry: dict, cutoff: datetime) -> str | None:
    if is_task_record(slug, entry):
        return "task workflow state belongs to the Tasks API escalation plane"
    if is_stale(entry, cutoff):
        return "stale incident record; reopen with fresh system evidence if observed again"
    return None


def load(path: Path) -> tuple[dict, str]:
    state = json.loads(path.read_text())
    if not isinstance(state, dict):
        raise ValueError(f"{path} is not a JSON object")
    if isinstance(state.get("incidents"), dict):
        return state, "incidents"
    if isinstance(state.get("ops"), dict):
        return state, "ops"
    raise ValueError(f"{path} has no incidents/ops object")


def atomic_write(path: Path, state: dict, backup: Path) -> None:
    shutil.copy2(path, backup)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--workspace",
        default=os.environ.get("OPENCLAW_WORKSPACE", str(Path.home() / ".openclaw" / "workspace")),
    )
    parser.add_argument("--max-age-hours", type=int, default=72)
    parser.add_argument("--apply", action="store_true", help="write changes after making backups")
    args = parser.parse_args()

    if args.max_age_hours < 1:
        parser.error("--max-age-hours must be positive")

    state_dir = Path(args.workspace) / "brain" / "state"
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=args.max_age_hours)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    total = 0

    for name in ("quinn-ops-state.json", "lox-incident-state.json"):
        path = state_dir / name
        if not path.exists():
            continue
        state, key = load(path)
        changes: list[tuple[str, str]] = []
        for slug, entry in state[key].items():
            if not isinstance(entry, dict) or entry.get("status") in INACTIVE:
                continue
            reason = archive_reason(slug, entry, cutoff)
            if reason is None:
                continue
            changes.append((slug, reason))
            if args.apply:
                entry["archiveOriginalStatus"] = entry.get("status", "watching")
                entry["archiveOriginalLastAction"] = entry.get("lastAction", "")
                entry["status"] = "archived"
                entry["scope"] = "task" if is_task_record(slug, entry) else "system"
                entry["archivedAt"] = now.isoformat()
                entry["archiveReason"] = reason
                entry["lastAction"] = f"Archived: {reason}."

        total += len(changes)
        print(f"{name}: {len(changes)} record(s) to archive")
        for slug, reason in changes:
            print(f"  - {slug}: {reason}")
        if args.apply and changes:
            backup = path.with_name(f"{path.name}.bak.incident-scope-{stamp}")
            atomic_write(path, state, backup)
            print(f"  backup: {backup}")

    print(f"total: {total}")
    if not args.apply:
        print("dry-run only; pass --apply to archive with backups")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
