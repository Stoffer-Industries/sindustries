#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = SCRIPT_DIR / "scripts"
PIPELINE = SCRIPT_DIR / "content-tasks.lobster.yaml"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from common import dump_json, list_tasks, log_debug  # noqa: E402


def _stream_reader(pipe, prefix: str, sink: list[str]) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if not line:
                break
            sink.append(line)
            text = line.rstrip("\n")
            if text:
                print(f"[{prefix}] {text}", file=sys.stderr, flush=True)
    finally:
        pipe.close()


def run_workflow(task_id: str, capacity_limit: int) -> dict:
    args_json = json.dumps({"taskId": task_id, "ivyCapacityLimit": capacity_limit})
    cmd = ["lobster", "run", "--mode", "tool", str(PIPELINE), "--args-json", args_json]
    log_debug("starting content-task pass for " + task_id)
    proc = subprocess.Popen(
        cmd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=os.environ.copy(),
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    stdout_thread = threading.Thread(target=_stream_reader, args=(proc.stdout, f"{task_id}:stdout", stdout_lines))
    stderr_thread = threading.Thread(target=_stream_reader, args=(proc.stderr, f"{task_id}:stderr", stderr_lines))
    stdout_thread.start()
    stderr_thread.start()
    returncode = proc.wait()
    stdout_thread.join()
    stderr_thread.join()
    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    result = {"taskId": task_id, "returncode": returncode, "stdout": stdout, "stderr": stderr}
    if returncode == 0 and stdout.strip():
        try:
            result["envelope"] = json.loads(stdout)
        except json.JSONDecodeError as exc:
            result["error"] = f"Could not parse content-task JSON envelope: {exc}"
    elif returncode != 0:
        result["error"] = (stderr or stdout or "content-task run failed").strip()
    return result


def discover_tasks(limit: int) -> list[dict]:
    tasks: list[dict] = []
    seen: set[str] = set()
    for state in ["open", "ready", "doing", "acceptance"]:
        for task in list_tasks(limit=limit, status=state):
            if task.get("taskType") != "content":
                continue
            task_id = str(task.get("id") or "")
            if task_id and task_id not in seen:
                seen.add(task_id)
                tasks.append(task)
    return tasks


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one content-task workflow pass for every active content task")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--capacity-limit", type=int, default=1)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    tasks = discover_tasks(args.limit)
    results = [run_workflow(str(task["id"]), args.capacity_limit) for task in tasks if task.get("id")]
    errors = [result for result in results if result.get("returncode") != 0 or result.get("error")]
    dump_json({"ok": not errors, "pipeline": str(PIPELINE), "count": len(tasks), "results": results, "errors": errors})
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
