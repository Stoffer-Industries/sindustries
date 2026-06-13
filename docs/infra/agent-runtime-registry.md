# Agent Runtime Registry

## Location and ownership

Delegated coding runs are persisted only in:

`brain/state/agent-runtime-registry.json`

This path is relative to the OpenClaw workspace, not the `sindustries` repository. It is
separate from `brain/state/bookmark-review-state.json`. The registry is operational state
and must not be copied into bookmark workflow state.

`agents/runtime/registry.py` owns initialization and all record writes. Launchers and
monitors must call its Python functions or CLI; they must not edit the JSON directly.

## Document schema

The version 1 document has this shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-14T00:00:00+00:00",
  "runs": {}
}
```

Each key in `runs` is a unique run ID. A run contains:

- `runId`: stable unique ID matching its key in `runs`
- `agentId`: delegated agent identity
- `taskLabel`: human-readable work label
- `branchName`: owned Git branch
- `worktreePath`: absolute worktree path
- `sessionId`: runtime or terminal session identifier
- `status`: lifecycle status listed below
- `retryCount`: number of explicit retry operations
- `prNumber`: positive GitHub PR number or `null`
- `lastHealthCheckAt`: timezone-aware ISO-8601 timestamp or `null`
- `blockedReason`: concrete operator-readable reason or `null`
- `createdAt`: timezone-aware ISO-8601 creation timestamp
- `updatedAt`: timezone-aware ISO-8601 last mutation timestamp
- `delegationPath`: optional launcher or workflow identifier
- `model`: optional implementation model
- `owner`: optional runtime owner
- `metadata`: optional structured launcher-specific data

Unknown top-level schema versions, missing required fields, invalid field types, malformed
JSON, and missing files are errors. The helper raises `RegistryDataError` and the CLI exits
non-zero with the error. It never replaces invalid data with an empty registry.

## Initialization and writes

Create the workspace file once:

```bash
cd /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries
python3 -m agents.runtime.registry init
```

Register and update a run:

```bash
python3 -m agents.runtime.registry register \
  --run-id task-123-attempt-0 \
  --agent-id rowan \
  --task-label "Implement task 123" \
  --branch-name feat/task-123 \
  --worktree-path /Users/quinnstoffer/workspaces/rowan/task-123 \
  --session-id codex-task-123

python3 -m agents.runtime.registry update-status task-123-attempt-0 running
python3 -m agents.runtime.registry update-status task-123-attempt-0 blocked \
  --blocked-reason "tmux session exited before tests completed"
python3 -m agents.runtime.registry update-status task-123-attempt-0 running --retry
python3 -m agents.runtime.registry list-active
```

Python callers use `register_run`, `update_status`, `get_run`, and `list_active_runs`.

Every operation locks `agent-runtime-registry.json.lock` with `fcntl.flock`. Mutations hold
an exclusive lock across read, validation, update, and write. Reads hold a shared lock.
Writes go to a same-directory temporary file, are flushed with `fsync`, and replace the
registry atomically with `os.replace`. Callers must not implement their own read-modify-write
cycle because doing so bypasses serialization and validation.

## Status lifecycle

Statuses and normal transitions:

- `registered` -> `running`, `blocked`, `failed`, or `cancelled`
- `running` -> `blocked`, `approval_ready`, `completed`, `failed`, or `cancelled`
- `blocked` -> `running` only through an explicit retry, or -> `failed`/`cancelled`
- `approval_ready` -> `running`, `blocked`, `completed`, `failed`, or `cancelled`
- `completed` and `cancelled` are terminal
- `failed` is terminal unless an explicit retry starts a new attempt

Writing the current status again is idempotent and may update health or PR fields. Entering
`blocked` requires `blockedReason`. Leaving `blocked` clears it.

Retries are only accepted from `blocked` or `failed`, must target `registered` or `running`,
and atomically increment `retryCount`. A normal transition cannot leave `failed`; the caller
must pass `retry=True` or CLI `--retry`. Retry count records attempts for the same logical
run. A launcher that needs separate immutable attempt histories should register a new run ID
instead.

`list_active_runs()` returns `registered`, `running`, `blocked`, and `approval_ready` records.
It excludes `completed`, `failed`, and `cancelled`.

## Failure recovery

Do not delete or overwrite malformed state. Correct it from a known-good backup or operator
inspection, then rerun the helper. If the file is missing intentionally, use `init`; if it
went missing unexpectedly, investigate before initialization. The sidecar lock may remain
as an empty file after a process exits; OS locks are released automatically and the file is
safe to retain.
