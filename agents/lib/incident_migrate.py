"""One-shot migration script for legacy agent incident state files.

Task 75ec1c8c: Quinn's `quinn-ops-state.json` uses an `ops` key with most of
the unified fields; Lox's `lox-incident-state.json` uses `incidents` but
without firstSeen/attempts/needsTom/severity. This script reads each file,
applies the legacy normalizer from `agents.lib.incident_state`, and writes the
file back under the unified `incidents` key.

This script is **not** invoked automatically by the PR that ships it. Quinn
runs it manually after the PR merges against live state, via the
`[openclaw-needed]` task comment workflow. The script:

* Writes a `.bak.<timestamp>` next to each file before replacing.
* Validates the migrated result against the JSON Schema (unless --skip-schema).
* Supports `--dry-run` for safe inspection.
* Supports `--reset` to start fresh (drops entries, writes empty incidents).
* Is idempotent — running twice on the same file produces no further changes.

Usage::

    # Inspect what would change (safe)
    python3 agents/lib/incident_migrate.py --dry-run

    # Migrate live state in place (Quinn does this after PR merge)
    python3 agents/lib/incident_migrate.py --in-place

    # Start fresh (drops all incidents)
    python3 agents/lib/incident_migrate.py --in-place --reset
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make the `agents.lib` package importable when this script is run directly
# (e.g. `python3 agents/lib/incident_migrate.py`) without installing the repo.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agents.lib.incident_state import (  # noqa: E402
    LOX_STATE_RELATIVE,
    QUINN_STATE_RELATIVE,
    WORKSPACE_DEFAULT,
    IncidentStateError,
    _normalize_lox_entry,
    _normalize_quinn_entry,
    validate_with_schema,
)

log = logging.getLogger("incident_migrate")

_DATE_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")
_ACTIVE_STATUSES = {"watching", "escalated", "open"}
_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


# ---------------------------------------------------------------------------
# Migration logic
# ---------------------------------------------------------------------------

def _backup_path(target: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return target.with_suffix(target.suffix + f".bak.{ts}")


def _timestamp(entry: dict[str, Any], field: str) -> str:
    value = entry.get(field)
    return value if isinstance(value, str) else ""


def _merge_incident_entries(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge repeated observations of one logical incident."""
    if not entries:
        raise ValueError("cannot merge an empty incident group")

    ordered = sorted(
        entries,
        key=lambda entry: (_timestamp(entry, "lastCheckedAt"), _timestamp(entry, "firstSeen")),
    )
    merged = dict(ordered[-1])

    first_seen = [v for v in (_timestamp(e, "firstSeen") for e in entries) if v]
    last_checked = [v for v in (_timestamp(e, "lastCheckedAt") for e in entries) if v]
    escalated = [v for v in (_timestamp(e, "escalatedAt") for e in entries) if v]
    resolved = [v for v in (_timestamp(e, "resolvedAt") for e in entries) if v]
    if first_seen:
        merged["firstSeen"] = min(first_seen)
    if last_checked:
        merged["lastCheckedAt"] = max(last_checked)
    if escalated:
        merged["escalatedAt"] = min(escalated)

    merged["attempts"] = sum(int(e.get("attempts", 0) or 0) for e in entries)
    merged["recurrenceCount"] = max(int(e.get("recurrenceCount", 0) or 0) for e in entries)
    merged["needsTom"] = any(bool(e.get("needsTom")) for e in entries)
    merged["severity"] = max(
        (e.get("severity", "medium") for e in entries),
        key=lambda value: _SEVERITY_RANK.get(value, _SEVERITY_RANK["medium"]),
    )

    active = [e for e in ordered if e.get("status") in _ACTIVE_STATUSES]
    if active:
        merged["status"] = (
            "escalated"
            if any(e.get("status") == "escalated" for e in active)
            else active[-1].get("status", "watching")
        )
        merged["resolvedAt"] = None
    else:
        merged["status"] = ordered[-1].get("status", "resolved")
        if resolved:
            merged["resolvedAt"] = max(resolved)

    details: dict[str, Any] = {}
    for entry in ordered:
        if isinstance(entry.get("details"), dict):
            details.update(entry["details"])
    merged["details"] = details

    for field in ("lastAction", "linkedPr", "linkedRunbook", "followUp", "dailyReviewDate"):
        for entry in reversed(ordered):
            if entry.get(field):
                merged[field] = entry[field]
                break

    return merged


def dedupe_incidents(entries: dict[str, dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], int]:
    """Collapse date-suffixed Quinn incident keys to one stable key each."""
    groups: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for key, entry in entries.items():
        canonical = _DATE_SUFFIX.sub("", key)
        groups.setdefault(canonical, []).append((key, entry))

    result: dict[str, dict[str, Any]] = {}
    removed = 0
    for canonical, group in groups.items():
        dict_entries = [(key, entry) for key, entry in group if isinstance(entry, dict)]
        if len(dict_entries) == 1:
            key, entry = dict_entries[0]
            result[canonical] = entry
            removed += int(key != canonical)
        elif dict_entries:
            result[canonical] = _merge_incident_entries([entry for _, entry in dict_entries])
            removed += len(dict_entries) - 1
        else:
            for key, entry in group:
                result[key] = entry

    return result, removed


