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

Do not approve with failing CI. Leave one clear review comment per PR.

---

## If you are the assignee

### Addressing review comments

Read and follow: `agents/skills/dev/pr-address-feedback/SKILL.md`

### Merging after approval

Poll for review state in your heartbeat. Once all reviewers have approved and CI is green:

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr view <number> --repo Stoffer-Industries/sindustries --json reviews,statusCheckRollup
```

Merge when every requested reviewer shows `APPROVED` and CI passes:

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr merge <number> --repo Stoffer-Industries/sindustries --squash --delete-branch
```
