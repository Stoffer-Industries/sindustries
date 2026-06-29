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
`TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py list --assignee Rowan --status ready --status doing --status acceptance`

Follow WORKFLOW.md for full per-state instructions (tech design, implementation, system spec, acceptance):
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/definitions/rowan/WORKFLOW.md`

**Note on `[feature-task-progress-checklist]` comments:** Lobster posts this to list what's still outstanding. It is not a signal that work is blocked or waiting on someone else — it means you need to produce those items. Keep working.

---

## Step 3 — Code gardening

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/code-garden/SKILL.md`

**Limit:** Open at most 1 code-garden PR at a time. Check for open PRs first — if one exists, skip this step.

**Skip code gardening entirely** if you have an active unblocked feature task in `doing` or `acceptance`.
