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

from agents.lib import safe_popen, safe_run

SCRIPT_DIR = Path(__file__).resolve().parent
FEATURE_TASK_PIPELINE = SCRIPT_DIR / "feature-task.lobster.yaml"
CODE_TASK_PIPELINE = SCRIPT_DIR / "code-task.lobster.yaml"
# Kept for backwards compatibility with any caller that imports `PIPELINE`.
PIPELINE = FEATURE_TASK_PIPELINE
CODEBASE_REPO = SCRIPT_DIR.parent.parent.parent
_ff_env = os.environ.get("FEATURE_FACTORY_REPO")
FEATURE_FACTORY_REPO = Path(_ff_env) if _ff_env else None
REPO = FEATURE_FACTORY_REPO if (FEATURE_FACTORY_REPO and FEATURE_FACTORY_REPO.exists()) else CODEBASE_REPO
_workspace_env = os.environ.get("OPENCLAW_WORKSPACE_ROOT")
if _workspace_env:
    WORKSPACE_ROOT = Path(_workspace_env)
else:
    WORKSPACE_ROOT = CODEBASE_REPO.parents[1] if len(CODEBASE_REPO.parents) > 1 else CODEBASE_REPO.parent
DEFAULT_BASE_URL = "http://localhost:4001/api/v1"
PATH_PREFIXES = [
    str(Path.home() / ".cargo" / "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
]


def _load_dotenv_token(key: str) -> str:
    dotenv = Path.home() / ".openclaw" / ".env"
    try:
        for line in dotenv.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def workflow_env() -> dict[str, str]:
    env = os.environ.copy()
    existing_path = env.get("PATH", "")
    path_parts = [path for path in PATH_PREFIXES if Path(path).exists()]
    if existing_path:
        path_parts.append(existing_path)
    env["PATH"] = os.pathsep.join(path_parts)
    if not env.get("GH_TOKEN") and not env.get("GITHUB_TOKEN"):
        token = _load_dotenv_token("LOBSTER_GITHUB_TOKEN")
        if token:
            env["GH_TOKEN"] = token
    # The reconciliation command acts only on Tom's explicit checked marker
    # in a brain spec file, using the dedicated `brain_spec_reconciler`
    # service credential (server-scoped to `spec` only, never `Tom` — see
    # ACTOR_PERMISSIONS in services/tasks-api/src/middleware/approvalAuth.ts).
    # The API still derives actor/permissions and remains the authoritative
    # gate store; this is not the same token as TASKS_API_APPROVAL_TOKEN
    # (Quinn's tech_design-only credential), which the server rejects with
    # APPROVAL_TYPE_FORBIDDEN for `spec` mutations.
    if not env.get("TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN"):
        token = _load_dotenv_token("TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN")
        if token:
            env["TASKS_API_BRAIN_SPEC_RECONCILER_TOKEN"] = token
    return env


def api_get(base_url: str, path: str) -> dict[str, Any]:
    with urllib.request.urlopen(base_url.rstrip("/") + path, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def list_tasks(base_url: str, status: str, limit: int) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"status": status, "limit": limit})
    payload = api_get(base_url, f"/tasks?{query}")
    data = payload.get("data", [])
    return data if isinstance(data, list) else []


def discover_tasks(base_url: str, limit: int) -> list[dict[str, Any]]:
    """Return every active feature or code task, paired with the pipeline YAML
    that should run for it.

    A task is dispatchable if:
      * `taskType == "feature"` (with or without the `feature-factory` tag),
        routed to `feature-task.lobster.yaml`; or
      * `taskType == "code"`, routed to `code-task.lobster.yaml`.

    Each task is returned exactly once even if it appears in multiple status
    lists.
    """
    tasks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for status in ("open", "ready", "doing", "acceptance"):
        for task in list_tasks(base_url, status, limit):
            tags = task.get("tags") if isinstance(task.get("tags"), list) else []
            task_type = task.get("taskType")
            if task_type == "code":
                pipeline = CODE_TASK_PIPELINE
            elif task_type == "feature" or "feature-factory" in tags:
                pipeline = FEATURE_TASK_PIPELINE
            else:
                continue
            task_id = str(task.get("id") or "")
            if not task_id or task_id in seen:
                continue
            seen.add(task_id)
            task["_pipeline"] = str(pipeline)
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


def run_workflow(task_id: str, base_url: str, dry_run: bool, pipeline: Path) -> dict[str, Any]:
    args_json = json.dumps(
        {
            "taskId": task_id,
            "tasksApiBaseUrl": base_url,
            "sindustriesRepo": str(REPO),
            "workspaceRoot": str(WORKSPACE_ROOT),
            "dryRun": dry_run,
        }
    )
    cmd = ["lobster", "run", "--mode", "tool", str(pipeline), "--args-json", args_json]
    proc = safe_popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=workflow_env())
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


def run_brain_spec_approval_reconciliation(base_url: str, dry_run: bool) -> dict[str, Any]:
    cmd = [
        "cargo",
        "run",
        "--manifest-path",
        str(REPO / "agents/workflows/feature-task/Cargo.toml"),
        "--",
        "reconcile-brain-spec-approvals",
        "--base-url",
        base_url,
        "--dry-run",
        str(dry_run).lower(),
        "--workspace-root",
        str(WORKSPACE_ROOT),
    ]
    proc = safe_run(cmd, text=True, capture_output=True, env=workflow_env())
    result: dict[str, Any] = {
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    if proc.returncode != 0:
        result["error"] = (proc.stderr or proc.stdout or "brain spec approval reconciliation failed").strip()
        return result
    try:
        result["envelope"] = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        result["error"] = f"Could not parse brain spec approval reconciliation envelope: {exc}"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one feature-task workflow pass for every active feature task")
    parser.add_argument("--base-url", default=os.environ.get("TASKS_API_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    reconciliation = run_brain_spec_approval_reconciliation(args.base_url, args.dry_run)
    tasks = discover_tasks(args.base_url, args.limit)
    results = [
        run_workflow(
            str(task["id"]),
            args.base_url,
            args.dry_run,
            Path(task["_pipeline"]),
        )
        for task in tasks
    ]
    errors = [result for result in results if result.get("returncode") != 0 or result.get("error")]
    reconciliation_envelope = reconciliation.get("envelope") or {}
    if (
        reconciliation.get("returncode") != 0
        or reconciliation.get("error")
        or reconciliation_envelope.get("criteriaMet") is False
    ):
        errors.insert(0, reconciliation)
    pipelines = sorted({task.get("_pipeline", str(PIPELINE)) for task in tasks})
    print(
        json.dumps(
            {
                "ok": not errors,
                "pipelines": pipelines,
                "count": len(tasks),
                "brainSpecApprovalReconciliation": reconciliation,
                "results": results,
                "errors": errors,
            },
            indent=2,
        )
    )
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
