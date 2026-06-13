#!/usr/bin/env python3
"""JSON-backed lifecycle registry for delegated coding runs."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1
DEFAULT_WORKSPACE = Path(
    os.environ.get("OPENCLAW_WORKSPACE", "/Users/quinnstoffer/.openclaw/workspace")
)
DEFAULT_REGISTRY_PATH = DEFAULT_WORKSPACE / "brain" / "state" / "agent-runtime-registry.json"

STATUSES = {
    "registered",
    "running",
    "blocked",
    "approval_ready",
    "completed",
    "failed",
    "cancelled",
}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
ACTIVE_STATUSES = STATUSES - {"completed", "failed", "cancelled"}
ALLOWED_TRANSITIONS = {
    "registered": {"running", "blocked", "failed", "cancelled"},
    "running": {"blocked", "approval_ready", "completed", "failed", "cancelled"},
    "blocked": {"failed", "cancelled"},
    "approval_ready": {"running", "blocked", "completed", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}
REQUIRED_RUN_FIELDS = {
    "runId",
    "agentId",
    "taskLabel",
    "branchName",
    "worktreePath",
    "sessionId",
    "status",
    "retryCount",
    "prNumber",
    "lastHealthCheckAt",
    "blockedReason",
    "createdAt",
    "updatedAt",
}
OPTIONAL_UPDATE_FIELDS = {
    "agentId",
    "taskLabel",
    "branchName",
    "worktreePath",
    "sessionId",
    "prNumber",
    "lastHealthCheckAt",
    "blockedReason",
    "delegationPath",
    "model",
    "owner",
    "metadata",
}


class RegistryError(RuntimeError):
    """Base error for registry operations."""


class RegistryDataError(RegistryError):
    """The registry is missing, malformed, or violates its schema."""


class RegistryTransitionError(RegistryError):
    """A requested lifecycle transition is not allowed."""


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _validate_timestamp(value: Any, field: str, *, nullable: bool = False) -> None:
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value:
        raise RegistryDataError(f"{field} must be a non-empty ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RegistryDataError(f"{field} is not a valid ISO-8601 timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise RegistryDataError(f"{field} must include a timezone: {value!r}")


def _validate_run(run_id: str, run: Any) -> None:
    if not isinstance(run, dict):
        raise RegistryDataError(f"run {run_id!r} must be an object")
    missing = REQUIRED_RUN_FIELDS - run.keys()
    if missing:
        raise RegistryDataError(f"run {run_id!r} is missing fields: {sorted(missing)}")
    if run["runId"] != run_id:
        raise RegistryDataError(f"run key {run_id!r} does not match runId {run['runId']!r}")
    for field in ("agentId", "taskLabel", "branchName", "worktreePath", "sessionId"):
        if not isinstance(run[field], str) or not run[field].strip():
            raise RegistryDataError(f"run {run_id!r} field {field} must be a non-empty string")
    if run["status"] not in STATUSES:
        raise RegistryDataError(f"run {run_id!r} has unknown status {run['status']!r}")
    if not isinstance(run["retryCount"], int) or isinstance(run["retryCount"], bool) or run["retryCount"] < 0:
        raise RegistryDataError(f"run {run_id!r} retryCount must be a non-negative integer")
    if run["prNumber"] is not None and (
        not isinstance(run["prNumber"], int)
        or isinstance(run["prNumber"], bool)
        or run["prNumber"] <= 0
    ):
        raise RegistryDataError(f"run {run_id!r} prNumber must be a positive integer or null")
    if run["blockedReason"] is not None and not isinstance(run["blockedReason"], str):
        raise RegistryDataError(f"run {run_id!r} blockedReason must be a string or null")
    _validate_timestamp(run["lastHealthCheckAt"], f"run {run_id!r} lastHealthCheckAt", nullable=True)
    _validate_timestamp(run["createdAt"], f"run {run_id!r} createdAt")
    _validate_timestamp(run["updatedAt"], f"run {run_id!r} updatedAt")


def _validate_registry(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RegistryDataError("registry root must be an object")
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise RegistryDataError(
            f"unsupported schemaVersion {data.get('schemaVersion')!r}; expected {SCHEMA_VERSION}"
        )
    if not isinstance(data.get("runs"), dict):
        raise RegistryDataError("registry runs must be an object keyed by run ID")
    _validate_timestamp(data.get("updatedAt"), "registry updatedAt")
    for run_id, run in data["runs"].items():
        if not isinstance(run_id, str) or not run_id:
            raise RegistryDataError("registry run IDs must be non-empty strings")
        _validate_run(run_id, run)
    return data


def _read_registry(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise RegistryDataError(
            f"registry does not exist at {path}; run `python3 -m agents.runtime.registry init`"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RegistryDataError(
            f"registry at {path} contains malformed JSON at line {exc.lineno}, column {exc.colno}"
        ) from exc
    except OSError as exc:
        raise RegistryDataError(f"could not read registry at {path}: {exc}") from exc
    return _validate_registry(data)


def _write_registry(path: Path, data: dict[str, Any]) -> None:
    _validate_registry(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(data, handle, indent=2, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError as exc:
        raise RegistryDataError(f"could not write registry at {path}: {exc}") from exc
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


@contextmanager
def _locked(path: Path, *, exclusive: bool) -> Iterator[None]:
    lock_path = path.with_name(f"{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError as exc:
        raise RegistryDataError(f"could not lock registry via {lock_path}: {exc}") from exc


def initialize_registry(
    registry_path: str | Path = DEFAULT_REGISTRY_PATH, *, overwrite: bool = False
) -> dict[str, Any]:
    """Create an empty registry. Refuses to replace an existing file by default."""
    path = Path(registry_path)
    with _locked(path, exclusive=True):
        if path.exists() and not overwrite:
            return _read_registry(path)
        now = _now_iso()
        data = {"schemaVersion": SCHEMA_VERSION, "updatedAt": now, "runs": {}}
        _write_registry(path, data)
        return data


def register_run(
    *,
    agent_id: str,
    task_label: str,
    branch_name: str,
    worktree_path: str,
    session_id: str,
    run_id: str | None = None,
    status: str = "registered",
    retry_count: int = 0,
    pr_number: int | None = None,
    last_health_check_at: str | None = None,
    blocked_reason: str | None = None,
    delegation_path: str | None = None,
    model: str | None = None,
    owner: str | None = None,
    metadata: dict[str, Any] | None = None,
    registry_path: str | Path = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Register one delegated run and return its persisted record."""
    path = Path(registry_path)
    actual_run_id = run_id or str(uuid.uuid4())
    now = _now_iso()
    run = {
        "runId": actual_run_id,
        "agentId": agent_id,
        "taskLabel": task_label,
        "branchName": branch_name,
        "worktreePath": worktree_path,
        "sessionId": session_id,
        "status": status,
        "retryCount": retry_count,
        "prNumber": pr_number,
        "lastHealthCheckAt": last_health_check_at,
        "blockedReason": blocked_reason,
        "createdAt": now,
        "updatedAt": now,
        "delegationPath": delegation_path,
        "model": model,
        "owner": owner,
        "metadata": metadata or {},
    }
    _validate_run(actual_run_id, run)
    if status == "blocked" and not (blocked_reason or "").strip():
        raise RegistryDataError("blocked runs require blockedReason")
    with _locked(path, exclusive=True):
        data = _read_registry(path)
        if actual_run_id in data["runs"]:
            raise RegistryDataError(f"run {actual_run_id!r} already exists")
        data["runs"][actual_run_id] = run
        data["updatedAt"] = now
        _write_registry(path, data)
    return run.copy()


