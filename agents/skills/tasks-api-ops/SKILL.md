---
name: tasks-api-ops
description: Manage Stoffer Industries tasks through the Tasks API from workspace automations. Use when creating, updating, listing, prioritizing, or archiving tasks, and when migrating task workflows away from local tasks.md/tasks.json state files toward API-first state.
---

# Tasks API Ops

Use API-first task operations for all automation flows.

## Rules

1. Prefer Tasks API as source of truth.
2. Avoid writing/reading `tasks.md` for operational state.
3. Use guarded env targeting for write automations to prevent accidental writes to the wrong environment.
4. Keep operations idempotent where possible (source tags, stable IDs).

## Base URL

Ensure `TASKS_API_BASE_URL` is set in your environment before running scripts:

```bash
export TASKS_API_BASE_URL=http://localhost:4001/api/v1
```

## Primary helper script

Scripts live at:
```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/tasks-api-ops/
```

Use:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/tasks-api-ops/tasks_api_client.py <command>
```

Programmatic use: import `get_task`, `list_tasks`, and `get_base_url` from `tasks_api_client` for scripts that need to query tasks without using the CLI (both files must be in the same directory).

### Commands

- Get one task:
```bash
python3 tasks_api_client.py get --id <task-id>
```

- List tasks:
```bash
python3 tasks_api_client.py list --limit 50
```
Optional filters: `--status`, `--assignee`, `--blocked true|false`, `--ready true|false`, `--priority`, `--q`.

Heartbeat view (all Acceptance, Doing, Ready, and 10 from Todo in one payload):

```bash
python3 tasks_api_client.py list --limit 50 --heartbeat
```

- Create task:
```bash
python3 tasks_api_client.py create --title "Task title" --priority high
```

- Update/move task:
```bash
python3 tasks_api_client.py patch --id <task-id> --status doing
```

- Set blocked/ready flags:
```bash
python3 tasks_api_client.py patch --id <task-id> --blocked true
python3 tasks_api_client.py patch --id <task-id> --ready true
```

- Archive task:
```bash
python3 tasks_api_client.py archive --id <task-id>
```

## Task transition check (heartbeat)

Script that evaluates whether a task can transition to the next state; used during heartbeat to report readiness and failed criteria.

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/tasks-api-ops/task_transition_check.py <task-id>
```

For Doing→Acceptance and Acceptance→Done checks (PR, tests, merge, branch cleanup), set `GITHUB_TOKEN`:

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 GITHUB_TOKEN=ghp_... python3 task_transition_check.py <task-id>
```

Output: JSON with `task_id`, `current_state`, `next_state`, `failed_criteria` (list of strings), `reason`. All task data is read via the Tasks API client (`get_task`, `list_tasks`).
