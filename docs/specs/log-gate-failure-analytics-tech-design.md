---
status: draft
task_id: 6a5783a7-83cd-431d-abb0-a041f5d08813
product_spec: brain/tasks/specs/open/log-gate-failure-analytics-post-merge-2026-07-22.md
shipped_pr: null
shipped_date: null
alignment_note: |
  This task is the summary-table sibling of task f170e344
  (post-merge-feature-factory-analytics, in `doing`, PR #303). f170e344
  captures every per-stage lifecycle event into a `feature_task_analytics_events`
  table; this task captures a single summary row per completed task into a
  `feature_task_analytics` table. The two are intentionally separate surface
  areas: the event log is fine-grained replay; the summary table is what the
  flow dashboard and retro scan read. Both ship in parallel; neither blocks
  the other.

  **Open question — revisit during implementation:** PR #303 ships a
  dashboard panel (`FeatureTaskAnalyticsPanel` in `apps/mission-control`) with
  weekly stacked capacity-vs-quality bars for AC4 of f170e344. Once PR #303
  merges, AC2 of this task ("weekly avg `quality_gate_failures` trend line
  alongside cycle time metrics") is *partially satisfied* by that panel. The
  remaining work may shrink to (a) the aggregate row + classifier + factory
  retro read path, and (b) folding the new `feature_task_analytics` table into
  the existing f170e344 dashboard panel rather than shipping a second
  `QualityFailuresTrend` chart. Confirm with Quinn during implementation
  whether to ship a separate dashboard component or reuse PR #303's panel.
---

# Log gate failure analytics at post-merge — tech design

## Links

- Product spec: `brain/tasks/specs/open/log-gate-failure-analytics-post-merge-2026-07-22.md`
- Task: `6a5783a7-83cd-431d-abb0-a041f5d08813` (`🔧 Log gate failure analytics at post-merge for flow dashboard`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/6a5783a7-83cd-431d-abb0-a041f5d08813`
- Sibling task: `f170e344-ea5f-4443-bebb-035948686fc1` (lifecycle event log) — emits per-stage events; this task emits one summary row per completed task.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-6a5783a7-log-gate-failure-analytics`
- Worktree: `~/workspaces/rowan/sindustries-task-6a5783a7-log-gate-failure-analytics` (currently co-located with the f520c396 worktree dir at `~/workspaces/rowan/sindustries-task-f520c396-gymtrack-agent-powered-workouts`; rename on next housekeeping pass)
- Surfaces touched:
  - `services/tasks-api/prisma/schema.prisma` — new `FeatureTaskAnalytics` model + migration
  - `services/tasks-api/src/routes/analytics.ts` — new router for the dashboard read endpoint
  - `agents/workflows/feature-task/src/main.rs` — post-merge step writes the analytics row
  - `agents/skills/ops/factory-retro/SKILL.md` — read gate counts from the table instead of recounting comments
  - `apps/mission-control/` — new dashboard panel + API client

## Goal

Persist one summary row per completed feature task with a capacity-vs-quality breakdown of gate failures, so the flow dashboard can show a weekly trend and the factory retro skill can read counts without re-scanning every lobster comment. The classification rule is the central design decision: capacity failure = "the implementer was not available", quality failure = "the work was not ready".

## Why this approach

Two patterns considered for capturing the capacity-vs-quality split:

1. **Tag at the failure site** — change each lobster stage to label its failure fingerprints as `capacity` or `quality` at the moment the comment is written. Pro: zero ambiguity. Con: every stage and every future fingerprint needs to be re-tagged; classification logic is scattered.
2. **Centralised classifier at post-merge** — keep today's fingerprints as-is, and at post-merge scan the task's `[feature-task-progress-checklist]` comments once, classify each fingerprint against a small allow-list, and write the row. Pro: classification logic lives in one place; future lobes can ship new fingerprints without analytics changes (only the allow-list grows). Con: keep the allow-list honest.

Approach 2 is chosen. The capacity fingerprint is uniquely stable (the gate loops on "Implementer `<name>` already has an active task in `doing`" — printed by `implementer_doing_capacity_failures()`), so a single sentinel string match is enough. Every other fingerprint is quality by default. Adding a new capacity check in the future is a one-line PR to the classifier.

## Data model

New Prisma model in `services/tasks-api/prisma/schema.prisma`:

```prisma
model FeatureTaskAnalytics {
  taskId                String   @id @db.Uuid
  completedAt           DateTime
  totalGateFailures     Int
  capacityGateFailures  Int
  qualityGateFailures   Int
  cycleDays             Int

  @@index([completedAt])
  @@map("feature_task_analytics")
}

enum GateFailureKind {
  capacity
  quality
}
```

`@id` on `taskId` makes the row naturally idempotent (one row per task). Re-running post-merge on an already-archived task is a no-op via `upsert`.

The classification helper lives in `agents/workflows/feature-task/src/main.rs`:

```rust
fn classify_gate_failure(text: &str) -> GateFailureKind {
    if text.contains("already has an active task in `doing`")
        || text.contains("must have an assignee/implementer before moving to `doing`")
    {
        GateFailureKind::Capacity
    } else {
        GateFailureKind::Quality
    }
}
```

A unit test pins the two capacity fingerprints. All other fingerprints (review feedback, missing evidence, system spec gate, missing `[implementer-prs]`, etc.) are classified as `quality`.

## Source-of-truth boundary

- The Prisma model is the new canonical store for the summary row. Tasks API owns it.
- The capacity-vs-quality classifier lives in the lobster binary. Tasks API does not need to know how classification works — it only stores the counts.
- The factory-retro skill reads from the table. The skill no longer needs comment-text parsing.
- Mission-control reads from a new `analytics` route which runs an aggregate query against the table.

## `.openclaw` boundary

- No `~/.openclaw/` writes required.
- Database migration runs through the standard Prisma migration path (`make db-migrate` in the dev prodlike data plane). No new env vars.
- Mission-control needs no new secrets — the existing tasks-api URL is reused.

## Implementation plan

### 1. Prisma migration

Add `FeatureTaskAnalytics` plus a Postgres migration. The companion task `f170e344` (lifecycle event log) will likely add a separate `feature_task_lifecycle_events` table; both land in their own migrations and the two coexist cleanly.

### 2. Lobster: write at post-merge

In `post_merge`, after the task transitions to `done` (and after `archive_done_task_spec` succeeds), call a new helper:

```rust
fn write_post_merge_analytics(args: &StageArgs, task: &Task) -> Result<()> {
    let comments = list_task_comments(&args.base_url, &task.id)?;
    let lobster_progress = comments.iter()
        .filter(|c| c.author == "Lobster"
            && c.text.starts_with("[feature-task-progress-checklist]"));
    let (cap, qual) = lobster_progress
        .fold((0, 0), |(c, q), c| match classify_gate_failure(&c.text) {
            GateFailureKind::Capacity => (c + 1, q),
            GateFailureKind::Quality => (c, q + 1),
        });
    let total = cap + qual;
    let completed_at = task.completed_at.unwrap_or_else(Utc::now);
    let cycle_days = (completed_at - task.created_at).num_days().max(0);
    analytics_upsert(&args.base_url, AnalyticsRow {
        task_id: task.id.clone(),
        completed_at,
        total_gate_failures: total,
        capacity_gate_failures: cap,
        quality_gate_failures: qual,
        cycle_days,
    })?;
    Ok(())
}
```

The helper is idempotent — same `taskId` upserts an existing row. `archive_done_task_spec` runs before analytics so the spec is archived before the row is written (no ordering risk).

### 3. Tasks API: new analytics endpoint

`services/tasks-api/src/routes/analytics.ts`. Read-only.

```ts
// GET /api/v1/analytics/feature-task-quality-failures-weekly?weeks=8
// Returns: [{ weekStart: '2026-07-20', avgQualityGateFailures: 1.4, taskCount: 5 }, ...]
```

Group by `date_trunc('week', completed_at)`, average `quality_gate_failures`, exclude the current partial week. Auth: same as the comments endpoint (no user-scoped filtering — analytics is global).

A second endpoint `GET /api/v1/analytics/feature-task-recent?limit=50` returns the row-by-row view for the factory retro and for ad-hoc drilling.

### 4. Mission-control: dashboard panel

New component `apps/mission-control/src/components/QualityFailuresTrend.tsx`. Reads the weekly endpoint, renders a line chart with weekly avg `qualityGateFailures` on the y-axis and week on the x-axis. Period selector `4w / 8w / 12w`. Reuses the charting library already in the app (look at the existing weekly cycle-time panel for the chart pattern).

The panel lives next to the existing cycle-time panel on the flow dashboard route.

### 5. Factory retro: read from the table

Replace the comment-counting block in `agents/skills/ops/factory-retro/SKILL.md` Step 2 with a `GET /api/v1/analytics/feature-task-recent?limit=50` query. The skill still walks `comments` for evidence-quality and backfill-PR detection (those are independent of gate-count analytics), but the gate-failure count is read from the API. Crucially, the retro skill now reads the *summary* per-task, not the per-comment enumeration, so the output is consistent with what the dashboard shows.

## Test plan — AC verification matrix

| AC | Layer | Plan |
|---|---|---|
| AC1 (row written at post-merge with the documented columns) | E2E: feature-task workflow tests | Drive a fixture task all the way to `done`. After the post-merge stage runs, assert a row exists with the expected columns and non-negative counts. Re-run post-merge on the same task and assert the row is unchanged (idempotency). |
| AC1 (capacity count is correct for a known capacity-blocked task) | Unit | Fixture task with two capacity-block comments and one quality-block comment. Run the classifier via a unit test; assert `capacity = 2, quality = 1, total = 3`. |
| AC1 (cycle_days is computed from createdAt to completedAt) | Unit | Fixture with `createdAt` 2026-07-01 and `completedAt` 2026-07-22. Assert `cycle_days == 21`. |
| AC2 (weekly endpoint returns weekStart, avgQualityGateFailures, taskCount) | E2E: tasks-api tests | Seed the analytics table with rows across 3 weeks (4, 6, 8 quality failures). Assert the endpoint returns 3 grouped rows with the correct averages and counts. |
| AC2 (mission-control panel renders a chart) | Unit + visual | Component test asserts the line chart receives the weekly data and renders the expected number of points. Visual review captured in the PR screenshots. |
| AC3 (factory retro reads from the table) | Manual + skill diff | The factory-retro `SKILL.md` no longer contains the comment-counting block in Step 2; it contains the new GET call. Review the PR diff. Run the skill once and verify the output uses the new counts. |
| AC3 (factory retro output is consistent with dashboard) | Manual | Generate a retro for the same week that the dashboard shows. The aggregated `quality_gate_failures` per task should match between the two views. |

E2E coverage is appropriate for AC1 and AC2 because the changes are end-to-end observable (lobster → Postgres → API → dashboard). AC3 is skill-text + manual; the skill change is mostly a documentation update.

## Open questions and risks

- **Classifier drift.** The capacity allow-list is two strings today. If a future capacity check is added (e.g. environment-specific capacity), the classifier must be updated. Mitigation: a unit test lists every capacity fingerprint string the lobster currently emits; CI fails if a new one is added without an allow-list update. The test file lives next to `classify_gate_failure`.
- **Pre-merge tasks.** Today's fingerprint strings are pre-merge. Post-merge the lobster may add QA-failure fingerprints (`Task advanced to \`done\` without Tom verifying task ACs`). Those are quality failures by definition (the implementer missed the QA gate). The default quality classification handles them correctly today; if a new post-merge fingerprint is added, the classifier may need to be extended. The unit test is the safety net.
- **Backfill.** The product spec explicitly disallows backfilling historical data. The dashboard's first 8 weeks will be partially sparse until 8 weeks of new completions accumulate. The retro skill continues to work on the sparse data by averaging whatever rows are present.
- **Partial-week handling.** The weekly endpoint excludes the current partial week. If today is Wednesday, the most recent week-start is last Monday and is excluded. This keeps the trend line stable across mid-week viewings; the alternative (include partial week) produces a misleading downward spike every Monday.
- **Multi-implementer capacity.** The capacity gate covers Rowan today. If a second implementer is added, the row schema does not need to change (the summary is per-task), but the dashboard's aggregate view may need a per-implementer breakdown later. Out of scope for this task.
