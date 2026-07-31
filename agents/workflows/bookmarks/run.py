#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

_env_ws = os.environ.get("OPENCLAW_WORKSPACE", "").strip()
WORKSPACE = Path(_env_ws).resolve() if _env_ws else Path(__file__).resolve().parents[5]
PIPELINE = WORKSPACE / "codebases" / "sindustries" / "agents" / "workflows" / "bookmarks" / "bookmarks.lobster.yaml"
REQUEST_APPROVAL = WORKSPACE / "codebases" / "sindustries" / "agents" / "workflows" / "bookmarks" / "scripts" / "request_topic_approval.py"
STATE_PATH = WORKSPACE / "brain" / "state" / "bookmark-review-state.json"
DEFAULT_ARGS = {
    "sourceRoot": "brain/bookmarks/x",
    "reviewsRoot": "brain/bookmarks/summaries",
    "specsRoot": "brain/bookmarks/specs",
    "limit": 5,
    "source": "any",
    "dryRun": False,
    "approvalTopic": "general",
}


def log_progress(message: str) -> None:
    print(f"[bookmark-review-cron] {message}", flush=True)


def is_all_deduped(approval_result: dict) -> bool:
    """True when request_topic_approval.py delivered no new approvals because
    a global approval lock is already held (one topic outstanding blocks all
    others per policy). Healthy/expected state — not an error.

    Not every blocked package will carry this reason: packages beyond the
    first ready one are blocked by the unrelated "single approval per run
    policy" cap, so we check for *any* match rather than requiring *all* to
    match. A prior version required all() to match a reason string
    ("approval already pending for topic") that request_topic_approval.py
    never emits (it emits "approval already pending globally"), so this
    dedup path was unreachable whenever more than one ready package existed
    — every run fell through to the ambiguous needs_approval branch with an
    empty approvals list instead. See cron 1d8a3cf1 error streak, 2026-08-01.
    """
    new_approvals = approval_result.get("approvals") or []
    blocked = approval_result.get("blockedPackages") or []
    return not new_approvals and any(
        b.get("reason") == "approval already pending globally" for b in blocked
    )


def _stream_reader(pipe, prefix: str, sink: list[str]) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if not line:
                break
            sink.append(line)
            text = line.rstrip("\n")
            if text:
                print(f"[{prefix}] {text}", flush=True)
    finally:
        pipe.close()


def run(cmd: list[str], stdin_text: str | None = None, env: dict[str, str] | None = None, label: str | None = None) -> dict:
    label = label or Path(cmd[0]).name
    log_progress(f"starting {label}: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(WORKSPACE),
        text=True,
        stdin=subprocess.PIPE if stdin_text is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=1,
    )

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    stdout_thread = threading.Thread(target=_stream_reader, args=(proc.stdout, f"{label}:stdout", stdout_lines))
    stderr_thread = threading.Thread(target=_stream_reader, args=(proc.stderr, f"{label}:stderr", stderr_lines))
    stdout_thread.start()
    stderr_thread.start()

    if stdin_text is not None and proc.stdin is not None:
        proc.stdin.write(stdin_text)
        proc.stdin.close()

    returncode = proc.wait()
    stdout_thread.join()
    stderr_thread.join()

    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    log_progress(f"finished {label} with exit code {returncode}")
    if returncode != 0:
        detail = stderr.strip() or stdout.strip() or f"command failed: {' '.join(cmd)}"
        raise RuntimeError(f"workflow command failed ({returncode}): {detail}")
    raw = stdout.strip()
    if not raw:
        return {}
    return json.loads(raw)


def pending_approvals() -> list[dict]:
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    items = []
    for key, item in (state.get("items") or {}).items():
        if item.get("reviewStatus") != "approval_pending":
            continue
        items.append({
            "bookmarkKey": key,
            "title": item.get("title"),
            "approvalId": item.get("approvalId"),
            "approvalResumeToken": item.get("approvalResumeToken"),
            "topic": item.get("approvalTopic") or item.get("topic"),
        })
    return items