def update_status(
    run_id: str,
    new_status: str,
    *,
    retry: bool = False,
    registry_path: str | Path = DEFAULT_REGISTRY_PATH,
    **fields: Any,
) -> dict[str, Any]:
    """Transition a run and atomically update related fields."""
    if new_status not in STATUSES:
        raise RegistryTransitionError(f"unknown status {new_status!r}")
    unknown_fields = fields.keys() - OPTIONAL_UPDATE_FIELDS
    if unknown_fields:
        raise RegistryDataError(f"unsupported update fields: {sorted(unknown_fields)}")
    path = Path(registry_path)
    with _locked(path, exclusive=True):
        data = _read_registry(path)
        if run_id not in data["runs"]:
            raise RegistryDataError(f"run {run_id!r} does not exist")
        run = data["runs"][run_id]
        current_status = run["status"]
        if retry:
            if current_status not in {"blocked", "failed"}:
                raise RegistryTransitionError("retry is only valid from blocked or failed")
            if new_status not in {"registered", "running"}:
                raise RegistryTransitionError("retry must transition to registered or running")
            run["retryCount"] += 1
        elif new_status != current_status and new_status not in ALLOWED_TRANSITIONS[current_status]:
            raise RegistryTransitionError(
                f"transition from {current_status!r} to {new_status!r} is not allowed"
            )
        if current_status in TERMINAL_STATUSES and not retry and new_status != current_status:
            raise RegistryTransitionError(f"terminal run {run_id!r} cannot transition")
        run.update(fields)
        run["status"] = new_status
        if new_status == "blocked" and not (run.get("blockedReason") or "").strip():
            raise RegistryDataError("blocked status requires blockedReason")
        if new_status != "blocked":
            run["blockedReason"] = None
        now = _now_iso()
        run["updatedAt"] = now
        data["updatedAt"] = now
        _validate_run(run_id, run)
        _write_registry(path, data)
        return run.copy()


