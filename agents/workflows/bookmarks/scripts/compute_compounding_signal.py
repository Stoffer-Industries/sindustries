#!/usr/bin/env python3
"""Compute the weekly compounding-signal artifact for the bookmark pipeline.

This is a read-only observer of existing bookmark pipeline artifacts. It does
not import or mutate any other workflow state. It produces two sibling files
under ``brain/state/``:

  * ``compounding-signal.json`` — validated machine-readable signal
  * ``compounding-signal.md``   — deterministic human-readable rendering

The signal answers the bookmark's question — "are we compounding yet?" — with
a weekly prior-context reuse percentage, a four-week trend, and the current
week's dossier-promotion count. See:

  * product spec: brain/tasks/specs/in-progress/compounding-signal-for-bookmark-pipeline-f0331a69bfaf9aa7.md
  * tech design:  docs/specs/compounding-signal-for-bookmark-pipeline-tech-design.md

Failure semantics: a non-zero exit means no upstream inputs were touched and
no destination files were overwritten. A failed run leaves the previous
successful pair in place; the dashboard then renders the previous value with
a stale marker. The signal never blocks another pipeline stage.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

# Eligible review-status set per the tech design. Items in any of these
# states count toward the denominator. Items in any known-but-not-eligible
# state (``EXCLUDED_STATES``) are silently excluded from windowing. Items
# in any other state — a status the pipeline does not use — fail the run
# rather than silently inflate the denominator.
ELIGIBLE_STATES: frozenset[str] = frozenset({
    "summarized",
    "needs_research",
    "spec_requested",
    "spec_created",
    "approval_pending",
    "revision_requested",
    "revision_staged",
    "approved",
    "tasked",
    "declined",
})

EXCLUDED_STATES: frozenset[str] = frozenset({
    "pending",
    "ingested",
    "monitoring",
    "curated_implement",
})

KNOWN_STATES: frozenset[str] = ELIGIBLE_STATES | EXCLUDED_STATES

# Decision-table thresholds. Living with the calculator keeps the predicate
# auditable and the runbook explainable. Changing them is a reviewed code or
# config change, never prose editing at runtime.
LOW_PERCENTAGE_BELOW = 25.0
CORPUS_ESTABLISHED_DOCUMENTS = 25
MINIMUM_FOUR_WEEK_ELIGIBLE_FOR_BROKEN_PATH = 10

# Note IDs and exact text. Closed set per the spec; no LLM or generated prose.
OPERATOR_NOTES: dict[str, str] = {
    "corpus_too_small": (
        "The indexed corpus is still too small to treat a low reuse rate as "
        "diagnostic. Keep collecting reviewed material, then reassess after "
        "four measurable weeks."
    ),
    "retrieval_path_may_be_broken": (
        "The corpus is established but no eligible bookmark recorded prior "
        "context in four measurable weeks. Check the retrieval and "
        "state-recording path before interpreting this as unrelated intake."
    ),
    "mostly_unrelated_intake": (
        "Prior context is being recorded, but fewer than one in four eligible "
        "bookmarks reused it in every measured week. Most recent bookmarks may "
        "be unrelated to the existing corpus; inspect matched terms and topic "
        "mix before changing retrieval."
    ),
}

# Per AC1.
WINDOW_DAYS = 7
WINDOW_COUNT = 4


# --- Helpers --------------------------------------------------------------

def parse_iso(value: Any) -> dt.datetime | None:
    """Parse an ISO-8601 timestamp into an aware UTC datetime.

    Returns None for empty, non-string, or unparseable inputs. Accepts both
    ``...Z`` and explicit ``+00:00`` forms. Naive timestamps are rejected —
    the product spec pins all stored instants to UTC.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(dt.timezone.utc)


