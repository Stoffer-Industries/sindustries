---
name: pr-process
description: "Generic PR lifecycle for Sindustries agent workflows: how to open, assign, review, and address comments on PRs. Reference this from HEARTBEATs and skills instead of hardcoding usernames or role logic."
---

# PR Process

Role-based entry point for Sindustries PR workflows. Read only the section for your role, then follow the linked skill.

---

## If you are opening a PR

Read and follow: `agents/skills/dev/pr-open/SKILL.md`

---

## If you are the reviewer

Read and follow: `agents/skills/dev/pr-review/SKILL.md`

**After completing your review:** submit approve or request-changes via `gh pr review`. Do not merge — the assignee merges.

For code-garden PRs, the single question is: **does this change observable behavior or any spec/API contract?** If yes, request changes. If no, approve. The audit already assessed risk — trust it.

Do not approve with failing CI. Leave one clear review comment per PR.

---

## If you are the assignee

### Addressing review comments

Read and follow: `agents/skills/dev/pr-address-feedback/SKILL.md`

### Merging after approval

Poll for review state in your heartbeat. Once all reviewers have approved and CI is green:

```bash
gh pr view <number> --repo Stoffer-Industries/sindustries --json reviews,statusCheckRollup
```

Merge when every requested reviewer shows `APPROVED` and CI passes:

```bash
gh pr merge <number> --repo Stoffer-Industries/sindustries --rebase --delete-branch
```

**Repo merge policy:** sindustries only accepts `rebase` merge (squash and merge-commit are rejected by repo settings). Use `--rebase`.

**Auth — always use your own token explicitly:** The default `gh` config has no token and will fail. Check your TOOLS.md for the correct config or env var to use. Before any write operation, verify you are authenticated as yourself:

```bash
gh api user --jq '.login'
```

**Never use another agent's token to work around a scope error.** Borrowing credentials changes the PR author, breaks reviewer assignment, and corrupts the audit trail. If your token lacks a required scope, escalate — do not improvise.

---

## PR Labels

Every PR must carry at least one label identifying its origin. Apply labels at `gh pr create` time via `--label`.

### Task-type labels (apply based on `taskType`)

| Label | When to use |
|---|---|
| `feature-task` | PR created by the feature task lobster workflow |
| `content-task` | PR created by the content task lobster workflow |
| `code-task` | PR created by the code task lobster workflow |
| `code-garden` | Code quality / structural cleanup PRs (existing) |
| `code-audit` | Weekly repo audit PRs (existing) |

### Origin labels (apply based on who initiated the work)

| Label | When to use |
|---|---|
| `workflow-garden` | Proactive fixes or improvements Quinn opens on her own initiative (no task, no direct ask) |
| `direct-ask` | PR requested directly by Tom in chat — include the original ask in the PR body |
| `retro-fix` | Same-day fix opened by the `retro-daily-fix` skill for the top `bad` pattern in yesterday's retro notes |

Labels are not mutually exclusive. A PR can be both `workflow-garden` and `direct-ask` if Tom spotted an issue in chat and Quinn fixed it.

---

## Example role mappings

This skill is role-based, not agent-based. Any agent can play any role on a given PR. The split is: one assignee owns the PR, one or more review it, and the assignee is responsible for merging once the required approval(s) are given and CI is green.

Concrete patterns in our workflows:

- **Feature tasks:** The task implementer is the PR assignee. The blocking reviewer is Quinn; Tom may be added as a visibility-only reviewer for GitHub inbox visibility. The assignee merges after the required approval (normally Quinn's) and CI is green — do not wait for Tom's PR approval or ask Tom to merge. Tom tests post-merge in main; his sign-off is the structured `qa` TaskApproval. The feature-task workflow is role-based: implementer is assignee/merger, reviewer reviews. Do not hardcode a specific agent into the workflow. Apply `--label feature-task` at PR creation.
- **Content tasks:** Assignee opens (`--assignee <self>`, `--reviewer quinn,Stoff81`, `--label content-task`). Quinn and Tom review. Assignee merges after the required approvals.
- **Code-garden tasks:** Assignee opens with `--label code-garden`, reviewer reviews against the code-garden guardrail (no behavior change). Assignee merges after approval.
- **Cross-repo PRs (workspace repo, infra scripts):** same pattern — assignee opens, reviewer reviews, assignee merges after approval.
- **Direct-ask PRs (Tom asked in chat, bypassing the task queue):** the `direct-ask` label describes *origin*, not reviewer routing — it does not replace the blocking reviewer. Quinn is still the blocking reviewer (`--reviewer quinn`); add Tom too (`--reviewer quinn,Stoff81`) for visibility since he's the one who asked. Do not request only Tom — he's not in any agent's `reviewRequests` heartbeat queue, so a Tom-only review request means nobody's automation will ever pick it up, and it relies entirely on Tom manually noticing.

The reviewer never merges. The assignee owns getting the PR accepted and merged.
