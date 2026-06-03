#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import select
import subprocess
import sys
from pathlib import Path
from typing import Any

WORKSPACE = Path("/Users/quinnstoffer/.openclaw/workspace")
TASKS_CLIENT_DIR = WORKSPACE / "codebases" / "sindustries" / "agents" / "skills" / "tasks-api-ops"
if str(TASKS_CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(TASKS_CLIENT_DIR))

from tasks_api_client import api_request, get_base_url, get_task, list_tasks  # noqa: E402

STATE_TAG = "[lobster-state]"
IVY_PRS_TAG = "[ivy-prs]"
AUTHOR = "Lobster"
STATUS_ORDER = {"open": 0, "ready": 1, "doing": 2, "acceptance": 3, "done": 4}
PR_URL_RE = re.compile(r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\d+)", re.I)
PR_HEADING_RE = re.compile(r"^\s{0,3}#{1,4}\s+.*\bPR\b.*$", re.I | re.M)
OWNER_HEADING_RE = re.compile(r"^\s{0,3}#{1,4}\s+.*\b(Tom|Quinn)\b.*$", re.I | re.M)
CHECKBOX_RE = re.compile(r"^\s*-\s*\[([ xX])\]\s+(.+\S)\s*$", re.M)


def log_debug(message: str) -> None:
    print(f"[content-task-workflow] {message}", file=sys.stderr, flush=True)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def dump_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def read_first_json_value(stream: Any, timeout_seconds: float = 5.0) -> Any:
    decoder = json.JSONDecoder()
    buffer = ""
    try:
        fd = stream.fileno()
    except (AttributeError, io.UnsupportedOperation):
        return json.load(stream)
    while True:
        ready, _, _ = select.select([fd], [], [], timeout_seconds)
        if not ready:
            if buffer.strip():
                return decoder.raw_decode(buffer.lstrip())[0]
            raise TimeoutError("timed out waiting for JSON on stdin")
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        buffer += chunk.decode("utf-8")
        stripped = buffer.lstrip()
        if not stripped:
            continue
        try:
            return decoder.raw_decode(stripped)[0]
        except json.JSONDecodeError:
            continue
    if not buffer.strip():
        raise json.JSONDecodeError("Expecting value", buffer, 0)
    return decoder.raw_decode(buffer.lstrip())[0]


def task_comments(task: dict[str, Any]) -> list[dict[str, Any]]:
    comments = task.get("comments")
    return comments if isinstance(comments, list) else []


def comment_text(comment: dict[str, Any]) -> str:
    value = comment.get("text")
    if value is None:
        value = comment.get("body")
    return value if isinstance(value, str) else ""


def parse_lobster_state(task: dict[str, Any]) -> dict[str, Any]:
    latest: dict[str, Any] = {}
    for comment in task_comments(task):
        text = comment_text(comment)
        if STATE_TAG not in text:
            continue
        after = text.split(STATE_TAG, 1)[1].strip()
        if after.startswith("```"):
            after = re.sub(r"^```(?:json)?\s*", "", after, flags=re.I)
            after = re.sub(r"\s*```\s*$", "", after)
        try:
            parsed = json.loads(after)
        except Exception:
            continue
        if isinstance(parsed, dict):
            latest = parsed
    latest.setdefault("version", 1)
    latest.setdefault("prUrls", [])
    return latest


def normalize_state(state: dict[str, Any]) -> dict[str, Any]:
    out = dict(state)
    urls = []
    for value in out.get("prUrls") or []:
        if isinstance(value, str) and value not in urls:
            urls.append(value)
    out["prUrls"] = urls
    out.setdefault("version", 1)
    out["updatedAt"] = now_iso()
    return out


def add_comment(task_id: str, text: str, base_url: str | None = None) -> dict[str, Any]:
    base = base_url or get_base_url()
    return api_request("POST", base, f"/tasks/{task_id}/comments", {"author": AUTHOR, "text": text})


def write_lobster_state(task_id: str, state: dict[str, Any], note: str | None = None, base_url: str | None = None) -> dict[str, Any]:
    state = normalize_state(state)
    body = f"{STATE_TAG}\n```json\n{json.dumps(state, indent=2, sort_keys=True)}\n```"
    if note:
        body = f"{note}\n\n{body}"
    return add_comment(task_id, body, base_url=base_url)


def patch_task(task_id: str, payload: dict[str, Any], base_url: str | None = None) -> dict[str, Any]:
    base = base_url or get_base_url()
    resp = api_request("PATCH", base, f"/tasks/{task_id}", payload)
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return resp["data"]
    return resp if isinstance(resp, dict) else {}


def refresh_task(task_id: str, base_url: str | None = None) -> dict[str, Any]:
    return get_task(task_id, base_url=base_url)


def status(task: dict[str, Any]) -> str:
    return str(task.get("status") or "open").strip().lower() or "open"


def is_past(task: dict[str, Any], stage: str) -> bool:
    return STATUS_ORDER.get(status(task), -1) > STATUS_ORDER[stage]


def is_at(task: dict[str, Any], stage: str) -> bool:
    return status(task) == stage


def transition_result(criteria_met: bool, already_past: bool, action_taken: str, task: dict[str, Any], **extra: Any) -> dict[str, Any]:
    out = {
        "criteria_met": bool(criteria_met),
        "already_past": bool(already_past),
        "action_taken": action_taken,
        "task": task,
    }
    out.update(extra)
    return out