def format_iso(value: dt.datetime) -> str:
    """Format an aware UTC datetime as an ISO-8601 string with ``Z`` suffix."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def window_bounds(as_of: dt.datetime, offset_weeks: int) -> tuple[dt.datetime, dt.datetime]:
    """Return the half-open ``[start, end)`` bounds for the window.

    ``offset_weeks=0`` is the current window; ``offset_weeks=1`` is the prior
    week's window, and so on. End is exclusive so the windows partition
    ``as_of`` without overlap.
    """
    end = as_of - dt.timedelta(days=WINDOW_DAYS * offset_weeks)
    start = end - dt.timedelta(days=WINDOW_DAYS)
    return start, end


# --- Input adapters -------------------------------------------------------

def load_bookmark_state(path: Path) -> dict[str, Any]:
    """Load bookmark-review-state.json. Returns the parsed object.

    Raises ``FileNotFoundError`` if the file is missing — the caller decides
    whether that is fatal for the current run.
    """
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"bookmark state at {path} must be a JSON object")
    return data


def load_corpus_index(path: Path) -> list[dict[str, Any]]:
    """Load bookmark-corpus-index.jsonl. Skips blank lines.

    Returns the parsed list of objects. Raises ``ValueError`` on malformed
    lines so the caller fails closed rather than silently skipping.
    """
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"corpus index {path}:{lineno} is not valid JSON: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"corpus index {path}:{lineno} is not a JSON object")
            out.append(row)
    return out


def load_dossier_promotions(path: Path) -> list[dict[str, Any]]:
    """Load the dossier-promotion log. Returns the parsed list of events.

    Schema is pending final upstream contract — we accept either a JSON array
    or JSONL of objects with at least ``eventId`` and ``promotedAt``. Missing
    files raise ``FileNotFoundError`` so the caller can degrade gracefully.
    """
    text = path.read_text(encoding="utf-8")
    stripped = text.strip()
    if not stripped:
        return []
    if stripped.startswith("["):
        data = json.loads(stripped)
        if not isinstance(data, list):
            raise ValueError(f"dossier promotions at {path} must be a JSON array")
        return data
    out: list[dict[str, Any]] = []
    for lineno, line in enumerate(stripped.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"dossier promotions {path}:{lineno} invalid: {exc}") from exc
        if not isinstance(row, dict):
            raise ValueError(f"dossier promotions {path}:{lineno} not an object")
        out.append(row)
    return out


# --- Domain helpers -------------------------------------------------------

def context_evaluation_at(item: dict[str, Any]) -> dt.datetime | None:
    """Return the upstream context-evaluation timestamp for an item.

    The knowledge-base spec proposes ``reviewedAt``; we also accept
    ``lastUpdatedAt`` and ``firstSeenAt`` as fallbacks so the calculator
    does not lock to a draft field name. Items with no parseable timestamp
    are excluded from per-window counting rather than counted at the as-of.
    """
    for key in ("reviewedAt", "lastUpdatedAt", "firstSeenAt"):
        ts = parse_iso(item.get(key))
        if ts is not None:
            return ts
    return None


def effective_review_status(item: dict[str, Any]) -> str:
    """Resolve the routing-safe review status.

    Items with non-empty ``taskIds`` are treated as ``tasked`` (mirrors the
    workflow's authoritative boundary — see
    ``agents/workflows/bookmarks/scripts/bookmark_state_machine.py``). This
    keeps the cohort semantics consistent with the rest of the pipeline.
    Non-dict inputs fall back to ``pending`` so callers can coalesce missing
    items without a separate None check.
    """
    if not isinstance(item, dict):
        return "pending"
    raw = item.get("reviewStatus")
    status = raw if isinstance(raw, str) and raw.strip() else "pending"
    task_ids = item.get("taskIds")
    if isinstance(task_ids, list) and any(isinstance(t, str) and t.strip() for t in task_ids):
        return "tasked"
    return status


def prior_context_refs(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the prior-context references attached to an item.

    Expected shape per the upstream knowledge-base draft: a list of
    ``{ key, score }`` objects. Self-references (same key as the item) are
    ignored downstream. Missing or malformed fields are treated as no
    references, not as an error.
    """
    refs = item.get("priorContextRefs")
    if not isinstance(refs, list):
        return []
    return [r for r in refs if isinstance(r, dict)]


def is_known_state(item: dict[str, Any]) -> bool:
    """Return True when the item's effective review status is recognized.

    Recognized states are ``ELIGIBLE_STATES`` plus ``EXCLUDED_STATES``. States
    outside this closed set are treated as upstream contract drift and fail
    the run rather than silently counting or excluding.
    """
    return effective_review_status(item) in KNOWN_STATES


# --- Windowing and aggregation -------------------------------------------

