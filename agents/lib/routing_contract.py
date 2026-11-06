"""Model routing contract — three model tiers, work categories, and the empty-queue preflight.

Task: ``d38c6aa5`` — Three-Tier Model Routing Contract With Empty-Queue Preflight.
Spec: ``brain/tasks/specs/in-progress/three-tier-model-routing-contract-with-empty-queue-preflight-f73dace927772ddb.md``

This module is the machine-readable half of the written contract in
``docs/systems/model-routing-contract.md``. The document explains *why* the
tiers exist and who reads them; this module decides *which* tier a unit of work
belongs on, refuses to run a model at all when the work queue is empty, and
records every decision so a run against the wrong tier is visible instead of
silently absorbed.

Nothing in here talks to the Tasks API or to a model provider. The preflight is
pure decision logic plus local counter state, so it can run as a scheduler
command with **no model call at all** — that is the whole point of the
preflight tier.

Tiers
-----
``routine``  cheap cognition — scanning, summaries, low-risk review, background work.
``mid``      approved coding work.
``frontier`` high-judgment work — planning, escalation, product decisions.
``preflight`` not a model tier at all: the "nothing to do" tier. A pass that
             lands here invokes no model and pays no tokens.

A work category that is not in ``CATEGORY_TIERS`` routes to ``frontier`` and is
flagged as unclassified. Silently downgrading unknown work to the cheap tier is
the failure mode this contract exists to prevent.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import pathlib
import re
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------

#: The "no model" tier. A preflight decision lands here when the queue is empty.
PREFILIGHT_TIER = "preflight"

#: The three model tiers, cheapest first.
TIERS: dict[str, dict[str, Any]] = {
    "routine": {
        "model_class": "cheap-fast",
        "summary": "Scanning, summaries, low-risk review, background cognition.",
        "examples": [
            "minimax-portal/MiniMax-M3",
            "minimax-portal/MiniMax-M3.1-Flash",
            "ollama/<local>",
            "anthropic/claude-haiku-*",
        ],
    },
    "mid": {
        "model_class": "coding-standard",
        "summary": "Approved coding work and code review.",
        "examples": [
            "anthropic/claude-sonnet-5",
        ],
    },
    "frontier": {
        "model_class": "high-judgment",
        "summary": "Explicitly tagged planning, escalation, and product-decision work.",
        "examples": [
            "openai/gpt-5.4",
            "openai/gpt-5.6-sol",
            "anthropic/claude-opus-*",
        ],
    },
}

#: Work categories and the tier that owns them. Read by humans and by the
#: preflight; the contract document carries the same table in prose.
CATEGORY_TIERS: dict[str, str] = {
    # routine cognition
    "heartbeat-scan": "routine",
    "routine-summary": "routine",
    "low-risk-review": "routine",
    "background-cognition": "routine",
    "bookmark-triage": "routine",
    "queue-monitor": "routine",
    "daily-brief": "routine",
    # mid-tier coding
    "approved-coding": "mid",
    "code-review": "mid",
    "spec-drafting": "mid",
    "test-and-verify": "mid",
    "ops-documentation": "mid",
    # frontier high judgment
    "planning": "frontier",
    "escalation": "frontier",
    "product-decision": "frontier",
    "high-judgment-review": "frontier",
    "acceptance": "frontier",
}

#: Unknown categories route to the expensive tier. Never downgrade silently.
UNCLASSIFIED_TIER = "frontier"

#: Maps a model id to the tier that model belongs on. Ordered — first match wins.
MODEL_TIER_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^minimax-portal/"), "routine"),
    (re.compile(r"^ollama/"), "routine"),
    (re.compile(r"^anthropic/claude-haiku"), "routine"),
    (re.compile(r"^anthropic/claude-sonnet"), "mid"),
    (re.compile(r"^anthropic/claude-opus"), "frontier"),
    (re.compile(r"^openai/gpt-5"), "frontier"),
)

#: Decisions this module can produce.
DECISION_SKIP = "skip"
DECISION_PROCEED = "proceed"
DECISION_UNKNOWN = "unknown"


# ---------------------------------------------------------------------------
# Tier resolution
# ---------------------------------------------------------------------------


def classify_category(category: str) -> str:
    """Return the tier that owns ``category``.

    Unknown categories resolve to :data:`UNCLASSIFIED_TIER` (frontier) so that
    unrecognised work is never silently run on the cheap tier.
    """
    if not category:
        return UNCLASSIFIED_TIER
    return CATEGORY_TIERS.get(category.strip().lower(), UNCLASSIFIED_TIER)


def is_known_category(category: str) -> bool:
    """True when ``category`` has an explicit entry in the contract."""
    return bool(category) and category.strip().lower() in CATEGORY_TIERS


def model_tier(model_id: str) -> str | None:
    """Return the tier a model id belongs on, or ``None`` when it is unknown."""
    if not model_id:
        return None
    mid = model_id.strip()
    for pattern, tier in MODEL_TIER_RULES:
        if pattern.match(mid):
            return tier
    return None


def model_class(tier: str) -> str:
    """Return the human-facing model class for ``tier``."""
    entry = TIERS.get(tier)
    return entry["model_class"] if entry else "unknown"


def tier_examples(tier: str) -> list[str]:
    """Return the example model ids for ``tier``."""
    entry = TIERS.get(tier)
    return list(entry["examples"]) if entry else []


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RoutingDecision:
    """The outcome of one preflight check."""

    decision: str
    tier: str
    model_class: str
    category: str
    work_count: int
    reason: str
    model_declared: bool = False
    agent: str | None = None
    unclassified: bool = False

    @property
    def skipped(self) -> bool:
        return self.decision == DECISION_SKIP

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["skipped"] = self.skipped
        return data


def _actionable_items(queue: Any) -> list[Mapping[str, Any]]:
    """Return the actionable entries in a queue payload.

    Accepts the raw ``agent_task_queue.py`` JSON (a mapping with a ``queue``
    list), a bare list of entries, or ``None``. An entry counts as actionable
    when it says so, or — for payloads without the flag — when it is not
    explicitly blocked.
    """
    if queue is None:
        return []
    if isinstance(queue, Mapping):
        entries = queue.get("queue")
        if not isinstance(entries, list):
            candidate = queue.get("topCandidate")
            entries = [candidate] if isinstance(candidate, Mapping) else []
    elif isinstance(queue, Sequence) and not isinstance(queue, (str, bytes)):
        entries = list(queue)
    else:
        return []

    actionable: list[Mapping[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        flag = entry.get("actionable")
        if isinstance(flag, bool):
            if flag:
                actionable.append(entry)
            continue
        classification = str(entry.get("classification", "")).upper()
        if classification and classification != "ACTIONABLE":
            continue
        actionable.append(entry)
    return actionable


def preflight(
    queue: Any,
    category: str,
    agent: str | None = None,
) -> RoutingDecision:
    """Decide whether a pass needs a model at all, and on which tier.

    ``queue`` is a work-queue payload (the JSON emitted by
    ``agent_task_queue.py``). An empty or fully-blocked queue yields the
    preflight decision: no model invoked, no tokens spent. A queue with
    actionable work yields the tier that owns ``category``.
    """
    items = _actionable_items(queue)
    tier = classify_category(category)
    unclassified = not is_known_category(category)

    if not items:
        return RoutingDecision(
            decision=DECISION_SKIP,
            tier=PREFILIGHT_TIER,
            model_class="none",
            category=category,
            work_count=0,
            reason="empty-queue",
            model_declared=False,
            agent=agent,
            unclassified=unclassified,
        )

    return RoutingDecision(
        decision=DECISION_PROCEED,
        tier=tier,
        model_class=model_class(tier),
        category=category,
        work_count=len(items),
        reason="work-queued",
        model_declared=True,
        agent=agent,
        unclassified=unclassified,
    )


def unknown_decision(category: str, agent: str | None = None, reason: str = "preflight-error") -> RoutingDecision:
    """Decision used when the preflight could not be evaluated.

    Unknown means "carry on with the normal procedure" — it must never mean
    "skip". A broken preflight must not silently mute an agent's pass.
    """
    tier = classify_category(category)
    return RoutingDecision(
        decision=DECISION_UNKNOWN,
        tier=tier,
        model_class=model_class(tier),
        category=category,
        work_count=0,
        reason=reason,
        model_declared=False,
        agent=agent,
        unclassified=not is_known_category(category),
    )


# ---------------------------------------------------------------------------
# Declaration / violation detection
# ---------------------------------------------------------------------------


def check_declaration(
    declared_tier: str,
    actual_model: str | None = None,
    actual_tier: str | None = None,
) -> dict[str, Any] | None:
    """Compare a declared tier against what actually ran.

    Returns a violation record when the actual tier does not match the
    declared tier, or ``None`` when the run matched the contract. A run with
    no observable actual model is not a violation — it is simply unmeasured —
    but it is still worth reporting as ``unmeasured`` so it does not hide.
    """
    actual = actual_tier
    if actual is None and actual_model:
        actual = model_tier(actual_model)
    if actual is None:
        return {
            "kind": "unmeasured",
            "declaredTier": declared_tier,
            "actualTier": None,
            "actualModel": actual_model,
        }
    if actual == declared_tier:
        return None
    return {
        "kind": "violation",
        "declaredTier": declared_tier,
        "actualTier": actual,
        "actualModel": actual_model,
    }


# ---------------------------------------------------------------------------
# Counter state
# ---------------------------------------------------------------------------

STATE_VERSION = 1

#: Counter buckets per category. ``routine``/``mid``/``frontier`` count the
#: tier a pass *declared* before it ran; ``observedRoutine``/``observedMid``/
#: ``observedFrontier`` count the tier that *actually* ran. A declaration alone
#: cannot prove which model was invoked, so both are needed to make a tier
#: drift — or a cost collapse — observable. ``preflight`` counts skipped
#: passes (no model invoked); ``violation`` and ``unmeasured`` count runs that
#: did not match their declaration; ``unclassified`` counts passes whose work
#: category is missing from the contract table.
COUNTER_BUCKETS = (
    "routine",
    "mid",
    "frontier",
    "observedRoutine",
    "observedMid",
    "observedFrontier",
    "preflight",
    "violation",
    "unmeasured",
    "unclassified",
)

#: Declared-tier buckets, in the order the operator table renders them.
DECLARED_BUCKETS = ("routine", "mid", "frontier")

#: Observed-tier buckets, in the order the operator table renders them.
OBSERVED_BUCKETS = ("observedRoutine", "observedMid", "observedFrontier")

#: Maps a tier name to its observed-tier counter bucket.
OBSERVED_BUCKET_FOR_TIER = {
    "routine": "observedRoutine",
    "mid": "observedMid",
    "frontier": "observedFrontier",
}


def default_state_path() -> pathlib.Path:
    """Return the default counters path (``$OPENCLAW_STATE_DIR`` aware)."""
    state_dir = os.environ.get("OPENCLAW_STATE_DIR")
    base = pathlib.Path(state_dir) if state_dir else pathlib.Path.home() / ".openclaw" / "state"
    return base / "model-routing-counters.json"


def default_event_log_path() -> pathlib.Path:
    """Return the default event log path (one JSON object per line)."""
    state_dir = os.environ.get("OPENCLAW_STATE_DIR")
    base = pathlib.Path(state_dir) if state_dir else pathlib.Path.home() / ".openclaw" / "state"
    return base / "model-routing-events.jsonl"


def _empty_state() -> dict[str, Any]:
    return {"version": STATE_VERSION, "updatedAt": None, "days": {}, "violations": []}


def _read_state_file(target: pathlib.Path) -> tuple[dict[str, Any], pathlib.Path | None]:
    """Read the counter state file.

    Returns ``(state, corrupt_path)``. ``corrupt_path`` is set when the file
    exists but could not be parsed — the caller decides whether to archive it.
    Reading never mutates the file, so a read-only surface (``--stats``)
    cannot destroy evidence.
    """
    try:
        with open(target) as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return _empty_state(), None
    except json.JSONDecodeError:
        return _empty_state(), target
    except OSError:
        return _empty_state(), None
    if not isinstance(data, dict):
        return _empty_state(), target
    data.setdefault("version", STATE_VERSION)
    data.setdefault("days", {})
    data.setdefault("violations", [])
    if not isinstance(data["days"], dict):
        data["days"] = {}
    if not isinstance(data["violations"], list):
        data["violations"] = []
    return data, None


def load_state(path: pathlib.Path | str | None = None) -> dict[str, Any]:
    """Load counter state, tolerating a missing or corrupt file."""
    target = pathlib.Path(path) if path else default_state_path()
    state, _corrupt = _read_state_file(target)
    return state


@contextlib.contextmanager
def state_lock(path: pathlib.Path | str | None = None):
    """Hold an exclusive lock on the counter state.

    The lock lives in a sibling ``.lock`` file so it survives the atomic
    replace of the state file itself. It is held across the whole
    read-modify-write, so two agents writing the same counters on one host
    cannot drop each other's increments.
    """
    target = pathlib.Path(path) if path else default_state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_name(target.name + ".lock")
    handle = open(lock_path, "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield target
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _archive_corrupt(path: pathlib.Path) -> pathlib.Path:
    """Move an unparseable state file aside so the loss stays visible."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    archived = path.with_name(f"{path.name}.corrupt-{stamp}")
    try:
        os.replace(path, archived)
    except OSError:
        return path
    return archived


