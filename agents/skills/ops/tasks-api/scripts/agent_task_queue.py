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
import importlib.util
import json
import os
import pathlib
import re
import subprocess
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
}
GREEN_CHECK_CONCLUSIONS = {"success", "skipped", "neutral"}
QUEUE_KIND_ORDER = {
    "authoredPrFeedback": 0,
    "mergeCandidate": 1,
    "reviewRequest": 2,
    "techDesignApproval": 3,
    "task": 4,
}
TASK_PRIORITY_ORDER = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
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


def build_queue(
    tasks: list[dict[str, Any]],
    delivery_prs: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    items = []
    for task in tasks:
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


def _gh_api(config_dir: str, token_env: str, endpoint: str) -> Any:
    env = os.environ.copy()
    env["GH_CONFIG_DIR"] = os.path.expanduser(config_dir)
    token = env.get(token_env)
    if token:
        env["GH_TOKEN"] = token
    result = safe_run(
        ["gh", "api", endpoint],
        check=True,
        capture_output=True,
        text=True,
        env=env,
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
        detail["reviews"] = _gh_api(
            config_dir, token_env, f"repos/{REPO}/pulls/{number}/reviews?per_page=100"
        )
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
    for url in sorted(linked_urls):
        if url in prs_by_url:
            continue
        pr_number = _pull_number_from_url(url)
        if pr_number is None:
            continue
        detail = _fetch_github_pr_detail(config_dir, token_env, pr_number)
        detail["reviews"] = _gh_api(
            config_dir, token_env, f"repos/{REPO}/pulls/{pr_number}/reviews?per_page=100"
        )
        checks = _gh_api(
            config_dir,
            token_env,
            f"repos/{REPO}/commits/{detail['head']['sha']}/check-runs?per_page=100",
        )
        detail["check_runs"] = checks.get("check_runs") or []
        if detail.get("html_url"):
            prs_by_url[str(detail["html_url"])] = detail
    return prs_by_url


def build_unified_queue(
    task_items: list[dict[str, Any]],
    tech_design_approvals: list[dict[str, Any]],
    github_queue: dict[str, list[dict[str, Any]]],
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
) -> dict[str, Any]:
    task_queue = build_queue(
        tasks,
        delivery_prs or {str(pr.get("html_url")): pr for pr in (github_prs or []) if pr.get("html_url")},
    )
    approvals = tech_design_approvals or []
    github_queue = classify_github_prs(agent, github_prs or [])
    queue = build_unified_queue(task_queue["items"], approvals, github_queue)
    return {
        "queue": queue,
        "topCandidate": next((item for item in queue if item["actionable"]), None),
        "tasks": task_queue["items"],
        "actionableTaskCount": task_queue["actionableCount"],
        "techDesignApprovals": approvals,
        **github_queue,
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
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    agent_key = args.assignee.lower()
    if agent_key not in GITHUB_IDENTITIES:
        raise SystemExit(f"unsupported agent {args.assignee!r}; expected Rowan, Ivy, or Quinn")
    tasks = fetch_agent_tasks(args.assignee)
    approvals = fetch_pending_tech_design_approvals() if agent_key == "quinn" else []
    github_prs = fetch_github_prs(args.assignee)
    delivery_prs = fetch_linked_delivery_prs(args.assignee, tasks, github_prs)
    queue = build_work_queue(
        tasks,
        args.assignee,
        github_prs,
        approvals,
        delivery_prs,
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


if __name__ == "__main__":
    main()
