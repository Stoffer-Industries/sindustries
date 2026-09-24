---
name: pr-open
description: "Open a pull request in the Sindustries repository. Covers branch setup, PR summary format, assignee/reviewer flags, the gh pr create command, the requested_reviewers postcondition check, and the AC evidence annotations the feature-task lobster parses."
---

# Pilot structured SKILL.md blueprint on `pr-open`

> Restructured into the 5+1 canonical blueprint (RULES / PROCESS / OUTPUT FORMAT / KNOWLEDGE FILES / ONBOARDING + minimal IDENTITY pointer) under task `43a9ac7b`. Operational content preserved verbatim from the prior version; presentation changed, not substance. See `docs/specs/pilot-structured-skill-blueprint-pr-open-tech-design.md` for the full mapping.

## RULES

- **Never open a PR without a designated reviewer in `--reviewer`.** If the reviewer is not stated by the invoking skill, task, or workflow, stop and ask/escalate — do **not** guess a default reviewer.
- **Never retry `gh pr create` with another agent's token to work around a scope error.** That makes the PR unreviewable by that agent and breaks the opener-reviewer-merge split. Fix the opener's GitHub token/config or escalate.
- **Never treat PR-open as complete until the `requested_reviewers` REST check returns non-zero.** Applies at both `gh pr create` time AND at the draft→ready-for-review conversion (`gh pr ready`). The latter is a second "opening" event.
- **Never use `gh pr view --json reviewRequests` for the postcondition check.** Resolving reviewer/team identity fields requires scopes the agent token intentionally does not have (`read:org` / `read:discussion`). Use the REST endpoint instead. Do not rely on `gh pr list`'s `reviewDecision`/`mergeStateStatus` (`REVIEW_REQUIRED`) as evidence a reviewer was actually requested — that field reflects branch-protection policy, not assignment; a PR can sit `REVIEW_REQUIRED` with `requested_reviewers` empty indefinitely.
- **Never nest parentheses inside AC evidence annotations.** The feature-task lobster matches the first top-level `(` after the AC text. Nested `)` truncates the annotation and misaligns subsequent ACs. Use `-` or `:` separators in test names instead:
  - **Breaks:** `AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-render (desktop))` — the trailing `)` closes the annotation, leaving `desktop))` outside the group; subsequent ACs are misaligned.
  - **Flat form (correct):** `AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-render - desktop)` or `AC1: Calendar renders 10 columns labelled by date. (🧪 testID: cal-render)` if "desktop" is not part of the test ID.
