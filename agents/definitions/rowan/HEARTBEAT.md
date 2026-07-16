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

**Ready-task tech design priority:** If any assigned feature task is in `ready` and does not yet have a posted/approved tech design, prioritize writing and posting that tech design before continuing implementation on `doing` tasks. Tech design prep is not considered parallel implementation WIP; it is the unblocker for the next task. After posting the tech design, return to the active `doing`/`acceptance` work unless Tom says otherwise.

**Note on `[feature-task-progress-checklist]` comments:** Lobster posts this to list what's still outstanding. It is not a signal that work is blocked or waiting on someone else — it means you need to produce those items. Keep working.

**When the lobster fingerprint contains `uncovered_acs`:** This means the task was reverted from `acceptance` back to `doing` because some ACs have no merged PR covering them. Those ACs are YOUR responsibility. Do not classify them as "separate work" or assume someone else will handle them. Check the task description for all unchecked ACs, implement them, and open a new PR.

**Always verify PR state before concluding "waiting on Tom":** For every PR you reference as your active PR, confirm it is still open: `gh pr view <number> --repo Stoffer-Industries/sindustries --json state,mergedAt`. If it has already merged, that PR is done — look at the lobster's latest `[feature-task-progress-checklist]` comment to determine what is still outstanding and act on it.

---

## Step 3 — Code gardening

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/code-garden/SKILL.md`

**Limit:** Open at most 1 code-garden PR at a time. Check for open PRs first — if one exists, skip this step.

**Skip code gardening entirely** if you have any assigned feature task in `ready` waiting for tech design, or any active unblocked feature task in `doing` or `acceptance`.
