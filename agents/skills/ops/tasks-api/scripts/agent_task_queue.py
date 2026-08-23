#!/usr/bin/env python3
"""Retrieve and classify an agent's active task queue.

The Tasks API and Lobster remain the source of truth for task state. This
read-only adapter makes task and GitHub state useful to heartbeat agents by
distinguishing work that can be advanced now from dependency blocks and external
waits. It never submits reviews, edits PRs, or merges; agents invoke the explicit
role-specific PR skills for every mutation.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from typing import Any

# Bootstrap `agents.lib` so `from agents.lib import safe_run` works under plain
# `python3 <this>.py` invocations. Walks up from `__file__` looking for a
# directory containing `agents/lib/`.
import sys as _sys
from pathlib import Path as _p
_w = next(
    (a for a in [_p(__file__).resolve().parent, *_p(__file__).resolve().parents]
     if (a / "agents" / "lib").is_dir()), None)
if _w is not None and str(_w) not in _sys.path:
    _sys.path.insert(0, str(_w))
del _sys, _p, _w

from agents.lib import safe_run

CLIENT_PATH = pathlib.Path(__file__).parents[1] / "tasks_api_client.py"
SPEC = importlib.util.spec_from_file_location("tasks_api_client", CLIENT_PATH)
tasks_api_client = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tasks_api_client)

APPROVALS_PATH = pathlib.Path(__file__).with_name("pending_tech_design_approvals.py")
APPROVALS_SPEC = importlib.util.spec_from_file_location(
    "pending_tech_design_approvals", APPROVALS_PATH
)
pending_approvals = importlib.util.module_from_spec(APPROVALS_SPEC)
assert APPROVALS_SPEC.loader is not None
APPROVALS_SPEC.loader.exec_module(pending_approvals)

IMPLEMENTATION_TYPES = {"feature", "code"}
DELIVERY_TAGS = ("[implementer-prs]", "[rowan-prs]")
TECH_DESIGN_TAG = "[tech-design]"
TECH_DESIGN_WAIVER_TAG = "[tech-design-not-required]"
PROGRESS_TAGS = ("[feature-task-progress-checklist]", "[code-task-progress-checklist]")
REPO = "Stoffer-Industries/sindustries"
GITHUB_IDENTITIES = {
    "rowan": ("rowanstoffer", "~/.config/gh-rowan", "ROWAN_GITHUB_TOKEN"),
    "ivy": ("ivystoffer", "~/.config/gh-ivy", "IVY_GITHUB_TOKEN"),
    "quinn": ("quinnstoffer", "~/.config/gh-quinn", "QUINN_GITHUB_TOKEN"),
    "ash": ("ashstoffer", "~/.config/gh-ash", "ASH_GITHUB_TOKEN"),
    # Tom is the terminal human attention owner. His queue remains read-only;
    # the default gh config is used only to hydrate PR context.
    "tom": ("stoff81", "~/.config/gh", "GITHUB_TOKEN"),
}
GREEN_CHECK_CONCLUSIONS = {"success", "skipped", "neutral"}
CURRENT_GATE_BY_STATUS = {
    "open": "spec",
    "ready": "tech_design",
    "doing": "qa_agent",
    "acceptance": "accepted",
}
QUEUE_KIND_ORDER = {
    "authoredPrFeedback": 0,
    "mergeCandidate": 1,
    "reviewRequest": 2,
    "techDesignApproval": 3,
    "task": 4,
    "workflowGate": 5,
    "attentionPage": 6,
}
TASK_PRIORITY_ORDER = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
# Per-call budget for `_gh_api`. Down from `safe_run`'s 25s default; bounded so
# a single stuck or slow GitHub response can't blow past the heartbeat slot.
# Cumulative time was the actual hang (12 URLs x 3 calls = 36 sequential ~4s
# calls = ~144s); parallelization handles cumulative wall-time, this handles
# pathological single-call latency. See
# docs/specs/agent-task-queue-cumulative-fetch-hang-2026-08-20-tech-design.md.
_GH_API_TIMEOUT_SECONDS = 10.0
# Cap the parallel fan-out in `fetch_linked_delivery_prs`. 8 is generous for
# the current workload (12 URLs); `min(len, MAX_WORKERS)` is used at call sites.
_MAX_PARALLEL_PR_FETCH_WORKERS = 8
# Module-level flag toggled by the --verbose CLI flag. Tests reset this in
# setUp/tearDown so they don't leak verbosity across cases.
_VERBOSE = False


class _GhApiTimeout(Exception):
    """Raised when an individual `gh api` call exceeds `_GH_API_TIMEOUT_SECONDS`.

    Callers translate this into "data unavailable" (empty reviews, no
    check_runs, skip the URL) so the script continues with partial data instead
    of aborting the heartbeat pass.
    """


def _log(msg: str, *, verbose_only: bool = False) -> None:
    """Stderr log gated by `_VERBOSE` when `verbose_only=True`. Always logs otherwise."""
    if verbose_only and not _VERBOSE:
        return
    print(f"[agent_task_queue] {msg}", file=sys.stderr, flush=True)


# Module-level counter for `_gh_api` calls. Surfaced in the --verbose exit summary
# (AC4). Tests reset this in setUp so counts don't leak across cases.
_GH_API_CALL_COUNT = 0
URL_RE = re.compile(r"https?://[^\s)>]+")
GITHUB_PR_URL_RE = re.compile(r"^https://github\.com/[^/]+/[^/]+/pull/(\d+)(?:[/?#].*)?$")


def _comment_texts(task: dict[str, Any]) -> list[str]:
    return [
        str(comment.get("text") or comment.get("body") or "").strip()
        for comment in task.get("comments") or []
    ]


def _has_prefix(texts: list[str], prefixes: tuple[str, ...]) -> bool:
    return any(text.lstrip().startswith(prefix) for text in texts for prefix in prefixes)


def _latest_tagged_comment(texts: list[str], prefixes: tuple[str, ...]) -> str:
    for text in reversed(texts):
        stripped = text.lstrip()
        if any(stripped.startswith(prefix) for prefix in prefixes):
            return text
    return ""


def _latest_progress_comment(texts: list[str]) -> str:
    return _latest_tagged_comment(texts, PROGRESS_TAGS)


def _delivery_urls(texts: list[str]) -> list[str]:
    comment = _latest_tagged_comment(texts, DELIVERY_TAGS)
    if not comment:
        return []
    urls: list[str] = []
    seen: set[str] = set()
    for match in URL_RE.finditer(comment):
        url = match.group(0).rstrip(".,)")
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def _task_agent(task: dict[str, Any]) -> str:
    assignee = str(task.get("assignee") or "").strip()
    return assignee if assignee.lower() in GITHUB_IDENTITIES else "Rowan"


def _checks_pending(checks: list[dict[str, Any]]) -> bool:
    return any(str(check.get("status") or "").lower() != "completed" for check in checks)


def _checks_failing(checks: list[dict[str, Any]]) -> bool:
    return any(
        str(check.get("status") or "").lower() == "completed"
        and str(check.get("conclusion") or "").lower() not in GREEN_CHECK_CONCLUSIONS
        for check in checks
    )


def _pull_number_from_url(url: str) -> int | None:
    match = GITHUB_PR_URL_RE.match(url)
    if not match:
        return None
    return int(match.group(1))


def _tech_design_approved(task: dict[str, Any]) -> bool:
    """Use the structured TaskApproval resource as the sole gate source."""
    return any(
        approval.get("type") == "tech_design" and approval.get("state") == "approved"
        for approval in (task.get("approvals") or [])
    )


def _latest_reviews(reviews: list[dict[str, Any]]) -> dict[str, str]:
    latest: dict[str, str] = {}
    for review in sorted(reviews, key=lambda item: item.get("submitted_at") or ""):
        login = str((review.get("user") or {}).get("login") or "").lower()
        state = str(review.get("state") or "").upper()
        if login and state not in {"COMMENTED", "PENDING"}:
            latest[login] = state
    return latest


def _blocking_reviewers(agent: str, pr: dict[str, Any], latest: dict[str, str]) -> list[str]:
    agent = agent.lower()
    title = str(pr.get("title") or "").lower()
    requested = {
        str(item.get("login") or "").lower()
        for item in pr.get("requested_reviewers") or []
    }
    if agent == "rowan":
        return ["quinnstoffer"]
    if agent == "ivy":
        if "tom-approval" in title:
            return ["stoff81"]
        if "quinn-approval" in title:
            return ["quinnstoffer"]
        known = (requested | set(latest)) & {"quinnstoffer", "stoff81"}
        return sorted(known)
    own_login = GITHUB_IDENTITIES[agent][0]
    non_self_requested = {login for login in requested if login != own_login}
    if non_self_requested:
        return sorted(non_self_requested)
    # GitHub clears requested_reviewers after a review is submitted. Retain the
    # non-self reviewer from latest review state so an approved Quinn-authored
    # PR can become merge-eligible without ever accepting Quinn's own review.
    return sorted(login for login in latest if login != own_login)


def _classify_delivery_pr(agent: str, pr: dict[str, Any]) -> tuple[str, str]:
    state = str(pr.get("state") or "").lower()
    if state != "open":
        if pr.get("merged_at") or pr.get("mergedAt"):
            return (
                "ACTIONABLE",
                "linked implementation PR is already merged; waiting for promotion is not a verified blocker",
            )
        return "ACTIONABLE", "linked implementation PR is closed without merge; replacement PR required"

    if pr.get("draft"):
        return "ACTIONABLE", "linked implementation PR is still draft"

    latest = _latest_reviews(pr.get("reviews") or [])
    changes_requested_by = sorted(
        reviewer for reviewer, state in latest.items() if state == "CHANGES_REQUESTED"
    )
    if changes_requested_by:
        return "ACTIONABLE", "linked implementation PR has requested changes"

    if pr.get("mergeable") is False:
        return "ACTIONABLE", "linked implementation PR has merge conflicts"

    checks = pr.get("check_runs") or []
    if _checks_failing(checks):
        return "ACTIONABLE", "linked implementation PR has failing CI"
    if _checks_pending(checks):
        return "WAITING_EXTERNAL", "linked implementation PR is waiting on CI"

    requested = {
        str(item.get("login") or "").lower()
        for item in pr.get("requested_reviewers") or []
    }
    blocking = _blocking_reviewers(agent, pr, latest)
    approvals_present = bool(blocking) and all(latest.get(reviewer) == "APPROVED" for reviewer in blocking)
    waiting_on_review = any(reviewer in requested for reviewer in blocking)

    if approvals_present and pr.get("mergeable") is True:
        return "ACTIONABLE", "linked implementation PR is approved and ready to merge"
    if waiting_on_review:
        return "WAITING_EXTERNAL", "linked implementation PR is waiting on review"

    return (
        "ACTIONABLE",
        "implementer delivery is posted but no verified current external blocker remains",
    )


def classify_task(
    task: dict[str, Any],
    delivery_prs: dict[str, dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """Return (classification, reason) for one full Tasks API task object."""
    active_handoffs = [
        gate for gate in task.get("workflowGates") or []
        if gate.get("state") == "outstanding" and gate.get("owner")
    ]
    if active_handoffs:
        agent = _task_agent(task).lower()
        owned = next(
            (gate for gate in active_handoffs if str(gate.get("owner")).lower() == agent),
            None,
        )
        if owned:
            return "ACTIONABLE", f"active workflow handoff is owned by {_task_agent(task)}"
        owners = ", ".join(str(gate["owner"]) for gate in active_handoffs)
        return "WAITING_EXTERNAL", f"active workflow handoff is owned by {owners}"

    if task.get("dependencyBlocked"):
        return "DEPENDENCY_BLOCKED", "one or more task dependencies are incomplete"
    if task.get("blocked"):
        return "BLOCKED", "task blocked flag is set"

    status = str(task.get("status") or "").lower()
    task_type = str(task.get("taskType") or "").lower()
    texts = _comment_texts(task)
    latest_progress = _latest_progress_comment(texts)

    if status == "open" and task_type in IMPLEMENTATION_TYPES:
        # Since task 3ba96b5e split the bundled ready gate, a task can only
        # reach `ready` once its tech design (or an explicit waiver) is
        # already approved. That means "tech design missing" is an `open`
        # task condition, not a `ready` one — see the mirrored check below,
        # which is now unreachable in practice but left in place as a
        # harmless no-op in case pipeline behavior changes again.
        has_design = _has_prefix(texts, (TECH_DESIGN_TAG,))
        has_approval = _tech_design_approved(task)
        has_waiver = _has_prefix(texts, (TECH_DESIGN_WAIVER_TAG,))
        if not has_design and not has_waiver:
            return "ACTIONABLE", "tech design or explicit waiver is missing"
        if has_approval or has_waiver:
            return "WAITING_EXTERNAL", "tech design is ready for Lobster promotion to ready"
        return "WAITING_EXTERNAL", "tech design is waiting for approval"

    if status == "ready" and task_type in IMPLEMENTATION_TYPES:
        has_design = _has_prefix(texts, (TECH_DESIGN_TAG,))
        has_approval = _tech_design_approved(task)
        has_waiver = _has_prefix(texts, (TECH_DESIGN_WAIVER_TAG,))
        if not has_design and not has_waiver:
            return "ACTIONABLE", "tech design or explicit waiver is missing"
        if has_approval or has_waiver:
            return "WAITING_EXTERNAL", "delivery is ready for Lobster promotion to doing"
        return "WAITING_EXTERNAL", "tech design is waiting for approval"

    if status == "doing" and task_type in IMPLEMENTATION_TYPES:
        has_design = _has_prefix(texts, (TECH_DESIGN_TAG,))
        has_approval = _tech_design_approved(task)
        has_waiver = _has_prefix(texts, (TECH_DESIGN_WAIVER_TAG,))
        if not has_design and not has_waiver:
            return "ACTIONABLE", "tech design or explicit waiver is missing"
        if not has_approval and not has_waiver:
            return "WAITING_EXTERNAL", "tech design is waiting for approval"
        if "missing `[implementer-prs]`" in latest_progress.lower():
            return "ACTIONABLE", "progress checklist says implementer delivery is missing"
        delivery_urls = _delivery_urls(texts)
        if delivery_urls:
            actionable_reasons: list[str] = []
            waiting_reasons: list[str] = []
            for url in delivery_urls:
                pr = (delivery_prs or {}).get(url)
                if pr is None:
                    actionable_reasons.append(
                        "implementer delivery is posted but live PR state is unavailable"
                    )
                    continue
                classification, reason = _classify_delivery_pr(_task_agent(task), pr)
                if classification == "WAITING_EXTERNAL":
                    waiting_reasons.append(reason)
                else:
                    actionable_reasons.append(reason)
            if actionable_reasons:
                return "ACTIONABLE", actionable_reasons[0]
            if waiting_reasons:
                return "WAITING_EXTERNAL", waiting_reasons[0]
        return "ACTIONABLE", "implementation PR delivery has not been posted"

    if status == "acceptance":
        if task_type in IMPLEMENTATION_TYPES and _has_prefix(texts, DELIVERY_TAGS):
            return "WAITING_EXTERNAL", "implementer delivery posted; verify review, QA, and post-merge state"
        if "missing `[implementer-prs]`" in latest_progress.lower():
            return "ACTIONABLE", "progress checklist says implementer delivery is missing"
        return "WAITING_EXTERNAL", "task is in acceptance; verify review, QA, and post-merge state"

    if status in {"ready", "doing"}:
        return "ACTIONABLE", f"{task_type or 'task'} task is in {status}"

    return "WAITING_EXTERNAL", f"task state {status or 'unknown'} has no agent action rule"


def top_attention_owner(task: dict[str, Any]) -> str | None:
    """Return position 0: the only currently actionable attention slot."""
    owners = task.get("attentionOwners") or []
    if not isinstance(owners, list) or not owners:
        return None
    owner = owners[0]
    if not isinstance(owner, str) or not owner.strip():
        return None
    return owner.strip()


def build_queue(
    tasks: list[dict[str, Any]],
    delivery_prs: dict[str, dict[str, Any]] | None = None,
    agent: str | None = None,
) -> dict[str, Any]:
    items = []
    for task in tasks:
        top_owner = top_attention_owner(task)
        if top_owner and agent:
            if top_owner.casefold() == agent.strip().casefold():
                classification, reason = "ACTIONABLE", f"top attention owner is {top_owner}"
            else:
                classification, reason = "WAITING_EXTERNAL", f"routed to top attention owner {top_owner}"
        else:
            classification, reason = classify_task(task, delivery_prs)
        items.append(
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "taskType": task.get("taskType"),
                "status": task.get("status"),
                "priority": task.get("priority"),
                "classification": classification,
                "reason": reason,
                "topAttentionOwner": top_owner,
            }
        )

    order = {"ACTIONABLE": 0, "WAITING_EXTERNAL": 1, "DEPENDENCY_BLOCKED": 2, "BLOCKED": 3}
    items.sort(key=lambda item: (order.get(item["classification"], 99), item.get("title") or ""))
    return {
        "actionableCount": sum(item["classification"] == "ACTIONABLE" for item in items),
        "items": items,
    }


def fetch_agent_tasks(assignee: str, base_url: str | None = None) -> list[dict[str, Any]]:
    base = base_url or tasks_api_client.get_base_url()
    summaries = tasks_api_client.list_tasks(
        limit=50,
        status=["open", "ready", "doing", "acceptance"],
        assignee=assignee,
        base_url=base,
    )
    return [tasks_api_client.get_task(task["id"], base_url=base) for task in summaries]


def fetch_workflow_gate_owner_tasks(name: str, base_url: str | None = None) -> list[dict[str, Any]]:
    """Fetch active tasks whose current outstanding gate is owned by ``name``."""
    base = base_url or tasks_api_client.get_base_url()
    summaries = tasks_api_client.list_tasks(
        limit=200,
        status=["open", "ready", "doing", "acceptance"],
        workflow_gate_owner=name,
        base_url=base,
    )
    return [tasks_api_client.get_task(task["id"], base_url=base) for task in summaries]


def _current_outstanding_gate_for_owner(
    task: dict[str, Any], owner: str
) -> dict[str, Any] | None:
    """Return only the exact current-stage outstanding gate owned by ``owner``."""
    expected_gate = CURRENT_GATE_BY_STATUS.get(str(task.get("status") or "").lower())
    if expected_gate is None:
        return None
    owner_key = owner.strip().casefold()
    return next(
        (
            gate
            for gate in task.get("workflowGates") or []
            if str(gate.get("state") or "").lower() == "outstanding"
            and str(gate.get("gate") or "").lower() == expected_gate
            and str(gate.get("owner") or "").strip().casefold() == owner_key
        ),
        None,
    )


def _build_workflow_gate_items(
    gate_owner: str,
    tasks: list[dict[str, Any]],
    seen_ids: set[str],
) -> list[dict[str, Any]]:
    """Surface gate-owner fallback only while the attention stack is empty."""
    items: list[dict[str, Any]] = []
    for task in tasks:
        task_id = str(task.get("id") or "")
        if not task_id or task_id in seen_ids:
            continue
        # Any populated attention stack is authoritative, even when Ash appears
        # in the gate plane. Only position 0 acts until that stack is cleared.
        if task.get("attentionOwners"):
            continue
        gate = _current_outstanding_gate_for_owner(task, gate_owner)
        if gate is None:
            continue
        items.append(
            {
                "kind": "workflowGate",
                "actionable": True,
                "id": task_id,
                "title": task.get("title"),
                "taskType": task.get("taskType"),
                "status": task.get("status"),
                "priority": task.get("priority"),
                "classification": "ACTIONABLE",
                "reason": f"current {gate['gate']} gate is owned by {gate_owner}",
                "workflowGate": gate.get("gate"),
                "workflowGateOwner": gate_owner,
                "topAttentionOwner": None,
            }
        )
    return items


def fetch_attention_owner_tasks(name: str, base_url: str | None = None) -> list[dict[str, Any]]:
    """Fetch active tasks where ``name`` is a current attention owner.

    Returns the full task dict per match. The list is independent of the
    assignee query — callers must dedup against the assignee bucket before
    merging into the heartbeat queue (task ``d8fbe750``).
    """
    base = base_url or tasks_api_client.get_base_url()
    summaries = tasks_api_client.list_tasks(
        limit=200,
        status=["open", "ready", "doing", "acceptance"],
        attention_owner=name,
        base_url=base,
    )
    return [tasks_api_client.get_task(task["id"], base_url=base) for task in summaries]


def _build_attention_page_items(
    attention_owner: str,
    tasks: list[dict[str, Any]],
    seen_ids: set[str],
) -> list[dict[str, Any]]:
    """Normalise attention-owner-fetched tasks into queue items.

    A task already surfaced via the assignee bucket is skipped; the assignee
    surface is always the primary signal. New entries carry ``kind:
    ``attentionPage```, are always ``actionable``, and carry a reason that
    identifies the page owner.
    """
    items: list[dict[str, Any]] = []
    for task in tasks:
        task_id = str(task.get("id") or "")
        top_owner = top_attention_owner(task)
        if (
            not task_id
            or task_id in seen_ids
            or not top_owner
            or top_owner.casefold() != attention_owner.strip().casefold()
        ):
            continue
        items.append(
            {
                "kind": "attentionPage",
                "actionable": True,
                "id": task_id,
                "title": task.get("title"),
                "taskType": task.get("taskType"),
                "status": task.get("status"),
                "priority": task.get("priority"),
                "classification": "ACTIONABLE",
                "reason": f"top attention owner is {top_owner}",
                "topAttentionOwner": top_owner,
            }
        )
    return items


def _gh_api(config_dir: str, token_env: str, endpoint: str) -> Any:
    """Run `gh api <endpoint>` and parse JSON. Wraps `_GH_API_TIMEOUT_SECONDS`.

    Raises:
        _GhApiTimeout — when the underlying `gh api` call exceeds the per-call
            timeout. Callers handle this as "data unavailable" instead of
            propagating, so a single slow endpoint can't kill the heartbeat pass.
        subprocess.CalledProcessError — `gh api` exited non-zero with `check=True`.
    """
    global _GH_API_CALL_COUNT
    _GH_API_CALL_COUNT += 1
    env = os.environ.copy()
    env["GH_CONFIG_DIR"] = os.path.expanduser(config_dir)
    token = env.get(token_env)
    if token:
        env["GH_TOKEN"] = token
    started = time.monotonic()
    try:
        result = safe_run(
            ["gh", "api", endpoint],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=_GH_API_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = time.monotonic() - started
        if _VERBOSE:
            _log(
                f"[gh api #{_GH_API_CALL_COUNT}] timeout {elapsed:.2f}s {endpoint}",
                verbose_only=True,
            )
        raise _GhApiTimeout(
            f"gh api {endpoint} exceeded {_GH_API_TIMEOUT_SECONDS:.0f}s"
        ) from exc
    elapsed = time.monotonic() - started
    if _VERBOSE:
        _log(
            f"[gh api #{_GH_API_CALL_COUNT}] {elapsed:.2f}s {endpoint}",
            verbose_only=True,
        )
    return json.loads(result.stdout)


def classify_github_prs(agent: str, prs: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Build read-only review, feedback, and merge queues from hydrated PR data."""
    login = GITHUB_IDENTITIES[agent.lower()][0].lower()
    review_requests = []
    authored_feedback = []
    merge_candidates = []

    for pr in prs:
        author = str((pr.get("user") or {}).get("login") or "").lower()
        requested = {
            str(item.get("login") or "").lower()
            for item in pr.get("requested_reviewers") or []
        }
        summary = {
            "number": pr.get("number"),
            "title": pr.get("title"),
            "url": pr.get("html_url"),
        }
        if login in requested and author != login:
            review_requests.append(summary)
        if author != login:
            continue

        latest = _latest_reviews(pr.get("reviews") or [])
        changes_requested_by = sorted(
            reviewer for reviewer, state in latest.items() if state == "CHANGES_REQUESTED"
        )
        if changes_requested_by:
            authored_feedback.append({**summary, "changesRequestedBy": changes_requested_by})

        blocking = _blocking_reviewers(agent, pr, latest)
        checks = pr.get("check_runs") or []
        ci_green = bool(checks) and all(
            check.get("status") == "completed"
            and str(check.get("conclusion") or "").lower() in GREEN_CHECK_CONCLUSIONS
            for check in checks
        )
        approvals_present = bool(blocking) and all(
            latest.get(reviewer) == "APPROVED" for reviewer in blocking
        )
        if (
            approvals_present
            and ci_green
            and pr.get("mergeable") is True
            and not changes_requested_by
        ):
            merge_candidates.append({**summary, "blockingApprovals": blocking})

    return {
        "reviewRequests": review_requests,
        "authoredPrFeedback": authored_feedback,
        "mergeCandidates": merge_candidates,
    }


def fetch_pending_tech_design_approvals(base_url: str | None = None) -> list[dict[str, Any]]:
    """Return Quinn's global approval queue, independent of task assignee."""
    base = (base_url or tasks_api_client.get_base_url()).rstrip("/")
    candidates = [
        task
        for task in pending_approvals.list_tasks(base, [])
        if pending_approvals.needs_tech_design_review(task)
    ]
    approvals = []
    for summary in candidates:
        task = pending_approvals.fetch_task_detail(base, summary["id"])
        url = pending_approvals.tech_design_url(task)
        if not url or pending_approvals.tech_design_approved(task):
            continue
        approvals.append(
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "status": task.get("status"),
                "assignee": task.get("assignee"),
                "techDesignUrl": url,
            }
        )
    return approvals


def _fetch_github_pr_detail(
    config_dir: str, token_env: str, number: int, retries: int = 3
) -> dict[str, Any]:
    """Fetch PR detail, retrying GitHub's transient null mergeable response.

    GitHub computes ``mergeable`` asynchronously and may return null while that
    calculation is in progress. A single fetch can therefore silently hide a
    PR that is otherwise ready to merge from the heartbeat queue.
    """
    detail = _gh_api(config_dir, token_env, f"repos/{REPO}/pulls/{number}")
    for _ in range(max(0, retries - 1)):
        if detail.get("mergeable") is not None:
            break
        time.sleep(1)
        detail = _gh_api(config_dir, token_env, f"repos/{REPO}/pulls/{number}")
    return detail


def _fetch_reviews_tolerant(
    config_dir: str, token_env: str, number: int
) -> list[dict[str, Any]]:
    """Fetch a PR's reviews, tolerating GitHub's REST->GraphQL bridge regression.

    The ``/pulls/{n}/reviews`` endpoint has intermittently returned a
    GraphQL-shaped 404 ("Could not resolve to a node") for otherwise-valid PRs
    since 2026-08-17 (see infra/runbooks/github-api-reviews-endpoint-404-regression.md).
    Other PR endpoints are unaffected. Treating the failure as "no reviews yet"
    degrades gracefully: every downstream consumer already handles an empty
    reviews list, and a PR just won't classify as a merge candidate while the
    upstream regression is active.
    """
    endpoint = f"repos/{REPO}/pulls/{number}/reviews?per_page=100"
    try:
        return _gh_api(config_dir, token_env, endpoint)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "") + (exc.stdout or "")
        if "Could not resolve to a node" in stderr:
            print(
                f"[agent_task_queue] WARN: GitHub /reviews endpoint unavailable "
                f"for PR #{number}; treating as no reviews (REST->GraphQL bridge "
                f"regression). See "
                f"infra/runbooks/github-api-reviews-endpoint-404-regression.md",
                file=sys.stderr,
                flush=True,
            )
            return []
        raise


def fetch_github_prs(agent: str) -> list[dict[str, Any]]:
    """Read open PR state with the agent's own GitHub credentials; never mutate."""
    _, config_dir, token_env = GITHUB_IDENTITIES[agent.lower()]
    prs = _gh_api(config_dir, token_env, f"repos/{REPO}/pulls?state=open&per_page=100")
    hydrated = []
    for summary in prs:
        author = str((summary.get("user") or {}).get("login") or "").lower()
        requested = {
            str(item.get("login") or "").lower()
            for item in summary.get("requested_reviewers") or []
        }
        login = GITHUB_IDENTITIES[agent.lower()][0].lower()
        if author != login and login not in requested:
            continue
        number = summary["number"]
        detail = _fetch_github_pr_detail(config_dir, token_env, number)
        detail["reviews"] = _fetch_reviews_tolerant(config_dir, token_env, number)
        checks = _gh_api(
            config_dir,
            token_env,
            f"repos/{REPO}/commits/{detail['head']['sha']}/check-runs?per_page=100",
        )
        detail["check_runs"] = checks.get("check_runs") or []
        hydrated.append(detail)
    return hydrated


def fetch_linked_delivery_prs(
    agent: str,
    tasks: list[dict[str, Any]],
    github_prs: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    _, config_dir, token_env = GITHUB_IDENTITIES[agent.lower()]
    prs_by_url = {
        str(pr.get("html_url")): pr for pr in (github_prs or []) if pr.get("html_url")
    }
    linked_urls = {
        url
        for task in tasks
        for url in _delivery_urls(_comment_texts(task))
    }

    def _hydrate_one_pr(url: str) -> tuple[str, dict[str, Any] | None]:
        """Hydrate one delivery URL's PR (detail + reviews + check-runs).

        Returns `(url, detail_or_None)`. `None` is returned (and a WARN line is
        printed) on per-URL `_GhApiTimeout`; the caller continues hydrating
        other URLs in the fan-out rather than aborting the whole call.
        """
        pr_number = _pull_number_from_url(url)
        if pr_number is None:
            return url, None
        try:
            detail = _fetch_github_pr_detail(config_dir, token_env, pr_number)
            detail["reviews"] = _fetch_reviews_tolerant(config_dir, token_env, pr_number)
            checks = _gh_api(
                config_dir,
                token_env,
                f"repos/{REPO}/commits/{detail['head']['sha']}/check-runs?per_page=100",
            )
            detail["check_runs"] = checks.get("check_runs") or []
        except _GhApiTimeout as exc:
            _log(
                f"gh api timeout hydrating PR #{pr_number} ({url}); skipping: {exc}",
                verbose_only=False,
            )
            return url, None
        return url, detail

    missing_urls = sorted(
        url for url in linked_urls if url not in prs_by_url
    )
    if missing_urls:
        started = time.monotonic()
        workers = min(len(missing_urls), _MAX_PARALLEL_PR_FETCH_WORKERS)
        _log(
            f"fetch_linked_delivery_prs: hydrating {len(missing_urls)} PR(s) "
            f"with {workers} parallel worker(s)",
            verbose_only=True,
        )
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="pr-hydrate") as pool:
            for url, detail in pool.map(_hydrate_one_pr, missing_urls):
                if detail is not None and detail.get("html_url"):
                    prs_by_url[str(detail["html_url"])] = detail
        _log(
            f"fetch_linked_delivery_prs: hydrated in {time.monotonic() - started:.2f}s",
            verbose_only=True,
        )

    return prs_by_url


def build_unified_queue(
    task_items: list[dict[str, Any]],
    tech_design_approvals: list[dict[str, Any]],
    github_queue: dict[str, list[dict[str, Any]]],
    routed_task_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Normalize every read-only heartbeat input into one deterministic queue."""
    items: list[dict[str, Any]] = []
    for item in github_queue["authoredPrFeedback"]:
        items.append({"kind": "authoredPrFeedback", "actionable": True, **item})
    for item in github_queue["mergeCandidates"]:
        items.append({"kind": "mergeCandidate", "actionable": True, **item})
    for item in github_queue["reviewRequests"]:
        items.append({"kind": "reviewRequest", "actionable": True, **item})
    for item in tech_design_approvals:
        items.append(
            {
                "kind": "techDesignApproval",
                "actionable": True,
                "id": item.get("id"),
                "title": item.get("title"),
                "url": item.get("techDesignUrl"),
                "status": item.get("status"),
                "assignee": item.get("assignee"),
            }
        )
    for item in task_items:
        items.append(
            {
                "kind": "task",
                "actionable": item.get("classification") == "ACTIONABLE",
                **item,
            }
        )
    for item in routed_task_items or []:
        items.append({**item, "actionable": True})

    def sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
        actionable_rank = 0 if item.get("actionable") else 1
        kind_rank = QUEUE_KIND_ORDER.get(str(item.get("kind")), 99)
        task_priority = TASK_PRIORITY_ORDER.get(str(item.get("priority") or "").lower(), 99)
        return (
            actionable_rank,
            kind_rank,
            task_priority,
            str(item.get("title") or ""),
            str(item.get("id") or item.get("number") or ""),
        )

    return sorted(items, key=sort_key)


def build_work_queue(
    tasks: list[dict[str, Any]],
    agent: str,
    github_prs: list[dict[str, Any]] | None = None,
    tech_design_approvals: list[dict[str, Any]] | None = None,
    delivery_prs: dict[str, dict[str, Any]] | None = None,
    attention_owner_tasks: list[dict[str, Any]] | None = None,
    attention_owner: str | None = None,
    workflow_gate_owner_tasks: list[dict[str, Any]] | None = None,
    workflow_gate_owner: str | None = None,
) -> dict[str, Any]:
    task_queue = build_queue(
        tasks,
        delivery_prs or {str(pr.get("html_url")): pr for pr in (github_prs or []) if pr.get("html_url")},
        agent,
    )
    approvals = tech_design_approvals or []
    github_queue = classify_github_prs(agent, github_prs or [])
    seen_ids = {str(item.get("id") or "") for item in task_queue["items"] if item.get("id")}
    attention_items: list[dict[str, Any]] = []
    if attention_owner and attention_owner_tasks:
        attention_items = _build_attention_page_items(
            attention_owner, attention_owner_tasks, seen_ids
        )
    routed_ids = seen_ids | {item["id"] for item in attention_items}
    workflow_gate_items: list[dict[str, Any]] = []
    if workflow_gate_owner and workflow_gate_owner_tasks:
        workflow_gate_items = _build_workflow_gate_items(
            workflow_gate_owner, workflow_gate_owner_tasks, routed_ids
        )
    queue = build_unified_queue(
        task_queue["items"],
        approvals,
        github_queue,
        [*attention_items, *workflow_gate_items],
    )
    return {
        "queue": queue,
        "topCandidate": next((item for item in queue if item["actionable"]), None),
        "tasks": task_queue["items"],
        "actionableTaskCount": task_queue["actionableCount"],
        "techDesignApprovals": approvals,
        **github_queue,
        "attentionOwner": attention_owner,
        "attentionPages": attention_items,
        "workflowGateOwner": workflow_gate_owner,
        "workflowGateTasks": workflow_gate_items,
    }


def print_human(queue: dict[str, Any], assignee: str) -> None:
    print(f"{assignee} actionable tasks: {queue['actionableCount']}")
    for item in queue["items"]:
        print(
            f"{item['classification']:18} [{str(item['id'])[:8]}] "
            f"{item['status']}/{item['taskType']}: {item['title']} — {item['reason']}"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assignee", required=True, help="Tasks API assignee name, e.g. Rowan")
    parser.add_argument(
        "--attention-owner",
        dest="attention_owner",
        default=None,
        help="Override the attention identity (defaults to --assignee). Only tasks "
        "where that identity is attentionOwners[0] are actionable; lower slots are "
        "dormant escalation context.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Emit per-stage wall-time + fan-out diagnostics on stderr. "
        "Used by AC4 instrumentation; production runs stay quiet.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    global _VERBOSE, _GH_API_CALL_COUNT
    _VERBOSE = args.verbose
    _GH_API_CALL_COUNT = 0
    agent_key = args.assignee.lower()
    if agent_key not in GITHUB_IDENTITIES:
        raise SystemExit(
            f"unsupported agent {args.assignee!r}; expected Rowan, Ivy, Quinn, Ash, or Tom"
        )
    tasks = fetch_agent_tasks(args.assignee)
    approvals = fetch_pending_tech_design_approvals() if agent_key == "quinn" else []
    github_prs = fetch_github_prs(args.assignee)
    delivery_prs = fetch_linked_delivery_prs(args.assignee, tasks, github_prs)
    attention_owner = args.attention_owner or args.assignee
    attention_owner_tasks = fetch_attention_owner_tasks(attention_owner)
    workflow_gate_owner_tasks = fetch_workflow_gate_owner_tasks(args.assignee)
    queue = build_work_queue(
        tasks,
        args.assignee,
        github_prs,
        approvals,
        delivery_prs,
        attention_owner_tasks=attention_owner_tasks,
        attention_owner=attention_owner,
        workflow_gate_owner_tasks=workflow_gate_owner_tasks,
        workflow_gate_owner=args.assignee,
    )
    if args.json:
        print(json.dumps(queue, indent=2))
    else:
        print_human(
            {
                "actionableCount": queue["actionableTaskCount"],
                "items": queue["tasks"],
            },
            args.assignee,
        )
        print(f"Tech-design approvals: {len(queue['techDesignApprovals'])}")
        print(f"Review requests: {len(queue['reviewRequests'])}")
        print(f"Authored PRs with requested changes: {len(queue['authoredPrFeedback'])}")
        print(f"Merge candidates: {len(queue['mergeCandidates'])}")
        if args.attention_owner:
            print(f"Attention pages for {args.attention_owner}: {len(queue['attentionPages'])}")
        print(
            f"Current workflow gates for {args.assignee}: "
            f"{len(queue['workflowGateTasks'])}"
        )
        if args.verbose:
            print(f"_gh_api call count: {_GH_API_CALL_COUNT}")


if __name__ == "__main__":
    main()
