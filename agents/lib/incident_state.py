"""Unified agent incident parser — Quinn (workflow/pipeline) + Lox (infra).

Task 75ec1c8c: unify the two agents' divergent incident state file schemas onto a
single superset so heartbeat can roll up across both with a single parser.

Public API:
    load_all_incidents(workspace=None) -> list[dict]
        Read both state files in the workspace and return a flat list of unified
        incident records. Malformed JSON is logged and treated as empty.

    parse_file(path, owner=None) -> list[dict]
        Read one file, apply the legacy normalizer for that file's known shape,
        return the unified list.

    needs_tom(incidents) -> list[dict]
        Filter to entries where needsTom is True or severity is high/critical.

    validate_with_schema(state) -> None
        Validate a state dict against the JSON Schema bundled in
        agents/schemas/agent-incident-state.schema.json. Raises jsonschema
        ValidationError on failure.

Legacy shapes handled:
    Quinn legacy: top-level `ops` key (each entry has firstSeen/attempts/needsTom/
        severity/lastAction/resolvedAt/escalatedAt/lastCheckedAt). Missing owner
        defaults to "quinn"; missing recurrenceCount/nextRetryAt/details default
        to 0/null/{}. key is renamed to `incidents`.
    Lox legacy: top-level `incidents` key (each entry has recurrenceCount/
        nextRetryAt/owner/details plus Lox-specific fields). Missing firstSeen/
        attempts/needsTom/severity default to safe values.

Legacy entries are accepted indefinitely (the schema marks only `owner` and
`status` as required). The normalizers are the safety net that lets us roll
forward without breaking agents that still write a slightly different shape.

Path conventions:
    Quinn: brain/state/quinn-ops-state.json (key `incidents` after migration;
        pre-migration key is `ops`)
    Lox:   brain/state/lox-incident-state.json (key `incidents` always)

`workspace` defaults to the OPENCLAW workspace root. Tests should pass it
explicitly to avoid filesystem coupling.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCHEMA_PATH_DEFAULT = (
    Path(__file__).resolve().parent.parent / "schemas" / "agent-incident-state.schema.json"
)

QUINN_STATE_RELATIVE = Path("brain/state/quinn-ops-state.json")
LOX_STATE_RELATIVE = Path("brain/state/lox-incident-state.json")

WORKSPACE_DEFAULT = Path(
    os.environ.get("OPENCLAW_WORKSPACE") or (Path.home() / ".openclaw" / "workspace")
)

VALID_OWNERS = {"lox", "quinn"}
VALID_STATUSES = {"watching", "escalated", "resolved", "false_positive"}
VALID_SEVERITIES = {"low", "medium", "high", "critical"}
TOM_SURFACING_SEVERITIES = {"high", "critical"}


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class IncidentStateError(Exception):
    """Raised when an incident state file is structurally broken past recovery."""


# ---------------------------------------------------------------------------
# Legacy normalizers (private)
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coerce_owner(raw: Any, fallback: str) -> str:
    if isinstance(raw, str) and raw in VALID_OWNERS:
        return raw
    return fallback


def _coerce_status(raw: Any) -> str:
    if isinstance(raw, str) and raw in VALID_STATUSES:
        return raw
    # Some legacy Lox entries used "repair_attempted" — map to "watching" so the
    # entry stays open and visible. (Legacy Quinn used "watching"/"escalated"
    # already.)
    if raw == "repair_attempted":
        return "watching"
    if raw == "blocked":
        return "escalated"
    return "watching"


def _coerce_severity(raw: Any) -> str:
    if isinstance(raw, str) and raw in VALID_SEVERITIES:
        return raw
    return "medium"


def _normalize_quinn_entry(raw: dict) -> dict:
    """Map a Quinn legacy `ops` entry onto the unified shape.

    Quinn already has: firstSeen, attempts, needsTom, severity, lastAction,
    escalatedAt, resolvedAt, lastCheckedAt.
    Missing in Quinn: owner (set), recurrenceCount (default 0), nextRetryAt
    (default null), details (default {}).
    """
    out = dict(raw)  # shallow copy so callers don't mutate their input
    out["owner"] = _coerce_owner(out.get("owner"), "quinn")
    out["status"] = _coerce_status(out.get("status"))
    out["severity"] = _coerce_severity(out.get("severity"))
    out["attempts"] = int(out.get("attempts", 0) or 0)
    out["recurrenceCount"] = int(out.get("recurrenceCount", 0) or 0)
    out["needsTom"] = bool(out.get("needsTom", False))
    if "firstSeen" not in out:
        out["firstSeen"] = _now_iso()
    if "nextRetryAt" not in out:
        out["nextRetryAt"] = None
    if "details" not in out or not isinstance(out["details"], dict):
        # Preserve other Lox-style details; do not drop a legacy `details` field.
        existing = out.get("details")
        out["details"] = existing if isinstance(existing, dict) else {}
    return out


def _normalize_lox_entry(raw: dict) -> dict:
    """Map a Lox `incidents` entry onto the unified shape.

    Lox already has: owner, recurrenceCount, nextRetryAt, details (plus Lox-
    specific: dailyReviewDate, blastRadius in details, etc.).
    Missing in Lox: firstSeen, attempts, needsTom, severity.
    """
    out = dict(raw)
    out["owner"] = _coerce_owner(out.get("owner"), "lox")
    out["status"] = _coerce_status(out.get("status"))
    out["severity"] = _coerce_severity(out.get("severity"))
    out["attempts"] = int(out.get("attempts", 0) or 0)
    out["recurrenceCount"] = int(out.get("recurrenceCount", 0) or 0)
    out["needsTom"] = bool(out.get("needsTom", False))
    if "firstSeen" not in out:
        # Fall back to dailyReviewDate if Lox recorded one.
        drd = out.get("dailyReviewDate")
        if isinstance(drd, str) and drd:
            out["firstSeen"] = f"{drd}T00:00:00Z"
        else:
            out["firstSeen"] = _now_iso()
    return out


# ---------------------------------------------------------------------------
# Public parsing API
# ---------------------------------------------------------------------------

def parse_file(path: Path, owner: str | None = None) -> list[dict]:
    """Read one state file and return a list of unified incident dicts.

    `owner` is used to pick the legacy normalizer when the file's content
    doesn't expose an unambiguous owner on each entry (e.g. Quinn's legacy
    `ops` shape). If omitted, owner is derived from the filename:
        * quinn-ops-state.json -> "quinn"
        * lox-incident-state.json -> "lox"
        * anything else -> falls back to "quinn" (Quinn is the dominant writer)
    """
    path = Path(path)
    if not path.exists():
        log.info("incident_state.parse_file: file does not exist: %s", path)
        return []
    try:
        raw_text = path.read_text()
        state = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        log.warning(
            "incident_state.parse_file: malformed JSON in %s (%s); treating as empty",
            path,
            exc,
        )
        return []
    except OSError as exc:
        log.warning(
            "incident_state.parse_file: cannot read %s (%s); treating as empty",
            path,
            exc,
        )
        return []

    if not isinstance(state, dict):
        log.warning(
            "incident_state.parse_file: %s is not an object (got %s); treating as empty",
            path,
            type(state).__name__,
        )
        return []

    # Detect which container key holds the incidents. Quinn legacy uses `ops`;
    # everything else (including Lox and post-migration Quinn) uses `incidents`.
    if "incidents" in state and isinstance(state["incidents"], dict):
        entries = state["incidents"]
        default_owner = owner or _owner_from_filename(path) or "quinn"
    elif "ops" in state and isinstance(state["ops"], dict):
        entries = state["ops"]
        default_owner = owner or _owner_from_filename(path) or "quinn"
    else:
        log.warning(
            "incident_state.parse_file: %s has no `incidents` or `ops` key; treating as empty",
            path,
        )
        return []

    out: list[dict] = []
    for slug, raw in entries.items():
        if not isinstance(raw, dict):
            log.warning(
                "incident_state.parse_file: skipping non-dict entry %s in %s",
                slug,
                path,
            )
            continue
        normalized = _normalize_for_owner(raw, default_owner)
        normalized.setdefault("_slug", slug)
        out.append(normalized)
    return out


def _normalize_for_owner(raw: dict, default_owner: str) -> dict:
    if default_owner == "lox":
        return _normalize_lox_entry(raw)
    return _normalize_quinn_entry(raw)


def _owner_from_filename(path: Path) -> str | None:
    name = path.name
    if name.startswith("quinn-"):
        return "quinn"
    if name.startswith("lox-"):
        return "lox"
    return None


def load_all_incidents(workspace: Path | None = None) -> list[dict]:
    """Read both Quinn and Lox state files and return the unified flat list."""
    ws = Path(workspace) if workspace else WORKSPACE_DEFAULT
    quinn = parse_file(ws / QUINN_STATE_RELATIVE, owner="quinn")
    lox = parse_file(ws / LOX_STATE_RELATIVE, owner="lox")
    return quinn + lox


def needs_tom(incidents: list[dict]) -> list[dict]:
    """Filter to incidents that should be surfaced to Tom."""
    out = []
    for inc in incidents:
        if not isinstance(inc, dict):
            continue
        if inc.get("needsTom"):
            out.append(inc)
            continue
        sev = inc.get("severity")
        if isinstance(sev, str) and sev in TOM_SURFACING_SEVERITIES:
            out.append(inc)
    return out


# ---------------------------------------------------------------------------
# Schema validation (lazy import so jsonschema is optional at runtime)
# ---------------------------------------------------------------------------

def _load_schema(schema_path: Path | None = None) -> dict:
    path = Path(schema_path) if schema_path else SCHEMA_PATH_DEFAULT
    if not path.exists():
        raise IncidentStateError(f"Schema not found at {path}")
    with path.open() as f:
        return json.load(f)


def validate_with_schema(state: Any, schema_path: Path | None = None) -> None:
    """Validate a state dict against the unified JSON Schema.

    Raises jsonschema.ValidationError on failure. The jsonschema package is
    imported lazily so the hot heartbeat path can call parse_file without
    needing it installed.
    """
    try:
        import jsonschema  # type: ignore
    except ImportError as exc:
        raise IncidentStateError(
            "jsonschema is not installed; install with `pip install jsonschema` "
            "to run validate_with_schema(). The hot parse_file() path does not "
            "need it."
        ) from exc
    schema = _load_schema(schema_path)
    jsonschema.validate(instance=state, schema=schema)


__all__ = [
    "SCHEMA_PATH_DEFAULT",
    "QUINN_STATE_RELATIVE",
    "LOX_STATE_RELATIVE",
    "WORKSPACE_DEFAULT",
    "VALID_OWNERS",
    "VALID_STATUSES",
    "VALID_SEVERITIES",
    "TOM_SURFACING_SEVERITIES",
    "IncidentStateError",
    "parse_file",
    "load_all_incidents",
    "needs_tom",
    "validate_with_schema",
]