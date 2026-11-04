"""Unified agent incident parser — Quinn (workflow/pipeline) + Lox (infra).

Task 75ec1c8c: unify the two agents' divergent incident state file schemas onto a
single superset so heartbeat can roll up across both with a single parser.

Public API:
    load_all_incidents(workspace=None) -> list[dict]
        Read both state files in the workspace and return a flat list of unified
        incident records. A file that could not be read or parsed contributes no
        records — use read_registry() to tell "no incidents" apart from
        "the file never loaded".

    parse_file(path, owner=None) -> list[dict]
        Read one file, apply the legacy normalizer for that file's known shape,
        return the unified list.

    state_file_read_failures(workspace=None) -> list[dict]
        Return the state files that exist but could not be read or parsed.
        An unreadable file is not an empty one — use this to avoid reporting
        an unverified zero for a registry that was never actually loaded.

    read_state_file(path, owner=None) -> StateFileRead
        Read one state file exactly once and return its records together with
        the reason it could not be read. The records and the read status come
        from the same read, so they cannot disagree.

    read_registry(workspace=None) -> RegistryRead
        Read both state files exactly once and return every record plus every
        read failure. This is the source of truth for the operator queue.

    active_incidents(incidents) -> list[dict]
        Filter out resolved, false-positive, and archived records.

    reportable_incidents(incidents) -> list[dict]
        Return fresh, system-scoped active records for the operator queue.

    needs_tom(incidents) -> list[dict]
        Filter reportable entries where needsTom is True or severity is
        high/critical.

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
from datetime import datetime, timedelta, timezone
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
VALID_STATUSES = {"watching", "escalated", "resolved", "false_positive", "archived"}
VALID_SEVERITIES = {"low", "medium", "high", "critical"}
TOM_SURFACING_SEVERITIES = {"high", "critical"}
INACTIVE_STATUSES = {"resolved", "false_positive", "archived"}
REPORTABLE_MAX_AGE_HOURS = 72


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

READ_OK = "ok"
READ_MISSING = "missing"
READ_FAILED = "failed"


class StateFileRead:
    """One state file read: its records, and the reason it could not be read.

    A state file that failed to read is not a state file with no incidents.
    ``parse_file`` returns an empty list for both, so a caller that renders a
    health result from it can report a clean zero it never verified. This
    object keeps the records and the failure reason together, derived from the
    same read, so the two cannot disagree.
    """

    __slots__ = ("path", "owner", "status", "error", "records")

    def __init__(
        self,
        path: Path | str,
        owner: str,
        status: str,
        error: str | None = None,
        records: list[dict] | None = None,
    ) -> None:
        self.path = str(path)
        self.owner = owner
        self.status = status
        self.error = error
        self.records = records or []

    @property
    def failed(self) -> bool:
        """True when the file existed but could not be read or parsed."""
        return self.status == READ_FAILED

    @property
    def missing(self) -> bool:
        """True when there was no file — which genuinely means no incidents."""
        return self.status == READ_MISSING

    def failure_record(self) -> dict:
        """The ``{"path", "owner", "error"}`` shape used by the queue."""
        return {"path": self.path, "owner": self.owner, "error": self.error}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"StateFileRead(path={self.path!r}, owner={self.owner!r}, "
            f"status={self.status!r}, records={len(self.records)}, error={self.error!r})"
        )


class RegistryRead:
    """Both state files read once: every record, and every read failure."""

    __slots__ = ("records", "failures", "files")

    def __init__(
        self,
        records: list[dict],
        failures: list[dict],
        files: list[StateFileRead],
    ) -> None:
        self.records = records
        self.failures = failures
        self.files = files

    @property
    def verified(self) -> bool:
        """True when every existing state file was read and parsed."""
        return not self.failures

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"RegistryRead(records={len(self.records)}, "
            f"failures={len(self.failures)}, files={len(self.files)})"
        )


def read_state_file(path: Path, owner: str | None = None) -> "StateFileRead":
    """Read one state file exactly once and return its records + read status.

    A state file that could not be read or parsed is not a state file with no
    incidents. ``parse_file`` returns an empty list for both cases, so a caller
    that renders a health result from it can report a clean zero it never
    verified. This function derives the records *and* the failure reason from
    the same read, so the two can never disagree.

    `owner` is used to pick the legacy normalizer when the file's content
    doesn't expose an unambiguous owner on each entry (e.g. Quinn's legacy
    `ops` shape). If omitted, owner is derived from the filename:
        * quinn-ops-state.json -> "quinn"
        * lox-incident-state.json -> "lox"
        * anything else -> falls back to "quinn" (Quinn is the dominant writer)

    The accepted shapes are exactly the ones the legacy normalizers support:
    a JSON object holding either an `incidents` object or a legacy `ops`
    object. Anything else (a JSON array, a JSON scalar, an object with no
    incidents container) is malformed rather than empty, and is reported as a
    read failure so the queue renders UNVERIFIED instead of a false zero.

    A non-object *entry* inside the incidents container is malformed for the
    same reason: per the schema every value under `incidents` is an incident
    object, so skipping one silently discards a record that may be the
    critical one and still reports a verified zero. The whole file is
    therefore reported as a read failure naming the offending slug.
    """
    path = Path(path)
    try:
        raw_text = path.read_text()
    except FileNotFoundError:
        log.info("incident_state.read_state_file: file does not exist: %s", path)
        return StateFileRead(path, owner or "", READ_MISSING)
    except UnicodeDecodeError as exc:
        log.warning(
            "incident_state.read_state_file: %s is not valid UTF-8 (%s)", path, exc
        )
        return StateFileRead(
            path, owner or "", READ_FAILED, error=f"UnicodeDecodeError: {exc}"
        )
    except OSError as exc:
        log.warning(
            "incident_state.read_state_file: cannot read %s (%s)", path, exc
        )
        return StateFileRead(
            path, owner or "", READ_FAILED, error=f"{type(exc).__name__}: {exc}"
        )

    try:
        state = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        log.warning(
            "incident_state.read_state_file: malformed JSON in %s (%s)", path, exc
        )
        return StateFileRead(
            path, owner or "", READ_FAILED, error=f"JSONDecodeError: {exc}"
        )

    if not isinstance(state, dict):
        log.warning(
            "incident_state.read_state_file: %s is not an object (got %s)",
            path,
            type(state).__name__,
        )
        return StateFileRead(
            path,
            owner or "",
            READ_FAILED,
            error=f"not a JSON object (got {type(state).__name__})",
        )

    # Detect which container key holds the incidents. Quinn legacy uses `ops`;
    # everything else (including Lox and post-migration Quinn) uses `incidents`.
    if "incidents" in state and isinstance(state["incidents"], dict):
        entries = state["incidents"]
    elif "ops" in state and isinstance(state["ops"], dict):
        entries = state["ops"]
    else:
        log.warning(
            "incident_state.read_state_file: %s has no `incidents` or `ops` object",
            path,
        )
        return StateFileRead(
            path,
            owner or "",
            READ_FAILED,
            error="no `incidents` or `ops` object (malformed registry shape)",
        )

    default_owner = owner or _owner_from_filename(path) or "quinn"
    malformed: list[str] = []
    out: list[dict] = []
    for slug, raw in entries.items():
        if not isinstance(raw, dict):
            malformed.append(f"`{slug}` (got {type(raw).__name__})")
            continue
        normalized = _normalize_for_owner(raw, default_owner)
        normalized.setdefault("_slug", slug)
        out.append(normalized)

    if malformed:
        log.warning(
            "incident_state.read_state_file: %s has malformed incident entries: %s",
            path,
            ", ".join(malformed),
        )
        return StateFileRead(
            path,
            default_owner,
            READ_FAILED,
            error=(
                "malformed incident entr"
                + ("y" if len(malformed) == 1 else "ies")
                + f": {', '.join(malformed)}"
            ),
        )

    return StateFileRead(path, default_owner, READ_OK, records=out)


def parse_file(path: Path, owner: str | None = None) -> list[dict]:
    """Read one state file and return a list of unified incident dicts.

    Thin wrapper over :func:`read_state_file` kept for existing callers. A
    file that could not be read or parsed yields an empty list here — use
    :func:`read_state_file` (or :func:`read_registry`) when you need to know
    whether an empty list means "no incidents" or "the file never loaded".
    """
    return read_state_file(path, owner=owner).records


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
    return read_registry(workspace).records


def read_registry(workspace: Path | None = None) -> RegistryRead:
    """Read both state files exactly once and return records + read failures.

    The records and the failures come from the same pass over the filesystem,
    so the queue can never report a count that disagrees with the failure list
    (iCloud can materialise a file between two separate reads).
    """
    ws = Path(workspace) if workspace else WORKSPACE_DEFAULT
    reads = [
        read_state_file(ws / QUINN_STATE_RELATIVE, owner="quinn"),
        read_state_file(ws / LOX_STATE_RELATIVE, owner="lox"),
    ]
    records: list[dict] = []
    failures: list[dict] = []
    for read in reads:
        records.extend(read.records)
        if read.failed:
            failures.append(read.failure_record())
    return RegistryRead(records, failures, reads)


def state_file_read_failures(workspace: Path | None = None) -> list[dict]:
    """Return the state files that exist but could not be read or parsed.

    An unreadable state file is not an empty one. ``parse_file`` returns an
    empty list for both cases, so a caller that renders a health result from
    it can report a clean zero it never verified. ``brain/`` is an
    iCloud-backed symlink, and a state file that is only read (never written)
    can be evicted to a dataless placeholder that fails to read with
    ``OSError [Errno 11] Resource deadlock avoided``.

    A missing file is *not* a failure — no state file means genuinely no
    incidents. Only files that exist and could not be parsed or read are
    reported here. "Could not be parsed" includes a file that is valid JSON
    but not a valid registry shape (a JSON array, or an object with no
    `incidents`/`ops` object): per the schema the top level must be an object
    with an `incidents` object, so a shape-invalid file is malformed, not
    empty. It also includes an entry inside the incidents container that is
    not an incident object: per the schema every value under `incidents` is an
    incident object, so a malformed record makes the whole registry
    unverifiable rather than safely skippable.

    Returns one record per unreadable file:
    ``{"path": str, "owner": str, "error": str}``.
    """
    return read_registry(workspace).failures


def active_incidents(incidents: list[dict]) -> list[dict]:
    """Return records that are still open in the incident registry.

    Archived records remain in the state files for audit/history, but are not
    operational work. This is deliberately separate from ``resolved``: an
    archive does not claim that the underlying condition was fixed.
    """
    return [
        inc for inc in incidents
        if isinstance(inc, dict) and inc.get("status") not in INACTIVE_STATUSES
    ]


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def reportable_incidents(
    incidents: list[dict],
    *,
    now: datetime | None = None,
    max_age_hours: int = REPORTABLE_MAX_AGE_HOURS,
) -> list[dict]:
    """Return fresh system incidents suitable for the operator queue.

    Task gates and handoffs belong to the Tasks API, so records explicitly
    marked ``scope: task`` never appear here. Records without a scope retain
    legacy behaviour and are treated as system records. A record with a
    ``lastCheckedAt`` older than the freshness window is also omitted; a new
    observation can reopen it with fresh evidence. Missing timestamps are
    retained for backwards compatibility with legacy state.
    """
    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = reference - timedelta(hours=max_age_hours)
    out: list[dict] = []
    for inc in active_incidents(incidents):
        if inc.get("scope") == "task":
            continue
        checked_at = _parse_timestamp(inc.get("lastCheckedAt"))
        if checked_at is not None and checked_at < cutoff:
            continue
        out.append(inc)
    return out


def needs_tom(incidents: list[dict], *, now: datetime | None = None) -> list[dict]:
    """Filter fresh system incidents that should be surfaced to Tom.

    ``now`` is threaded through to ``reportable_incidents`` so callers that
    already evaluated the reportable set at a fixed reference time (tests,
    queue rendering) get the same cut-off instead of "now".
    """
    out = []
    for inc in reportable_incidents(incidents, now=now):
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
    "INACTIVE_STATUSES",
    "REPORTABLE_MAX_AGE_HOURS",
    "IncidentStateError",
    "READ_OK",
    "READ_MISSING",
    "READ_FAILED",
    "StateFileRead",
    "RegistryRead",
    "parse_file",
    "read_state_file",
    "read_registry",
    "load_all_incidents",
    "state_file_read_failures",
    "active_incidents",
    "reportable_incidents",
    "needs_tom",
    "validate_with_schema",
]
