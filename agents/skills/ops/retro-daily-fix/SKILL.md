---
name: retro-daily-fix
description: "Daily pass over yesterday's retro-notes (brain/ops/retro-notes/YYYY-MM-DD.md): picks the single highest-impact 'bad' pattern with a suggested-action, re-verifies it's still live, and fixes it directly (config/data) or via a PR (code/docs) — the same-day tactical loop. Complements the weekly factory-retro, which does cross-week RCA and creates feature tasks for structural issues this can't reach."
---

# Retro Daily Fix

The retro-notes system (`agents/skills/retro-notes/SKILL.md`) is a firehose of small, dated
observations — agents append a row whenever they hit the same shape of friction twice. Most
rows never get acted on same-day; they sit until the weekly `factory-retro` pass aggregates
them into a feature task, which Tom then has to approve and someone has to implement. For a
row whose fix is a one-line config change or a small, well-scoped code fix, that's a lot of
latency for something that could just be done.

This skill closes that gap: read yesterday's file, pick the ONE highest-impact actionable
`bad` row, and actually resolve it — same day, no task-admin round-trip, following the same
discipline used on 2026-08-21 for the `tasks-api-actor-attribution-quinn-default` finding
(found in retro-notes → root cause confirmed live → fixed directly with a doc/PR follow-up).

**Relationship to `factory-retro` (weekly):** this skill does the tactical single-item fix;
factory-retro does the cross-week pattern analysis, root-cause writeups, and auto-creates a
feature task for the structural issue behind a recurring pattern. A pattern this skill fixed
outright shouldn't need a feature task later; a pattern this skill *can't* safely act on
(infra, another agent's runtime, anything needing human judgment) is exactly the kind of
thing factory-retro's weekly RCA should catch if it keeps recurring.

**One fix per run, same reasoning as factory-retro's one-task-per-run:** keeps the daily
digest readable and keeps Quinn from batching up unreviewed changes.

---

## Step 0 — Locate yesterday's file

```bash
YESTERDAY=$(TZ=Pacific/Auckland date -v-1d +%Y-%m-%d 2>/dev/null || TZ=Pacific/Auckland date -d yesterday +%Y-%m-%d)
cat "/Users/quinnstoffer/.openclaw/workspace/brain/ops/retro-notes/${YESTERDAY}.md" 2>/dev/null
```

If the file doesn't exist, or exists with no `bad`-tagged rows: output `"✅ No actionable
findings in yesterday's retro-notes ($YESTERDAY)."` and stop. Don't reach into older files —
this skill is deliberately scoped to yesterday only; older unresolved rows are the weekly
pass's job.

---

## Step 1 — Pick the top candidate

Parse rows in the same shape `factory-retro` Step 0 uses: `date`, `agent`, `good|bad`,
`pattern-slug`, observation, optional `suggested-action`, optional `| evidence: ...`.

Filter to `bad` rows with a `suggested-action`. If none qualify (all `good`, or all missing a
suggested-action): output `"✅ Yesterday's findings are informational only — nothing with a
concrete suggested-action to act on."` and stop.

Rank by, in order:
1. Explicit severity if present in the row (`high` > `medium` > default).
2. Whether the row cites a specific, checkable evidence artifact (file path, task ID, PR
   number) — prefer rows you can actually verify over vague ones.
3. Earlier-logged row wins ties (first blocker of the day is usually still the most acute).

Take the single top row. If two rows are genuinely tied on all three, prefer the one whose
fix looks smaller in scope (safer for an unattended daily pass) — do not attempt the larger
one "for efficiency."

---

## Step 2 — Re-verify it's still real

Do not act on the retro-note's text alone — it's a snapshot from whenever it was written,
and may already be stale by the next morning. Re-check live state for whatever the row
actually claims:

- If it names a task: `GET /tasks/:id` and check current status/approvals/comments.
- If it names a file/config: read the current file, not just the diff quoted in the row.
- If it names a PR: `gh pr view <n>` for current state.
- If it names an env var or credential: check presence (not the value) the same way — don't
  print secrets into the report.

If the condition no longer holds (someone already fixed it, the task moved on, the PR
merged): stop here, report `"Yesterday's top finding (<pattern-slug>) was already resolved
before this run — no action taken."` Do not manufacture work.

If it's still live, proceed. If verification is inconclusive (can't tell either way): treat
this as **not safely fixable** and fall through to the routing case in Step 3, don't guess.

---

## Step 3 — Classify and fix

**Direct fix** (env var / credential wiring in `~/.openclaw/.env`, a Tasks API state
correction via `tasks_api_client.py`, a workspace-only file under
`/Users/quinnstoffer/.openclaw/workspace/` outside `codebases/sindustries/`): apply it
directly, then verify the fix actually took (re-read the value / re-fetch the task / re-run
the check that would have caught the original problem).

**Code/docs fix inside the sindustries repo:**
1. `infra/guards/sindustries-worktree.sh <descriptive-branch-name>` — never edit inside
   `codebases/sindustries/` directly, and never work on bare `main`.
2. Make the minimal change that resolves the specific finding. Don't use this pass to also
   clean up adjacent things you notice — one fix, one PR, matching the row's actual scope.
3. Commit as `quinnstoffer`, push, open a PR with Tom as the reviewer (`gh pr create ...
   --reviewer Stoff81 --label retro-fix`). Reference the retro-notes finding and evidence in
   the PR body.
4. **Never merge or self-approve.** This skill's job ends at "PR is open and correct" — same
   rule as every other Quinn-authored PR.
5. Once the PR merges (check on the next run, or same run if Tom approves quickly), mark the
   row fixed per `agents/skills/retro-notes/SKILL.md` "Marking a pattern fixed" — append
   `**Status:** ✅ [PR #<n>](<url>) (merged <date>)` under the pattern's entry in the
   `brain/ops/retro-notes/YYYY-MM-DD.md` it came from (a direct file edit, not part of the
   sindustries repo). This keeps `factory-retro`'s weekly scoring from re-surfacing a pattern
   this skill already closed.

**Not safely fixable by Quinn** (infra changes that are Lox's domain, another agent's runtime
or credentials, anything where the "fix" requires a judgment call beyond mechanically
applying what the row already specifies): don't attempt it. Post the finding, the reason it's
out of scope, and who should own it (Lox for infra, Rowan for larger code changes, Tom for
anything needing a product/business call) in the daily report instead. This is a legitimate,
expected outcome — not a failure of the run.

Remove the worktree after pushing (`git worktree remove`), same as any other Quinn PR.

---

## Step 4 — Report

Deliver the same way `factory-retro` does — output the summary and let Quinn decide whether
to message Tom directly, or let the cron's own delivery handle it.

```
🔧 Daily Retro Fix — <yesterday's date>

Top finding: <pattern-slug> (<agent> — bad)
<one-line observation from the row>

Status: <Fixed directly | PR opened | Already resolved | Not safely fixable — routed to <owner>>
<what was done, or why not, in 1-3 sentences>
<PR link if one was opened>

No other rows actioned this run (one fix per day, by design).
```

If Step 0 or Step 1 stopped early, output just that message and nothing else.
