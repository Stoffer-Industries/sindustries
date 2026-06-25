---
name: pr-review
description: >
  Conduct a code review and submit your verdict via gh pr review. Use when the user
  asks to review a PR, check a PR for problems, review someone's code changes, or
  audit a pull request. Triggers include "review this PR", "review this pull
  request", "check this PR for problems", "review the diff", "look at this PR",
  "any problems with this PR".
---

# PR Review

Conduct a review and submit approve or request-changes via `gh pr review`. Do not merge — the assignee merges.

## Workflow

### 1. Get the diff and context

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr view <number> --repo Stoffer-Industries/<repo> --json title,body,reviews,statusCheckRollup

GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr diff <number> --repo Stoffer-Industries/<repo>
```

Read the title, body, and existing reviews. Note any linked task or spec, and the PR's scope guardrail (code-garden = no behavior change; content task = ACs from linked task; infra = check runbooks).

### 2. Understand intent

Before line-by-line review:
- What is this PR trying to achieve? (title + description)
- What type of change is it? (bug fix / feature / refactor / cleanup)
- What scope guardrail applies? Does the diff respect it?

### 3. Review the changes

**Read the changed files in context** (surrounding code, not just the diff lines). **Trace changed contracts and callers** — if a signature or shared type changed, every consumer is affected. **Check tests actually prove the change**, not just that they run. **Prioritise correctness, security, and data loss over style** — a PR with great naming but a race condition is not LGTM.

For each modified file, walk through these in order:

1. **Correctness and logic errors** — things that would cause incorrect behavior.
2. **Security** — input validation, injection, auth, secret handling.
3. **Contract / API surface changes** — backward compatibility, validation, return shapes.
4. **Performance** — only in hot paths or where the change is plausibly worse.
5. **Missing or weak tests** — for any changed logic.
6. **Style and readability** — only flag if genuinely confusing.

Be specific — reference file:line. Provide fixes, not just complaints. Do not flag TODOs or pre-existing issues unless the PR makes them worse.

**When to escalate to pr-deep-review:** if the PR touches any of the following, run `pr-deep-review` for the full checklist before approving:

- Concurrency, async paths, locks, or shared mutable state
- Database queries, schema changes, or data migrations
- Authentication, authorization, secrets, or token handling
- Public APIs or shared types/contracts (exported types, REST/GraphQL signatures, serialisation formats)
- File system, network, or external service integration
- Error handling / retry / backoff logic
- Anything touching `tasks-api`, `bookmark-*` workflows, `tilt`, `otel`, or infra runbooks

For doc updates, content tasks, code-garden cleanup, and small bug fixes, this skill alone is sufficient — do not invoke `pr-deep-review` for those.

### 4. Task-linked PRs

If the PR is linked to a task (look for `Task:` or `Linked task:` in the body, or match the PR title to a task title), every AC must be verified and marked done **during review, before approving**.

1. Read the task body in the Tasks API (`tasks_api_client.py get <task-id>`).
2. For each AC in the task, find the corresponding change in the diff. If any AC is not delivered, request changes — **do not approve until every AC has a matching change**.
3. When every AC is accounted for, mark the AC checkboxes in the task body as done (`- [ ]` → `- [x]`) using your role's check-off script:
   - **Quinn (content reviewer):** runs `check_off_quinn_acs.py`:
     ```bash
     TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
       python3 codebases/sindustries/agents/workflows/content-tasks/scripts/check_off_quinn_acs.py \
       --task-id <task-id>
     ```
   - **Tom (content reviewer):** no script — Tom verifies ACs by reading the task body and the diff directly. There is no separate flip-the-box step.
   - **Other roles:** check the content-tasks workflow docs before assuming a script exists. Do not invent one.
4. Approve the PR only after every AC is verified AND marked done in the task body.

The PR can only be approved once all ACs are checked. Merging is a separate step that happens after approval.

### 5. Submit verdict

Approve:

```bash
GITHUB_TOKEN="..." gh pr review <number> --repo Stoffer-Industries/<repo> --approve --body "LGTM"
```

Request changes (always with specific, actionable feedback):

```bash
GITHUB_TOKEN="..." gh pr review <number> --repo Stoffer-Industries/<repo> --request-changes --body "<specific issues>"
```

## Guardrails

- **One clear review per PR.** Consolidate feedback; do not leave fragments or "minor" comments that the assignee has to chase.
- **Do not approve with failing CI.**
- **Do not bundle unrelated cleanup.** If you spot something off-topic, file a follow-up — don't block this PR on it.
- **Scope guardrails.** If the PR's diff touches `agents/skills/` or `agents/crons/`, verify it does not include application code (those paths belong on a different PR). If it does, request changes.
- **Code-garden PRs.** The single question is: does this change observable behavior or any spec/API contract? If yes, request changes. The audit already assessed risk — trust it.
