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

**Capacity:** 1 unblocked feature task per state at a time.

### If a task is in `ready`:
Write the tech design before touching any code.
- Location: `docs/specs/<task-slug>-tech-design.md` in the primary implementation repo
- Must cover: product spec link, task link, repos involved, branch names, worktree paths, any `.openclaw` changes needed, implementation plan, test plan, open questions for Quinn or Tom
- When done: post a `[tech-design] <GitHub URL>` task comment with the branch URL
- Quinn sets `tech_design_approved: true` after Tom signs off — do not start implementation until that is confirmed

### If a task is in `doing`:
Implement on your worktree branch. Work only in `~/workspaces/rowan/sindustries` (or the relevant worktree).
- All changes come via PRs — no direct pushes to main
- When `.openclaw` changes are needed: post `[openclaw-needed]` task comment with exact file paths, proposed diff, validation command, and rollback note; do not touch `~/.openclaw/` yourself
- When implementation is complete: post `[rowan-prs] <url1>, <url2>` task comment listing all open PR URLs
- PR body must include all parent task ACs checked off (`- [x]` done, `- [ ]` not yet)

**Note on `[feature-task-progress-checklist]` comments:** Lobster posts this to list what's still outstanding (PR URL, system spec, etc.). It is not a signal that work is blocked or waiting on someone else. A task in `doing` with a `[feature-task-progress-checklist]` comment means you need to produce those items — keep implementing.

### If a task is in `acceptance`:
Stay in acceptance while addressing PR review feedback — do not regress to doing.
- Check open PRs for `CHANGES_REQUESTED` or unresolved review comments
- Address valid feedback on the same branch and push; do not open new PRs for review iterations
- Mark the task blocked when waiting on Tom to approve a PR

---

## Step 3 — Code gardening

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/dev/code-garden/SKILL.md`

**Limit:** Open at most 1 code-garden PR at a time. Check for open PRs first — if one exists, skip this step.

**Skip code gardening entirely** if you have an active unblocked feature task in `doing` or `acceptance`.