def main() -> int:
    env = os.environ.copy()
    env.setdefault("TASKS_API_BASE_URL", "http://localhost:4000/api/v1")
    log_progress(f"workspace={WORKSPACE}")
    log_progress(f"pipeline={PIPELINE}")
    log_progress(f"state_path={STATE_PATH}")
    log_progress(f"default_args={json.dumps(DEFAULT_ARGS, sort_keys=True)}")

    envelope = run(
        [
            "lobster",
            "run",
            "--mode",
            "tool",
            str(PIPELINE),
            "--args-json",
            json.dumps(DEFAULT_ARGS),
        ],
        env=env,
        label="lobster-run",
    )

    log_progress(f"lobster status={envelope.get('status')}")

    status = envelope.get("status")
    if status == "needs_approval":
        req = envelope.get("requiresApproval") or {}
        preview = req.get("preview")
        token = req.get("resumeToken")
        if not token:
            raise RuntimeError("Lobster approval gate returned no resumeToken")
        if not preview:
            raise RuntimeError("Lobster approval gate returned no preview payload")
        # Lobster may cap/truncate the preview string. Don't let a malformed
        # preview crash the cron — the underlying approval state lives on the
        # lobster side (resumeToken) and the next run can re-attempt. Log
        # clearly and exit gracefully so the cron state stays healthy.
        try:
            preview_data = json.loads(preview)
        except json.JSONDecodeError as exc:
            log_progress(
                f"lobster returned unparseable preview "
                f"({len(preview)} chars, error at char {exc.pos}: {exc.msg}); "
                f"exiting cleanly to let the next run retry"
            )
            print(json.dumps({
                "ok": False,
                "status": "preview_unparseable",
                "error": str(exc),
                "preview_length": len(preview),
                "resume_token": token,
                "reason": (
                    "Lobster preview was truncated or invalid JSON. The "
                    "underlying approval state is preserved (resumeToken "
                    "valid); the next cron run can re-attempt. Original "
                    "crash bug fixed in run_bookmark_curate.py."
                ),
            }))
            return 0
        if not isinstance(preview_data, dict):
            raise RuntimeError("Lobster approval preview was not a JSON object")
        preview_data["resumeToken"] = token
        log_progress("lobster requested approval; invoking request_topic_approval.py")
        approval_result = run(
            [sys.executable, str(REQUEST_APPROVAL), "--json"],
            stdin_text=json.dumps(preview_data),
            env=env,
            label="request-topic-approval",
        )
        pending = pending_approvals()
        log_progress(f"pending approval items after request: {len(pending)}")
        if not pending:
            # Not all spec cycles produce approval-ready items. This is expected when
            # no spec meets the threshold for review. Return gracefully, not as an error.
            print(json.dumps({
                "ok": True,
                "status": "no_approval_needed",
                "approval_attempted": True,
                "approval_result": approval_result,
                "reason": "request_topic_approval completed but no items reached approval threshold",
            }))
            return 0
        if not all(item.get("approvalResumeToken") for item in pending):
            print(json.dumps({
                "ok": False,
                "status": "partial_failure",
                "pending_items": pending,
                "reason": "approval_pending items exist but one or more are missing approvalResumeToken",
            }))
            return 1
        if is_all_deduped(approval_result):
            print(json.dumps({
                "ok": True,
                "status": "waiting_on_approval",
                "pending": pending,
                "reason": "approval already delivered and pending Tom reply; dedup prevented re-send",
            }))
            return 0
        print(json.dumps({
            "ok": True,
            "status": "needs_approval",
            "approval": approval_result,
            "pending": pending,
        }))
        return 0

    print(json.dumps({
        "ok": bool(envelope.get("ok")),
        "status": status,
        "envelope": envelope,
        "pending": pending_approvals(),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