def save_state(state: Mapping[str, Any], path: pathlib.Path | str | None = None) -> pathlib.Path:
    """Write counter state atomically.

    The temp file name is unique per writer (``tempfile.mkstemp``), so two
    writers on the same host cannot interleave their writes into one
    truncated file that then gets published by ``os.replace`` — which used to
    zero the whole counter history without an error.
    """
    target = pathlib.Path(path) if path else default_state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=target.name + ".", suffix=".tmp")
    tmp = pathlib.Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return target


def mutate_state(path: pathlib.Path | str | None, mutator) -> dict[str, Any]:
    """Apply ``mutator`` to the counter state under an exclusive lock.

    The lock is held across load → mutate → save, so concurrent writers
    cannot silently drop each other's counts. A state file that cannot be
    parsed is archived (``<name>.corrupt-<timestamp>``) rather than silently
    replaced by an empty one: a lost day must not be indistinguishable from
    "no frontier calls happened".
    """
    target = pathlib.Path(path) if path else default_state_path()
    with state_lock(target):
        state, corrupt = _read_state_file(target)
        if corrupt is not None:
            archived = _archive_corrupt(corrupt)
            state = _empty_state()
            state["recoveredFrom"] = str(archived)
        mutator(state)
        save_state(state, target)
    return state


def _day_bucket(state: dict[str, Any], day: str) -> dict[str, Any]:
    days = state.setdefault("days", {})
    bucket = days.setdefault(day, {"categories": {}})
    bucket.setdefault("categories", {})
    return bucket


