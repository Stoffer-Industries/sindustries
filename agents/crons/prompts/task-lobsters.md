Run the Feature Factory and Content Task workflow lobsters once each.

## 1. Feature Task Lobster

```
TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/feature-task/run.py
```

The runner discovers active tasks in `open`, `ready`, `doing`, and `acceptance` where `taskType == "feature"` (or `feature-factory` tag), then invokes Lobster for each task.

**If the lobster reports `ready_checks_blocked` due to missing `[tech-design]`:**
- Check if Rowan is free (no tasks in `doing` assigned to Rowan):
  `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Rowan --status doing --summary`
- If Rowan is free: read the tech-design skill and spawn Rowan as a background subagent to write the tech design:
  `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/tech-design/SKILL.md`
- If Rowan is busy: log a watching entry in `brain/state/quinn-ops-state.json` (slug: `feature-task-<task-id-prefix>-ready_checks-<YYYY-MM-DD>`).

## 2. Content Task Lobster

```
TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/content-tasks/run.py --json
```

Report only failures, blocked closed-unmerged PRs, or meaningful transitions.

## Soft-fail handling

Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If either lobster exits non-zero or returns `ok: false`, escalate to Lox's main session.
If both succeed with no actionable output, say exactly: NO_REPLY
