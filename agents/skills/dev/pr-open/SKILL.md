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

Use your own GitHub token from `~/.openclaw/.env` for all `gh` commands. If you are unsure which env var holds your token, grep for your username in that file.

```bash
GITHUB_TOKEN="$(grep <YOUR_TOKEN_VAR> ~/.openclaw/.env | cut -d= -f2-)" \
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

