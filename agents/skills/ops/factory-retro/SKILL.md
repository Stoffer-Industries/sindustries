---
name: factory-retro
description: "Weekly retro on feature-task gate health and recurring patterns. Reads Post-Merge Feature Factory Analytics events (task f170e344), agent retro-notes (brain/ops/retro-notes/*.md), and auto-creates one feature task per run for the highest-impact pattern — Tom approves via the brain spec."
---

# Feature Factory Retro

Summarise feature-task gate health for the last 7 days using the analytics event stream
(`/api/v1/feature-task-analytics/*`, task f170e344), and produce up to 3 concrete,
data-backed suggestions to reduce gate fails.

Runs weekly via the "Factory Retro - Weekly" cron (Mon 9am NZST). Can also be run manually
on request between scheduled runs.

**Why events, not comments/PRs:** the feature-task lobster (`agents/workflows/feature-task/src/analytics.rs`)
now emits a `gate_failure` event on every gate block and a `terminal_summary` event on every
`done`/`accepted` transition. That's a structured, queryable record of the same signal this
skill used to reconstruct by re-parsing `[feature-task-progress-checklist]` comments and PR
bodies. Prefer the event stream; only fall back to comment/PR scraping for the two things
events don't cover (see Step 5).

**Why also retro-notes:** agents append rows to `brain/ops/retro-notes/YYYY-MM-DD.md` whenever they
notice the same shape of friction (or working practice) recur (`agents/skills/retro-notes/SKILL.md`).
This catches friction the lobster can't see — undocumented workarounds, missing mechanisms, patterns
that don't trip any tracked gate. Treat retro-notes as the **second signal source** alongside the
analytics event stream; the two are merged in Step 4's ranking.

**Why auto-create one feature task:** the actioning half of the loop is `pattern → note → auto-created
task → Tom approves via brain spec`. Without this, factory-retro would only surface observations;
tom still has to manually translate them into tasks. The auto-create puts the highest-impact pattern
directly into the backlog as a `feature` task; Tom approves via the brain-spec flow the same way he
approves every other feature task. One task per run is intentional: keeps the backlog signal density
high without spamming.

**Known gap:** there is no global aggregation endpoint yet (that's task 6a5783a7, still in
`doing` — a Postgres rollup fed by these same events). Until it ships, per-task gate-failure
breakdown means iterating `GET /feature-task-analytics/tasks/:taskId/events` across the
in-window task set (see `agents/skills/ops/tasks-analytics/SKILL.md` for the supersession
note). The `/weekly` endpoint already gives clean aggregate counts/rates — use it for
headline numbers, and only pay the per-task iteration cost for the top-3 breakdown.

All data plumbing below lives in `agents/skills/ops/tasks-analytics/` — see that skill for
endpoint details, script args, and the supersession note for when task 6a5783a7's
aggregation endpoint replaces the per-task loop. This skill only owns the report shape and
the failure-message → suggestion lookup table (domain knowledge, not data plumbing).

---

## Step 0 — Retro notes this week

```bash
ls -1 /Users/quinnstoffer/.openclaw/workspace/brain/ops/retro-notes/*.md 2>/dev/null \
  | tail -7 \
  | xargs -I {} sh -c 'echo "=== {} ==="; cat {}' 2>/dev/null
```

Read the last 7 days of files. For each row, extract `pattern-slug`, `agent`, `good|bad`, and the
one-line observation. Group by slug and count occurrences.

