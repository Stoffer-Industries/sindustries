#!/usr/bin/env python3
"""Task transition check for heartbeat: given a task ID, returns whether the task
can transition to the next state and any failed criteria.

Uses tasks_api_client for all task data. For Doing→Acceptance and Acceptance→Done
requires GITHUB_TOKEN to fetch PR and check status.

Usage:
  TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 scripts/task_transition_check.py <task-id>
  With GitHub (for Doing/Acceptance checks): GITHUB_TOKEN=ghp_... python3 scripts/task_transition_check.py <task-id>

Output: JSON with task_id, current_state, failed_criteria (list), reason (string).
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sys
import urllib.request
from typing import Any

# Import from workspace script; run from repo root or ensure script dir in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tasks_api_client import get_base_url, get_task, list_tasks


# --- User-facing failure/reason strings (grouped by destination state)
MSG: dict[str, Any] = {
    "SYSTEM": {
        "USAGE": {"ERROR": "Usage: task_transition_check.py <task-id>"},
        "API": {
            "MISSING_TASKS_API_BASE_URL": "TASKS_API_BASE_URL is required",
            "REASON_MISSING_TASKS_API_BASE_URL": "Missing TASKS_API_BASE_URL",
            "REASON_FAILED_TO_LOAD_TASK": "Failed to load task",
            "TASK_NOT_FOUND": "Task not found",
            "REASON_TASK_NOT_FOUND": "Task not found",
        },
    },
    "READY": {
        "DESC": {
            "MISSING": "Description missing",
            "MISSING_WHAT": "Description missing **What:** section",
            "MISSING_WHY": "Description missing **Why:** section",
            "MISSING_AC": "Description missing **AC:** section",
            "MISSING_SPEC": "Description missing **Spec:** section",
            "REASON_NO_DESC": "Task has no description",
        },
        "AC": {"NO_CHECKBOXES": "**AC:** section has no checkbox items (- [ ] or - [x])"},
        "SPEC": {"TOO_LONG_FMT": "**Spec:** exceeds 500 words ({words})"},
        "ASSIGNEE": {"MISSING": "Task has no assignee"},
        "REASON": {"NOT_READY": "Task is not ready for Ready state"},
    },
    "DOING": {
        "ASSIGNEE": {
            "MISSING": "No assignee",
            "REASON_REQUIRED": "Assignee required for Doing",
        },
        "CAPACITY": {
            "NO_CAPACITY_FMT": "Assignee has {count} unblocked doing task(s); no capacity for new work",
            "REASON_NO_CAPACITY": "Assignee does not have capacity for new work",
            "CANNOT_EVALUATE_WITHOUT_ASSIGNEE": "Assignee capacity cannot be evaluated until an assignee is set",
        },
    },
    "ACCEPTANCE": {
        # requires PR link
        "PR": {
            "NO_LINK": "No PR link found in task description or comments",
            "BLOCKED_NO_PR": "PR is blocked from merging because it does not exist yet; create a PR first",
            "INVALID_URL": "Invalid PR URL format",
            "COULD_NOT_FETCH": "Could not fetch PR from GitHub",
            "CANNOT_VALIDATE_URL_WITHOUT_LINK": "Cannot validate PR URL format until a PR link is present",
            "CANNOT_FETCH_WITHOUT_LINK": "Cannot fetch PR until a PR link is present",
            "REASON_NO_PR": "Task has no PR; create a PR and mirror the ACs before moving to Acceptance",
            "REASON_INVALID_URL": "Invalid PR URL",
            "REASON_NOT_FOUND": "PR not found or inaccessible",
        },
        # requires GITHUB_TOKEN
        "GITHUB": {
            "NEEDS_TOKEN": "GITHUB_TOKEN required to validate PR and checks",
            "REASON_NEEDS_TOKEN": "Cannot validate PR without GITHUB_TOKEN",
        },
        # requires task ACs
        "AC": {
            "TASK_MISSING": "Task description has no AC checkbox lines under **AC:**; add '- [ ] ...' items for each acceptance criterion",
            "CANNOT_CHECK_PR_AC_WITHOUT_TASK_AC": "Cannot validate PR AC checkboxes until task AC checkboxes exist",
        },
        # requires PR head SHA to check CI
        "TESTS": {
            "NOT_PASSING_NO_PR": "Tests not passing: no PR created yet to run required checks against",
            "NOT_PASSING_FMT": "Tests not passing: {msg}",
            "MISSING_HEAD_SHA": "Could not get PR head SHA for status checks",
            "CANNOT_EVALUATE_WITHOUT_TOKEN": "Tests not passing: cannot verify checks without GITHUB_TOKEN",
            "CANNOT_EVALUATE_WITHOUT_PR": "Tests not passing: cannot verify checks until a PR exists",
        },
        # requires PR data
        "MERGE": {
            "IS_DRAFT": "PR is still marked as draft in GitHub; mark it ready for review before moving this task forward",
            "BEHIND": "PR branch is out-of-date with the base branch; update the branch (merge or rebase main) before moving this task forward",
            "BLOCKED": "PR is blocked from merging (for example, required review or checks); resolve the merge requirements shown in the GitHub UI before moving this task forward",
            "CANNOT_EVALUATE_WITHOUT_PR": "PR mergeability cannot be evaluated until a PR exists",
            "CANNOT_EVALUATE_WITHOUT_TOKEN": "PR mergeability cannot be evaluated without GITHUB_TOKEN",
        },
        "PREFERRED": {
            "E2E": "Preferred: at least 1 E2E per AC with testID or (not tested: reason) in PR description",
        },
        "REASON": {"NOT_READY": "Task is not ready for acceptance"},
    },
    "DONE": {
        # requires PR link
        "PR": {
            "NO_LINK": "No PR link found",
            "INVALID_URL": "Invalid PR URL",
            "COULD_NOT_FETCH": "Could not fetch PR",
            "REASON_NO_LINK": "Cannot verify merge without PR link",
            "REASON_INVALID_URL": "Invalid PR URL",
            "REASON_NOT_MERGED": "PR not merged to main",
            "CANNOT_CHECK_MERGE_WITHOUT_LINK": "Cannot verify merge status until a PR link is present",
        },
        # requires GITHUB_TOKEN
        "GITHUB": {
            "NEEDS_TOKEN": "GITHUB_TOKEN required",
            "REASON_NEEDS_TOKEN": "Cannot verify merge without GITHUB_TOKEN",
        },
        # requires merge commit SHA to check CI
        "TESTS": {
            "NOT_PASSING_FMT": "Tests not passing: {msg}",
            "MISSING_MERGE_SHA": "Could not get PR merge commit SHA for status checks",
            "CANNOT_EVALUATE_WITHOUT_TOKEN": "Tests not passing: cannot verify merged commit checks without GITHUB_TOKEN",
            "CANNOT_EVALUATE_WITHOUT_PR": "Tests not passing: cannot verify PR checks until a PR exists",
            "MISSING_HEAD_SHA": "Could not get PR head SHA for status checks",
        },
        # requires head ref to check branch deletion
        "BRANCH": {"NOT_CLEANED_UP_FMT": "Branch not cleaned up after merge: {msg}"},
        "REASON": {"NOT_READY": "Task is not ready for Done"},
    },
    "TERMINAL": {"REASON": "Task already in terminal state"},
    "GENERIC": {"READY_FOR_TRANSITION": "Ready for transition"},
}


# --- State mapping (API may use open/ready/doing/acceptance/done or legacy todo/doing/done + ready)
LEGACY_TO_LOGICAL = {
    ("todo", False): "Open",
    ("todo", True): "Ready",
    ("doing",): "Doing",
    ("acceptance",): "Acceptance",
    ("done",): "Done",
}


def resolve_current_state(task: dict) -> str:
    """Map API task to logical state name."""
    status = (task.get("status") or "").strip().lower()
    ready = task.get("ready") is True
    if status in ("open", "ready", "doing", "acceptance", "done"):
        return status.capitalize()
    if status == "todo":
        return "Ready" if ready else "Open"
    if status == "doing":
        return "Doing"
    if status == "done":
        return "Done"
    return status or "Open"


# --- Open → Ready: description and assignee
DESC_WHAT = re.compile(r"\*\*What:\*\*\s*(.+)", re.IGNORECASE | re.DOTALL)
DESC_WHY = re.compile(r"\*\*Why:\*\*\s*(.+)", re.IGNORECASE | re.DOTALL)
DESC_AC = re.compile(r"\*\*AC:\*\*", re.IGNORECASE)
DESC_AC_ITEM = re.compile(r"^\s*-\s*\[[\sx]\].+", re.MULTILINE)
DESC_SPEC = re.compile(r"\*\*Spec:\*\*\s*(.+?)(?=\n\*\*|\Z)", re.IGNORECASE | re.DOTALL)


def check_open_to_ready(task: dict) -> tuple[list[str], str]:
    failed = []
    desc = (task.get("description") or "").strip()
    if not desc:
        failed.append(MSG["READY"]["DESC"]["MISSING"])
    if not DESC_WHAT.search(desc):
        failed.append(MSG["READY"]["DESC"]["MISSING_WHAT"])
    if not DESC_WHY.search(desc):
        failed.append(MSG["READY"]["DESC"]["MISSING_WHY"])
    if not DESC_AC.search(desc):
        failed.append(MSG["READY"]["DESC"]["MISSING_AC"])
    else:
        ac_items = DESC_AC_ITEM.findall(desc)
        if not ac_items:
            failed.append(MSG["READY"]["AC"]["NO_CHECKBOXES"])
    spec_match = DESC_SPEC.search(desc)
    if not spec_match:
        failed.append(MSG["READY"]["DESC"]["MISSING_SPEC"])
    else:
        spec_text = (spec_match.group(1) or "").strip()
        words = len(spec_text.split())
        if words > 500:
            failed.append(MSG["READY"]["SPEC"]["TOO_LONG_FMT"].format(words=words))
    assignee = (task.get("assignee") or "").strip()
    if not assignee:
        failed.append(MSG["READY"]["ASSIGNEE"]["MISSING"])
    if not desc:
        reason = MSG["READY"]["DESC"]["REASON_NO_DESC"]
    else:
        reason = MSG["READY"]["REASON"]["NOT_READY"] if failed else ""
    return failed, reason


# --- Ready → Doing: assignee capacity
def check_ready_to_doing(task: dict, base_url: str) -> tuple[list[str], str]:
    """Check if assignee has capacity to start a new Doing task.
    
    Capacity rule: an assignee can only have ONE unblocked Doing task at a time.
    This is intentional - it enforces focus and prevents context-switching overhead.
    If they already have an unblocked Doing task, they cannot start another until
    that one moves to Acceptance (which blocks it) or is otherwise addressed.
    
    Note: This check runs for ALL tasks transitioning to Doing, not just new tasks.
    It's a strict capacity gate to ensure high-quality, focused work.
    """
    failed = []
    assignee = (task.get("assignee") or "").strip()
    if not assignee:
        failed.append(MSG["DOING"]["ASSIGNEE"]["MISSING"])
        failed.append(MSG["DOING"]["CAPACITY"]["CANNOT_EVALUATE_WITHOUT_ASSIGNEE"])
        return failed, MSG["DOING"]["ASSIGNEE"]["REASON_REQUIRED"]
    # Unblocked doing tasks for this assignee count as "in progress"; if any, no capacity
    doing = list_tasks(limit=100, status="doing", assignee=assignee, base_url=base_url)
    unblocked = [t for t in doing if t.get("blocked") is not True and t.get("id") != task.get("id")]
    if unblocked:
        failed.append(MSG["DOING"]["CAPACITY"]["NO_CAPACITY_FMT"].format(count=len(unblocked)))
        return failed, MSG["DOING"]["CAPACITY"]["REASON_NO_CAPACITY"]
    return failed, ""


# --- PR URL from task description or comments
PR_URL_RE = re.compile(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", re.IGNORECASE)


def find_pr_url(task: dict) -> str | None:
    comments = task.get("comments") or []
    if isinstance(comments, str):
        comments_text = comments
    else:
        comments_text = "".join(c.get("text", "") for c in comments)
    text = (task.get("description") or "") + "\n" + comments_text
    m = PR_URL_RE.search(text)
    if m:
        return f"https://github.com/{m.group(1)}/{m.group(2)}/pull/{m.group(3)}"
    return None


def parse_github_pr_url(url: str) -> tuple[str, str, int] | None:
    m = PR_URL_RE.search(url)
    if m:
        return m.group(1), m.group(2), int(m.group(3))
    return None


# --- GitHub API
def github_request(path: str, token: str) -> dict | None:
    """GET GitHub API path (e.g. /repos/owner/repo/pulls/123). path is path after api.github.com."""
    url = f"https://api.github.com{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except Exception:
        return None


def github_commit_status(owner: str, repo: str, sha: str, token: str) -> dict | None:
    return github_request(f"/repos/{owner}/{repo}/commits/{sha}/status", token)


def github_check_runs(owner: str, repo: str, ref: str, token: str) -> dict | None:
    return github_request(f"/repos/{owner}/{repo}/commits/{ref}/check-runs", token)


def pr_tests_passing(owner: str, repo: str, head_sha: str, token: str) -> tuple[bool, str]:
    """Check combined status and check runs. Returns (passing, message).
    Fails closed: if GitHub API is unavailable, treat as not passing."""
    # Check commit status first
    status = github_commit_status(owner, repo, head_sha, token)
    if status is None:
        # API unavailable - fail closed (don't allow transition if we can't verify)
        return False, "GitHub API unavailable; cannot verify commit status"
    state = (status.get("state") or "").lower()
    if state == "success":
        return True, ""
    if state == "pending":
        return False, "GitHub reports this commit's status as pending; wait for all required checks on the PR to finish before moving the task forward"
    if state == "failure" or state == "error":
        return False, "One or more checks failed"
    # Fall through to check runs if status returned but wasn't conclusive
    runs = github_check_runs(owner, repo, head_sha, token)
    if runs is None:
        # API unavailable - fail closed
        return False, "GitHub API unavailable; cannot verify check runs"
    if runs and "check_runs" in runs:
        for run in runs.get("check_runs", []):
            conclusion = (run.get("conclusion") or "").lower()
            if conclusion == "failure" or conclusion == "cancelled" or conclusion == "timed_out":
                return False, f"Check failed: {run.get('name', 'unknown')}"
            if conclusion == "" and (run.get("status") or "").lower() == "in_progress":
                return False, "GitHub check runs are still in progress; wait for them to complete in the PR before moving the task forward"
    return True, ""


def pr_merged_to_main(owner: str, repo: str, pull_number: int, token: str) -> tuple[bool, str]:
    pr = github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}", token)
    if not pr:
        return False, "Could not fetch PR"
    merged = pr.get("merged") is True
    base_ref = (pr.get("base", {}).get("ref") or "").strip()
    if not merged:
        return False, "PR is not merged"
    if base_ref.lower() != "main":
        return False, f"PR base branch is {base_ref}, not main"
    return True, ""


def pr_branch_deleted(owner: str, repo: str, head_ref: str, token: str) -> tuple[bool, str]:
    """Check if branch no longer exists (merged and deleted).
    Returns (deleted, error_message). Errors are treated as blocking - return False."""
    # GET /repos/{owner}/{repo}/branches/{branch} -> 404 if deleted
    try:
        branch_ref = head_ref.replace("refs/heads/", "")
        data = github_request(f"/repos/{owner}/{repo}/branches/{urllib.request.quote(branch_ref)}", token)
        if data is None:
            # 404 means branch was deleted - that's what we want
            return True, ""
        # Branch still exists
        return False, f"Branch '{branch_ref}' still exists"
    except Exception as e:
        # API error - treat as blocking (don't allow transition if we can't verify)
        return False, f"GitHub API error checking branch: {e}"


# --- AC parsing from task description
def task_ac_lines(description: str) -> list[str]:
    """Extract AC checkbox lines from **AC:** section."""
    if not description:
        return []
    ac_match = re.search(r"\*\*AC:\*\*\s*(.+?)(?=\n\*\*|\Z)", description, re.IGNORECASE | re.DOTALL)
    if not ac_match:
        return []
    block = ac_match.group(1)
    return [line.strip() for line in block.splitlines() if re.match(r"^\s*-\s*\[[\sx]\].+", line)]


def pr_has_all_ac_checked(pr_body: str, task_ac_lines: list[str]) -> tuple[bool, list[str]]:
    """PR body must contain each task AC as checked (- [x]) with matching text.

    Matching is done on normalized text (case-insensitive, collapsed whitespace)
    for the content after the checkbox.
    Returns (ok, failed_messages).
    """
    failed: list[str] = []
    body = pr_body or ""
    # Collect all checked AC lines from PR body
    pr_checked: list[str] = []
    for line in body.splitlines():
        if re.match(r"^\s*-\s*\[\s*x\s*\]", line, flags=re.IGNORECASE):
            content = re.sub(r"^\s*-\s*\[\s*x\s*\]\s*", "", line, flags=re.IGNORECASE).strip()
            if content:
                # Normalize: lower, collapse internal whitespace
                norm = re.sub(r"\s+", " ", content).strip().lower()
                pr_checked.append(norm)
    for ac in task_ac_lines:
        ac_content = re.sub(r"^\s*-\s*\[[\sx]\]\s*", "", ac, flags=re.IGNORECASE).strip()
        if not ac_content:
            continue
        norm_ac = re.sub(r"\s+", " ", ac_content).strip().lower()
        # Match if PR checked line starts with the task AC text (to allow suffixes like testID/not tested)
        if not any(pr_line.startswith(norm_ac) for pr_line in pr_checked):
            failed.append(f"PR description missing matching checked AC line for task AC: {ac_content[:120]}")
    return len(failed) == 0, failed


def check_doing_to_acceptance(task: dict, token: str | None) -> tuple[list[str], str]:
    failed = []
    pr_url = find_pr_url(task)
    desc = task.get("description") or ""
    ac_lines = task_ac_lines(desc)

    # Flat list of criteria: always return all criteria, even if some cannot be
    # evaluated yet (missing PR link/token/etc). This prevents agents from
    # "unlocking" new criteria after resolving one item.

    pr: dict | None = None
    owner = repo = ""
    pull_number: int | None = None

    if not pr_url:
        failed.append(MSG["ACCEPTANCE"]["PR"]["NO_LINK"])
        failed.append(MSG["ACCEPTANCE"]["PR"]["BLOCKED_NO_PR"])
        failed.append(MSG["ACCEPTANCE"]["TESTS"]["NOT_PASSING_NO_PR"])
        failed.append(MSG["ACCEPTANCE"]["PR"]["CANNOT_VALIDATE_URL_WITHOUT_LINK"])
        failed.append(MSG["ACCEPTANCE"]["PR"]["CANNOT_FETCH_WITHOUT_LINK"])
        failed.append(MSG["ACCEPTANCE"]["MERGE"]["CANNOT_EVALUATE_WITHOUT_PR"])
        failed.append(MSG["ACCEPTANCE"]["TESTS"]["CANNOT_EVALUATE_WITHOUT_PR"])
    else:
        parsed = parse_github_pr_url(pr_url)
        if not parsed:
            failed.append(MSG["ACCEPTANCE"]["PR"]["INVALID_URL"])
        else:
            owner, repo, pull_number = parsed

    if not token:
        failed.append(MSG["ACCEPTANCE"]["GITHUB"]["NEEDS_TOKEN"])
        failed.append(MSG["ACCEPTANCE"]["MERGE"]["CANNOT_EVALUATE_WITHOUT_TOKEN"])
        failed.append(MSG["ACCEPTANCE"]["TESTS"]["CANNOT_EVALUATE_WITHOUT_TOKEN"])

    if not ac_lines:
        failed.append(MSG["ACCEPTANCE"]["AC"]["TASK_MISSING"])
        failed.append(MSG["ACCEPTANCE"]["AC"]["CANNOT_CHECK_PR_AC_WITHOUT_TASK_AC"])

    # If we have enough inputs, fetch the PR and run the deeper validations.
    if pr_url and token and owner and repo and pull_number is not None:
        pr = github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}", token)
        if not pr:
            failed.append(MSG["ACCEPTANCE"]["PR"]["COULD_NOT_FETCH"])
        else:
            # AC checks
            if ac_lines:
                _, ac_failures = pr_has_all_ac_checked(pr.get("body") or "", ac_lines)
                failed.extend(ac_failures)

            # Tests
            head_sha = (pr.get("head", {}).get("sha") or "").strip()
            if head_sha:
                passing, msg = pr_tests_passing(owner, repo, head_sha, token)
                if not passing:
                    failed.append(MSG["ACCEPTANCE"]["TESTS"]["NOT_PASSING_FMT"].format(msg=msg))
            else:
                failed.append(MSG["ACCEPTANCE"]["TESTS"]["MISSING_HEAD_SHA"])

            # Mergeability
            if pr.get("draft") is True:
                failed.append(MSG["ACCEPTANCE"]["MERGE"]["IS_DRAFT"])
            mergeable_state = (pr.get("mergeable_state") or "").lower()
            if mergeable_state == "behind":
                failed.append(MSG["ACCEPTANCE"]["MERGE"]["BEHIND"])
            elif mergeable_state == "blocked":
                failed.append(MSG["ACCEPTANCE"]["MERGE"]["BLOCKED"])

            # Preferred: at least 1 E2E per AC (soft)
            pr_body = pr.get("body") or ""
            if ac_lines and "testID:" not in pr_body and "not tested:" not in pr_body.lower():
                failed.append(MSG["ACCEPTANCE"]["PREFERRED"]["E2E"])

    if not pr_url:
        return failed, MSG["ACCEPTANCE"]["PR"]["REASON_NO_PR"]
    if not token:
        return failed, MSG["ACCEPTANCE"]["GITHUB"]["REASON_NEEDS_TOKEN"]
    reason = MSG["ACCEPTANCE"]["REASON"]["NOT_READY"] if failed else ""
    return failed, reason


def check_acceptance_to_done(task: dict, token: str | None) -> tuple[list[str], str]:
    failed = []
    pr_url = find_pr_url(task)
    parsed = parse_github_pr_url(pr_url) if pr_url else None
    owner = repo = ""
    pull_number: int | None = None
    if parsed:
        owner, repo, pull_number = parsed

    # Flat criteria: always include downstream criteria, even if we can't
    # evaluate them yet, so agents don't "unlock" new checks after resolving one.
    if not pr_url:
        failed.append(MSG["DONE"]["PR"]["NO_LINK"])
        failed.append(MSG["DONE"]["PR"]["CANNOT_CHECK_MERGE_WITHOUT_LINK"])
        failed.append(MSG["DONE"]["TESTS"]["CANNOT_EVALUATE_WITHOUT_PR"])
    if not token:
        failed.append(MSG["DONE"]["GITHUB"]["NEEDS_TOKEN"])
        failed.append(MSG["DONE"]["TESTS"]["CANNOT_EVALUATE_WITHOUT_TOKEN"])
    if pr_url and not parsed:
        failed.append(MSG["DONE"]["PR"]["INVALID_URL"])

    merged_ok = False
    if pr_url and token and parsed and pull_number is not None:
        merged_ok, merged_msg = pr_merged_to_main(owner, repo, pull_number, token)
        if not merged_ok:
            failed.append(merged_msg)

    pr = None
    if pr_url and token and parsed and pull_number is not None:
        pr = github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}", token)
        if pr is None:
            failed.append(MSG["DONE"]["PR"]["COULD_NOT_FETCH"])

    # PR tests should be evaluated on the PR head SHA (merge request checks),
    # regardless of whether the PR is merged yet.
    if pr:
        head_sha = (pr.get("head", {}).get("sha") or "").strip()
        if head_sha:
            passing, msg = pr_tests_passing(owner, repo, head_sha, token)
            if not passing:
                failed.append(MSG["DONE"]["TESTS"]["NOT_PASSING_FMT"].format(msg=msg))
        else:
            failed.append(MSG["DONE"]["TESTS"]["MISSING_HEAD_SHA"])

    if merged_ok and pr:
        merge_sha = (pr.get("merge_commit_sha") or "").strip()
        if merge_sha:
            passing, msg = pr_tests_passing(owner, repo, merge_sha, token)
            if not passing:
                failed.append(MSG["DONE"]["TESTS"]["NOT_PASSING_FMT"].format(msg=msg))
        else:
            failed.append(MSG["DONE"]["TESTS"]["MISSING_MERGE_SHA"])

        head_ref = (pr.get("head", {}).get("ref") or "").strip()
        if head_ref:
            branch_deleted, branch_msg = pr_branch_deleted(owner, repo, head_ref, token)
            if not branch_deleted:
                failed.append(MSG["DONE"]["BRANCH"]["NOT_CLEANED_UP_FMT"].format(msg=branch_msg))

    if not pr_url:
        return failed, MSG["DONE"]["PR"]["REASON_NO_LINK"]
    if not token:
        return failed, MSG["DONE"]["GITHUB"]["REASON_NEEDS_TOKEN"]
    if pr_url and not parsed:
        return failed, MSG["DONE"]["PR"]["REASON_INVALID_URL"]
    if not merged_ok:
        return failed, MSG["DONE"]["PR"]["REASON_NOT_MERGED"]
    reason = MSG["DONE"]["REASON"]["NOT_READY"] if failed else ""
    return failed, reason


def run_transition_check(task_id: str) -> dict[str, Any]:
    base_url = os.getenv("TASKS_API_BASE_URL", "").strip()
    if not base_url:
        return {
            "task_id": task_id,
            "error": MSG["SYSTEM"]["API"]["MISSING_TASKS_API_BASE_URL"],
            "failed_criteria": [],
            "reason": MSG["SYSTEM"]["API"]["REASON_MISSING_TASKS_API_BASE_URL"],
        }
    try:
        task = get_task(task_id, base_url=base_url)
    except Exception as e:
        return {
            "task_id": task_id,
            "error": str(e),
            "failed_criteria": [],
            "reason": MSG["SYSTEM"]["API"]["REASON_FAILED_TO_LOAD_TASK"],
        }
    if not task or not task.get("id"):
        return {
            "task_id": task_id,
            "error": MSG["SYSTEM"]["API"]["TASK_NOT_FOUND"],
            "failed_criteria": [],
            "reason": MSG["SYSTEM"]["API"]["REASON_TASK_NOT_FOUND"],
        }
    current = resolve_current_state(task)
    failed = []
    reason = ""
    if current == "Open":
        failed, reason = check_open_to_ready(task)
        next_state = "Ready"
    elif current == "Ready":
        failed, reason = check_ready_to_doing(task, base_url)
        next_state = "Doing"
    elif current == "Doing":
        failed, reason = check_doing_to_acceptance(task, os.getenv("GITHUB_TOKEN"))
        next_state = "Acceptance"
    elif current == "Acceptance":
        failed, reason = check_acceptance_to_done(task, os.getenv("GITHUB_TOKEN"))
        next_state = "Done"
    else:
        next_state = ""
        reason = MSG["TERMINAL"]["REASON"]
    return {
        "task_id": task_id,
        "current_state": current,
        "next_state": next_state or None,
        "failed_criteria": failed,
        "reason": reason if failed else (reason or MSG["GENERIC"]["READY_FOR_TRANSITION"]),
    }


def _csv_escape_field(value: str) -> str:
    # Always quote to keep the format stable (and tolerate commas/newlines).
    return '"' + value.replace('"', '""') + '"'


def append_transition_log(task_id: str, payload: dict[str, Any]) -> None:
    """Append a single CSV row: timestamp, taskId, current_state, json."""
    # Static, stable path relative to repo root.
    log_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "memory", "task-transition-check.csv")
    )
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    ts = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    current_state = ""
    if isinstance(payload, dict):
        # Payloads from run_transition_check include current_state when available.
        cs = payload.get("current_state")
        if isinstance(cs, str):
            current_state = cs

    json_str = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    line = ",".join(
        [
            _csv_escape_field(ts),
            _csv_escape_field(task_id),
            _csv_escape_field(current_state),
            _csv_escape_field(json_str),
        ]
    ) + "\n"

    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        # Never break the checker due to logging problems.
        return


def main():
    if len(sys.argv) < 2:
        out = {"error": MSG["SYSTEM"]["USAGE"]["ERROR"]}
        append_transition_log("", out)
        print(json.dumps(out, indent=2))
        sys.exit(1)
    task_id = sys.argv[1].strip()
    out = run_transition_check(task_id)
    append_transition_log(task_id, out)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
