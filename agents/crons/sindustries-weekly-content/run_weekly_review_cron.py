#!/usr/bin/env python3
"""
Cron entry point for the SIndustries weekly content review.

Runs sindustries-weekly-content.lobster.yaml, which collects weekly ops notes,
distils them via llm_task.invoke, writes the review file, and creates a content task.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

WORKSPACE = Path(__file__).resolve().parents[5]
PIPELINE = Path(__file__).resolve().parent / "sindustries-weekly-content.lobster.yaml"
OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"

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


def openclaw_config() -> dict[str, Any]:
    if not OPENCLAW_CONFIG.exists():
        return {}
    try:
        return json.loads(OPENCLAW_CONFIG.read_text())
    except json.JSONDecodeError:
        return {}


def run_lobster(args: dict) -> int:
    config = openclaw_config()
    gateway_port = os.environ.get("OPENCLAW_GATEWAY_PORT") or str(config.get("gateway", {}).get("port") or "18789")
    gateway_token = os.environ.get("OPENCLAW_TOKEN") or config.get("gateway", {}).get("auth", {}).get("token")
    env = {
        **os.environ,
        "OPENCLAW_URL": os.environ.get("OPENCLAW_URL") or f"http://localhost:{gateway_port}",
        "TASKS_API_BASE_URL": os.environ.get("TASKS_API_BASE_URL", "http://localhost:4001/api/v1"),
    }
    if gateway_token:
        env["OPENCLAW_TOKEN"] = gateway_token
    cmd = [
        "lobster", "run",
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
    return proc.returncode


def main() -> None:
    args = dict(DEFAULT_ARGS)
    if "--dry-run" in sys.argv:
        args["dryRun"] = True

    log("weekly review cron starting")
    rc = run_lobster(args)
    if rc != 0:
        log(f"lobster failed with exit code {rc}")
        sys.exit(rc)
    log("weekly review cron complete")


if __name__ == "__main__":
    main()