**Skip already-fixed patterns:** if a pattern's entry (row or `###` heading) carries a
`**Status:** ✅ [PR #...]` line (see `agents/skills/retro-notes/SKILL.md` "Marking a pattern
fixed"), exclude that slug from scoring/ranking and from Step 5's auto-create — it's already
shipped. Still count it in `uniquePatternCount` for the weekly digest, but don't resurface it
as a top-3 suggestion or spawn a duplicate task. If the status line calls out a specific
sub-issue as still open (bundled pattern, partial fix), keep scoring the pattern but treat the
observation text as only the still-open part.

Score each slug:
- `bad` pattern: `count × 3` (highest weight — these are blockers, not signal)
- `good` pattern: `count × 2` (lower weight — working practices are informational)
- Patterns with no `suggested-action` field: skip from ranking (observation-only, surface in digest)

Output: `{"patterns": [{"slug": "...", "agent": "...", "score": N, "occurrences": N, "suggestedAction": "..."}, ...]}`
sorted by score descending.

If the directory doesn't exist or contains no rows: output empty patterns list, proceed with events-only.

---

## Step 1 — Weekly aggregate snapshot

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-analytics/scripts/weekly_summary.py --weeks 2 | jq .
```

Take the most recent bucket (current week, Monday-start) as the headline. Keep the prior
bucket for trend comparison (rate going up/down).

If the current week's bucket has `gateFailureCount == 0` and `terminalTaskCount == 0`:
output `"✅ No signal this week — no gate failures, no terminal tasks."` and stop. Nothing
below applies.

---

## Step 2 — Terminal tasks this week (for titles + per-task deep checks)

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-analytics/scripts/get_terminal_tasks.py --days 7 \
  | jq -r '.[] | "\(.id[0:8]) — \(.title)"'
```

These feed the report's task-title list and Step 5's per-PR deep checks. They are not the
source of the gate-failure counts — those come from Step 1/Step 3.

---

## Step 3 — Top gate-failure breakdown (for the suggestions)

Scope: any task with recent gate-failure activity, not just terminal ones — a task can rack
up failures while stuck in `doing`/`ready`/`acceptance` without ever reaching `done`.
`tally_events.py` pulls the in-window task set (active statuses + this week's terminal
tasks), fetches each task's events, and tallies.

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-analytics/scripts/tally_events.py --days 7 | jq .
```

Returns `{"total": N, "byGate": [...], "byCause": [...], "byMessage": [...]}` — `byMessage` is
the most-common-first list Step 4 selects its top 3 from.

If `total == 0`: skip Step 4 (Top 3 suggestions) — there's nothing to suggest against, even
if the weekly bucket showed non-zero counts from a prior period.

**Retro-notes merge:** retro-note patterns from Step 0 are added to the ranking as additional
entries. A retro-note pattern with score `>= 6` (count × weight) is treated equivalently to a
gate-failure message with count `>= 2`. Step 4 selects its top 3 from the combined list — both
sources compete on the same score scale. This is the unified view factory-retro reports on.

---

## Step 4 — Top 3 suggestions to reduce gate fails

Only run this step if Step 3's `total > 0`. Take the top 3 entries from `message_counts`
(by count, ties broken by gate severity: `spec_check` > `ready_checks` > `post_merge` >
`verify_delivery` > `feedback_aggregate`) and turn each into one specific, actionable
suggestion. Do not write generic advice ("write better specs") — name the actual workflow
rule, gate, and who owns the fix.

Use this lookup table for known failure patterns. If a top-3 message doesn't match anything
below, write an ad-hoc suggestion referencing the literal gate + message text instead of
forcing it into a bucket.

| Failure message (substring match) | Gate | Cause | Suggestion |
|---|---|---|---|
| `Product spec not approved by Tom` | spec_check | capacity | Spec approval is the bottleneck. Recommend Quinn/Tom review new specs same-day during heartbeat rather than batching — every day a spec sits unapproved re-fires this failure on every lobster pass for that task. |
| `Task description must include workstreams` | spec_check / ready_checks | quality | Task creation is skipping the workstreams section. Recommend the task-creation paths (Quinn `tasks-create`, Rowan `feature-task-create`, bookmark pipeline, spec-from-conversation) default a stub `**Workstreams**` block so this never fires on a well-formed task. |
| `Task description must include acceptance criteria checkboxes` | spec_check | quality | Same root cause as workstreams — task creation producing incomplete descriptions. Recommend a pre-flight lint in the creation skill(s) that refuses to create a feature task without at least one `- [ ] AC` line. |
| Missing structured `qa` approval | post_merge | capacity | Tom's acceptance-gate backlog. If this is chronic, flag the accumulating count to Tom directly — it's a flow drag, not a quality issue. |
| `Missing task comment \`[tech-design]\`` | ready_checks | quality | Tech design isn't being posted before `ready`. Recommend Rowan post `[tech-design] <url>` (or `[tech-design-not-required] <reason>`) as part of picking up the task, before starting implementation. |
| Missing structured `tech_design` approval | ready_checks | capacity | Quinn's tech-design approval queue (delegated per HEARTBEAT.md) is lagging. Recommend Quinn check this queue every heartbeat pass, not just when nudged. |
| `Task must have an assignee/implementer before moving to \`doing\`` | ready_checks | quality | Tasks are reaching `ready` without an assignee. Recommend the creation flow set `assignee` at creation time when the owner is already known (e.g. Rowan for all feature work). |
| `Missing \`[implementer-prs]\` task comment` | verify_delivery / post_merge | quality | PR opened but never linked back to the task. Recommend `pr-open` skill's post-PR step (`[implementer-prs] <url>`) get checked in the implementer's own PR checklist, not just documented. |
| `does not show checked acceptance criteria in its body` | verify_delivery / post_merge | quality | PR body AC formatting drift (unbolded `AC1:`, no nested parens — see MEMORY.md lobster-parser gotchas). Recommend linking `pr-open` SKILL.md's AC-format section directly in the PR template/checklist so implementers hit it before opening, not after a bounce. |
| `already has an active task in \`doing\`` | ready_checks | capacity | Genuine capacity constraint — implementer already has a task in flight. Not a quality issue; no fix needed beyond scheduling, note it as expected friction. |
| `Spec drift detected` | ready_checks / post_merge | quality | AC checksum changed after approval. Recommend flagging spec edits post-approval more visibly (e.g. a warning at edit time) so drift is caught before the lobster blocks on it. |

Write the 3 selected suggestions as:

```
1. [N failures] <specific suggestion, gate + owner named>
2. [N failures] <specific suggestion, gate + owner named>
3. [N failures] <specific suggestion, gate + owner named>
```

If fewer than 3 distinct failure messages exist in the window, output only as many as exist —
do not pad with generic filler.

---

## Step 5 — Auto-create one feature task (highest-impact pattern)

This is the actioning half of the loop: `pattern → note → auto-created task → Tom approves via
brain spec`. Without this step, factory-retro only surfaces observations; Tom still has to manually
translate them into tasks.

Take the highest-score entry from the combined Step 0 + Step 3 ranking (skip any entry that lacks a
`suggested-action` field — those are observation-only).

Build a feature task:

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py create \
    --title "<suggested-action, one line, title-case, max 80 chars>" \
    --description "<observation + count + evidence links + pattern-slug>" \
    --taskType feature \
    --priority medium
```

Notes on what gets passed in:
- **Title**: the pattern's `suggested-action` (one line, title-case). Truncate at 80 chars.
- **Description**: includes the observation, the count ("3 occurrences this week"), the evidence
  links (task IDs / PR numbers / file paths), and the original `pattern-slug` in a callout. Tom
  approves via brain spec per the normal feature-task flow.
- **taskType**: `feature` — so it lands in the brain-spec approval queue, not the ops queue.
- **priority**: `medium` by default. Promote to `high` only if the top pattern's `bad` tag comes
  with `severity: high` or equivalent in the retro-notes row.
- **assignee**: leave unset — Tom picks during brain-spec approval.

Skip this step entirely if the highest-score entry is already a `gate_failure` message that has
created a task within the last 7 days. Check via `tally_events.py` for the most recent
`task-created` comment on a task with the same `pattern-slug`. Don't duplicate.

If Step 0 returned no patterns AND Step 3 returned `total == 0`: skip this step entirely. The
weekly digest still gets sent (Step 7), but no task is created — there's nothing to act on.

---

## Step 6 — Deep checks (still requires PR/comment scraping — not covered by events)

Two signals aren't in the analytics event schema yet. Only run these against Step 2's
terminal-task list (small set, don't scale this to all active tasks):

### Backfill PR detection
Check if a second PR was opened for the same task within 48 hours of the first. Look for:
- Multiple URLs in `[implementer-prs]` comments with close timestamps
- PR titles containing "backfill", "docs", "follow-up" on a task that already has a feature PR

(Requires `GET /tasks/:id` per task for comments — the list endpoint omits them.)

### System spec quality
In the latest linked PR body, read `## System Spec`. Flag if the section says "No change" or
is under 20 non-whitespace characters **and** the PR diff is large:

```bash
GITHUB_TOKEN="$QUINN_GITHUB_TOKEN" gh api repos/Stoffer-Industries/sindustries/pulls/<N> --jq '.additions + .deletions'
```
(threshold: > 200 lines)

Evidence-type mix (testID vs not-tested vs not-code) is already covered by Step 1's
`evidenceTypeDistribution` field — don't re-derive it from PR bodies.

---

## Step 7 — Write the report

Plain text for Telegram.

```
🏭 Feature Factory Retro — week of <weekStart from Step 1>

Terminal tasks: <terminalTaskCount>  |  Gate failures: <gateFailureCount>  (<gateFailureRate as %>, prior week <prior rate>)
Quality/Capacity split: <qualityFailureCount>/<capacityFailureCount>
PR cycle time: median <medianPrCycleTimeSeconds>s, p90 <p90PrCycleTimeSeconds>s
Retro notes: <retroNoteCount> rows, <uniquePatternCount> unique patterns

Auto-created feature task (highest impact):
→ <taskTitle> — <taskId> — score <score> — <one-line description>
→ Tom: approve via brain spec at brain/tasks/specs/open/<slug>.md

Top 3 patterns (highest impact):
1. [score N] <pattern-slug> — <observation> | evidence: <ids>
   → action: <suggested-action>
2. [score N] <pattern-slug> — <observation> | evidence: <ids>
   → action: <suggested-action>
3. [score N] <pattern-slug> — <observation> | evidence: <ids>
   → action: <suggested-action>

Findings:
• [Task title] — <backfill-PR or system-spec-quality finding, if any>
...

✅ Nothing else flagged.
```

If Step 1 already stopped (no signal): output just `"✅ No signal this week — no gate
failures, no terminal tasks."` and skip the rest of this template.

If Step 3 found `total == 0` AND Step 0 returned no patterns: omit the "Top 3 patterns"
and "Auto-created feature task" blocks entirely rather than printing empty ones.

---

## Step 8 — Deliver

Output the report and let Quinn decide whether to message Tom. The "Factory Retro - Weekly"
cron fires this skill weekly on a fixed cadence and Quinn delivers the digest. Can also be
triggered manually on request between scheduled runs.
