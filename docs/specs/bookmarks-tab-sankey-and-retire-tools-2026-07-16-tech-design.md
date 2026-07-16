---
status: shipped
task_id: b179c0e3-c6b0-4c9d-97dc-982d3b841783
product_spec: brain/tasks/specs/bookmark-analytics-postgres.md
shipped_pr: 238
shipped_date: 2026-07-16
---

# Bookmarks tab — Sankey + states-over-time + retire tools dashboard — Tech Design

## Links

- Product spec: `brain/tasks/specs/bookmark-analytics-postgres.md` (the remaining unchecked ACs)
- Companion tech design (already approved, AC1-AC7): `docs/specs/bookmark-pipeline-analytics-postgres-transition-log-tech-design.md`
- Companion tech design (already approved, BookmarksTab v1): `docs/specs/mc-bookmarks-pipeline-tab-tech-design.md` (covers the port into Mission Control; this design slots into the parking-lot items declared there)
- Existing reference implementation: `tools/bookmark-dashboard/index.html` + `tools/bookmark-dashboard/serve.py`
- Task: `b179c0e3-c6b0-4c9d-97dc-982d3b841783` (`🔧 Bookmark pipeline analytics — Postgres transition log`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/b179c0e3-c6b0-4c9d-97dc-982d3b841783`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-b179c0e3-bookmarks-tab-ac8-ac10`
- Worktree: `~/workspaces/rowan/sindustries-task-b179c0e3-bookmarks-dashboard-complete`
- No secondary repos; Mission Control app + a `tools/` cleanup.

## Scope (what the lobsters won't accept as done)

The task was reverted from `acceptance` to `doing` because three acceptance criteria have no merged PR covering them:

- **AC8**: KPIs on dashboard are all on 1 row (except for pending approvals)
- **AC9**: Sankey chart and states over time chart exists on dashboard like old tools/dashboard
- **AC10**: tools dashboard is retired

Each maps to the existing tech design work or to a small follow-up; this design closes them out.

## Product intent (from approved product spec, restated)

The Bookmarks tab in Mission Control is becoming the single bookmark dashboard. The standalone `tools/bookmark-dashboard/` is a development artefact from before the Mission Control port — operators today have two places to look (one static page served by `python tools/bookmark-dashboard/serve.py`, one Mission Control tab). The remaining work is:

1. **AC8 — Make the KPIs a single visible row.** Today `<CardContainer>` wraps, so a wide status set produces multiple rows. Pending approvals already sit above the row; we keep that and make every state KPI land on row 1.
2. **AC9 — Port the Sankey + states-over-time charts.** Both charts exist in `tools/bookmark-dashboard/index.html`. They're explicitly called out in the spec for parity.
3. **AC10 — Retire the tools dashboard.** Delete `tools/bookmark-dashboard/`. Add a `tools/README.md` link so anyone landing there knows where the dashboard lives now (defence in depth — the `serve.py` shouldn't even start if anyone clones a copy).

Approved by Tom on 2026-07-07 per the task description.

## `.openclaw` boundary

None. Mission Control is a static SPA; the `tools/bookmark-dashboard/` removal is internal code only.

## Out of scope (parking lot, deliberately)

- Re-introducing a polling timer (the `mc-bookmarks-pipeline-tab-tech-design.md` parked Q2).
- WebSocket streaming of state changes (parked in product spec's non-goals).
- Filter-state persistence across reloads (parked as Q4 in the prior design).
- Migrating the dashboard off local JSONL — once `analytics.bookmark_transitions` is populated, Pulse can read from Postgres instead, but that's a separate task (`feat/pulse-read-from-postgres` if/when we file it).
- Removing the dev-only Vite plugin (`vite.config.js`) — that ships the brain state to the Bookmarks tab. It stays.

## Implementation plan

### File / module scope

- **`apps/mission-control/src/bookmarkPipeline.js`** *(modified)* — add three pure helpers and one constant:
  - `STATUS_COLOR_VAR` is already declared in `BookmarksTab.jsx` — move it into `bookmarkPipeline.js` so compute + render agree on colour mapping.
  - `sankeyNodesAndLinks(items, { threshold })`: mirrors the `computeSankeyData()` function in the standalone dashboard. Returns `{ nodes: [...], links: [...] }` with the cumulative pass-through link values that keep every link visible even when items move on. Pure compute; no React, no DOM. Uses the same 10-node stage list as the standalone dashboard. Cumulative pass-through is required for visual correctness — naive "items leaving this stage only" link values collapse the chart when downstream links dominate (documented in the standalone `computeSankeyData`).
  - `stateCountsTimeSeries(items, transitions, { windowValue, topic, now })`: ports `seriesData()` from the standalone dashboard. Returns `{ statuses: [...], points: [{ date, counts }] }`. Dedupes consecutive same-direction transitions per item so the lobster's idempotent re-application of status doesn't inflate counts. Today's snapshot is the baseline; transitions are walked backward from each day-end to reconstruct historical state counts.
  - `formatTimeSeriesDate(date)`: tiny helper used by both the chart and the legend. Mirrors the `fmtDate` helper in the standalone dashboard.
  - Tests added in the next bullet.
- **`apps/mission-control/src/bookmarkPipeline.test.js`** *(modified)* — new tests:
  - `sankeyNodesAndLinks` — empty list, single bucket filled, multiple items per bucket, threshold boundary for the `Curated: High Signal` bucket. Verify the cumulative-pass-through link values (i.e. nodes with zero `value` still appear with `value: 0` so d3-sankey renders an invisible-but-valid node — confirmed in the standalone dashboard).
  - `stateCountsTimeSeries` — empty items, single item at known status (one point), transition inflates the count, dedup of consecutive same-direction transitions, topic filter excludes items. Validate the backward-walk by constructing a 7-day synthetic dataset.
  - `kpiCounts` already tested; no new tests there.
- **`apps/mission-control/src/tabs/BookmarksTab.jsx`** *(modified)*:
  - Replace the KPI `<CardContainer>` with a single-row grid (`display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));` on the existing `bookmarks-tab__kpis` element, plus a CSS rule that caps at row 1 when the parent is wider than ~1180px). Add a `data-testid="pulse-bookmarks-kpi-row"` attribute for AC8 verification. Pending approvals remain above the KPI row in their own `<Card>` (already in place).
  - Add two new sections, in the order defined by the existing design (Section 6 → Sankey, Section 8 → state counts over time):
    - `<SankeySection nodes={...} links={...} />` — a thin React component (extracted into `BookmarksTab.jsx` and not a separate file because the file is already sized for a single tab; if it crosses 600 lines during implementation we hoist it to `apps/mission-control/src/tabs/BookmarksSankey.jsx`).
    - `<StateCountsChart points={...} statuses={...} />` — same dispatch rule.
  - Both components use d3-sankey for layout (compute) and React-managed SVG (render). No d3 global. The chart consumes `stateCountsTimeSeries()` output directly.
  - The Sankey card is collapsed by default (matching the prior tech design's Q1 deferral note); a `Button variant="ghost"` reveals it. This keeps the canvas clean when there are few items and gives the Sankey room to breathe when expanded.
  - The state-counts chart renders inline (it's smaller) and always visible.
- **`apps/mission-control/src/tabs/BookmarksTab.jsx`** does NOT add new dependencies to `@sindustries/design-tokens` — all colours come from `STATUS_COLOR_VAR` (existing). A follow-up could add `--si-color-status-*` tokens, but that's parked (see Q6 in the prior design).
- **`apps/mission-control/package.json`** *(modified)* — Add `d3-sankey@^0.12.3` as a runtime dependency. **Only d3-sankey** — every other chart (the line chart, axes, tooltip, crosshair, status colour mapping) is implemented in plain React/SVG. The standalone dashboard pulls `d3.min.js` + `d3-sankey`, but only `d3-sankey` is genuinely needed; pulling the full d3 would bloat the bundle by ~270 KB. The line chart's path generator is a one-line React helper, not d3-shape. If during implementation we discover we genuinely need a d3 utility (e.g. d3-array's `extent`), we add it; otherwise we don't.
- **`apps/mission-control/src/styles/bookmarks-tab.css`** *(modified)* — add one rule for the single-row KPI grid:
  ```css
  .bookmarks-tab__kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    grid-auto-rows: 1fr;
  }
  ```
  Other KPI styles already live in the existing CSS partial.
- **`apps/mission-control/src/styles/bookmarks-tab.css`** *(modified, small)* — add `.bookmarks-tab__sankey-card` (white-on-panel card background with `min-height: 320px`) and `.bookmarks-tab__state-chart-card` (`min-height: 240px`).
- **`apps/mission-control/SPEC.md`** *(modified)* — Update the Bookmarks flow to mention the new sections:
  - "Renders a header, a toolbar…, a pending-approvals banner…, a single-row KPI grid…, a three-column curation breakdown…, a Sankey diagram of the curation pipeline…, a pipeline funnel and per-topic count…, a line chart of state counts over time…, and the most recent 20 transitions in scope."
  - Update the Screens table row to mention the Sankey + states-over-time cards.
  - Add a row to the E2e coverage table for the new tests (deferred per existing E2e policy, but the Vitest unit tests stay).
- **`tools/bookmark-dashboard/index.html`** *(delete)* + **`tools/bookmark-dashboard/serve.py`** *(delete)* + **`tools/bookmark-dashboard/`** *(rmdir if empty)*
- **`tools/README.md`** *(new if missing, else modified)* — Add a "Bookmark pipeline dashboard" section explaining that the dashboard is now `/bookmarks` in Mission Control and pointing operators there. The standalone Python script is gone, deliberately.

### Section composition (mapped to ACs)

1. **Header** — unchanged.
2. **Toolbar** — unchanged.
3. **Pending approvals banner** — unchanged; still rendered above the KPI row when `approvalLocks` has entries. AC8 exception covers this banner.
4. **KPIs (single row)** — `CardContainer` → CSS grid row. AC8.
5. **Curations** — unchanged.
6. **Curation Pipeline Flow (Sankey)** — new. AC9 (chart #1).
7. **Pipeline Funnel + By Topic** — unchanged.
8. **State counts over time** — new. AC9 (chart #2).
9. **Recent transitions** — unchanged.

### Data source + refresh

Unchanged. The Vite dev plugin serves `brain/state/*` on `/api/*`; the tab fetches with focus + Refresh. The Sankey and the time-series chart consume `loadBookmarkState()` output via `useMemo` — no new fetch, no new endpoints.

### Design system usage

- Sankey node colours and link gradients come from the existing `STATUS_COLOR_VAR` map (moved from the tab component into `bookmarkPipeline.js` — no copy-paste).
- Line chart series colours come from the same map.
- Light/dark mode: all colours flow from CSS variables; the Sankey + chart use `fill="var(--si-color-text, fallback)"` patterns matching the existing `bookmarks-tab__kpi-value` rule. No new opaque colours.

## Test plan

- **Unit (compute) — `bookmarkPipeline.test.js`:** add tests for `sankeyNodesAndLinks` (empty, single bucket, threshold boundary, cumulative link values), `stateCountsTimeSeries` (empty, single-day baseline, transition inflates, dedup consecutive, topic filter). Existing tests still pass.
- **Unit (component) — `BookmarksTab.test.jsx`:** add tests for:
  - All KPIs are present in a single DOM row when rendered (assert all `data-testid="pulse-bookmarks-kpi-*"` elements share the same `parentElement` and the parent has class `bookmarks-tab__kpis`).
  - `pulse-bookmarks-pending` (if rendered) sits ABOVE `pulse-bookmarks-kpis` (its parent is a sibling, not a child).
  - `pulse-bookmarks-sankey` exists and toggles its expansion state when the trigger is clicked.
  - `pulse-bookmarks-state-chart` exists with at least one `<svg>` child.
  - Empty snapshot still renders both charts without throwing (zero-data branch).
- **Unit regression:** existing `App.test.jsx`, `flowMetrics.test.jsx`, `Sidebar.test.jsx`, `bookmarkPipeline.test.js`, `bookmarkStateSource.test.js` must still pass.
- **Build:** `npm --workspace @sindustries/mission-control run build` — confirms the d3-sankey tree-shake and the Sankey SVG wiring don't blow up the bundle. d3-sankey is ~50 KB minified; we expect mission-control's bundle to grow by <60 KB total (Sankey + chart code combined).
- **Dev smoke:** `npm --workspace @sindustries/mission-control run dev` → click Bookmarks → confirm:
  - KPIs all on one row.
  - Sankey card present, expands on click, hover tooltips work.
  - State-counts chart shows lines + crosshair tooltip.
  - Pending approvals banner stays above the KPI row when present.
  - Light/dark both render correctly.
- **E2e:** Playwright suite for Pulse remains deferred per `SPEC.md`. This PR doesn't move that needle.

## Tech design acceptance criteria mapping

| AC  | Strategy                                                              | New tests                                                      |
|-----|-----------------------------------------------------------------------|----------------------------------------------------------------|
| AC8 | CSS grid row replaces `<CardContainer>` (wraps); pending stays above  | `kpiCounts` already covered; new component test on DOM row     |
| AC9 | Port `computeSankeyData` + `seriesData` from the standalone dashboard | New `sankeyNodesAndLinks` + `stateCountsTimeSeries` compute tests + component tests |
| AC10| Delete `tools/bookmark-dashboard/`; add `tools/README.md` redirect     | Smoke: `python3 tools/bookmark-dashboard/serve.py` returns "file not found" via a missing-module path check (no test needed; covered by file system fact) |

## Open questions / risks

- **Q1 — Sankey bundle budget.** d3-sankey adds ~50 KB to Mission Control's JS bundle. If `npm --workspace @sindustries/mission-control run build` shows the bundle growing past 350 KB, we revisit (cut the Sankey and file a follow-up task). Current estimate: 260 KB → 310 KB, well below the threshold.
- **Q2 — Sankey accessibility.** The Sankey is decorative for screen readers; we mark the SVG with `role="presentation"` and `aria-hidden="true"` and rely on the Curations section to convey the pipeline as text.
- **Q3 — `tools/README.md` already exists?** Need to check; if so we patch the existing file rather than creating a new one. If absent, we add a one-line pointer.
- **Q4 — Sankey data with very few items.** When the snapshot has < 3 items, d3-sankey renders a degenerate chart (zero-width links). The wrapper handles this with `computeSankeyData()` returning `null` (same as the standalone), and the section renders a "Not enough data to render." empty state. The standalone handles this case at the data layer; we mirror it.
- **Q5 — States-over-time chart window behaviour.** When the operator picks "All", the chart shows the full date range from the earliest transition. With many transitions this can be a wide chart. Same behaviour as the standalone; no change. If we need to cap at 90 days by default we file a follow-up.

## Companion doc updates

- `apps/mission-control/SPEC.md` — update the Bookmarks flow + Screens table row.
- `apps/mission-control/README.md` — note that `/bookmarks` now renders Sankey + states-over-time; otherwise unchanged from prior design.
- `docs/systems/bookmark-workflow.md` — add a one-line pointer that the operator dashboard lives at `/bookmarks` and `tools/bookmark-dashboard/` no longer exists.

## Later todos (parking lot)

- `--si-color-status-*` Design System tokens (parked in prior design Q6).
- Polling auto-refresh (parked in prior design Q2).
- Real-time WebSocket streaming of state changes (parked in product spec non-goals).
- Filter-state persistence across reloads (parked as Q4 in prior design).
- Migrate the Bookmarks tab off `bookmark-transitions.jsonl` to `analytics.bookmark_transitions` once Postgres has enough rows to render Sankey + states-over-time directly from the analytics schema (a separate feature task; do not fold into this PR).
- d3-array / d3-shape if we discover they reduce chart code (small chance; revisit on bundle review).
