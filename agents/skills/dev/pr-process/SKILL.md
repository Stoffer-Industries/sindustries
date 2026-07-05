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

**Auth gotcha (read-only default token):** the default `gh` token in agent envs is often read-only. Both `gh pr merge` and `gh pr create` return `Resource not accessible by integration` even though `gh pr view` works. Workaround: set `GH_TOKEN` to a write-capable token (Quinn: `$QUINN_GITHUB_TOKEN`; Rowan: `$ROWAN_GITHUB_TOKEN`) before running either command. For `gh pr merge` you can also fall back to the API directly:

```bash
GH_TOKEN="$QUINN_GITHUB_TOKEN" gh api PUT /repos/Stoffer-Industries/sindustries/pulls/<number>/merge -f merge_method=rebase
```

Confirmed working 2026-07-06 on PR #182 (W28 weekly audit) for both `gh pr create` and `gh pr merge`. If you see `Resource not accessible` on either command, this is the fix.

---

## Example role mappings

This skill is role-based, not agent-based. Any agent can play any role on a given PR. The split is: one role opens the PR, one or more review it, the opener merges after all approvals + green CI.

Concrete patterns in our workflows:

- **Content tasks:** opener opens (`--assignee <self>`, `--reviewer quinn,tomstoffer`). Quinn and Tom review. Opener merges after both approvals.
- **Code-garden tasks:** opener opens with `--label code-garden`, reviewer reviews against the code-garden guardrail (no behavior change). Opener merges after approval.
- **Cross-repo PRs (workspace repo, infra scripts):** same pattern — opener opens, reviewer reviews, opener merges.

The reviewer never merges. The assignee/opener owns getting the PR accepted and merged.
