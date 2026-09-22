#!/usr/bin/env python3
"""One-shot cleanup utility for stale `reviewDoc` fields (task b38f70bb).

After the bookmark pipeline migrated from the old `reviewDoc` review-classification
artifact to the `summaryDoc` curation-summary artifact, many state records
carried BOTH fields. This script removes the stale `reviewDoc` field from
records that also have a non-empty `summaryDoc`, preserving every other field
(`summaryDoc`, `reviewStatus`, `approvals`, `curation`, `taskIds`, transition
history, etc).

Records that have only `reviewDoc` (no `summaryDoc`) are intentionally NOT
touched — those are genuine legacy-only records whose summary has not yet been
written by the current pipeline; this script must never erase their only
artifact pointer.

Safety
------
- Dry-run by default. Pass `--apply` to mutate state.
- Each eligible record is validated to confirm its `summaryDoc` file exists on
  disk before mutation. Records whose summary file is missing are reported
  but skipped (so a destructive cleanup never silently drops the only good
  pointer to a recoverable record).
- Before any mutation, a timestamped backup of the state file is written
  beside it. The new state is written to a temporary file in the same
  directory and atomically replaced via ``os.replace`` so a crash mid-write
  cannot corrupt the live brain state.
- Re-running the script on an already-cleaned state is a no-op (changed=0).

Usage
-----
::

    # Inspect what would change (always safe; never mutates)
    python3 migrate_reviewdoc_fields.py

    # Mutate the live brain state (creates a backup next to STATE_PATH)
    python3 migrate_reviewdoc_fields.py --apply

    # Operate on a custom state file (used by tests + dry-run audits)
    python3 migrate_reviewdoc_fields.py --state-path /path/to/state.json --apply

    # Emit machine-readable JSON instead of the human summary
    python3 migrate_reviewdoc_fields.py --json
    python3 migrate_reviewdoc_fields.py --json --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Make sibling modules importable when run as a plain script.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from common import STATE_PATH, WORKSPACE, ensure_parent  # noqa: E402


def _normalized(value: Any) -> str:
    """Return a stripped string when value is a non-empty string, else ""."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ""


def _classify(state: dict[str, Any], workspace: Path) -> tuple[list[str], list[str], list[str], list[str]]:
    """Return (eligible, skipped_missing_summary, review_only, neither) key lists.

    - eligible: items that have BOTH normalized summaryDoc and reviewDoc and
      would be cleaned by --apply.
    - skipped_missing_summary: items that have both fields but their
      summaryDoc file is missing on disk; reported but not changed.
    - review_only: items that have only reviewDoc; intentionally preserved
      (legacy-only records with no current summary).
    - neither: items that have neither field; not relevant to this migration.
    """
    items = state.get("items", {})
    eligible: list[str] = []
    skipped_missing_summary: list[str] = []
    review_only: list[str] = []
    neither: list[str] = []
    for key, item in items.items():
        if not isinstance(item, dict):
            continue
        summary = _normalized(item.get("summaryDoc"))
        review = _normalized(item.get("reviewDoc"))
        if summary and review:
            summary_path = workspace / summary
            if summary_path.exists():
                eligible.append(key)
            else:
                skipped_missing_summary.append(key)
        elif review:
            review_only.append(key)
        elif not summary:
            neither.append(key)
    return eligible, skipped_missing_summary, review_only, neither


def _atomic_write_state(state: dict[str, Any], state_path: Path) -> None:
    """Write ``state`` to ``state_path`` atomically with fsync.

    Writes to a same-directory temporary file, flushes + fsyncs, then
    ``os.replace`` to the target. A crash mid-write leaves the original
    file untouched.
    """
    ensure_parent(state_path)
    payload = json.dumps(state, indent=2, ensure_ascii=False) + "\n"
    tmp_path = state_path.with_name(state_path.name + ".tmp-migrate")
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp_path, state_path)


def _backup_state(state_path: Path) -> Path:
    """Copy state to a timestamped backup next to it. Returns backup path."""
    from datetime import datetime, timezone

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = state_path.with_name(f"{state_path.name}.bak.{timestamp}")
    if backup.exists():
        # Avoid clobbering an existing backup from the same second; bump ms.
        i = 1
        while True:
            candidate = state_path.with_name(f"{state_path.name}.bak.{timestamp}-{i}")
            if not candidate.exists():
                backup = candidate
                break
            i += 1
    backup.write_text(state_path.read_text(encoding="utf-8"), encoding="utf-8")
    return backup


def run(state_path: Path, apply: bool, workspace: Path | None = None) -> dict[str, Any]:
    """Inspect (and optionally mutate) state at ``state_path``.

    Returns a structured report; callers can decide whether to print as
    JSON or human-readable text.
    """
    ws = workspace or WORKSPACE
    if not state_path.exists():
        raise SystemExit(f"state file not found: {state_path}")

    state = json.loads(state_path.read_text(encoding="utf-8"))
    items = state.get("items", {})
    eligible, skipped_missing_summary, review_only, neither = _classify(state, ws)

    backup_path: Path | None = None
    changed_keys: list[str] = []
    if apply and eligible:
        backup_path = _backup_state(state_path)
        for key in eligible:
            before = items[key].get("reviewDoc")
            items[key].pop("reviewDoc", None)
            if before is not None:
                changed_keys.append(key)
        if changed_keys:
            state["items"] = items
            _atomic_write_state(state, state_path)

    return {
        "ok": True,
        "applied": bool(apply and changed_keys),
        "statePath": str(state_path),
        "counts": {
            "inspected": len(items),
            "eligible": len(eligible),
            "changed": len(changed_keys),
            "skippedMissingSummary": len(skipped_missing_summary),
            "reviewDocOnly": len(review_only),
            "neither": len(neither),
        },
        "keys": {
            "changed": sorted(changed_keys),
            "eligible": sorted(eligible),
            "skippedMissingSummary": sorted(skipped_missing_summary),
            "reviewDocOnly": sorted(review_only),
            "neither": sorted(neither),
        },
        "backupPath": str(backup_path) if backup_path else None,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="One-shot cleanup of stale reviewDoc fields (task b38f70bb).")
    p.add_argument("--state-path", default=str(STATE_PATH), help="Path to bookmark-review-state.json (default: common.STATE_PATH)")
    p.add_argument("--apply", action="store_true", help="Actually mutate state (default is dry-run).")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON report.")
    args = p.parse_args()

    report = run(Path(args.state_path), apply=args.apply)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        counts = report["counts"]
        keys = report["keys"]
        print(f"inspected={counts['inspected']} eligible={counts['eligible']} changed={counts['changed']} "
              f"skipped_missing_summary={counts['skippedMissingSummary']} "
              f"review_only={counts['reviewDocOnly']} neither={counts['neither']}")
        if report["applied"]:
            print(f"applied=True backup={report['backupPath']}")
        else:
            print("applied=False (dry-run; pass --apply to mutate)")
        for label, key_list in keys.items():
            if not key_list:
                continue
            preview = key_list[:5]
            suffix = f" (+{len(key_list) - 5} more)" if len(key_list) > 5 else ""
            print(f"  {label}: {preview}{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
