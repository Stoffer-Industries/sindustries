---
name: code-garden-review
description: "Quinn reviews open code-garden PRs from Rowan, applies the review tier, merges T1/T2, and flags T3 for Tom."
---

# Code Garden Review

Quinn runs this skill during heartbeat to close out Rowan's non-functional cleanup PRs.

## Review tiers

| Tier | Type | Quinn action |
|------|------|-------------|
| T1 | Trivial non-functional | Auto-approve + merge |
| T2 | Structural, low risk | Review carefully, approve + merge if correct |
| T3 | Touches logic/API surface | Request changes — Rowan must split it |

**Comment format:**
```
[T1] LGTM — merging.
[T2] LGTM. <specific note if anything worth flagging>.
[T2] Request changes: <specific actionable feedback>.
[T3] This crosses into logic territory: <reason>. Please split the T3 change out — keep this PR T1/T2 only.
```

---

## Workflow

### 1. Find open code-garden PRs

See `agents/skills/dev/pr-roles/SKILL.md` for role conventions. PRs are assigned to Rowan; Quinn is the reviewer.

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr list \
  --repo Stoffer-Industries/sindustries \
  --label code-garden \
  --state open \
  --assignee rowanstoffer \
  --json number,title,url,headRefName,author,createdAt
```

If none, stop here.

### 2. For each PR

#### a. Read the diff

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr diff <number> --repo Stoffer-Industries/sindustries
```

#### b. Read CI status

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr checks <number> --repo Stoffer-Industries/sindustries
```

Do not merge if CI is failing.

#### c. Apply the tier

Ask for each changed file/hunk:
- Does this change any logic, computation, or runtime behavior? → T3
- Does this change a public API surface (exported function signature, REST endpoint, DB schema)? → T3
- Is this purely structural (rename, dead code, comment, doc, constant extraction)? → T1 or T2

If the PR mixes tiers (some hunks are T1, one hunk is T3): request changes asking Rowan to split.

#### d. Act on the tier

**T1 — approve and merge:**
```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --approve --body "[T1] LGTM — merging."

GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr merge <number> --repo Stoffer-Industries/sindustries --squash --delete-branch
```

**T2 — review and merge if correct:**
```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --approve \
  --body "[T2] LGTM. <note if anything worth flagging>."

GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr merge <number> --repo Stoffer-Industries/sindustries --squash --delete-branch
```

**T2 with issues — request changes:**
```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --request-changes \
  --body "[T2] Request changes: <specific actionable feedback>."
```

**T3 — block and explain:**
```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --request-changes \
  --body "[T3] This crosses into logic territory: <reason>. Please split the T3 change out — keep this PR T1/T2 only."
```

### 3. After merging

No task update needed — code garden PRs are not task-backed. The merge is the completion signal.

---

## Guardrails

- Never merge a PR with failing CI
- Never merge a PR that changes logic, security posture, or API surface
- Never merge a PR from a non-Rowan author via this skill (check `author` field)
- Leave one clear review comment per PR — not multiple fragmented messages
- If a PR has been open >7 days with no CI issues and is T1: flag it in the heartbeat summary
