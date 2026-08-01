# HEARTBEAT.md — Rowan

**Scope of this file:** *when* I check for work and *what triggers action* each pass. For *how* I execute — task-state rules, tech-design gate, PR standards, escalation triggers — see `WORKFLOW.md`. This file is the polling cadence; WORKFLOW is the execution playbook.

Each heartbeat pass does two things in order: handle all PR work (review assigned PRs and address feedback on my own), then pick code-garden work.

Before Step 1, run the shared read-only work queue once:
`TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Rowan --json`

Use `reviewRequests`, `authoredPrFeedback`, and `mergeCandidates` for PR discovery, and `tasks` for Step 2. The queue never reviews or merges automatically; every action still follows `pr-process` with Rowan's own GitHub identity.

---

## Step 1 — PR work

Read and follow the pr-process skill for both reviewer and assignee duties:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/pr-process/SKILL.md`

- Review any PRs assigned to me for review.
- Check all open PRs I authored for unresolved `CHANGES_REQUESTED` reviews. Address valid feedback and push. As PR assignee, merge any PR where the required approval has been given and CI is green; do not wait for Tom to merge unless Tom is explicitly the required reviewer.

If no open PRs or no unresolved comments: skip the assignee part.

---

## Step 2 — Task work (feature + code)

Use the `tasks` returned by the shared queue for all active tasks assigned to me, regardless of `taskType`.

The classifier distinguishes explicit and dependency blocks from actionable work. Capacity and state admission remain entirely owned by Lobster. A missing implementation delivery (`[implementer-prs]`) is `ACTIONABLE`, never a request or wait for Quinn.

For each returned task, follow `WORKFLOW.md` for the execution steps in that state. If the queue contains any `ACTIONABLE` task, the pass must materially progress one before finishing: create/update a branch, commit, PR, validation result, required task comment, or a newly evidenced concrete blocker. A pass with actionable work and no such progress is a failed heartbeat and must follow **Escalate on Failure** below.

**Heartbeat cadence rule — the only per-pass opinion layered on top of `WORKFLOW.md`:**

If any assigned task is in `ready` and lacks a posted `[tech-design]` comment, prioritise writing and posting that tech design before continuing implementation on any `doing`/`acceptance` task. After posting `[tech-design]`, return to the active implementation work — do not start implementing the `ready` task.

---

## Step 3 — Code gardening

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/code-garden/SKILL.md`

**Limit:** Open at most 1 code-garden PR at a time. Check for open PRs first — if one exists, skip this step.

**Skip code gardening entirely** if any assigned feature task in `ready` is waiting for a tech design, or any `doing`/`acceptance` task can be materially progressed this pass (implementation, review feedback, merge/post-merge work, required comments/specs, or validation). Code garden is only on the table when all active feature tasks are waiting on someone else's action and any needed nudge has already been sent.

---

## Escalate on Failure

If any step fails due to an external dependency or operational issue (GitHub auth/scope error, Tasks API error, service unavailable, command traceback, unexpected empty output, or a brittle diagnostic command failure):

1. Do NOT silently fall back, spam Tom with raw command failure output, or treat the failure as ordinary heartbeat progress
2. Note which step failed and what the error was
3. Read and follow `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` — escalate to Lox's main session
4. Continue only if the remaining heartbeat steps are safe and independent; otherwise stop after the Lox escalation
