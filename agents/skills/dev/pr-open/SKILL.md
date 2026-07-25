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

Always set `--assignee` to the implementation owner/opener and `--reviewer` to the designated reviewer(s). Check the invoking skill, task, or workflow for reviewer routing. If the reviewer is not stated, stop and ask/escalate — do **not** guess a default reviewer.

For feature-task PRs, the opener is the task implementer/assignee. Reviewers are the blocking reviewer plus any visibility-only reviewers defined by the workflow. The reviewer must not open the implementer's PR on their own account.

Use the opener's GitHub identity/token for `gh pr create`. Before creating the PR, verify the active GitHub login matches the intended opener:

```bash
gh api user --jq '.login'
```

If `gh pr create` fails with an auth/scope error (`Resource not accessible...`, `createPullRequest`, `Bad credentials`, etc.), fix the opener's GitHub token/config or escalate. Do **not** retry with another agent's token/account; that makes the PR unreviewable by that agent and breaks the opener-reviewer-merge split.

```bash
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --base main \
  --title "<type>(<scope>): <short description>" \
  --assignee <opener-github-username> \
  --reviewer <reviewer-github-username>[,<visibility-reviewer>] \
  --body "$(cat <<'EOF'
## Summary
- <bullet: what changed and why>
- <bullet: any notable decisions or trade-offs>

## System Spec
<path to docs/systems/<file>.md that was written or updated>
— OR —
No system spec change — <substantive reason, e.g. "CI-only fix, no user-facing behaviour">

## Test plan
- [ ] <specific thing to verify>
- [ ] <another check>

🤖 Generated with Claude Code
EOF
)"
```

**`## System Spec` is required on every feature-task PR.** The lobster's `verify_delivery` gate reads this section and blocks if it is absent or empty. Provide either:
- The path to the spec file that was written or updated (`docs/systems/<file>.md`), plain or backtick-quoted.
- A substantive no-change reason (at least 12 non-whitespace characters, no spec path) explaining why no spec was touched.

A short stub like "No change" will be treated as missing and will block acceptance.

**Do not name any other `docs/systems/*.md` file in the no-change reason, even in passing.** The lobster's parser matches the *first* `docs/systems/\S+\.md`-shaped string anywhere in the section — it does not check whether you actually declared that file as updated. If your explanation mentions an existing system doc for context ("this already lives in docs/systems/tasks.md"), the lobster will treat that as your declared spec file and pass the gate even though nothing was touched. Write the no-change reason without naming any `docs/systems/*.md` path at all.

**This section only covers `docs/systems/*.md`. It does not satisfy the app-spec requirement.** Per `docs/CONVENTIONS.md` (DoD item 3) and `agents/definitions/rowan/DoD.md`, if your change alters user-visible behaviour in an app that has an `apps/<app>/SPEC.md`, that file must be updated in this PR too — a system-doc no-change declaration does not exempt you from it. There is currently no automated gate for this, so check it by hand before opening the PR: does `apps/<app>/SPEC.md` exist, and does it describe the flow/screen you just changed? If yes, update it in the same PR and reference it in your AC evidence (`(📄 not code: updated apps/<app>/SPEC.md)`).

Include a `Co-Authored-By` trailer in your commit messages identifying yourself:
```
Co-Authored-By: <Your Name> <your-email>
```

## PR Summary Guidelines

**Title:** `<type>(<scope>): <short description>` — same format as commit messages. Under 72 characters.

**Summary bullets:** focus on *what* changed and *why*, not implementation steps. One bullet per logical change. If the PR is trivial (e.g. code-garden), one bullet is enough.

**Test plan:** concrete, checkable steps. Not "tests pass" — what specifically should a reviewer verify? For non-functional changes, it's fine to write "No logic changes — diff is purely structural."