def record_decision(
    state: dict[str, Any],
    decision: RoutingDecision,
    day: str | None = None,
) -> dict[str, Any]:
    """Count a routing decision and stamp the state.

    A skipped pass counts under ``preflight`` (no model invoked). A pass that
    proceeded counts under the tier it declared.
    """
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    bucket = _day_bucket(state, day)
    categories = bucket["categories"]
    counters = categories.setdefault(decision.category, {name: 0 for name in COUNTER_BUCKETS})
    for name in COUNTER_BUCKETS:
        counters.setdefault(name, 0)

    if decision.decision == DECISION_SKIP:
        counters[PREFILIGHT_TIER] += 1
    elif decision.decision == DECISION_PROCEED:
        counters[decision.tier] = counters.get(decision.tier, 0) + 1
    elif decision.decision == DECISION_UNKNOWN:
        # An unknown decision means the preflight could not be evaluated. It is
        # a pass that ran, but with no measured tier — counted so a
        # systematically failing preflight leaves a trace.
        counters["unmeasured"] += 1
    if decision.unclassified:
        counters["unclassified"] = counters.get("unclassified", 0) + 1

    state["updatedAt"] = datetime.now(timezone.utc).isoformat()
    return state


def record_violation(
    state: dict[str, Any],
    violation: Mapping[str, Any],
    day: str | None = None,
) -> dict[str, Any]:
    """Count a routing violation and keep a bounded list of recent ones."""
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    bucket = _day_bucket(state, day)
    categories = bucket["categories"]
    entry = {
        "at": datetime.now(timezone.utc).isoformat(),
        "day": day,
        "kind": violation.get("kind", "violation"),
        "declaredTier": violation.get("declaredTier"),
        "actualTier": violation.get("actualTier"),
        "actualModel": violation.get("actualModel"),
        "category": violation.get("category"),
        "agent": violation.get("agent"),
    }
    for category in (entry["category"], "__global__"):
        if not category:
            continue
        counters = categories.setdefault(category, {name: 0 for name in COUNTER_BUCKETS})
        for name in COUNTER_BUCKETS:
            counters.setdefault(name, 0)
        key = "violation" if entry["kind"] == "violation" else "unmeasured"
        counters[key] += 1
        break
    violations = state.setdefault("violations", [])
    violations.append(entry)
    del violations[:-50]
    state["updatedAt"] = entry["at"]
    return state


