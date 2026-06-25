---
name: pr-process
description: "Generic PR lifecycle for Sindustries agent workflows: how to open, assign, review, and address comments on PRs. Reference this from HEARTBEATs and skills instead of hardcoding usernames or role logic."
---

# PR Process

Role-based guidance for any agent participating in a Sindustries PR. Each section covers one role — only read the section relevant to you.

Tokens are stored in `~/.openclaw/.env`. Use `grep <VAR> ~/.openclaw/.env | cut -d= -f2-` to read them.

---

## If you are opening a PR

Always set `--assignee` to yourself and `--reviewer` to the designated reviewer. Check the skill or heartbeat that invoked you for who the reviewer is; if not stated, default to `quinnstoffer`.

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --assignee <your-github-username> \
  --reviewer <reviewer-github-username> \
  ...
```

The assignee owns the PR to completion. The reviewer is the only one who merges.

---

## If you are the reviewer

### 1. Find open PRs assigned to you for review

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr list \
  --repo Stoffer-Industries/sindustries \
  --state open \
  --json number,title,url,headRefName,author,createdAt,assignees,reviewRequests
```

Filter to PRs where you are in `reviewRequests`.

### 2. For each PR: read the diff and CI status

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr diff <number> --repo Stoffer-Industries/sindustries

GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr checks <number> --repo Stoffer-Industries/sindustries
```

Do not approve or merge if CI is failing.

### 3. Apply a review tier (for code-garden PRs)

Code-garden PRs are categorised by risk. For other PR types, use your own judgement.

| Tier | Type | Reviewer action |
|------|------|-----------------|
| T1 | Trivial non-functional (dead code, comments, imports, typos) | Approve + merge |
| T2 | Structural, low risk (constants, dedup, type annotations) | Review carefully; approve + merge if correct |
| T3 | Touches logic, API surface, or security posture | Request changes — assignee must split |

If the PR mixes tiers (some hunks are T1, one hunk is T3), request changes and ask the assignee to split.

**Comment format:**
```
[T1] LGTM — merging.
[T2] LGTM. <specific note if anything worth flagging>.
[T2] Request changes: <specific actionable feedback>.
[T3] This crosses into logic territory: <reason>. Please split the T3 change out — keep this PR T1/T2 only.
```

### 4. Act on the tier

**Approve and merge (T1 or T2):**
```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --approve --body "[T1] LGTM — merging."

GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr merge <number> --repo Stoffer-Industries/sindustries --squash --delete-branch
```

**Request changes (T2 with issues or T3):**
```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
gh pr review <number> --repo Stoffer-Industries/sindustries --request-changes \
  --body "[T2] Request changes: <specific actionable feedback>."
```

### Reviewer guardrails

- Never merge with failing CI
- Never merge a PR that changes logic, security posture, or API surface
- Leave one clear review comment per PR — not multiple fragmented messages
- If a code-garden PR has been open >7 days with no CI issues and is T1: flag it in the heartbeat summary

---

## If you are the assignee addressing review comments

When the reviewer requests changes:

1. List your open PRs with pending reviews:
   ```bash
   GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
   gh pr list --repo Stoffer-Industries/sindustries --author <your-github-username> \
     --state open --json number,title,url,reviews
   ```

2. For each PR with `CHANGES_REQUESTED`, read the review comments:
   ```bash
   GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
   gh api repos/Stoffer-Industries/sindustries/pulls/<number>/comments \
     --jq '.[] | {id, path, line, body, user: .user.login}'
   ```

3. For each change request:
   - If valid T1/T2 fix: make the change, push to branch, reply "Fixed in `<commit-sha>`."
   - If requesting T3 change: reply "Acknowledged — this is out of scope for this PR. Leaving in T1/T2 scope."

4. Do not resolve threads — the reviewer resolves on re-review.