**Acceptance Criteria (feature-task PRs only):** the lobster enforces a per-AC evidence rule at the `doing → acceptance` gate. **Every task AC must appear in the PR body as a `- [x]` checkbox** — not a bullet, not `- [ ]`, not plain prose, not a `✅` emoji. The `- [x]` form is the only signal the lobster can machine-parse to confirm the AC is covered by this PR (or by a merged predecessor PR referenced on the line). Unchecked ACs and bullet-style ACs are both treated as missing and block the transition. The actual QA verdict is a separate gate (`[qa-ac-verified] true` from Tom); the `- [x]` checkbox is "work is in this PR", not "work is verified".

Every `- [x]` AC line must end with one of the following annotations, in priority order:

| Priority | Annotation | When to use |
|---|---|---|
| 1st | `(🧪 testID: <id>)` | Playwright e2e test or unit test ID — **always prefer this** |
| 2nd | `(⚠️ not tested: <reason>)` | When automation is genuinely impractical — requires a substantive reason |
| — | `(📄 not code: <reason>)` | AC fulfilled outside the codebase (doc, spec, config update) |
| — | `(🔗 pr: #<n>)` | Covered by a different merged PR |

`file:` has been removed. If you wrote a unit test, reference it via `testID` or explain in `not tested` why it wasn't feasible to add a Playwright test. Emojis are optional but encouraged for visual clarity.

**Every task AC must appear in the PR body** — checked with evidence. Fix PRs must re-list all task ACs, not just the ones being addressed.

Example:

```markdown
## Acceptance Criteria
- [x] AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-10-day-render)
- [x] AC2: Drag to reschedule updates scheduledFor. (🧪 testID: cal-drag-reschedule)
- [x] AC3: Published items show read-only badge. (⚠️ not tested: visual badge; covered by CSS class assertion in unit test — no Playwright testID yet)
- [x] AC4: System spec updated. (📄 not code: updated docs/systems/content-scheduler.md)
```

PRs without the required annotations are blocked from acceptance with a clear comment listing the ACs that need evidence.

**Multi-task combined deliveries:** when one PR covers two or more feature tasks (e.g. a combined delivery), use one `## Acceptance Criteria` section containing a `### Task <task-id> — <short description>` subsection per task. The lobster scopes the AC vs task comparison by `### Task <id>` heading, so AC labels (`AC1`, `AC2`, ...) in different subsections do not collide. Each task's ACs still need their own evidence annotation.

```markdown
## Acceptance Criteria
### Task 513b3b02 — Pulse shell scaffold
- [x] AC1: Pulse loads at a single URL and renders a persistent tab bar. (testID: 4)
- [x] AC2: Tab bar shows Tasks, Bookmarks, and Flow metrics tabs. (not tested: design tokens; visual review only)
### Task e2e647b1 — Flow metrics dashboard
- [x] AC1: Dashboard shows cycle time (median and p90) for tasks completed. (testID: 5)
- [x] AC2: Dashboard is reachable from the Flow metrics tab. (🧪 testID: flow-metrics-tab-reachable)
```

The lobster walks the AC section line-by-line and tracks the current `### Task <id>` heading. ACs in a sibling task's subsection are not considered for the current task's text/evidence comparison. PR bodies without any `### Task <id>` heading fall back to the pre-#183 behavior (the whole AC section is implicitly one subsection).

**QA bounce:** after merge, the lobster compares the latest merged PR body against the task description ACs. If any AC is missing, unchecked, or has altered text, the task bounces back to `doing` and a `[feature-task-progress-checklist]` comment is posted explaining what the next PR must address.

---

## After Opening — Update Task Workstreams

For feature-task PRs, post `[implementer-prs] <url>` as a task comment when the PR is ready for review. Existing `[rowan-prs]` comments are treated as a legacy alias only; new work should use `[implementer-prs]`.

Patch the task description to record the branch and PR URL in the workstreams section. The task ID is the first 8 chars of the branch name (`task-{8chars}-...`).

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

