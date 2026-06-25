---
name: pr-roles
description: "Defines PR author, assignee, and reviewer roles for Sindustries repository workflows. Reference this from HEARTBEATs and skills instead of hardcoding usernames."
---

# PR Roles

Single source of truth for who creates, owns, and reviews PRs across Sindustries agent workflows.

## Roles

| Role | Agent | GitHub username | Token env var |
|------|-------|----------------|---------------|
| Author / Assignee | Rowan | `rowanstoffer` | `ROWAN_GITHUB_TOKEN` |
| Reviewer | Quinn | `quinnstoffer` | `QUINN_GITHUB_TOKEN` |

## Creating a PR (Rowan)

- Use `ROWAN_GITHUB_TOKEN` for all `gh` commands
- Always include `--assignee rowanstoffer --reviewer quinnstoffer`

```bash
GITHUB_TOKEN="$(grep ROWAN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --assignee rowanstoffer \
  --reviewer quinnstoffer \
  ...
```

## Reviewing a PR (Quinn)

- Use `QUINN_GITHUB_TOKEN` for all `gh` commands
- Discover PRs by label or assignee (`--assignee rowanstoffer`)

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr list \
  --repo Stoffer-Industries/sindustries \
  --assignee rowanstoffer \
  --state open \
  --json number,title,url,headRefName,author,createdAt
```

## Addressing review comments (Rowan)

When Quinn requests changes, Rowan fixes them and pushes to the same branch:

1. List open code-garden PRs authored by Rowan:
   ```bash
   GITHUB_TOKEN="$(grep ROWAN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
   gh pr list --repo Stoffer-Industries/sindustries --author rowanstoffer \
     --state open --label code-garden --json number,title,url
   ```
2. For each PR, check for `CHANGES_REQUESTED` reviews:
   ```bash
   GITHUB_TOKEN="$(grep ROWAN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
   gh pr view <number> --repo Stoffer-Industries/sindustries --json reviews,comments
   ```
3. For each `CHANGES_REQUESTED` with specific feedback:
   - If valid T1/T2 fix: make the change, push to branch, reply "Fixed in `<commit-sha>`."
   - If requesting T3 change: reply "Acknowledged — this is out of scope for this PR. Leaving in T1/T2 scope."
4. Do not resolve threads — Quinn resolves on re-review.
