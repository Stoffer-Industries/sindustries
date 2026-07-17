# HEARTBEAT.md — Rowan

Each heartbeat pass does two things: handle all PR work (review assigned PRs and address feedback on your own), then pick code garden work.

---

## Step 1 — PR work

Read and follow the pr-process skill for both reviewer and assignee duties:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/pr-process/SKILL.md`

- Review any PRs assigned to you for review
- Check all open code-garden PRs you authored for unresolved `CHANGES_REQUESTED` reviews. Address valid feedback and push. Merge any PR where all reviewers have approved and CI is green.

If no open PRs or no unresolved comments: skip the assignee part.

---

## Step 2 — Feature task work

Check for active feature tasks assigned to you:
`TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Rowan --status ready --status doing --status acceptance summary`

Follow WORKFLOW.md for full per-state instructions (tech design, implementation, system spec, acceptance):
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/rowan/WORKFLOW.md`

**State boundaries — do not cross them:**
- `ready` = **tech design only**. Your only job on a `ready` task is to write the tech design, commit it to the implementation branch, and post `[tech-design] <blob-url>`. Do NOT write any feature code. Do NOT open a feature PR. Wait for Quinn to post `[tech-design-approved] true` and for the lobster to move the task to `doing` before touching implementation.
- `doing` / `acceptance` = implementation. Only pick up implementation work on tasks the lobster has already moved to `doing`.

**Ready-task tech design priority:** If any assigned feature task is in `ready` and does not yet have a posted tech design, prioritize writing and posting that tech design before continuing implementation on `doing` tasks. After posting the tech design comment, return to the active `doing`/`acceptance` work — do not start implementing the `ready` task.

**Note on `[feature-task-progress-checklist]` comments:** Lobster posts this to list what's still outstanding. It is not a signal that work is blocked or waiting on someone else — it means you need to produce those items. Keep working.

**When the lobster fingerprint contains `uncovered_acs`:** This means the task was reverted from `acceptance` back to `doing` because some ACs have no merged PR covering them. Those ACs are YOUR responsibility. Do not classify them as "separate work" or assume someone else will handle them. Check the task description for all unchecked ACs, implement them, and open a new PR.

**Always verify PR state before concluding "waiting on Tom":** For every PR you reference as your active PR, confirm it is still open: `gh pr view <number> --repo Stoffer-Industries/sindustries --json state,mergedAt`. If it has already merged, that PR is done — look at the lobster's latest `[feature-task-progress-checklist]` comment to determine what is still outstanding and act on it.

---

## Step 3 — Code gardening

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/code-garden/SKILL.md`

**Limit:** Open at most 1 code-garden PR at a time. Check for open PRs first — if one exists, skip this step.

**Skip code gardening entirely** if you have any assigned feature task in `ready` waiting for tech design, or any active feature task in `doing`/`acceptance` that you can materially progress in this pass (implementation, review feedback, merge/post-merge work, required comments/specs, or validation). If all active feature tasks are waiting on Quinn/Tom/reviewer action and you have already sent any needed nudge, code garden is on the table.

---

## Escalate on Failure

If any step fails due to an external dependency or operational issue (GitHub auth/scope error, Tasks API error, service unavailable, command traceback, unexpected empty output, or a brittle diagnostic command failure):

1. Do NOT silently fall back, spam Tom with raw command failure output, or treat the failure as ordinary heartbeat progress
2. Note which step failed and what the error was
3. Read and follow `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` — escalate to Lox's main session
4. Continue only if the remaining heartbeat steps are safe and independent; otherwise stop after the Lox escalation
