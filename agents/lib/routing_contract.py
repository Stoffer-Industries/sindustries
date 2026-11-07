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

import json
import os
import pathlib
import re
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
            "ollama/<local model>",
        ],
    },
    "mid": {
        "model_class": "coding-standard",
        "summary": "Approved coding work and code review.",
        "examples": [
            "anthropic/claude-sonnet-5",
            "anthropic/claude-haiku-*",
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
    model_invoked: bool = False
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
            model_invoked=False,
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
        model_invoked=True,
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
        model_invoked=False,
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

#: Counter buckets per category. ``preflight`` counts skipped passes (no
#: model invoked); the three model tiers count invocations; ``violation``
#: counts runs that landed on an unexpected tier.
COUNTER_BUCKETS = ("routine", "mid", "frontier", "preflight", "violation", "unmeasured")


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


def load_state(path: pathlib.Path | str | None = None) -> dict[str, Any]:
    """Load counter state, tolerating a missing or corrupt file."""
    target = pathlib.Path(path) if path else default_state_path()
    try:
        with open(target) as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _empty_state()
    if not isinstance(data, dict):
        return _empty_state()
    data.setdefault("version", STATE_VERSION)
    data.setdefault("days", {})
    data.setdefault("violations", [])
    if not isinstance(data["days"], dict):
        data["days"] = {}
    if not isinstance(data["violations"], list):
        data["violations"] = []
    return data


def save_state(state: Mapping[str, Any], path: pathlib.Path | str | None = None) -> pathlib.Path:
    """Write counter state atomically (temp file + replace)."""
    target = pathlib.Path(path) if path else default_state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with open(tmp, "w") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, target)
    return target


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
    """Render the operator-facing per-category, per-tier counter table."""
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    counts = daily_counts(state, day)
    if not counts:
        return f"model routing counters — {day}: no recorded invocations"
    header = f"{'category':<24} {'routine':>8} {'mid':>6} {'frontier':>9} {'preflight':>10} {'violation':>10}"
    lines = [f"model routing counters — {day}", header, "-" * len(header)]
    for category in sorted(counts):
        counters = counts[category]
        lines.append(
            f"{category:<24} {counters.get('routine', 0):>8} {counters.get('mid', 0):>6} "
            f"{counters.get('frontier', 0):>9} {counters.get('preflight', 0):>10} "
            f"{counters.get('violation', 0):>10}"
        )
    totals = {"routine": 0, "mid": 0, "frontier": 0, "preflight": 0, "violation": 0}
    for counters in counts.values():
        for key in totals:
            totals[key] += int(counters.get(key, 0) or 0)
    lines.append("-" * len(header))
    lines.append(
        f"{'TOTAL':<24} {totals['routine']:>8} {totals['mid']:>6} {totals['frontier']:>9} "
        f"{totals['preflight']:>10} {totals['violation']:>10}"
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
    "DECISION_PROCEED",
    "DECISION_SKIP",
    "DECISION_UNKNOWN",
    "MODEL_TIER_RULES",
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
    "preflight",
    "record_decision",
    "record_violation",
    "render_stats",
    "save_state",
    "tier_examples",
    "unknown_decision",
]