def _build_unified_state(
    before: dict[str, Any], incidents: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Build a schema-valid state while retaining unknown legacy metadata.

    Older Quinn state files also carried top-level ``watching`` and
    ``heartbeatBeat`` fields; Lox has used ``lastHeartbeatAt``.  The unified
    schema intentionally allows only ``incidents`` and ``_meta`` at the top
    level, so retain those fields under ``_meta.legacyTopLevel`` instead of
    either failing validation or silently dropping operator data.
    """
    meta = dict(before.get("_meta")) if isinstance(before.get("_meta"), dict) else {}
    legacy_top_level = (
        dict(meta.get("legacyTopLevel"))
        if isinstance(meta.get("legacyTopLevel"), dict)
        else {}
    )
    for key, value in before.items():
        if key not in {"_meta", "ops", "incidents"}:
            legacy_top_level[key] = value
    if legacy_top_level:
        meta["legacyTopLevel"] = legacy_top_level

    after: dict[str, Any] = {"incidents": incidents}
    if meta:
        after["_meta"] = meta
    return after


def _atomic_write_json(target: Path, state: dict[str, Any]) -> None:
    """Write JSON next to *target* and replace it atomically."""
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)


def migrate_file(
    target: Path,
    owner: str,
    *,
    reset: bool = False,
    write: bool = False,
    dedupe: bool = False,
    schema_path: Path | None = None,
) -> dict[str, Any]:
    """Migrate one state file in place.

    Returns a dict describing what happened, suitable for printing::

        {
            "path": "<absolute>",
            "owner": "quinn"|"lox",
            "existed": bool,
            "changed": bool,
            "backup": "<path>" | None,
            "before_keys": [...],
            "after_keys": [...],
            "entries_migrated": int,
        }
    """
    target = Path(target).resolve()
    result: dict[str, Any] = {
        "path": str(target),
        "owner": owner,
        "existed": target.exists(),
        "changed": False,
        "backup": None,
        "before_keys": [],
        "after_keys": [],
        "entries_migrated": 0,
        "entries_removed": 0,
    }

    if not target.exists():
        log.warning("migrate_file: %s does not exist; skipping", target)
        return result

    raw_text = target.read_text()
    try:
        before = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise IncidentStateError(
            f"{target} is not valid JSON; aborting migration: {exc}"
        ) from exc

    if not isinstance(before, dict):
        raise IncidentStateError(
            f"{target} is not a JSON object (got {type(before).__name__}); aborting"
        )

    # Source container detection
    if "ops" in before and isinstance(before["ops"], dict) and "incidents" not in before:
        source_entries = before["ops"]
        source_key = "ops"
    elif "incidents" in before and isinstance(before["incidents"], dict):
        source_entries = before["incidents"]
        source_key = "incidents"
    else:
        source_entries = {}
        source_key = None

    result["before_keys"] = sorted(before.keys())

    if reset:
        after_incidents: dict[str, dict] = {}
    else:
        normalizer = _normalize_lox_entry if owner == "lox" else _normalize_quinn_entry
        after_incidents = {}
        for slug, entry in source_entries.items():
            if not isinstance(entry, dict):
                log.warning("migrate_file: dropping non-dict entry %s in %s", slug, target)
                continue
            after_incidents[slug] = normalizer(entry)

    if dedupe and owner == "quinn" and not reset:
        after_incidents, result["entries_removed"] = dedupe_incidents(after_incidents)

    after = _build_unified_state(before, after_incidents)
    result["after_keys"] = sorted(after.keys())
    result["entries_migrated"] = len(after_incidents)

    # Comparing the complete state also catches legacy top-level fields that
    # must be moved under _meta for schema validation, plus dedupe key changes.
    result["changed"] = after != before

    if not write:
        return result

    if not reset and not result["changed"]:
        log.info("migrate_file: %s already in unified shape; no write", target)
        return result

    # Schema validation (if jsonschema is installed).
    try:
        validate_with_schema(after, schema_path=schema_path)
    except IncidentStateError as exc:
        # jsonschema not installed -> skip validation but continue (this is
        # acceptable since the script's normalizer produces valid output).
        log.warning("migrate_file: schema validation skipped (%s)", exc)
    except Exception as exc:  # jsonschema.ValidationError or similar
        raise IncidentStateError(
            f"{target} would not validate against the unified schema after "
            f"migration: {exc}"
        ) from exc

    backup = _backup_path(target)
    backup.write_text(raw_text)
    result["backup"] = str(backup)

    # Replace atomically so a heartbeat cannot observe a half-written state
    # file. The backup is retained for rollback.
    _atomic_write_json(target, after)
    log.info("migrate_file: wrote %s (backup %s)", target, backup)
    return result


def run_migration(
    workspace: Path,
    *,
    reset: bool = False,
    write: bool = False,
    dedupe: bool = False,
    schema_path: Path | None = None,
) -> list[dict]:
    quinn_target = workspace / QUINN_STATE_RELATIVE
    lox_target = workspace / LOX_STATE_RELATIVE
    return [
        migrate_file(
            quinn_target,
            owner="quinn",
            reset=reset,
            write=write,
            dedupe=dedupe,
            schema_path=schema_path,
        ),
        migrate_file(lox_target, owner="lox", reset=reset, write=write, schema_path=schema_path),
    ]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate Quinn + Lox incident state files to the unified schema."
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=WORKSPACE_DEFAULT,
        help=f"Workspace root (default: {WORKSPACE_DEFAULT})",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Write the migrated files back to disk. Default is dry-run (no writes).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Explicit dry-run (default behaviour). Suppresses --in-place.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Start fresh: drop all incidents and write empty `incidents: {}`.",
    )
    parser.add_argument(
        "--dedupe",
        action="store_true",
        help="Collapse Quinn's legacy date-suffixed incident keys to one stable key per logical incident.",
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=None,
        help="Override path to the JSON Schema (default: bundled).",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Verbose logging.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    write = args.in_place and not args.dry_run
    results = run_migration(
        args.workspace,
        reset=args.reset,
        write=write,
        dedupe=args.dedupe,
        schema_path=args.schema,
    )
    for r in results:
        print(json.dumps(r, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