def record_observation(
    state: dict[str, Any],
    category: str | None,
    declared_tier: str | None,
    actual_tier: str | None,
    actual_model: str | None = None,
    agent: str | None = None,
    day: str | None = None,
    kind: str = "violation",
) -> dict[str, Any]:
    """Record what actually ran, next to what was declared.

    The observed tier is counted in its own bucket, so a category that ran on
    a different tier than it declared stays visible even when the run is not
    a violation. This is the "recorded alongside the invocation" half of the
    declaration contract — a declaration alone proves nothing.
    """
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    bucket = _day_bucket(state, day)
    categories = bucket["categories"]
    key = category or "__global__"
    counters = categories.setdefault(key, {name: 0 for name in COUNTER_BUCKETS})
    for name in COUNTER_BUCKETS:
        counters.setdefault(name, 0)
    observed_key = OBSERVED_BUCKET_FOR_TIER.get(actual_tier or "")
    if observed_key:
        counters[observed_key] += 1
    if kind == "match":
        # A run that matched its declaration is not a violation and not
        # unmeasured — it is the healthy case. It is counted as observed and
        # left out of the violation list.
        state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return state
    record_violation(
        state,
        {
            "kind": kind,
            "declaredTier": declared_tier,
            "actualTier": actual_tier,
            "actualModel": actual_model,
            "category": category,
            "agent": agent,
        },
        day=day,
    )
    return state


