---
status: draft
task_id: 6a5783a7-83cd-431d-abb0-a041f5d08813
product_spec: brain/tasks/specs/in-progress/log-gate-failure-analytics-post-merge-2026-07-22.md
shipped_pr: null
shipped_date: null
---

# Log gate failure analytics at post-merge for flow dashboard — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/log-gate-failure-analytics-post-merge-2026-07-22.md`
- Task: `6a5783a7-83cd-431d-abb0-a041f5d08813` (`🔧 Log gate failure analytics at post-merge for flow dashboard`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/6a5783a7-83cd-431d-abb0-a041f5d08813`
- Predecessor task: `f170e344-ea5f-4443-bebb-035948686fc1` (Post-Merge Feature Factory Analytics). On 2026-07-26 PR #303 shipped the underlying analytics-event surface that this task is now defined against. See "Scope drift" below — most of the spec is already covered by PR #303; the residual work is the factory-retro skill migration to read from the database.

## Scope drift (read this first)

The 6a5783a7 spec was written on 2026-07-22 against a plan to introduce a custom `feature_task_analytics` Postgres aggregation table written by the feature-task lobster at `post_merge`. Sibling task `f170e344` (Post-Merge Feature Factory Analytics) widened the design to an event-sourced analytics model and shipped it on 2026-07-26 in PR #303. The shipped surface and the 6a5783a7 spec overlap heavily:

- **AC1 ("lobster writes a row to `feature_task_analytics` with `task_id`, `completed_at`, `total_gate_failures`, `capacity_gate_failures`, `quality_gate_failures`, `cycle_days`")** — functionally covered by f170e344.
  - The actual table is `FeatureTaskAnalyticsEvent` (event-sourced), added in migration `20260726080000_add_feature_task_analytics_events` on `services/tasks-api`.
  - The feature-task Rust CLI (`agents/workflows/feature-task/src/analytics.rs`) emits a single `terminal_summary` event per task at terminal transition (`ae42525 feat(feature-task): emit gate failure and terminal summary events`). The summary row carries `taskId`, `completionTimestamp`, `totalGateFailureCount`, `capacityBlockCount`, `qualityFailureCount`, `prCycleTimeSeconds` — the same five metrics, in the same shape, expressed as one event row.
  - Schema divergences (column naming `prCycleTimeSeconds` vs `cycle_days`; event-sourced vs aggregation row) are documented in f170e344's tech design and the prisma migration. They are intentional and accepted; harmonizing them in 6a5783a7 would be duplication, not progress.
  - **No additional Prisma models, migrations, or Rust emission code is in scope for 6a5783a7.**

- **AC2 ("flow dashboard shows a weekly avg `quality_gate_failures` trend line alongside existing cycle time metrics")** — functionally covered by f170e344.
  - `apps/mission-control/src/tabs/FlowMetricsTab.jsx` ships a `FeatureTaskAnalyticsPanel` (`feat(mission-control): add Feature Factory analytics panel and replay helper`, commit `6888644`) reading `/api/v1/feature-task-analytics/weekly` and rendering: (a) summary cards (totalCapacity, totalQuality, trendDelta across weeks); (b) weekly stacked horizontal bars showing weekly capacity-failure vs quality-failure counts; (c) median PR cycle time and evidence distribution per week. The "weekly quality trend" is rendered as the `qualityFailureCount` series in the stacked bars plus the `trendDelta` summary card.
  - The spec's literal wording is "a separate `quality_gate_failures` trend line"; the shipped panel stacks capacity and quality in one bar so both are visible per week without an extra line. Open question for Tom/Quinn: stacked bar vs separate line. Recommend keeping the stacked bar (more information density, already implemented).
  - **No incremental dashboard work is in scope for 6a5783a7 unless Tom wants a literal separate quality-only line.**

- **AC3 ("factory retro skill reads gate failure counts from this table instead of recounting comments on each run")** — not covered by f170e344. The `agents/skills/ops/factory-retro/SKILL.md` skill still parses `[feature-task-progress-checklist]` comments on each run. This is the actual incremental work for 6a5783a7.

## Goal

Satisfy AC3 by migrating `agents/skills/ops/factory-retro/SKILL.md` from comment-replay to read-from-analytics-table. The lobster's existing analytics event emission makes this a SKILL.md edit, not a code change. After this PR merges, the factory retro cron stops recounting comments and pulls counts from the database the existing feature-task workflow already populates.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-6a5783a7-log-gate-failure-analytics-post-merge`
- Worktree: `~/workspaces/rowan/sindustries-task-6a5783a7-log-gate-failure-analytics-post-merge`
- No secondary repo changes expected.
- No dependency on a predecessor task shipping first — f170e344 (PR #303) is already merged on `main`.

## Source-of-truth boundary

- The factory-retro skill is a workflow asset, not a service: `agents/skills/ops/factory-retro/SKILL.md`. Its job is to read analytics state for a weekly report; it does not own state. It reads from the Tasks API (already on `services/tasks-api`, the existing owner of feature-task analytics events).
- The Tasks API owns the analytics state. f170e344's existing endpoints are reused unchanged:
  - `GET /api/v1/feature-task-analytics/tasks/:taskId/events` — raw event log per task (chronological).
  - `GET /api/v1/feature-task-analytics/weekly?weeks=N` — weekly buckets with `gateFailureCount`, `capacityFailureCount`, `qualityFailureCount`, `medianPrCycleTimeSeconds`, `p90PrCycleTimeSeconds`, `evidenceTypeDistribution`.
- Ownership stays where f170e344 placed it; nothing in 6a5783a7 adds routes, models, or services.

## `.openclaw` boundary

- No `~/.openclaw/` config, cron, or agent profile changes required.
- The existing factory-retro cron already points at the Tasks API; this PR only changes which Tasks API endpoint it uses.
- The factory-retro script (Step 1 of the SKILL.md) uses `urllib.request` against `http://localhost:4001` (the prodlike data plane). This design keeps the same base URL. No new env vars.

## Implementation plan

### Single change: `agents/skills/ops/factory-retro/SKILL.md`

The skill today runs:

```python
gate_failures = sum(
    1 for c in task.get('comments', [])
    if c.get('author') == 'Lobster'
    and (c.get('text') or '').startswith('[feature-task-progress-checklist]')
)
```

inside its per-task signals loop. Replace this with a Tasks API call to the analytics surface:

```python
import urllib.request, json

base = 'http://localhost:4001/api/v1'

# Per-task gate failures — replace comment-replay with analytics lookup.
# Capacity vs quality breakdown comes for free from the same endpoint.
with urllib.request.urlopen(
    f'{base}/feature-task-analytics/tasks/{task_id}/events'
) as r:
    events = json.load(r).get('data', [])

gate_failures = sum(1 for e in events if e.get('eventType') == 'gate_failure')
capacity_failures = sum(
    1 for e in events
    if e.get('eventType') == 'gate_failure' and e.get('cause') == 'capacity'
)
quality_failures = sum(
    1 for e in events
    if e.get('eventType') == 'gate_failure' and e.get('cause') == 'quality'
)
```

Inside Step 2 ("Per task signals"), the existing buckets (0–1 normal, 2–3 mild, 4+ significant) keep their thresholds. Add a sub-finding line for high-capacity-vs-quality splits (e.g. "4 of 6 gate failures are capacity blocks → not a quality problem, reassign not rework").

For the weekly summary row in Step 3 ("Write the report"), pull a single `/api/v1/feature-task-analytics/weekly?weeks=2` and include the most-recent-week `gateFailureCount`, `capacityFailureCount`, `qualityFailureCount` and a capacity-vs-quality split line. This replaces the ad-hoc comment counts the current skill still surfaces in Step 3.

### No other file changes

- No Prisma schema or migration. (`FeatureTaskAnalyticsEvent` from PR #303 is reused.)
- No Rust emission changes. (`agents/workflows/feature-task/src/analytics.rs` is already shipping gate-failure events and a terminal summary event.)
- No Mission Control changes. (The Feature Factory Analytics panel from `6888644` already renders weekly stacked bars.)
- No system-doc change needed in this PR. `docs/systems/tasks.md` already describes the analytics surface in its "Feature-Task Lifecycle Analytics" section (added in `c99b836`); the factory-retro skill is documented under `docs/systems/` if it exists there, otherwise in the skill file only.

### Optional alignment with AC2's literal wording

If Tom wants a literal "weekly avg `quality_gate_failures` trend line" rather than the stacked bar the panel ships today, this PR can add a 6-line area-chart series to `FeatureTaskAnalyticsPanel` that draws `qualityFailureCount` as a single series. Open question — listed in the Open questions section. Default plan: do not add it.

## Test plan — AC verification matrix

| AC | Verification layer | Plan |
|---|---|---|
| AC3 (factory retro reads from analytics table) | Skill smoke + manual | Cron a one-off manual run of the skill against `localhost:4001` for a known completed task (e.g. `f520c396` GymTrack, which has known gate-failure history). Confirm the per-task `gate_failures` count matches the analytics endpoint, and the capacity/quality split is shown. Two completed tasks: (a) a task with only quality failures (text-only rework loop), (b) a task with capacity-only failures (`already has an active task in doing`). Confirm the SKILL renders the right split line in each case. |
| AC3 (backwards compat: count zero matches DB) | Skill smoke | For each task in the last 7 days, check that the per-task count from the analytics endpoint equals the analytics endpoint's `weekly.gateFailureCount` minus the events that pre-date the cutoff. If they diverge by more than one (timezone or heart-beat boundary), document in the SKILL.md runbook section how to interpret the small drift. |
| AC1 (lobster writes a row at post-merge) | Verify-on-main | Already covered by PR #303's existing tests (`feat(feature-task): emit gate failure and terminal summary events`, `feat(tasks-api): add feature task analytics POST/GET endpoints`). No new code in this PR. Confirmation step: `gh pr checks 303` should be green; spot-check the analytics-row contents for `f520c396` via the Tasks API. |
| AC2 (flow dashboard weekly quality trend) | Verify-on-main | Already covered by PR #303's `FeatureTaskAnalyticsPanel`. No new code in this PR. Confirmation step: load `apps/mission-control` against `:4001`, open the Flow Metrics tab, confirm the weekly stacked bars render and the `totalQuality` / `trendDelta` cards have non-null values once a week of data has accumulated. |

No `file:` evidence rows. Every AC's verification is either a service-level test that already exists (AC1, AC2), a skill-level smoke that runs against `localhost:4001` (AC3), or a confirmation step that cites the predecessor PR.

## Open questions and risks

- **AC1/AC2's status against the shipped surface.** The 6a5783a7 spec was written before f170e344 landed. f170e344 covers the substance of AC1 and AC2 in a more general shape. Question for Quinn/Tom: keep 6a5783a7 in scope with AC1/AC2 marked "covered by PR #303" and AC3 as the only implementation PR, or revise the task description to AC3-only and re-tag. Default plan: keep all three ACs on the task with explicit "covered by PR #303" annotations on AC1/AC2, and ship the implementation PR covering AC3 only.
- **AC2 wording: stacked bar vs separate quality-only line.** The spec asks for a separate `quality_gate_failures` trend line. The shipped panel renders a stacked bar (capacity + quality per week). Tom may prefer the literal single-line view, in which case this PR can add a one-axis area chart of `qualityFailureCount` to the existing panel (~6 lines). Default: do not add; the stacked bar already separates capacity and quality visually.
- **Schema drift between spec and shipped surface.** Spec uses `feature_task_analytics` (singular table, snake_case columns, `cycle_days`). Shipped surface uses `FeatureTaskAnalyticsEvent` (event-sourced, camelCase, `prCycleTimeSeconds`). The shipped naming is locked in by PR #303. The 6a5783a7 spec will not be revised to match the delivered names — the AC words ("writes a row", "weekly avg quality_gate_failures trend") are the substance, and the names are implementation detail.
- **Backfill.** Tasks that completed before PR #303's merge (2026-07-26T05:28:46Z) have no analytics events. The factory retro skill before that cutoff falls back to comment counts. Document this in the SKILL.md runbook section: "For tasks completed before 2026-07-26, the per-task gate-failure count is 0 from analytics and the comment-replay fallback is used."
- **Routine vs retro cron frequency.** The factory-retro skill is invoked on a weekly cadence by a cron. The skill's per-task API call is one HTTP GET per task in the window — small enough not to be a load concern, but if the window grows past 50 tasks the per-task call pattern should be replaced with a single weekly endpoint call. Not addressed in this PR.
