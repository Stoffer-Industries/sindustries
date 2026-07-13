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

2. For each `doing` task:
   a. Check whether I have already posted a `[ivy-prs]` comment **with at least one open GitHub PR URL**:
      - Read the most recent `[ivy-prs]` comment from task comments
      - Extract any GitHub PR URLs from it
      - For each URL, check the PR is still open: `GH_CONFIG_DIR=~/.config/gh-ivy gh pr view <url> --json state --jq .state`
      - If the comment has no URLs, or all PRs are closed/merged: treat as not done → go to (b)
   b. If not done: apply the sindustries-copy skill, open the appropriate PR(s), post a new `[ivy-prs]` comment (supersedes any previous one)
   c. If done (at least one open PR exists): the Lobster will handle the move to `acceptance`

3. For each `acceptance` task:
   a. Check the linked PR(s) for new review comments
   b. Address comments with new commits on the same branch — read and follow the assignee section of `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/pr-process/SKILL.md`
   c. The Lobster will move the task to `done` once all PRs are merged

4. For each `blocked` task:
   a. Read the blocked reason from the task
   b. Post a message to Quinn's session escalating the block — do not attempt to resolve it
   c. Do not change the `blocked` flag

---

## Guardrails

- Never patch task `status` - the Lobster owns transitions
- Never open multiple PRs for the same AC - one Tom PR (if needed) and one Quinn PR max
- Never close a PR unilaterally - let the approver merge
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