def move_task(task: dict[str, Any], new_status: str, reason: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    task_id = str(task["id"])
    current = status(task)
    if current == new_status:
        return task
    updated = patch_task(task_id, {"status": new_status})
    note = f"Content task workflow moved `{current}` -> `{new_status}`. {reason}".strip()
    if state is not None:
        write_lobster_state(task_id, state, note=note)
    else:
        add_comment(task_id, note)
    return refresh_task(task_id)


def extract_pr_urls_from_text(text: str) -> list[str]:
    urls: list[str] = []
    for match in PR_URL_RE.finditer(text or ""):
        url = f"https://github.com/{match.group(1)}/{match.group(2)}/pull/{match.group(3)}"
        if url not in urls:
            urls.append(url)
    return urls


def pr_heading_blocks(description: str) -> list[str]:
    matches = list(PR_HEADING_RE.finditer(description or ""))
    blocks: list[str] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(description)
        blocks.append(description[start:end])
    return blocks


def pr_heading_block_url_failures(description: str) -> list[str]:
    failures: list[str] = []
    matches = list(PR_HEADING_RE.finditer(description or ""))
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(description or "")
        block = (description or "")[start:end]
        heading = match.group(0).strip()
        if not extract_pr_urls_from_text(heading + "\n" + block):
            failures.append(f"{heading} has no GitHub PR URL.")
    return failures


def owner_heading_blocks(description: str) -> list[str]:
    matches = list(OWNER_HEADING_RE.finditer(description or ""))
    blocks: list[str] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(description)
        blocks.append(description[start:end])
    return blocks


def owner_heading_block_url_failures(description: str) -> list[str]:
    failures: list[str] = []
    matches = list(OWNER_HEADING_RE.finditer(description or ""))
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(description or "")
        block = (description or "")[start:end]
        heading = match.group(0).strip()
        if not extract_pr_urls_from_text(heading + "\n" + block):
            failures.append(f"{heading} has no GitHub PR URL.")
    return failures


def task_acceptance_criteria(description: str) -> list[str]:
    criteria: list[str] = []
    for match in CHECKBOX_RE.finditer(description or ""):
        text = re.sub(r"\s+", " ", match.group(2)).strip()
        if text and text not in criteria:
            criteria.append(text)
    return criteria


def extract_ivy_pr_urls(task: dict[str, Any]) -> list[str]:
    # Only read the most recent [ivy-prs] comment — newer comment supersedes older ones
    latest = None
    for comment in task_comments(task):
        text = comment_text(comment)
        if IVY_PRS_TAG in text:
            latest = text
    if not latest:
        return []
    return list(dict.fromkeys(extract_pr_urls_from_text(latest)))


def parse_pr_url(url: str) -> tuple[str, str, str] | None:
    match = PR_URL_RE.search(url or "")
    if not match:
        return None
    return match.group(1), match.group(2), match.group(3)


def _run_gh_json(cmd: list[str]) -> Any:
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=30)
    error = (proc.stderr or proc.stdout or "").strip()
    if proc.returncode != 0 and os.environ.get("GITHUB_TOKEN") and ("HTTP 401" in error or "Bad credentials" in error):
        env = dict(os.environ)
        env.pop("GITHUB_TOKEN", None)
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=30, env=env)
        error = (proc.stderr or proc.stdout or "").strip()
    if proc.returncode != 0:
        raise RuntimeError(error or "gh command failed")
    return json.loads(proc.stdout or "null")


def gh_pr_view(url: str, fields: list[str]) -> dict[str, Any]:
    cmd = ["gh", "pr", "view", url, "--json", ",".join(fields)]
    data = _run_gh_json(cmd)
    return data if isinstance(data, dict) else {}


def gh_api(path: str) -> Any:
    return _run_gh_json(["gh", "api", path])


def _check_name(check: dict[str, Any]) -> str:
    return str(check.get("name") or check.get("context") or check.get("workflowName") or check.get("title") or check.get("app", {}).get("name") or "unnamed check")


def _check_state(check: dict[str, Any]) -> str:
    for key in ("state", "conclusion", "status"):
        value = check.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().upper()
    return "UNKNOWN"


def gh_pr_ci_checks(url: str) -> list[dict[str, str]]:
    pr = gh_pr_view(url, ["statusCheckRollup"])
    rollup = pr.get("statusCheckRollup")
    if not isinstance(rollup, list):
        return []
    checks: list[dict[str, str]] = []
    for item in rollup:
        if isinstance(item, dict):
            checks.append({"name": _check_name(item), "state": _check_state(item)})
    return checks


def gh_pr_ci_state(url: str) -> str:
    checks = gh_pr_ci_checks(url)
    if not checks:
        return "UNKNOWN"
    states = [check["state"] for check in checks]
    if all(state == "SUCCESS" for state in states):
        return "SUCCESS"
    if any(state in {"FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"} for state in states):
        return "FAILURE"
    if any(state in {"PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "EXPECTED"} for state in states):
        return "PENDING"
    return "UNKNOWN"


def gh_pr_body(url: str) -> str:
    pr = gh_pr_view(url, ["body"])
    body = pr.get("body")
    return body if isinstance(body, str) else ""


def gh_pr_review_decision(url: str) -> str:
    pr = gh_pr_view(url, ["reviewDecision"])
    decision = pr.get("reviewDecision")
    return decision.strip().upper() if isinstance(decision, str) and decision.strip() else "UNKNOWN"


def gh_pr_review_comments(url: str) -> list[dict[str, Any]]:
    parsed = parse_pr_url(url)
    if parsed is None:
        raise RuntimeError(f"Invalid GitHub PR URL: {url}")
    owner, repo, number = parsed
    comments = gh_api(f"repos/{owner}/{repo}/pulls/{number}/comments")
    return comments if isinstance(comments, list) else []


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def hours_since(value: str | None) -> float | None:
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return (dt.datetime.now(dt.timezone.utc) - parsed).total_seconds() / 3600
