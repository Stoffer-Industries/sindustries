---
name: code-garden
description: "Pick non-functional findings from the latest repo audit and fix them. Opens a PR assigned to Quinn. T1/T2 changes only — no logic, no security, no behaviour changes."
---

# Code Garden

Rowan runs this skill during heartbeat to keep the codebase tidy without shipping logic changes.

## What counts as a code-garden change (T1/T2 only)

**T1 — Trivial, auto-mergeable by Quinn:**
- Remove dead/unreachable code
- Remove unused imports
- Fix stale/wrong comments or inline docs
- README additions or corrections
- Rename variable/function for clarity (no callers outside the file)
- Fix typos in strings that are not user-facing

**T2 — Structural, low risk (Quinn reviews before merging):**
- Extract a repeated literal into a named constant
- Consolidate duplicated logic into a shared helper (no API-surface change)
- Simplify a condition without changing its truth table
- Add or fix a TypeScript type annotation that doesn't change runtime behavior
- Add lint/format CI step (no rule changes, just enforcement)
- Sync constants that are documented as needing to match (e.g. assignee lists)

**Never pick (skip immediately):**
- Security fixes (separate, needs Tom)
- Performance changes that could affect observable behavior
- Logic refactors that change how data is computed
- New features or new tests
- Schema or migration changes
- Any finding tagged Critical or High in the audit

---

## Workflow

### 1. Find the latest audit

```bash
ls /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/repo-audits/ | sort | tail -1
```

Read the full audit file.

### 2. Load the done-list

Read (or create if missing) the state file tracking which audit findings have already been addressed:

```
/Users/quinnstoffer/.openclaw/workspace/brain/state/code-garden-state.json
```

Schema:
```json
{
  "done": [
    {
      "auditWeek": "2026-W26",
      "finding": "<short slug of the finding>",
      "pr": 123,
      "completedAt": "ISO"
    }
  ]
}
```

### 3. Select 1 finding

Check whether there is already an open PR with the `code-garden` label. That label is the **only** gate — any other open PRs (including infrastructure or skills PRs without the label) do not count and must be ignored.

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr list --repo Stoffer-Industries/sindustries --label code-garden --state open --json number,title
```

If that command returns a non-empty list, stop here. Otherwise proceed.

Pick one Low or Medium finding that:
- Is not already in the `done` list for this audit week
- Is T1 or T2 (see above)
- Can be fully addressed in a single focused PR

Skip any finding that requires understanding product/business intent. If unsure, skip.

### 4. Implement on a chore branch off feat/code-garden

Branch off `feat/code-garden`, not main:

```bash
git fetch origin
git checkout -b chore/code-garden-<audit-week>-<short-slug> origin/feat/code-garden
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

Commit message format:
```
chore(code-garden): <what was fixed> [<audit-week>]

Non-functional change from repo audit <audit-week>.
Finding: <short description>

Co-Authored-By: Rowan <rowanstoffer@gmail.com>
```

### 5. Open PR

PR targets `main`. The branch is off `feat/code-garden` for context, but the PR base is main.

```bash
GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
gh pr create \
  --repo Stoffer-Industries/sindustries \
  --base main \
  --title "chore(code-garden): <what was fixed>" \
  --label "code-garden" \
  --assignee quinnstoffer \
  --body "$(cat <<'EOF'
## Code garden

**Audit:** docs/repo-audits/<week>.md
**Finding:** [<Severity>] <finding title>
**Tier:** T1 | T2

<one-sentence description of what was changed and why it's non-functional>

## Test plan
- [ ] `npm test --workspace <workspace>` passes
- [ ] No logic changes — diff is purely structural/cosmetic

🌱 Code garden — non-functional cleanup only
EOF
)"
```

### 6. Update the state file

Add an entry to `brain/state/code-garden-state.json` for each finding addressed.

---

## PR comment addressing

When this skill is called to address review comments (not to pick new findings):

1. List your open PRs:
   ```bash
   GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
   gh pr list --repo Stoffer-Industries/sindustries --author rowanstoffer --state open \
     --label code-garden --json number,title,url
   ```

2. For each PR, check for unresolved review comments:
   ```bash
   GITHUB_TOKEN="$(grep QUINN_GITHUB_TOKEN ~/.openclaw/.env | cut -d= -f2-)" \
   gh pr view <number> --repo Stoffer-Industries/sindustries --json reviews,comments
   ```

3. For each `CHANGES_REQUESTED` review with specific comments:
   - Read the comment carefully
   - If it's requesting a T3 change: reply "Acknowledged — this finding has been escalated to Tom as it touches logic/behavior. Leaving this PR in its current T1/T2 scope."
   - If it's requesting a valid T1/T2 fix: make the change, push to the same branch, reply "Fixed in <commit-sha>."

4. Do not resolve threads yourself — Quinn resolves them on re-review.