def get_run(
    run_id: str, registry_path: str | Path = DEFAULT_REGISTRY_PATH
) -> dict[str, Any]:
    """Return a copy of one run or raise when it is absent."""
    path = Path(registry_path)
    with _locked(path, exclusive=False):
        data = _read_registry(path)
        if run_id not in data["runs"]:
            raise RegistryDataError(f"run {run_id!r} does not exist")
        return data["runs"][run_id].copy()


def list_active_runs(
    registry_path: str | Path = DEFAULT_REGISTRY_PATH,
) -> list[dict[str, Any]]:
    """Return non-terminal runs ordered by creation time."""
    path = Path(registry_path)
    with _locked(path, exclusive=False):
        data = _read_registry(path)
        runs = [run.copy() for run in data["runs"].values() if run["status"] in ACTIVE_STATUSES]
    return sorted(runs, key=lambda run: (run["createdAt"], run["runId"]))


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry-path", default=str(DEFAULT_REGISTRY_PATH))
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init")

    register = subparsers.add_parser("register")
    register.add_argument("--run-id")
    register.add_argument("--agent-id", required=True)
    register.add_argument("--task-label", required=True)
    register.add_argument("--branch-name", required=True)
    register.add_argument("--worktree-path", required=True)
    register.add_argument("--session-id", required=True)
    register.add_argument("--status", choices=sorted(STATUSES), default="registered")
    register.add_argument("--model")
    register.add_argument("--owner")
    register.add_argument("--delegation-path")

    update = subparsers.add_parser("update-status")
    update.add_argument("run_id")
    update.add_argument("new_status", choices=sorted(STATUSES))
    update.add_argument("--retry", action="store_true")
    update.add_argument("--pr-number", type=int)
    update.add_argument("--last-health-check-at")
    update.add_argument("--blocked-reason")
    update.add_argument("--session-id")

    get = subparsers.add_parser("get")
    get.add_argument("run_id")
    subparsers.add_parser("list-active")
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    path = Path(args.registry_path)
    try:
        if args.command == "init":
            result = initialize_registry(path)
        elif args.command == "register":
            result = register_run(
                run_id=args.run_id,
                agent_id=args.agent_id,
                task_label=args.task_label,
                branch_name=args.branch_name,
                worktree_path=args.worktree_path,
                session_id=args.session_id,
                status=args.status,
                model=args.model,
                owner=args.owner,
                delegation_path=args.delegation_path,
                registry_path=path,
            )
        elif args.command == "update-status":
            fields = {
                key: value
                for key, value in {
                    "prNumber": args.pr_number,
                    "lastHealthCheckAt": args.last_health_check_at,
                    "blockedReason": args.blocked_reason,
                    "sessionId": args.session_id,
                }.items()
                if value is not None
            }
            result = update_status(
                args.run_id,
                args.new_status,
                retry=args.retry,
                registry_path=path,
                **fields,
            )
        elif args.command == "get":
            result = get_run(args.run_id, path)
        else:
            result = list_active_runs(path)
    except RegistryError as exc:
        parser = _build_parser()
        parser.error(str(exc))
    _print_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