def compute_trend_window(
    items: Iterable[dict[str, Any]],
    *,
    as_of: dt.datetime,
    offset_weeks: int,
) -> dict[str, Any]:
    """Compute the per-window counts and percentage.

    An item is counted in the window whose half-open bounds contain its
    context-evaluation timestamp; this prevents later state transitions
    from counting the same item in multiple weeks. Eligibility is evaluated
    from the **current** effective state (post-``tasked`` reconciliation).
    """
    eligible_count = 0
    referenced_count = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        if not is_known_state(item):
            raise ValueError(
                f"unknown review status {effective_review_status(item)!r}; "
                f"update ELIGIBLE_STATES or EXCLUDED_STATES if the upstream contract changed"
            )
        status = effective_review_status(item)
        if status not in ELIGIBLE_STATES:
            continue
        ts = context_evaluation_at(item)
        if ts is None:
            continue
        start, end = window_bounds(as_of, offset_weeks)
        if not (start <= ts < end):
            continue
        eligible_count += 1
        item_key = item.get("key")
        refs = prior_context_refs(item)
        non_self = [
            r for r in refs
            if isinstance(r.get("key"), str) and r.get("key") != item_key
        ]
        if non_self:
            referenced_count += 1
    percentage = (
        round(referenced_count / eligible_count * 100, 1)
        if eligible_count > 0
        else None
    )
    start, end = window_bounds(as_of, offset_weeks)
    return {
        "offsetWeeks": offset_weeks,
        "start": format_iso(start),
        "end": format_iso(end),
        "eligibleCount": eligible_count,
        "referencedCount": referenced_count,
        "percentage": percentage,
    }


def compute_dossier_promotion_count(
    events: Iterable[dict[str, Any]],
    *,
    as_of: dt.datetime,
) -> int:
    """Count unique dossier-promotion events in the current 7-day window."""
    start, end = window_bounds(as_of, 0)
    seen: set[str] = set()
    for event in events:
        if not isinstance(event, dict):
            continue
        event_id = event.get("eventId")
        if not isinstance(event_id, str) or not event_id:
            continue
        if event_id in seen:
            continue
        ts = parse_iso(event.get("promotedAt"))
        if ts is None:
            continue
        if start <= ts < end:
            seen.add(event_id)
    return len(seen)


def select_operator_note(
    trend: list[dict[str, Any]],
    corpus_document_count: int,
) -> dict[str, str] | None:
    """Pick the operator note from the closed decision table.

    Returns ``None`` when the predicate fires (to omit the key from JSON) or
    when all four trend percentages are null or >= 25.0.
    """
    percentages = [w["percentage"] for w in trend]
    if not all(isinstance(p, (int, float)) for p in percentages):
        return None
    if not all(p < LOW_PERCENTAGE_BELOW for p in percentages):
        return None

    eligible_total = sum(w["eligibleCount"] for w in trend)
    referenced_total = sum(w["referencedCount"] for w in trend)

    if corpus_document_count < CORPUS_ESTABLISHED_DOCUMENTS:
        note_id = "corpus_too_small"
    elif (
        corpus_document_count >= CORPUS_ESTABLISHED_DOCUMENTS
        and eligible_total >= MINIMUM_FOUR_WEEK_ELIGIBLE_FOR_BROKEN_PATH
        and referenced_total == 0
    ):
        note_id = "retrieval_path_may_be_broken"
    else:
        note_id = "mostly_unrelated_intake"

    if note_id not in OPERATOR_NOTES:
        raise ValueError(f"decided note {note_id!r} is not in OPERATOR_NOTES")
    return {"id": note_id, "text": OPERATOR_NOTES[note_id]}


# --- Top-level orchestration ---------------------------------------------

