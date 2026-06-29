---
name: tasks-api
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
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/
```

Use:

```bash
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py <command>
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

## Content task creation (weekly review approval)

When Tom approves a weekly content review, create the task with `--type content` and use the following description format. Each change item must use a markdown checkbox (`- [ ]`).

```bash
python3 tasks_api_client.py create \
  --title "SIndustries weekly content updates — YYYY-MM-DD" \
  --priority high \
  --type content \
  --tags "weekly-review,content-ops" \
  --description "$(cat <<'EOF'
**Source:** brain/content/sindustries-weekly-content/YYYY-MM-DD.md

**Review window:** YYYY-MM-DD to YYYY-MM-DD

---

## Quinn can execute

- [ ] ADD/EDIT/REMOVE ...

## Needs Tom approval

- [ ] ADD/EDIT/REMOVE ...

## Defer / needs more context

- [ ] ...
EOF
)"
```

Rules:
- `--type content` is required — the task will be rejected or miscategorised without it
- Each change item from the review file becomes one `- [ ]` checkbox line
- Omit sections that have no items rather than leaving them empty
- `--tags "weekly-review,content-ops"` should always be included for weekly review tasks
