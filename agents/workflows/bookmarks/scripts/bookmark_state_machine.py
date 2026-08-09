#!/usr/bin/env python3
"""Bookmark state-machine helpers (task 0089f4f9).

The bookmark workflow had a drift bug: a later ``lobster_request_spec_approval``
finalize pass could overwrite a terminal ``tasked`` status with ``reviewed``
when the item fell into the routing bucket for lack of anything else to do.
Then ``lobster_generate_specs`` / ``validate_spec_output`` could re-route it
to ``spec_requested`` / ``spec_created`` even though the Tasks API had
already reused or created a task for it. The author-tweet hook is only
triggered inline at the original ``approval_pending → tasked`` transition, so
the regression caused a silent missed tweet.

The durable fix is to make non-empty ``taskIds`` the authoritative signal for
``tasked`` at every workflow boundary that can mutate or route bookmark
state. This module is the single helper every transition path uses.

Public API:
    - is_task_linked(item) -> bool
    - effective_review_status(item) -> str
    - reconcile_tasked_item(item, key, reason, transitions_path) -> bool
    - effective_review_status_or_none(item) -> str | None
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from common import log_transition, now_iso


def is_task_linked(item: dict[str, Any] | None) -> bool:
    """Return True when the item has at least one non-empty task ID.

    Treats a non-empty ``taskIds`` list as the authoritative terminal-state
    signal — tasks are the Tasks API-owned resource, and once linked the
    bookmark cannot move backward in the lifecycle.
    """
    if not isinstance(item, dict):
        return False
    ids = item.get("taskIds")
    if not isinstance(ids, list):
        return False
    return any(isinstance(tid, str) and tid.strip() for tid in ids)


def effective_review_status(item: dict[str, Any] | None) -> str:
    """Return the routing-safe review status.

    Items with non-empty ``taskIds`` are treated as ``tasked`` regardless
    of the persisted ``reviewStatus`` field. This is the function every
    routing and mutation boundary MUST use instead of reading
    ``item.get("reviewStatus")`` directly.

    Items without task IDs fall through to the persisted status. There is
    intentionally no precedence override for ``declined`` here — a declined
    item must not also have task IDs, and if a future bug ever crosses those
    two states, ``tasked`` is the safer routing outcome (it cannot re-enter
    the spec pipeline). Callers that need to preserve a literal ``declined``
    for an already-declined item should gate on ``is_task_linked`` first.
    """
    if is_task_linked(item):
        return "tasked"
    if not isinstance(item, dict):
        return ""
    return str(item.get("reviewStatus") or "")


def effective_review_status_or_none(item: dict[str, Any] | None) -> str | None:
    """Same as ``effective_review_status`` but returns ``None`` for empty/missing."""
    status = effective_review_status(item)
    return status or None


def reconcile_tasked_item(
    item: dict[str, Any],
    key: str,
    reason: str,
    transitions_path: Path | None,
) -> bool:
    """Repair persisted ``reviewStatus`` to ``tasked`` when task-linked.

    Logs a transition only when the persisted status diverges from the
    effective status. Returns ``True`` when a repair was written, ``False``
    when the item was already effectively ``tasked`` (no-op) or the
    persisted status was already ``tasked``. If the item is not task-linked,
    the function is a no-op and returns ``False`` — callers should use
    ``is_task_linked`` first to decide whether reconciliation is meaningful.

    The transition log is the audit trail; never hand-edit the JSON state
    without going through this helper or its sibling ``log_transition``.
    """
    if not isinstance(item, dict):
        return False
    if not is_task_linked(item):
        return False
    previous = item.get("reviewStatus")
    if previous == "tasked":
        return False
    item["reviewStatus"] = "tasked"
    item["lastUpdatedAt"] = now_iso()
    log_transition(
        key,
        previous,
        "tasked",
        reason,
        transitions_path=transitions_path,
    )
    return True


__all__ = [
    "is_task_linked",
    "effective_review_status",
    "effective_review_status_or_none",
    "reconcile_tasked_item",
]
