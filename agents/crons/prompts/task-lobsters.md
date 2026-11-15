Run the Feature Factory and Content Task workflow lobsters once each.

## Execution contract

Run both lobster commands in the foreground and wait for each command to reach
a terminal state before completing this cron turn. Never append `&`, use
`nohup`, or otherwise detach a lobster process.

If `exec` returns a process/session ID because a command is still running, poll
that process with `process` until it exits. Do not proceed to the next section
or report success while either lobster is still active. Record the final exit
status and output for both commands, including when one exits non-zero; one
lobster's failure must not prevent the other lobster from reaching a terminal
state.

**Capture the output to files — do not rely on the tool's echoed stdout.** The
feature lobster's stdout embeds every swept task's full record and comment
history, so it is megabytes and grows monotonically with task age; echoed
unredirected it overruns the tool's output-retention cap and the decisive
middle of the envelope is discarded. Both commands below therefore redirect
both streams to `/tmp`, and the exit status is written alongside:

```
mkdir -p /tmp/task-lobsters
set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a; TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/feature-task/run.py > /tmp/task-lobsters/feature.json 2> /tmp/task-lobsters/feature.err; echo "exit=$?"
```

Read `ok`, `errors`, `aborted`, `abortedAfterTaskId` and `count` from
`/tmp/task-lobsters/feature.json` (its `results[]` holds the per-task
envelopes), and the per-task stderr from `/tmp/task-lobsters/feature.err`.
Judge success from the **captured file**, never from the tool's retained
stdout: a completion whose middle was discarded is not a completion you can
reason from.

**On retry (this is attempt > 1 within the same cron run):** always re-run both lobsters from scratch. Do not assume a prior attempt's session completed, try to inspect or attach to its processes, or spend time reasoning about what state it left behind — treat this as a clean, independent run and let the runners' own idempotent discovery (active-task queries) handle anything the prior attempt already touched.

## 1. Feature Task Lobster

```
mkdir -p /tmp/task-lobsters
set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a; TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/feature-task/run.py > /tmp/task-lobsters/feature.json 2> /tmp/task-lobsters/feature.err; echo "exit=$?"
```

The runner discovers active tasks in `open`, `ready`, `doing`, and `acceptance` where `taskType == "feature"` (or `feature-factory` tag), then invokes Lobster for each task.


**If the lobster reports `ready_checks_blocked` due to missing `[tech-design]`:**
- Check if Rowan is free (no tasks in `doing` assigned to Rowan):
  `set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a; TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Rowan --status doing --summary`
- If Rowan is free: read the tech-design skill and spawn Rowan as a background subagent to write the tech design:
  `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/tech-design/SKILL.md`
- If Rowan is busy: do **not** create or update an incident. The task's `attentionOwners[0]` is the authoritative handoff surface; the feature-task lobster's workflow-attention reconciliation should route the missing tech-design gate to Quinn. If the task still has no attention owner after the lobster run, use the Tasks API attention-owner helper to add Quinn while preserving the existing ordered stack, then leave an audit comment on the task. A task gate failure belongs in Tasks API state, not the agent incident registry.

## 2. Content Task Lobster

```
mkdir -p /tmp/task-lobsters
set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a; TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/content-tasks/run.py --json > /tmp/task-lobsters/content.json 2> /tmp/task-lobsters/content.err; echo "exit=$?"
```

Read `ok`, `count`, `results` and `errors` from
`/tmp/task-lobsters/content.json` and the exit status from the echoed
`exit=` line.

Report only failures, blocked closed-unmerged PRs, or meaningful transitions.

## Soft-fail handling

Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If either lobster exits non-zero or returns `ok: false`, escalate the **lobster/runtime failure** to Lox's main session. Do not turn an individual task's blocked gate or missing prerequisite into an incident; those route through `attentionOwners`.
If both succeed with no actionable output, say exactly: NO_REPLY
