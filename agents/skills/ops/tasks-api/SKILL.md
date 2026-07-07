---
name: tasks-api
description: Manage Stoffer Industries tasks through the Tasks API from workspace automations. Use when creating, updating, listing, prioritizing, or archiving tasks, and when migrating task workflows away from local tasks.md/tasks.json state files toward API-first state.
---

# Tasks API Ops

Use API-first task operations for all automation flows.

> **Creating a new task?** Read `agents/skills/ops/tasks-create/SKILL.md` first — it covers task type selection, required field formats, and when not to create a task at all.

## Rules

1. Prefer Tasks API as source of truth.
2. Avoid writing/reading `tasks.md` for operational state.
3. Use guarded env targeting for write automations to prevent accidental writes to the wrong environment.
4. Keep operations idempotent where possible (source tags, stable IDs).

## Base URL

```bash
export TASKS_API_BASE_URL=http://localhost:4001/api/v1
```

## Script

```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py
```

Run with `-h` or `<command> -h` for full usage:

```bash
python3 tasks_api_client.py -h
python3 tasks_api_client.py list -h
python3 tasks_api_client.py create -h
```

Programmatic use: import `get_task`, `list_tasks`, and `get_base_url` from `tasks_api_client` for scripts that need to query tasks without the CLI.

## Common patterns

Agent task view (grouped by status with blockers):
```bash
python3 tasks_api_client.py list --assignee Rowan --status ready --status doing --status acceptance --summary
```

Heartbeat view (all active + 10 open):
```bash
python3 tasks_api_client.py list --heartbeat
```

## Tech-design approval queue (heartbeat helper)

For Quinn's heartbeat tech-design approval pass:

```bash
python3 agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py
python3 agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py --json
```

Mirrors the lobster's `tagged_values` + `tech_design_approved` parser so substring matches in checklist complaints (`Missing task comment [tech-design-approved] true`) are correctly NOT counted as approvals.

## Content task creation

When Tom approves a weekly content review, create the task with `--type content`:

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
- `--type content` is required
- Each change item becomes one `- [ ]` checkbox line
- Omit empty sections
- Always include `--tags "weekly-review,content-ops"`
