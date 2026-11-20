#!/usr/bin/env python3
"""Identify tasks that reached a gate without a granted `qa_agent` approval.

Read-only audit helper for task `fb5c4e40` (AC5).

The Tasks API now refuses a `doing → acceptance` transition unless the task's
`qa_agent` approval is granted, so new damage cannot happen. Tasks promoted
before that guard existed are still in `acceptance` with the gate open. This
script finds them and prints the repair options for each — it never writes.

It deliberately does NOT repair anything. AC5 forbids this implementation from
marking a QA or acceptance approval as approved: only the listed outcomes are
legitimate, and all of them need a human or an authorised agent to perform
them.

Two classes are reported, because they mean different things and need
different handling:

  * `skipped_gate` — the `qa_agent` gate WAS materialised for this task and
    was never granted. This is the defect's signature: the gate existed, the
    task was promoted past it anyway. These tasks need a repair decision.
  * `no_gate_row` — no `qa_agent` row was ever created for this task, so the
    task predates the QA gate (the gate materialises its row at task
    creation). Not damage from the transition defect. A task still sitting in
    `acceptance` in this class is itemised, because it is live and someone
    has to decide whether QA is still owed to it; closed tasks in this class
    are only counted.

Usage:
  python3 identify_skipped_qa_tasks.py
  python3 identify_skipped_qa_tasks.py --json

TASKS_API_BASE_URL is required and is read from the environment. It is the live
route, owned by `~/.openclaw/.env`; the prodlike origin is a local-dev fallback
only, so a caller running inside the OpenClaw runtime follows the live route.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys

# Bootstrap `agents.lib` the same way the sibling scripts in this directory
# do, so `python3 <this>.py` works without an installed package.
import sys as _sys
from pathlib import Path as _p

_w = next(
    (a for a in [_p(__file__).resolve().parent, *_p(__file__).resolve().parents]
     if (a / "agents" / "lib").is_dir()), None)
if _w is not None and str(_w) not in _sys.path:
    _sys.path.insert(0, str(_w))
del _sys, _p, _w

CLIENT_PATH = pathlib.Path(__file__).parents[1] / "tasks_api_client.py"
SPEC = importlib.util.spec_from_file_location("tasks_api_client", CLIENT_PATH)
tasks_api_client = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tasks_api_client)

# The approval type whose absence means "the QA gate was skipped".
QA_APPROVAL_TYPE = "qa_agent"

# Statuses the audit reads. `acceptance` is the live gate violation; `done`
# is the historical damage left by the same defect.
AUDITED_STATUSES = ("acceptance", "done")

# A task in `acceptance` still has mutable approvals, so the repair can be
# recorded directly through the approval endpoint.
REPAIR_OPTIONS_ACCEPTANCE = (
    "(a) Ash reruns QA and grants the `qa_agent` approval through the approval endpoint",
    "(b) an authorised operator moves the task back to `doing` for redelivery",
    "(c) an authorised operator records the approval through the normal path "
    "and closes the task",
)

# A `done` task is approval-immutable (`409 TASK_IMMUTABLE`), so the repair
# has to start by reopening it. Every option below says so explicitly rather
# than implying an approval can be attached to a closed task.
REPAIR_OPTIONS_DONE = (
    "(a) an authorised operator reopens the task to `acceptance`, then Ash "
    "grants the `qa_agent` approval and the close is re-recorded",
    "(b) an authorised operator reopens the task to `doing` for redelivery",
)

# A pre-gate task that is still waiting at Tom's gate. No gate row was ever
# created for it, so it is not damage from the transition defect — but it is
# live and owes someone a decision.
REPAIR_OPTIONS_PRE_GATE = (
    "(a) an authorised operator decides QA is still owed, then Ash grants the "
    "`qa_agent` approval through the approval endpoint",
    "(b) an authorised operator moves the task back to `doing` for redelivery",
)


def qa_approval_granted(task: dict) -> bool:
    """True when the task carries a granted `qa_agent` approval.

    Mirrors the API-side guard: the row must be `approved` and must not
    carry a revocation timestamp. A revoked row is not a grant, and neither
    is a missing or pending one.
    """
    for approval in task.get("approvals") or []:
        if approval.get("type") != QA_APPROVAL_TYPE:
            continue
        if approval.get("state") != "approved":
            continue
        if approval.get("revokedAt"):
            continue
        return True
    return False


def qa_approval_rows(task: dict) -> list[dict]:
    return [
        approval
        for approval in (task.get("approvals") or [])
        if approval.get("type") == QA_APPROVAL_TYPE
    ]


def repair_options_for(kind: str, status: str) -> list[str]:
    """The legitimate repair paths for a finding."""
    if kind == "skipped_gate":
        return list(REPAIR_OPTIONS_DONE if status == "done" else REPAIR_OPTIONS_ACCEPTANCE)
    return list(REPAIR_OPTIONS_PRE_GATE)


def classify_task(task: dict, requires_qa_agent: bool) -> dict | None:
    """Return a finding for a task whose QA gate was not satisfied, else `None`.

    A finding carries the evidence an operator needs to decide the repair:
    the task, the gate owner, the approval state that was found, whether the
    gate row existed at all, and the repair options.
    """
    if not requires_qa_agent:
        return None
    status = task.get("status")
    if status not in AUDITED_STATUSES:
        return None
    if qa_approval_granted(task):
        return None

    qa_rows = qa_approval_rows(task)
    if qa_rows:
        kind = "skipped_gate"
        state = qa_rows[0].get("state") or "unknown"
        owner = qa_rows[0].get("owner") or "Ash"
    else:
        kind = "no_gate_row"
        state = "missing"
        owner = "Ash"

    return {
        "id": task.get("id"),
        "title": task.get("title"),
        "taskType": task.get("taskType"),
        "status": status,
        "assignee": task.get("assignee"),
        "kind": kind,
        "qaApprovalState": state,
        "qaApprovalOwner": owner,
        "recommendedRepairs": repair_options_for(kind, status),
    }


def required_approvals_for(task_type: str, base_url: str, cache: dict) -> list[str]:
    """The task type's required-approval set, read from the API's policy.

    The policy endpoint is the same source the enforcement guard reads, so
    this script can never drift from the rule it is auditing against.
    """
    if task_type in cache:
        return cache[task_type]
    if not task_type:
        cache[task_type] = []
        return cache[task_type]
    response = tasks_api_client.api_request(
        "GET", base_url, f"/task-types/{task_type}/required-approvals"
    )
    data = response.get("data", {}) if isinstance(response, dict) else {}
    required = data.get("requiredApprovals") or []
    cache[task_type] = required
    return required


def _urlencode(params: dict) -> str:
    import urllib.parse

    return urllib.parse.urlencode(params)


def list_audited_tasks(base_url: str, limit: int = 200) -> list[dict]:
    """Every task in an audited status, following the list cursor."""
    tasks: list[dict] = []
    cursor: str | None = None
    while True:
        params = {"status": ",".join(AUDITED_STATUSES), "limit": str(limit)}
        if cursor:
            params["cursor"] = cursor
        response = tasks_api_client.api_request(
            "GET", base_url, "/tasks?" + _urlencode(params)
        )
        if not isinstance(response, dict):
            break
        tasks.extend(response.get("data") or [])
        page = response.get("page") or {}
        if not page.get("hasNextPage"):
            break
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return tasks


def identify(base_url: str, limit: int = 200) -> dict:
    """Find every task in `acceptance`/`done` whose QA gate was not satisfied.

    Returns the partitioned report: the affected tasks (the gate row existed
    and was never granted), the live pre-gate tasks that still owe a
    decision, and the count of closed pre-gate tasks.
    """
    cache: dict[str, list[str]] = {}
    findings: list[dict] = []
    for task in list_audited_tasks(base_url, limit=limit):
        task_type = task.get("taskType") or ""
        required = required_approvals_for(task_type, base_url, cache)
        finding = classify_task(task, QA_APPROVAL_TYPE in required)
        if finding:
            findings.append(finding)

    affected = [f for f in findings if f["kind"] == "skipped_gate"]
    pre_gate_live = [
        f for f in findings if f["kind"] == "no_gate_row" and f["status"] == "acceptance"
    ]
    pre_gate_closed = [
        f for f in findings if f["kind"] == "no_gate_row" and f["status"] == "done"
    ]
    return {
        "affected": affected,
        "preGateLive": pre_gate_live,
        "preGateClosedCount": len(pre_gate_closed),
        "preGateClosed": pre_gate_closed,
    }


def render_text(report: dict) -> str:
    affected = report["affected"]
    pre_gate_live = report["preGateLive"]
    lines: list[str] = []

    if affected:
        lines.append(
            f"{len(affected)} task(s) had the `qa_agent` gate materialised and were "
            "promoted past it without it ever being granted:"
        )
        lines.append("")
        for finding in affected:
            lines.append(f"- {finding['id']}  {finding['title']}")
            lines.append(
                f"    status={finding['status']} type={finding['taskType']} "
                f"assignee={finding['assignee']} qa_approval={finding['qaApprovalState']}"
            )
            for repair in finding["recommendedRepairs"]:
                lines.append(f"    repair: {repair}")
        lines.append("")
    else:
        lines.append("No task has a materialised `qa_agent` gate that was skipped.")
        lines.append("")

    if pre_gate_live:
        lines.append(
            f"{len(pre_gate_live)} live task(s) reached `acceptance` with no `qa_agent` "
            "row at all. These predate the QA gate, so they are not damage from the "
            "transition defect — but they are still waiting at Tom's gate and owe a "
            "decision:"
        )
        lines.append("")
        for finding in pre_gate_live:
            lines.append(f"- {finding['id']}  {finding['title']}")
            lines.append(
                f"    status={finding['status']} type={finding['taskType']} "
                f"assignee={finding['assignee']}"
            )
            for repair in finding["recommendedRepairs"]:
                lines.append(f"    repair: {repair}")
        lines.append("")

    closed = report["preGateClosedCount"]
    if closed:
        lines.append(
            f"{closed} closed task(s) have no `qa_agent` row. They were closed before "
            "the QA gate existed and are not damage from the transition defect."
        )
        lines.append("")

    lines.append(
        "This report is read-only. No approval, status or attention owner was "
        "written by it."
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--json", action="store_true", help="emit machine-readable JSON instead of text"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=200,
        help="page size for the task list read (default: 200)",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="Tasks API base URL (defaults to TASKS_API_BASE_URL)",
    )
    args = parser.parse_args()

    base_url = args.base_url or tasks_api_client.get_base_url()
    report = identify(base_url, limit=args.limit)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
