#!/usr/bin/env python3
"""Bounded access to brain/state/lox-incident-state.json.

Why this exists
---------------
`brain/state/lox-incident-state.json` grew unbounded: every heartbeat appended a
new cycle log to free-text fields (`lastAction`, `notes`, `details`, `evidence`,
`resolution`, ...), so the file passed 1.38 MB with 184 incidents (115 entries
over 4 KB). HEARTBEAT.md step 2 used to tell the heartbeat to *read that file*,
so every Lox heartbeat tick burned ~1.38 MB of context before doing any work.
The result was a runaway feedback loop:

    bigger file -> more context burned per tick -> slower turn
                -> timeout -> append an even bigger lastAction
                -> next tick reads an even bigger file

Lox's own heartbeat failed 6 consecutive times overnight on 2026-10-24 while its
successful runs sat at 249-571s against a 600s budget.

This module provides the two things that fix it:

  summary   Read a *bounded* view of unresolved incidents. Use this on every
            heartbeat instead of reading the raw state file.
  compact   Shrink the file in place: preserves every incident key and every
            machine-readable schema field, truncates only operator free text,
            archives the original, and writes atomically.

The canonical shared roll-up across both agents' state files remains
`python3 -m agents.lib.incident_queue` (see codebases/sindustries/agents/lib/).
That already renders 3 MB of state down to ~540 bytes. This module is the
Lox-local equivalent that also covers entries the shared queue filters out.

Usage
-----
  python3 infra/lox_incident_state.py summary [--all] [--max-chars N]
  python3 infra/lox_incident_state.py compact [--dry-run] [--max-last-action N]
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

WORKSPACE = Path(
    os.environ.get("OPENCLAW_WORKSPACE")
    or Path(__file__).resolve().parent.parent
)
STATE_PATH = WORKSPACE / "brain" / "state" / "lox-incident-state.json"
ARCHIVE_DIR = WORKSPACE / "brain" / "state" / "archive"

# Contract sizes. These are the single source of truth: the CLI defaults and
# the compaction function defaults both read from here, so the documented
# bound and the enforced bound cannot drift apart.
MAX_LAST_ACTION = 300
MAX_NOTE_CHARS = 200

ACTIVE_STATUSES = ("watching", "escalated", "repair_attempted", "blocked")
TERMINAL_STATUSES = ("resolved", "false_positive", "archived")

# Caps that keep the live state file a triage/queue artifact rather than an
# archive. The full original text always survives in brain/state/archive/.
MAX_DETAIL_KEYS = 6
MAX_LIST_ITEMS = 3

# Keys that carry routing / diagnostic value - always kept when a details
# dict has to be trimmed.
PRIORITY_DETAIL_KEYS = frozenset(
    {
        "runbook",
        "rootCause",
        "smokingGun",
        "fixCommand",
        "fixApplied",
        "diagnosis",
        "trigger",
        "blastRadius",
        "blast_radius",
        "cause",
        "error",
        "lastAction",
        "runbookAlternative",
        "fixRiskAssessment",
        "owner",
        "summary",
        "detection",
        "remainingAction",
        "impact",
        "status",
        "nextSteps",
        "remediation",
        "workaround",
    }
)

REQUIRED_FIELDS = ("owner", "status")
UNIFIED_FIELDS = ("firstSeen", "attempts", "needsTom", "severity")

# Fields that carry machine-readable state. `compact` copies these verbatim -
# bounding them would corrupt the incident contract
# (docs/systems/agent-incidents.md).
PRESERVE_EXACT = frozenset(
    {
        "owner",
        "status",
        "scope",
        "severity",
        "firstSeen",
        "lastCheckedAt",
        "attempts",
        "recurrenceCount",
        "needsTom",
        "escalatedAt",
        "resolvedAt",
        "nextRetryAt",
        "dailyReviewDate",
        "linkedPr",
        "linkedRunbook",
        "impactTaskIds",
        "canonicalPath",
        "canonicalPathUnreachable",
        "cronJobId",
        "trackingTaskId",
        "runbook",
        "coOwner",
        "owner_agent",
    }
)


def load_state(path: Path = STATE_PATH) -> dict:
    with path.open() as fh:
        return json.load(fh)


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_ts(value: Any) -> _dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# summary
# --------------------------------------------------------------------------
def summarize(
    state: dict,
    include_all: bool = False,
    max_chars: int = 6000,
) -> str:
    incidents = state.get("incidents", {}) or {}
    now = _dt.datetime.now(_dt.timezone.utc)

    rows = []
    for key, entry in incidents.items():
        if not isinstance(entry, dict):
            continue
        status = entry.get("status", "watching")
        if not include_all and status in TERMINAL_STATUSES:
            continue

        retry_at = _parse_ts(entry.get("nextRetryAt"))
        due = ""
        if retry_at is not None:
            delta_h = (now - retry_at).total_seconds() / 3600.0
            due = f"retry_in={-delta_h:+.1f}h"

        details = entry.get("details") or {}
        runbook = entry.get("linkedRunbook") or ""
        if not runbook and isinstance(details, dict):
            runbook = details.get("runbook", "") or ""

        rows.append(
            {
                "key": key,
                "status": status,
                "severity": entry.get("severity", "medium"),
                "needsTom": bool(entry.get("needsTom")),
                "attempts": entry.get("attempts", 0),
                "firstSeen": entry.get("firstSeen", ""),
                "dailyReviewDate": entry.get("dailyReviewDate", ""),
                "nextRetryAt": entry.get("nextRetryAt"),
                "lastCheckedAt": entry.get("lastCheckedAt", ""),
                "due": due,
                "lastAction": str(entry.get("lastAction", ""))[-280:],
                "runbook": runbook,
            }
        )

    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rows.sort(
        key=lambda r: (
            0 if r["needsTom"] else 1,
            0 if r["status"] in ("escalated", "blocked") else 1,
            order.get(r["severity"], 9),
            r["firstSeen"] or "9999",
        )
    )

    active = [r for r in rows if r["status"] in ACTIVE_STATUSES]
    terminal = [r for r in rows if r["status"] in TERMINAL_STATUSES]
    needs_tom = [r for r in active if r["needsTom"]]

    def head_line(r: dict) -> str:
        flags = []
        if r["needsTom"]:
            flags.append("NEEDS_TOM")
        if r["due"]:
            flags.append(r["due"])
        return (
            f"- {r['key']} | {r['status']} sev={r['severity']} "
            f"attempts={r['attempts']} {' '.join(flags)}"
        ).rstrip()

    def runbook_line(r: dict) -> str | None:
        return f"    runbook: {r['runbook']}" if r["runbook"] else None

    def last_line(r: dict) -> str | None:
        return f"    last: {r['lastAction']}" if r["lastAction"] else None

    header = [
        f"lox incident state: {len(incidents)} total | {len(active)} active | "
        f"{len(needs_tom)} needsTom",
        "  (--all for terminal entries; full history in brain/state/archive/)",
    ]

    # --- Mandatory block -------------------------------------------------
    # One line per ACTIVE incident, always emitted in full. An active
    # incident (especially one with needsTom=true) must never be absent from
    # the bounded read: the whole point of this view is that the heartbeat can
    # see every live escalation without reading the raw file. Detail lines
    # are what gets squeezed when the budget runs out, never the row itself.
    blocks: list[list[str]] = [[head_line(r)] for r in active]

    mandatory_len = len("\n".join(header + [b[0] for b in blocks]))
    remaining = max_chars - mandatory_len

    # --- Optional detail -------------------------------------------------
    # Allocated round-robin so a long first row cannot starve every later
    # row: every active incident gets its runbook pointer before any of them
    # get the verbose `last:` free text. Detail stays directly under its own
    # incident, so the view stays readable.
    for getter in (runbook_line, last_line):
        for i, r in enumerate(active):
            line = getter(r)
            if not line:
                continue
            if len(line) + 1 <= remaining:
                blocks[i].append(line)
                remaining -= len(line) + 1

    out = header + [line for b in blocks for line in b]

    used = len("\n".join(out))

    def room_for(line: str) -> bool:
        nonlocal used
        return used + len(line) + 1 <= max_chars

    def append(line: str) -> None:
        nonlocal used
        out.append(line)
        used += len(line) + 1

    # --- Terminal entries (--all only) ----------------------------------
    # Optional: dropped first if they do not fit, and the count is reported
    # so a reader can tell history was elided rather than absent.
    dropped_terminal = 0
    if include_all:
        for r in terminal:
            line = head_line(r)
            if room_for(line):
                append(line)
            else:
                dropped_terminal += 1
        if dropped_terminal:
            append(f"  ({dropped_terminal} terminal entries omitted - budget {max_chars} chars)")

    text = "\n".join(out)

    # The mandatory block may exceed the budget on a pathological file. The
    # guarantee "every active incident is present" wins over the byte budget;
    # say so explicitly rather than silently truncating a live escalation.
    if len(text) > max_chars:
        text += (
            f"\n[mandatory active rows exceed the {max_chars}-char budget "
            f"({len(text)} chars); raise --max-chars to see detail lines]"
        )

    # Belt and braces: if an active key is somehow missing, say so rather
    # than letting the heartbeat believe the incident does not exist.
    missing = [r["key"] for r in active if r["key"] not in text]
    if missing:
        text += "\n[MISSING FROM THIS VIEW: " + ", ".join(missing) + "]"

    return text


# --------------------------------------------------------------------------
# compaction
# --------------------------------------------------------------------------
def _truncate_str(value: str, limit: int) -> tuple[str, bool]:
    """Keep head + tail so both the original context and the newest update survive.

    The returned string is never longer than `limit` - the truncation marker
    is budgeted out of the limit rather than added on top of it, so a
    documented "lastAction <= 300 chars" contract is actually enforceable.
    """
    if len(value) <= limit:
        return value, False
    marker = " [...truncated; full text in archive] "
    if limit <= len(marker):
        return value[:limit], True
    room = limit - len(marker)
    dropped = len(value) - room
    marker = f" [...truncated {dropped} chars; full text in archive] "
    if len(marker) >= limit:
        return value[:limit], True
    room = limit - len(marker)
    head = room // 3
    tail = room - head
    return value[:head] + marker + value[-tail:], True


def _bound_value(value: Any, limit: int, depth: int = 0, max_keys: int | None = None) -> tuple[Any, bool]:
    """Recursively bound a free-text value. Returns (value, changed)."""
    changed = False
    if depth > 6:
        return value, False
    if isinstance(value, str):
        new, c = _truncate_str(value, limit)
        return new, c
    if isinstance(value, list):
        if len(value) > MAX_LIST_ITEMS:
            value = value[-MAX_LIST_ITEMS:]
            changed = True
        out = []
        for item in value:
            new, c = _bound_value(item, limit, depth + 1, max_keys)
            changed = changed or c
            out.append(new)
        return out, changed
    if isinstance(value, dict):
        # Cap the NUMBER of keys too. The bulk of `details` is many medium
        # strings, so bounding string length alone barely helps.
        key_cap = MAX_DETAIL_KEYS if max_keys is None else max_keys
        if len(value) > key_cap:
            keep = [k for k in value if k in PRIORITY_DETAIL_KEYS]
            keep += [k for k in value if k not in keep][: key_cap - len(keep)]
            value = {k: value[k] for k in keep[:key_cap]}
            changed = True
        out = {}
        for k, v in value.items():
            new, c = _bound_value(v, limit, depth + 1, max_keys)
            changed = changed or c
            out[k] = new
        return out, changed
    return value, False


def compact_state(
    path: Path = STATE_PATH,
    archive_dir: Path = ARCHIVE_DIR,
    max_last_action: int = MAX_LAST_ACTION,
    max_note: int = MAX_NOTE_CHARS,
    keep_notes: int = 2,
    max_detail: int = 200,
    keep_followup: int = 5,
    dry_run: bool = False,
) -> dict:
    """Shrink the state file, preserving every key and every schema field."""
    original = load_state(path)
    incidents = original.get("incidents", {}) or {}
    before_bytes = path.stat().st_size

    compacted: dict[str, Any] = {}
    archive: dict[str, Any] = {}
    changed_keys: list[str] = []

    for key, entry in incidents.items():
        if not isinstance(entry, dict):
            compacted[key] = entry
            continue

        # Terminal entries (resolved / false_positive) are history: keep their
        # status, severity and timestamps, but move the prose to the archive.
        # Active entries keep a richer excerpt because they still need triage.
        status = entry.get("status")
        terminal = status in TERMINAL_STATUSES
        ent_last_action = 200 if terminal else max_last_action
        ent_max_detail = 150 if terminal else max_detail
        ent_keep_notes = 1 if terminal else keep_notes

        new_entry: dict[str, Any] = {}
        arch: dict[str, Any] = {}

        for field, value in entry.items():
            # Schema-critical fields are copied verbatim - never bounded.
            if field in PRESERVE_EXACT:
                new_entry[field] = value
                continue

            if field == "lastAction":
                if isinstance(value, str) and len(value) > ent_last_action:
                    new_entry[field], _ = _truncate_str(value, ent_last_action)
                    arch[field] = value
                    changed_keys.append(key)
                else:
                    new_entry[field] = value
                continue

            if field == "notes" and isinstance(value, list):
                kept = []
                truncated_in_place = False
                for note in value[-ent_keep_notes:]:
                    if isinstance(note, str) and len(note) > max_note:
                        note, _ = _truncate_str(note, max_note)
                        truncated_in_place = True
                    kept.append(note)
                # Archive on ANY change, not only when the note count shrinks:
                # a note truncated in place loses its original text just as
                # surely as a dropped note does.
                if len(kept) != len(value) or truncated_in_place:
                    arch[field] = value
                    changed_keys.append(key)
                new_entry[field] = kept
                continue

            if field == "followUp" and isinstance(value, list):
                kept = value[-keep_followup:]
                if len(kept) != len(value):
                    arch[field] = value
                    changed_keys.append(key)
                new_entry[field] = kept
                continue

            bounded, c = _bound_value(value, ent_max_detail, max_keys=3 if terminal else MAX_DETAIL_KEYS)
            if c:
                arch[field] = value
                changed_keys.append(key)
            new_entry[field] = bounded

        compacted[key] = new_entry
        if arch:
            archive[key] = arch

    new_state = dict(original)
    new_state["incidents"] = compacted
    meta = new_state.get("_meta") or {}
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    meta["lastCompactedAt"] = _now_iso()
    meta["lastCompactedBy"] = "lox-heartbeat"
    meta["compactionArchive"] = str(archive_dir / f"{path.name}.full-{stamp}.json")
    new_state["_meta"] = meta

    payload = json.dumps(new_state, indent=2, ensure_ascii=False)
    after_bytes = len(payload.encode("utf-8"))

    result = {
        "dry_run": dry_run,
        "incidents": len(incidents),
        "keys_preserved": set(compacted.keys()) == set(incidents.keys()),
        "changed_entries": len(set(changed_keys)),
        "before_bytes": before_bytes,
        "after_bytes": after_bytes,
        "reduction_pct": round(100 * (1 - after_bytes / before_bytes), 1) if before_bytes else 0,
        "archived_entries": len(archive),
        "archive_path": meta["compactionArchive"],
    }

    if dry_run:
        return result

    # 1. archive the full original free text (nothing is deleted from disk)
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = Path(meta["compactionArchive"])
    archive_doc = {
        "_meta": {
            "archivedAt": _now_iso(),
            "reason": "Lox incident-state compaction: unbounded operator free text "
            "removed from the live file to stop per-heartbeat context bloat.",
            "sourceFile": str(path),
            "incidentCount": len(incidents),
        },
        "incidents": archive,
    }
    _atomic_write(archive_path, json.dumps(archive_doc, indent=2, ensure_ascii=False))

    # 2. timestamped backup of the complete original
    backup_path = path.with_suffix(path.suffix + f".bak.{stamp}")
    _atomic_write(backup_path, json.dumps(original, indent=2, ensure_ascii=False))

    # 3. atomic write of the compacted live file
    _atomic_write(path, payload)

    # 4. re-validate after the rename.
    #    Compare against the ORIGINAL rather than asserting a fixed field list:
    #    legacy entries may predate `owner` (the shared parser derives it from
    #    the filename on read), so requiring it here would false-alarm.
    verify = load_state(path)
    v_inc = verify.get("incidents", {}) or {}
    assert set(v_inc.keys()) == set(incidents.keys()), "incident key set changed"
    for k, v in v_inc.items():
        if not isinstance(v, dict):
            continue
        assert "status" in v, f"{k}: lost required field status"
        for f in original.get("incidents", {})[k]:
            assert f in v, f"{k}: lost field {f}"
    result["verified"] = True
    result["backup_path"] = str(backup_path)
    result["archive_file"] = str(archive_path)
    return result


def _atomic_write(path: Path, text: str) -> None:
    """Write atomically: tmp -> fsync -> validate re-read -> rename -> re-validate."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        with tmp.open() as fh:
            json.load(fh)  # validate before rename
        os.rename(tmp, path)
        with path.open() as fh:
            json.load(fh)  # validate after rename
    finally:
        if tmp.exists():
            tmp.unlink()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bounded Lox incident-state access.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("summary", help="bounded view of incidents")
    s.add_argument("--all", action="store_true", help="include terminal entries")
    s.add_argument("--max-chars", type=int, default=6000)
    s.add_argument("--path", type=Path, default=STATE_PATH)

    c = sub.add_parser("compact", help="shrink the state file in place")
    c.add_argument("--dry-run", action="store_true")
    c.add_argument(
        "--max-last-action",
        type=int,
        default=MAX_LAST_ACTION,
        help=f"max chars for lastAction (default {MAX_LAST_ACTION})",
    )
    c.add_argument("--path", type=Path, default=STATE_PATH)

    args = ap.parse_args(argv)

    if args.cmd == "summary":
        try:
            state = load_state(args.path)
        except FileNotFoundError:
            # A missing state file is a normal state, not an error: there is
            # simply nothing to triage. The old raw-read step tolerated this;
            # the bounded read must too, or every heartbeat tick hard-fails
            # on a fresh install.
            print(f"lox incident state: no state file at {args.path} (nothing to triage)")
            return 0
        except json.JSONDecodeError as exc:
            print(f"lox incident state: {args.path} is not valid JSON ({exc})")
            return 1
        print(
            summarize(
                state,
                include_all=args.all,
                max_chars=args.max_chars,
            )
        )
        return 0

    if args.cmd == "compact":
        res = compact_state(
            args.path,
            max_last_action=args.max_last_action,
            dry_run=args.dry_run,
        )
        for k, v in res.items():
            print(f"{k}: {v}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