- **Never omit AC checkboxes from a feature-task PR body.** Use `- [x]` (the lobster's only parseable form), not bullet, not `- [ ]`, not `✅` emoji, not plain prose. Every task AC must appear in the PR body, with the original task AC sentence copied verbatim before the evidence annotation.
- **Never paraphrase or shorten the AC sentence text.** The lobster ignores Markdown code-span markers and line-wrapping whitespace, but it rejects omitted clauses, paraphrases, or shortened sentences. Copy the task AC sentence exactly.
- **Never use `file:` as an AC evidence annotation.** It has been removed; use `testID` or record a substantive reason in `not tested`.
- **Never set `--assignee` to anyone other than the implementation owner/opener.** The reviewer must not open the implementer's PR on their own account.
- **Never create an implementation PR from a different agent's GitHub identity.** The task implementer/assignee is the intended opener; commit authorship and branch ownership are not substitutes for authenticated identity.
- **Always include `## System Spec` (or a one-line no-change reason)** in the PR body. It is a documentation convention, not a lobster gate — doc content is too varied to check reliably in code — so verify by hand before opening.
- **Always check the app-spec requirement separately.** A `docs/systems/*.md` no-change declaration does **not** exempt you from `apps/<app>/SPEC.md`. If the app has a `SPEC.md` and this PR changes user-visible behaviour, update it in the same PR and reference it in your AC evidence.
- **Always include a `Co-Authored-By` trailer** in commit messages identifying the opener (`Co-Authored-By: <Your Name> <your-email>`).
- **Always apply at least one label to every PR.** Labels are required; see the label table in `pr-process/SKILL.md`. Task-driven PRs use the matching task-type label (`feature-task`, `content-task`, `code-task`); Quinn proactive fixes use `workflow-garden`; Tom asks in chat use `direct-ask`; retro-daily-fix output uses `retro-fix`. Labels are not mutually exclusive — apply all that apply.

## PROCESS

### 1. Pre-flight (before `gh pr create`)

- Branch is pushed to `origin` (verify with `git ls-remote origin <branch>` or a `git push` step earlier in the work).
- All tests pass locally on the implementation branch.
- Commits follow the project convention: `<type>(<scope>): <what>`.
- Open on the agent's own GitHub identity — immediately before `gh pr create`, run `agents/skills/dev/pr-open/scripts/assert-opener-identity.sh <intended-opener-login>`. For a task implementation PR, `<intended-opener-login>` is the task implementer's GitHub login; for a Quinn-owned workflow-garden/direct-ask PR, it is `quinnstoffer`. If the check fails, stop and fix the agent environment or escalate. Never retry with another agent's token.
- (Rust workflow PRs only) If the PR touches `agents/workflows/feature-task/**`, run the quality gates in `agents/workflows/feature-task/WORKFLOW.md` and confirm clippy + tests are green. Note that fact in the PR test plan; do **not** paste the full `cargo` command lines into every PR body. Content / doc / non-Rust PRs skip this step.

### 2. Compose the PR body

Use the OUTPUT FORMAT section below. For feature-task PRs the body MUST include the `## Acceptance Criteria` section with every task AC as a `- [x]` line and a valid evidence annotation. For multi-task combined deliveries, group ACs under `### Task <task-id> — <short description>` so the lobster scopes AC vs task comparison per heading.

### 3. `gh pr create`

```bash
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --base main \
  --title "<type>(<scope>): <short description>" \
  --assignee <opener-github-username> \
  --reviewer <reviewer-github-username>[,<visibility-reviewer>] \
  --label <origin-label>[,<task-type-label>] \
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

(Add `--draft` if you want informal self-review before requesting the formal pass; convert to ready-for-review only after ACs are complete and the system spec / app spec / `Co-Authored-By` trailer are all in place.)

### 4. Postcondition verify — `requested_reviewers` is non-zero

```bash
gh api repos/Stoffer-Industries/sindustries/pulls/<number>/requested_reviewers \
  --jq '(.users | length) + (.teams | length)'
```

If this prints `0`, the PR is currently unreviewable by anyone's heartbeat queue. Fix it before moving on:

```bash
gh pr edit <number> --repo Stoffer-Industries/sindustries --add-reviewer <reviewer-github-username>
```

Re-run the REST `requested_reviewers` check and confirm it is non-zero before considering the PR opened.

> **Draft → ready conversion is also a "second opening" event.** Before `gh pr ready <number>`, rerun `assert-opener-identity.sh <intended-opener-login>` so an ambient token cannot change the PR's operating identity mid-lifecycle. Then add the reviewer(s) immediately (`gh pr edit <number> --add-reviewer <login>`) and re-run the REST check. The zero-reviewer state at `gh pr create --draft` time is expected and fine — but the conversion to ready-for-review must end with a non-zero `requested_reviewers` count.

### 5. Update task workstreams

For feature-task PRs, post `[implementer-prs] <url>` as a task comment when the PR is ready for review. Existing `[rowan-prs]` comments are treated as a legacy alias only; new work should use `[implementer-prs]`.

Then PATCH the task description to fill in the workstream `Branch:` and `PR:` lines. The task ID prefix is the first 8 chars of the branch name (`task-{8chars}-...`):

```bash
TASK_ID_PREFIX="<first-8-chars>"
TASK=$(TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py list | \
  python3 -c "import json,sys; tasks=json.load(sys.stdin)['data']; \
    t=next((t for t in tasks if t['id'].startswith('$TASK_ID_PREFIX')), None); \
    print(t['id'], t['description']) if t else print('NOT FOUND')")

TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py patch \
    --id <full-task-id> \
    --description '<updated description with Branch and PR filled in>'
```

If this PR covers only a subset of ACs, add a new workstream entry for the remaining ACs (still `Branch: (pending)`, `PR: (pending)`) so the task description reflects what is still outstanding.

## OUTPUT FORMAT

### PR body template

```markdown
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

## Acceptance Criteria  (feature-task PRs only)
- [x] AC<n>: <verbatim task AC sentence> (<annotation: evidence>)
- [x] ...

🤖 Generated with Claude Code
```

### Title format

`<type>(<scope>): <short description>` — same format as commit messages, under 72 characters.

### Summary bullets

Focus on *what* changed and *why*, not implementation steps. One bullet per logical change. For trivial PRs (e.g. code-garden), one bullet is enough.

### Test plan

Concrete, checkable steps — not "tests pass." For non-functional changes, "No logic changes — diff is purely structural" is acceptable.

### AC evidence annotations (priority-ordered)

The lobster enforces a per-AC evidence rule at the `doing → acceptance` gate. **Every task AC must appear in the PR body as a `- [x]` checkbox.** Each `- [x]` AC line must end with one of the following annotations, in priority order:

| Priority | Annotation | When to use |
|---|---|---|
| 1st | `(🧪 testID: <id>)` | Playwright e2e test or unit test ID — **always prefer this** |
| 2nd | `(⚠️ not tested: <reason>)` | When automation is genuinely impractical — requires a substantive reason |
| — | `(📄 not code: <reason>)` | AC fulfilled outside the codebase (doc, spec, config update) |
| — | `(🔗 pr: #<n>)` | Covered by a different merged PR |

`file:` has been removed. If you wrote a unit test, reference it via `testID` or explain in `not tested` why it wasn't feasible to add a Playwright test. Emojis are optional but encouraged for visual clarity.

A CI job or GitHub Actions check may be cited as `testID: <job name> CI job — <what it verifies>`; Ash's structured QA approval is the verification for that external check. For shell fixture suites, cite the script (for example `testID: fly-deploy-trigger-paths > static assertions`) rather than a prose summary of its assertions.

### Multi-task combined deliveries

When one PR covers two or more feature tasks, use one `## Acceptance Criteria` section containing a `### Task <task-id> — <short description>` subsection per task. The lobster scopes the AC vs task comparison by `### Task <id>` heading, so AC labels (`AC1`, `AC2`, ...) in different subsections do not collide. Each task's ACs still need their own evidence annotation.

```markdown
## Acceptance Criteria
### Task 513b3b02 — Pulse shell scaffold
- [x] AC1: Pulse loads at a single URL and renders a persistent tab bar. (testID: 4)
- [x] AC2: Tab bar shows Tasks, Bookmarks, and Flow metrics tabs. (not tested: design tokens; visual review only)
### Task e2e647b1 — Flow metrics dashboard
- [x] AC1: Dashboard shows cycle time (median and p90) for tasks completed. (testID: 5)
- [x] AC2: Dashboard is reachable from the Flow metrics tab. (🧪 testID: flow-metrics-tab-reachable)
```

### QA-bounce footer

After merge, the lobster compares the latest merged PR body against the task description ACs. If any AC is missing, unchecked, or has altered text, the task bounces back to `doing` and a `[feature-task-progress-checklist]` comment is posted explaining what the next PR must address. The AC list in the PR body is "work is in this PR", not "work is verified"; the actual QA verdict is Ash's structured `qa_agent` TaskApproval + Tom's structured `accepted` TaskApproval.

## KNOWLEDGE FILES

Read in this order before invoking this skill:

1. `agents/skills/dev/pr-process/SKILL.md` — reviewer routing, label table, merging rules, role-based entry points (opener / reviewer / addressee).
2. `agents/skills/dev/pr-address-feedback/SKILL.md` — referenced from `pr-process` for the addressing-comments loop (used after reviewer feedback lands, not at PR-open time).
3. The task description on the Tasks API — for the AC list to mirror in the PR body. Fetch with `python3 agents/skills/ops/tasks-api/tasks_api_client.py get --id <task-uuid>`.
4. `docs/CONVENTIONS.md` — for the system-spec vs app-spec DoD item (item 3) and the PR body's `## System Spec` requirement.
5. (Feature-task PRs) The task's prior `[implementer-prs]` comment, if any — to confirm which PR is the current gating PR for the task (the most recent one naming parseable PR URLs wins, not PR number magnitude).
6. (Rust workflow PRs only) `agents/workflows/feature-task/WORKFLOW.md` — quality gates before `gh pr create` or `gh pr ready`.

## ONBOARDING

To invoke this skill, the caller must provide:

- (a) the implementation branch name (off `origin/main`),
- (b) the implementation owner's GitHub login (the `--assignee` value),
- (c) the blocking reviewer's GitHub login, or `null` if the workflow does not specify one,
- (d) the label set (origin label + task-type label; see `pr-process/SKILL.md` for the table),
- (e) the task ID and full AC list (verbatim, for mirroring in the PR body), and
- (f) the system-spec path the implementation touched, or a substantive no-change reason.

The skill returns the `gh pr create` invocation composed from the inputs, runs the `requested_reviewers` REST postcondition check, and (for feature-task PRs) the workstream update + `[implementer-prs]` task comment.

## IDENTITY

> See the agent's `AGENTS.md` for role framing; this skill is doc-only and inherits the agent's authority boundaries from that file. No agent-specific role prose is inlined here.
