#!/usr/bin/env python3
"""
Cron entry point for the SIndustries weekly content review.

Runs sindustries-weekly-content.lobster.yaml in tool mode. If the lobster
pauses at the approval gate (prompting Tom for his weekly notes), saves the
resumeToken to brain/state/weekly-content-pending.json and exits 0. The cron
prompt agent then messages Tom; Quinn's main session calls lobster resume when
Tom replies.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import date, datetime, timezone
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]
PIPELINE = Path(__file__).resolve().parent / "sindustries-weekly-content.lobster.yaml"
PENDING_STATE_PATH = WORKSPACE / "brain" / "state" / "weekly-content-pending.json"

DEFAULT_ARGS = {
    "reviewsRoot": "brain/content/sindustries-weekly-content",
    "dryRun": False,
}


def log(message: str) -> None:
    print(f"[weekly-review-cron] {message}", flush=True)


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


def run_lobster(args: dict) -> tuple[int, str]:
    env = {
        **os.environ,
        "TASKS_API_BASE_URL": os.environ.get("TASKS_API_BASE_URL", "http://localhost:4001/api/v1"),
    }
    cmd = [
        "lobster", "run",
        "--mode", "tool",
        "--file", str(PIPELINE),
        "--args-json", json.dumps(args),
    ]
    log(f"starting lobster: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(WORKSPACE),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=1,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    t1 = threading.Thread(target=_stream_reader, args=(proc.stdout, "lobster:stdout", stdout_lines))
    t2 = threading.Thread(target=_stream_reader, args=(proc.stderr, "lobster:stderr", stderr_lines))
    t1.start()
    t2.start()
    proc.wait()
    t1.join()
    t2.join()
    log(f"lobster exited with code {proc.returncode}")
    return proc.returncode, "".join(stdout_lines)


def main() -> None:
    args = dict(DEFAULT_ARGS)
    if "--dry-run" in sys.argv:
        args["dryRun"] = True

    log("weekly review cron starting")
    rc, raw_output = run_lobster(args)

    if rc != 0:
        log(f"lobster failed with exit code {rc}")
        sys.exit(rc)

    try:
        envelope = json.loads(raw_output.strip())
    except json.JSONDecodeError as exc:
        log(f"failed to parse lobster output: {exc}")
        sys.exit(1)

    status = envelope.get("status")
    log(f"lobster status: {status}")

    if status == "needs_approval":
        req = envelope.get("requiresApproval") or {}
        prompt_text = req.get("prompt", "")
        resume_token = req.get("resumeToken", "")

        if not resume_token:
            log("approval gate returned no resumeToken")
            sys.exit(1)

        PENDING_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PENDING_STATE_PATH.write_text(json.dumps({
            "resumeToken": resume_token,
            "prompt": prompt_text,
            "week": str(date.today()),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }, indent=2))
        log(f"resumeToken saved to {PENDING_STATE_PATH}")

        # Output for the cron agent to use
        print(json.dumps({
            "status": "needs_approval",
            "prompt": prompt_text,
        }))
        log("waiting for Tom's input via infra channel")

    elif status in ("ok", "done", "complete"):
        if PENDING_STATE_PATH.exists():
            PENDING_STATE_PATH.unlink()
        log("weekly review cron complete")
        print(json.dumps({"status": "done"}))

    else:
        log(f"unexpected lobster status: {status}")
        sys.exit(1)


if __name__ == "__main__":
    main()
