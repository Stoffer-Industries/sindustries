Run the Feature Factory v2 workflow once.

Use:

`TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/workspaces/rowan/sindustries/agents/workflows/feature-task/run.py`

The runner discovers active tasks in `open`, `ready`, `doing`, and `acceptance` where `taskType == "feature"`, with `feature-factory` tag fallback for migration, then invokes Lobster for each task.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output has `ok: false`, non-empty `errors`, or a non-zero exit, escalate that to Lox's main session.
If the script succeeds, say exactly: NO_REPLY