def build_signal(
    *,
    as_of: dt.datetime,
    bookmark_state: dict[str, Any],
    corpus_index: list[dict[str, Any]],
    dossier_events: list[dict[str, Any]],
    inputs_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Compose the validated JSON signal."""
    items_obj = bookmark_state.get("items")
    if not isinstance(items_obj, dict):
        items_obj = {}
    items = list(items_obj.values())

    trend = [
        compute_trend_window(items, as_of=as_of, offset_weeks=offset)
        for offset in range(WINDOW_COUNT)
    ]
    dossier_count = compute_dossier_promotion_count(dossier_events, as_of=as_of)
    operator_note = select_operator_note(trend, len(corpus_index))

    headline = trend[0]["percentage"]
    if headline is None:
        # All four windows null is fine; the headline is also null.
        headline_value: Any = None
    else:
        headline_value = headline

    run_id = format_iso(as_of)
    signal: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "generatedAt": run_id,
        "asOf": run_id,
        "headlinePercentage": headline_value,
        "currentWindow": {
            "start": trend[0]["start"],
            "end": trend[0]["end"],
            "eligibleCount": trend[0]["eligibleCount"],
            "referencedCount": trend[0]["referencedCount"],
            "percentage": trend[0]["percentage"],
            "dossierPromotionCount": dossier_count,
        },
        "trend": trend,
        "operatorNote": operator_note,
        "decisionPolicy": {
            "lowPercentageBelow": LOW_PERCENTAGE_BELOW,
            "corpusEstablishedDocuments": CORPUS_ESTABLISHED_DOCUMENTS,
            "minimumFourWeekEligibleItemsForBrokenPath": MINIMUM_FOUR_WEEK_ELIGIBLE_FOR_BROKEN_PATH,
        },
        "inputs": inputs_meta,
    }
    validate_signal(signal)
    return signal


def validate_signal(signal: dict[str, Any]) -> None:
    """Validate the signal against the schema invariants documented in the spec.

    Raises ``ValueError`` on any structural problem. Publishing is gated on this
    check so the dashboard can rely on the JSON shape.
    """
    if signal.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("schemaVersion mismatch")
    for key in ("runId", "generatedAt", "asOf", "headlinePercentage", "trend", "decisionPolicy", "inputs"):
        if key not in signal:
            raise ValueError(f"missing required field: {key}")
    trend = signal["trend"]
    if not isinstance(trend, list) or len(trend) != WINDOW_COUNT:
        raise ValueError(f"trend must have exactly {WINDOW_COUNT} windows")
    for window in trend:
        if not isinstance(window, dict):
            raise ValueError("trend window must be an object")
        for key in ("offsetWeeks", "start", "end", "eligibleCount", "referencedCount", "percentage"):
            if key not in window:
                raise ValueError(f"trend window missing {key}")
        if window["percentage"] is not None and not isinstance(window["percentage"], (int, float)):
            raise ValueError("trend percentage must be null or number")
        if window["eligibleCount"] < 0 or window["referencedCount"] < 0:
            raise ValueError("counts must be non-negative")
        if window["referencedCount"] > window["eligibleCount"]:
            raise ValueError("referencedCount cannot exceed eligibleCount")
    if signal["headlinePercentage"] != trend[0]["percentage"]:
        raise ValueError("headlinePercentage must equal current window percentage")
    note = signal.get("operatorNote")
    if note is not None:
        if not isinstance(note, dict) or "id" not in note or "text" not in note:
            raise ValueError("operatorNote must be null or {id, text}")
        if note["id"] not in OPERATOR_NOTES:
            raise ValueError(f"operatorNote id {note['id']!r} is not in closed set")
        if note["text"] != OPERATOR_NOTES[note["id"]]:
            raise ValueError("operatorNote text does not match closed-set text")
    policy = signal["decisionPolicy"]
    if policy.get("lowPercentageBelow") != LOW_PERCENTAGE_BELOW:
        raise ValueError("decisionPolicy.lowPercentageBelow drift")
    if policy.get("corpusEstablishedDocuments") != CORPUS_ESTABLISHED_DOCUMENTS:
        raise ValueError("decisionPolicy.corpusEstablishedDocuments drift")
    if policy.get("minimumFourWeekEligibleItemsForBrokenPath") != MINIMUM_FOUR_WEEK_ELIGIBLE_FOR_BROKEN_PATH:
        raise ValueError("decisionPolicy.minimumFourWeekEligibleItemsForBrokenPath drift")


def render_markdown(signal: dict[str, Any]) -> str:
    """Render the deterministic Markdown view from the validated JSON.

    The Markdown is an operator rendering; the dashboard reads the JSON. The
    Markdown must carry the same ``runId`` so both files are paired.
    """
    headline = signal["headlinePercentage"]
    if headline is None:
        headline_text = "—"
    else:
        headline_text = f"{headline:.1f}%"
    lines: list[str] = []
    lines.append("# Compounding signal — bookmark pipeline")
    lines.append("")
    lines.append(f"- Run ID: `{signal['runId']}`")
    lines.append(f"- Generated: {signal['generatedAt']}")
    lines.append(f"- As-of: {signal['asOf']}")
    lines.append(f"- Headline (7d): **{headline_text}**")
    lines.append("")
    lines.append("## Four-week trend")
    lines.append("")
    lines.append("| Window | Start | End | Referenced | Eligible | % |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: |")
    for window in signal["trend"]:
        pct = "—" if window["percentage"] is None else f"{window['percentage']:.1f}"
        lines.append(
            f"| offset {window['offsetWeeks']}w | {window['start']} | {window['end']} | "
            f"{window['referencedCount']} | {window['eligibleCount']} | {pct} |"
        )
    lines.append("")
    cw = signal["currentWindow"]
    lines.append(f"Current-window dossier promotions: **{cw['dossierPromotionCount']}**")
    lines.append("")
    note = signal.get("operatorNote")
    if note is not None:
        lines.append("## Operator note")
        lines.append("")
        lines.append(f"**{note['id']}** — {note['text']}")
        lines.append("")
    lines.append("## Decision policy")
    lines.append("")
    policy = signal["decisionPolicy"]
    lines.append(f"- Low-percentage threshold: <{policy['lowPercentageBelow']:.1f}%")
    lines.append(f"- Corpus established at: {policy['corpusEstablishedDocuments']} documents")
    lines.append(
        f"- Four-week eligible minimum for broken-path note: "
        f"{policy['minimumFourWeekEligibleItemsForBrokenPath']} items"
    )
    lines.append("")
    lines.append("## Inputs")
    lines.append("")
    inputs = signal["inputs"]
    for key, meta in inputs.items():
        path = meta.get("path", "—")
        lines.append(f"- `{key}`: `{path}`")
    body = "\n".join(lines) + "\n"
    return body


def write_artifacts(
    signal: dict[str, Any],
    markdown: str,
    json_path: Path,
    md_path: Path,
) -> None:
    """Atomically write the JSON and Markdown artifacts.

    Writes to a sibling ``.tmp`` file, fsyncs, then ``os.replace`` over the
    destination. If the first write succeeds but the second fails, the
    destination file is left untouched and the partial ``.tmp`` is removed.
    """
    json_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    json_tmp = json_path.with_suffix(json_path.suffix + ".tmp")
    md_tmp = md_path.with_suffix(md_path.suffix + ".tmp")
    try:
        with json_tmp.open("w", encoding="utf-8") as fh:
            fh.write(json.dumps(signal, indent=2, sort_keys=False))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(json_tmp, json_path)
    except Exception:
        if json_tmp.exists():
            json_tmp.unlink()
        raise
    try:
        with md_tmp.open("w", encoding="utf-8") as fh:
            fh.write(markdown)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(md_tmp, md_path)
    except Exception:
        if md_tmp.exists():
            md_tmp.unlink()
        # Keep the JSON write; the render is recoverable from JSON.
        raise


def resolve_workspace_root(cli_root: str | None) -> Path:
    """Resolve the workspace root from CLI flag, env var, or canonical path."""
    candidates: list[Path] = []
    if cli_root:
        candidates.append(Path(cli_root))
    env_root = os.environ.get("WORKSPACE_ROOT", "").strip()
    if env_root:
        candidates.append(Path(env_root))
    # Canonical fallback: this script lives in
    # ``<workspace>/agents/workflows/bookmarks/scripts/compute_compounding_signal.py``
    # both in the Edge-managed checkout and in any worktree. ``parents[4]``
    # walks up from the script file to the directory that contains
    # ``agents/`` directly.
    candidates.append(Path(__file__).resolve().parents[4])
    for candidate in candidates:
        if (candidate / "agents" / "workflows" / "bookmarks").is_dir():
            return candidate
    raise ValueError(
        "could not resolve workspace root; pass --workspace-root or set WORKSPACE_ROOT"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace-root",
        default=None,
        help="Path to the workspace root (defaults to WORKSPACE_ROOT or script-derived location)",
    )
    parser.add_argument(
        "--as-of",
        default=None,
        help="ISO-8601 timestamp for deterministic computation (defaults to now)",
    )
    parser.add_argument(
        "--bookmark-state",
        default=None,
        help="Override path for bookmark-review-state.json",
    )
    parser.add_argument(
        "--corpus-index",
        default=None,
        help="Override path for bookmark-corpus-index.jsonl",
    )
    parser.add_argument(
        "--dossier-promotions",
        default=None,
        help="Override path for dossier-promotion log (JSON array or JSONL)",
    )
    parser.add_argument(
        "--json-path",
        default=None,
        help="Override output path for compounding-signal.json",
    )
    parser.add_argument(
        "--md-path",
        default=None,
        help="Override output path for compounding-signal.md",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the candidate JSON without writing artifacts",
    )
    parser.add_argument(
        "--print-json",
        action="store_true",
        help="Print the validated JSON to stdout (after validation, before publishing)",
    )
    args = parser.parse_args(argv)

    try:
        workspace_root = resolve_workspace_root(args.workspace_root)
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2

    if args.as_of:
        as_of = parse_iso(args.as_of)
        if as_of is None:
            print(json.dumps({"error": f"invalid --as-of: {args.as_of!r}"}), file=sys.stderr)
            return 2
    else:
        as_of = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

    state_path = Path(args.bookmark_state) if args.bookmark_state else (
        workspace_root / "brain" / "state" / "bookmark-review-state.json"
    )
    corpus_path = Path(args.corpus_index) if args.corpus_index else (
        workspace_root / "brain" / "state" / "index" / "bookmark-corpus-index.jsonl"
    )
    dossier_path = Path(args.dossier_promotions) if args.dossier_promotions else (
        workspace_root / "brain" / "state" / "dossier-promotions.jsonl"
    )
    json_path = Path(args.json_path) if args.json_path else (
        workspace_root / "brain" / "state" / "compounding-signal.json"
    )
    md_path = Path(args.md_path) if args.md_path else (
        workspace_root / "brain" / "state" / "compounding-signal.md"
    )

    try:
        try:
            bookmark_state = load_bookmark_state(state_path)
        except FileNotFoundError:
            print(json.dumps({"error": f"missing bookmark state at {state_path}"}), file=sys.stderr)
            return 3
        try:
            corpus_index = load_corpus_index(corpus_path)
        except FileNotFoundError:
            corpus_index = []
        try:
            dossier_events = load_dossier_promotions(dossier_path)
        except FileNotFoundError:
            dossier_events = []

        inputs_meta = {
            "bookmarkState": {
                "path": str(state_path),
                "observedModifiedAt": _stat_iso(state_path),
            },
            "corpusIndex": {
                "path": str(corpus_path),
                "documentCount": len(corpus_index),
            },
            "dossierPromotions": {
                "path": str(dossier_path),
                "eventCount": len(dossier_events),
            },
        }

        signal = build_signal(
            as_of=as_of,
            bookmark_state=bookmark_state,
            corpus_index=corpus_index,
            dossier_events=dossier_events,
            inputs_meta=inputs_meta,
        )
    except (ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 4

    if args.dry_run:
        if args.print_json:
            print(json.dumps(signal, indent=2, sort_keys=False))
        else:
            print(json.dumps({"dryRun": True, "headlinePercentage": signal["headlinePercentage"]}))
        return 0

    if args.print_json:
        print(json.dumps(signal, indent=2, sort_keys=False))

    markdown = render_markdown(signal)
    try:
        write_artifacts(signal, markdown, json_path, md_path)
    except OSError as exc:
        print(json.dumps({"error": f"failed to write artifacts: {exc}"}), file=sys.stderr)
        return 5

    print(json.dumps({
        "published": True,
        "runId": signal["runId"],
        "headlinePercentage": signal["headlinePercentage"],
        "jsonPath": str(json_path),
        "mdPath": str(md_path),
    }))
    return 0


def _stat_iso(path: Path) -> str | None:
    """Return the mtime of ``path`` as an ISO-8601 UTC string, or None if missing."""
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return format_iso(dt.datetime.fromtimestamp(st.st_mtime, tz=dt.timezone.utc))


if __name__ == "__main__":
    sys.exit(main())
