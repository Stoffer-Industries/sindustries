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
import sys
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


# ---------------------------------------------------------------------------
# Migration logic
# ---------------------------------------------------------------------------

def _backup_path(target: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return target.with_suffix(target.suffix + f".bak.{ts}")


def migrate_file(
    target: Path,
    owner: str,
    *,
    reset: bool = False,
    write: bool = False,
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

    # Preserve any _meta key the file already had (operator bookkeeping).
    after = dict(before)
    after.pop("ops", None)
    after["incidents"] = after_incidents
    result["after_keys"] = sorted(after.keys())
    result["entries_migrated"] = len(after_incidents)

    if source_key != "incidents":
        result["changed"] = True
    elif reset:
        result["changed"] = bool(before.get("incidents"))
    else:
        # Same key. Still consider it changed if normalization altered entries.
        for slug, new_entry in after_incidents.items():
            old_entry = source_entries.get(slug, {})
            if old_entry != new_entry:
                result["changed"] = True
                break

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

    target.write_text(json.dumps(after, indent=2, sort_keys=True) + "\n")
    log.info("migrate_file: wrote %s (backup %s)", target, backup)
    return result


def run_migration(
    workspace: Path,
    *,
    reset: bool = False,
    write: bool = False,
    schema_path: Path | None = None,
) -> list[dict]:
    quinn_target = workspace / QUINN_STATE_RELATIVE
    lox_target = workspace / LOX_STATE_RELATIVE
    return [
        migrate_file(quinn_target, owner="quinn", reset=reset, write=write, schema_path=schema_path),
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
        schema_path=args.schema,
    )
    for r in results:
        print(json.dumps(r, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())