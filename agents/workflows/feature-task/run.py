#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE = SCRIPT_DIR / "feature-task.lobster.yaml"
REPO = SCRIPT_DIR.parent.parent.parent
WORKSPACE_ROOT = Path("/Users/quinnstoffer/.openclaw/workspace")
if not WORKSPACE_ROOT.exists():
    WORKSPACE_ROOT = REPO.parents[1] if len(REPO.parents) > 1 else REPO.parent
DEFAULT_BASE_URL = "http://localhost:4001/api/v1"


def api_get(base_url: str, path: str) -> dict[str, Any]:
    with urllib.request.urlopen(base_url.rstrip("/") + path, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def list_tasks(base_url: str, status: str, limit: int) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"status": status, "limit": limit})
    payload = api_get(base_url, f"/tasks?{query}")
    data = payload.get("data", [])
    return data if isinstance(data, list) else []


def discover_tasks(base_url: str, limit: int) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for status in ("open", "ready", "doing", "acceptance"):
        for task in list_tasks(base_url, status, limit):
            tags = task.get("tags") if isinstance(task.get("tags"), list) else []
            if task.get("taskType") != "feature" and "feature-factory" not in tags:
                continue
            task_id = str(task.get("id") or "")
            if task_id and task_id not in seen:
                seen.add(task_id)
                tasks.append(task)
    return tasks


def stream_reader(pipe, prefix: str, sink: list[str]) -> None:
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


def run_workflow(task_id: str, base_url: str, dry_run: bool) -> dict[str, Any]:
    args_json = json.dumps(
        {
            "taskId": task_id,
            "tasksApiBaseUrl": base_url,
            "sindustriesRepo": str(REPO),
            "workspaceRoot": str(WORKSPACE_ROOT),
            "dryRun": dry_run,
        }
    )
    cmd = ["lobster", "run", "--mode", "tool", str(PIPELINE), "--args-json", args_json]
    proc = subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ.copy())
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    threads = [
        threading.Thread(target=stream_reader, args=(proc.stdout, f"{task_id}:stdout", stdout_lines)),
        threading.Thread(target=stream_reader, args=(proc.stderr, f"{task_id}:stderr", stderr_lines)),
    ]
    for thread in threads:
        thread.start()
    returncode = proc.wait()
    for thread in threads:
        thread.join()
    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    result: dict[str, Any] = {"taskId": task_id, "returncode": returncode, "stdout": stdout, "stderr": stderr}
    if returncode == 0 and stdout.strip():
        try:
            result["envelope"] = json.loads(stdout)
        except json.JSONDecodeError as exc:
            result["error"] = f"Could not parse feature-task JSON envelope: {exc}"
    elif returncode != 0:
        result["error"] = (stderr or stdout or "feature-task run failed").strip()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one feature-task workflow pass for every active feature task")
    parser.add_argument("--base-url", default=os.environ.get("TASKS_API_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    tasks = discover_tasks(args.base_url, args.limit)
    results = [run_workflow(str(task["id"]), args.base_url, args.dry_run) for task in tasks]
    errors = [result for result in results if result.get("returncode") != 0 or result.get("error")]
    print(json.dumps({"ok": not errors, "pipeline": str(PIPELINE), "count": len(tasks), "results": results, "errors": errors}, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
