---
name: code-garden
description: "Pick findings from the latest repo audit and fix them. Opens a PR for review."
---

# Code Garden

## Guardrail

Follow audit findings as-is. The only constraint: **changes must be functionally equivalent** — the system must behave identically before and after. No spec changes, no API surface changes, no behavior changes.

Skip a finding if:
- Addressing it would change observable behavior
- It requires product/business judgement
- It touches security (needs Tom)
- You are unsure — skip and move on

The audit already identifies risk and severity. Trust it.

---

## Workflow

### 1. Find the latest audit

```bash
ls /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/repo-audits/ | sort | tail -1
```

Read the full audit file.

### 2. Select 1 finding

Check whether there is already an open PR with the `code-garden` label. That label is the **only** gate — any other open PRs (including infrastructure or skills PRs without the label) do not count and must be ignored.

```bash
gh pr list --repo Stoffer-Industries/sindustries --label code-garden --state open --json number,title
```

If that command returns a non-empty list, stop here. Otherwise proceed.

Pick one finding that:
- Is **not already marked done** in the audit md file (look for `<!-- DONE: PR #... -->` on the finding line)
- Can be fully addressed in a single focused PR

Skip any finding that requires understanding product/business intent. If unsure, skip.

### 3. Implement on a chore branch off main

```bash
git fetch origin
git checkout -b chore/code-garden-<audit-week>-<short-slug> origin/main
```

e.g. `chore/code-garden-2026-W26-stale-triage-comment`

Make the minimal change to address the finding. Do not bundle unrelated changes.

**Scope guard — your commits must never touch these paths** (they exist on the base branch but must not appear in your new commits):
- `agents/skills/`
- `agents/crons/`
- Any file outside the application source code

Before staging, verify only code improvement files are included:
```bash
git diff --name-only origin/main HEAD
```
If that list includes anything under `agents/skills/` or `agents/crons/`, do not open the PR — those leaked from the base branch. Fix by resetting those files: `git checkout origin/main -- <path>`.

If a finding only touches those paths, skip it entirely.

Run the relevant tests locally before committing:
```bash
# For TypeScript/JS changes:
npm test --workspace <affected-workspace>

# For Python changes:
python3 -m pytest <affected-dir>
```

Commit message format and co-authored-by convention: follow `agents/skills/dev/pr-open/SKILL.md`.

Example commit message:
```
chore(code-garden): <what was fixed> [<audit-week>]

Non-functional change from repo audit <audit-week>.
Finding: <short description>
```

### 4. Mark the finding as done in the audit file

Before opening the PR, edit the audit file to mark the finding done. Append `<!-- DONE: PR #TBD -->` to the finding's header line in `docs/repo-audits/<week>.md`. Commit this to the chore branch so it travels with the PR. Once the PR number is known, update the placeholder to the actual number.

### 5. Open PR

Read and follow: `agents/skills/dev/pr-open/SKILL.md`

Use this PR body format:

```
## Summary
- **Audit:** docs/repo-audits/<week>.md
- **Finding:** [<Severity>] <finding title>
- <one-sentence description of what was changed and why it's functionally equivalent>

## Test plan
- [ ] Relevant tests pass
- [ ] No logic changes — diff is purely structural/cosmetic

🌱 Code garden — non-functional cleanup only
```

Add `--label "code-garden"` to the `gh pr create` command.