def append_event(event: Mapping[str, Any], path: pathlib.Path | str | None = None) -> pathlib.Path:
    """Append one routing event to the JSONL event log."""
    target = pathlib.Path(path) if path else default_event_log_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "a") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")
    return target


def daily_counts(state: Mapping[str, Any], day: str | None = None) -> dict[str, dict[str, int]]:
    """Return ``{category: {bucket: count}}`` for ``day``."""
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    bucket = state.get("days", {}).get(day, {})
    return bucket.get("categories", {}) if isinstance(bucket, Mapping) else {}


def render_stats(state: Mapping[str, Any], day: str | None = None) -> str:
    """Render the operator-facing per-category, per-tier counter table.

    Two blocks: the tier each pass *declared* it would run on, and the tier
    that *actually* ran. A declaration cannot prove which model was invoked,
    so both are needed to make a tier drift — or a cost collapse — visible.
    """
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    counts = daily_counts(state, day)
    lines: list[str] = []
    recovered = state.get("recoveredFrom")
    if recovered:
        lines.append(f"! counter state was recovered from an unreadable file: {recovered}")
    if not counts:
        lines.append(f"model routing counters — {day}: no recorded invocations")
        return "\n".join(lines)

    declared_header = (
        f"{'category':<24} {'routine':>8} {'mid':>6} {'frontier':>9} "
        f"{'preflight':>10} {'violation':>10} {'unclassified':>13}"
    )
    lines.append(f"model routing counters — {day}")
    lines.append("declared tiers — what the pass said it would run on")
    lines.append(declared_header)
    lines.append("-" * len(declared_header))
    totals = {name: 0 for name in ("routine", "mid", "frontier", "preflight", "violation", "unclassified")}
    for category in sorted(counts):
        counters = counts[category]
        lines.append(
            f"{category:<24} {counters.get('routine', 0):>8} {counters.get('mid', 0):>6} "
            f"{counters.get('frontier', 0):>9} {counters.get('preflight', 0):>10} "
            f"{counters.get('violation', 0):>10} {counters.get('unclassified', 0):>13}"
        )
        for key in totals:
            totals[key] += int(counters.get(key, 0) or 0)
    lines.append("-" * len(declared_header))
    lines.append(
        f"{'TOTAL':<24} {totals['routine']:>8} {totals['mid']:>6} {totals['frontier']:>9} "
        f"{totals['preflight']:>10} {totals['violation']:>10} {totals['unclassified']:>13}"
    )

    observed_header = f"{'category':<24} {'routine':>8} {'mid':>6} {'frontier':>9}"
    lines.append("")
    lines.append("observed tiers — what actually ran")
    lines.append(observed_header)
    lines.append("-" * len(observed_header))
    observed_totals = {name: 0 for name in OBSERVED_BUCKETS}
    for category in sorted(counts):
        counters = counts[category]
        lines.append(
            f"{category:<24} {counters.get('observedRoutine', 0):>8} {counters.get('observedMid', 0):>6} "
            f"{counters.get('observedFrontier', 0):>9}"
        )
        for key in observed_totals:
            observed_totals[key] += int(counters.get(key, 0) or 0)
    lines.append("-" * len(observed_header))
    lines.append(
        f"{'TOTAL':<24} {observed_totals['observedRoutine']:>8} {observed_totals['observedMid']:>6} "
        f"{observed_totals['observedFrontier']:>9}"
    )
    return "\n".join(lines)


def contract_table() -> str:
    """Render the contract's category → tier table (used by docs and tests)."""
    lines = ["| work category | tier |", "| --- | --- |"]
    for category in sorted(CATEGORY_TIERS):
        lines.append(f"| `{category}` | {CATEGORY_TIERS[category]} |")
    return "\n".join(lines)


__all__ = [
    "CATEGORY_TIERS",
    "COUNTER_BUCKETS",
    "DECLARED_BUCKETS",
    "DECISION_PROCEED",
    "DECISION_SKIP",
    "DECISION_UNKNOWN",
    "MODEL_TIER_RULES",
    "OBSERVED_BUCKETS",
    "OBSERVED_BUCKET_FOR_TIER",
    "PREFILIGHT_TIER",
    "RoutingDecision",
    "TIERS",
    "UNCLASSIFIED_TIER",
    "append_event",
    "check_declaration",
    "classify_category",
    "contract_table",
    "daily_counts",
    "default_event_log_path",
    "default_state_path",
    "is_known_category",
    "load_state",
    "model_class",
    "model_tier",
    "mutate_state",
    "preflight",
    "record_decision",
    "record_observation",
    "record_violation",
    "render_stats",
    "save_state",
    "state_lock",
    "tier_examples",
    "unknown_decision",
]
