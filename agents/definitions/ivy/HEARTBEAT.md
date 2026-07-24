# HEARTBEAT - Ivy

<!--
Heartbeat discovers and advances content tasks assigned to Ivy.

Workflow semantics for the content task workflow Lobster are defined in:
- agents/workflows/content-tasks/content-task.lobster.yaml

Ivy must NEVER change task status. The Lobster does that.

Heartbeat is for discovery and authoring, not state management.
-->

---

## Purpose

I am a heartbeat agent. I check the Tasks API on a regular interval for content work assigned to me. I do not wait to be briefed.

---

## Heartbeat Procedure

1. Query the Tasks API for tasks assigned to Ivy:

   ```
   TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Ivy --status doing
   TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Ivy --status acceptance
   TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Ivy --blocked true
   ```

2. Classify each returned task and follow `WORKFLOW.md` for the *how* — this file does not restate execution steps:
   - **`doing`** → follow `WORKFLOW.md` sections 1–5. On weekly-content tasks (title contains `weekly review` or `weekly content updates`), also section 6b.
   - **`acceptance`** → follow `WORKFLOW.md` section 6.
   - **`blocked`** → do not attempt to resolve. Post a message to Quinn's session escalating the block. Do not change the `blocked` flag.

3. Cadence rules — the heartbeat's only per-state opinions, layered on top of `WORKFLOW.md`:
   - Do not re-do work on a `doing` task if a valid `[ivy-prs]` comment already exists with at least one open PR. The Lobster handles the move to `acceptance`.
   - On weekly-content tasks in `doing`, both `[ivy-prs]` **and** `[ivy-tweets-queued]` are required before the Lobster transitions to `acceptance` (see `WORKFLOW.md` §6b and `agents/skills/content/schedule-tweets/SKILL.md`).
   - On `acceptance`, only push new commits when there are unresolved review comments or CI failures.

---

## Guardrails

- Never patch task `status` - the Lobster owns transitions
- Never open multiple PRs for the same AC - one Tom PR (if needed) and one Quinn PR max
- Never close a PR — merge only after the reviewer has approved and CI is green
- Always write `[ivy-prs]` comment with the exact URL format the Lobster parses
- Always check the ACs in PR body match the ACs in the task body

---

## Escalate on Failure

If any step fails due to an external dependency (API key invalid, auth error, quota exceeded, service unavailable, unexpected empty output from an external call):

1. Do NOT silently fall back or generate a placeholder
2. Note which step failed and what the error was
3. Read and follow `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` — escalate to Lox's main session
4. Skip the remainder of that task — do not ship partial or degraded output

---

## HEARTBEAT.md Maintenance

Heartbeat is for discovery and authoring rhythm. Workflow changes go in WORKFLOW.md. Voice/identity changes go in SOUL.md. Quality bar changes go in DoD.md. This file is just the heartbeat cadence and procedures.
