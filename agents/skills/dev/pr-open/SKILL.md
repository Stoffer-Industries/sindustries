---
name: pr-open
description: "Open a pull request in the Sindustries repository. Covers branch setup, PR summary format, assignee/reviewer flags, and the gh pr create command."
---

# Opening a PR

Use this skill whenever you need to open a pull request in the Sindustries repository.

## Before You Open

- Branch must be pushed to `origin`
- All tests must pass locally
- Commits must follow the project convention: `<type>(<scope>): <what>`

## The gh pr create Command

Always set `--assignee` to yourself and `--reviewer` to the designated reviewer. Check the skill or heartbeat that invoked you for who the reviewer is; if not stated, default to `tomstoffer`.

`GITHUB_TOKEN` is provided by your agent config — do not define it in skills.

```bash
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --base main \
  --title "<type>(<scope>): <short description>" \
  --assignee <your-github-username> \
  --reviewer <reviewer-github-username> \
  --body "$(cat <<'EOF'
## Summary
- <bullet: what changed and why>
- <bullet: any notable decisions or trade-offs>

## Test plan
- [ ] <specific thing to verify>
- [ ] <another check>

🤖 Generated with Claude Code
EOF
)"
```

Include a `Co-Authored-By` trailer in your commit messages identifying yourself:
```
Co-Authored-By: <Your Name> <your-email>
```

## PR Summary Guidelines

**Title:** `<type>(<scope>): <short description>` — same format as commit messages. Under 72 characters.

**Summary bullets:** focus on *what* changed and *why*, not implementation steps. One bullet per logical change. If the PR is trivial (e.g. code-garden), one bullet is enough.

**Test plan:** concrete, checkable steps. Not "tests pass" — what specifically should a reviewer verify? For non-functional changes, it's fine to write "No logic changes — diff is purely structural."

**Acceptance Criteria (feature-task PRs only):** the lobster enforces a per-AC evidence rule at the `doing → acceptance` gate. Every checked `- [x]` AC line must end with one of:

- `(testID: <id>)` — Playwright test ID reference
- `(file: <path>:<test-name>)` — file plus test name reference
- `(not tested: <reason>)` — implemented in code but not testable
- `(not code: <reason>)` — AC fulfilled outside the codebase (brain file, spec doc, etc.)

**Every task AC must appear in the PR body** — checked with evidence. Fix PRs must re-list all task ACs, not just the ones being addressed.

Example:

```markdown
## Acceptance Criteria
- [x] AC1: Task detail shows dependency links. (testID: 4)
- [x] AC2: Card click-to-copy affordance. (file: apps/tasks/src/components/TaskCardSummary.test.jsx: click-to-copy affordance)
- [x] AC3: Reduced opacity for archived tasks. (not tested: design tokens supply color; visual review only)
- [x] AC4: Feature factory v2 spec updated. (not code: updated brain/bookmarks/specs/feature-factory-v2-2026-06-04.md)
```

PRs without the required annotations are blocked from acceptance with a clear comment listing the ACs that need evidence.

**QA bounce:** after merge, the lobster compares the latest merged PR body against the task description ACs. If any AC is missing, unchecked, or has altered text, the task bounces back to `doing` and a `[feature-task-progress-checklist]` comment is posted explaining what the next PR must address.

---

## After Opening — Update Task Workstreams

For feature-task PRs, patch the task description to record the branch and PR URL in the workstreams section. The task ID is the first 8 chars of the branch name (`task-{8chars}-...`).

Find the task by ID prefix, then PATCH the description to fill in the workstream entry:

```bash
# Get the task (first 8 chars of branch = task ID prefix)
TASK_ID_PREFIX="<first-8-chars>"
TASK=$(TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py list | \
  python3 -c "import json,sys; tasks=json.load(sys.stdin)['data']; \
    t=next((t for t in tasks if t['id'].startswith('$TASK_ID_PREFIX')), None); \
    print(t['id'], t['description']) if t else print('NOT FOUND')")

# Then PATCH the description: replace the pending Branch/PR placeholders
# with the actual branch name and PR URL
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py patch \
    --id <full-task-id> \
    --description '<updated description with Branch and PR filled in>'
```

If this PR covers only a subset of ACs, add a new workstream entry for the remaining ACs (still `Branch: (pending)`, `PR: (pending)`) so the task description reflects what's still outstanding.

