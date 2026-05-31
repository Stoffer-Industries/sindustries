#!/usr/bin/env python3
"""
Cron entry point for the SIndustries weekly review.
Triggered every Friday 4pm NZST via OpenClaw cron.

Runs sindustries-weekly-review.lobster.yaml, which prompts Tom for his weekly
notes, creates the review file, and opens a PR against brain/reviews/.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[5]
PIPELINE = Path(__file__).resolve().parent / "sindustries-weekly-review.lobster.yaml"

DEFAULT_ARGS = {
    "reviewsRoot": "brain/reviews/website-content",
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


def run_lobster(args: dict) -> int:
    env = {**os.environ, "TASKS_API_BASE_URL": os.environ.get("TASKS_API_BASE_URL", "http://localhost:4001/api/v1")}

    cmd = ["lobster", "run", str(PIPELINE)]
    for k, v in args.items():
        cmd += [f"--{k}", str(v).lower() if isinstance(v, bool) else str(v)]

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
