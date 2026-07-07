---
status: draft
task_id: 35c96cef-0271-45e5-90d8-d5377575854f
product_spec: brain/tasks/specs/mc-bookmarks-tab-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Bookmarks pipeline tab in Mission Control — Tech Design

## Links

- Product spec: `brain/tasks/specs/mc-bookmarks-tab-2026-07-07.md`
- Tech design: `docs/specs/mc-bookmarks-tab-tech-design.md`
- Task: `35c96cef-0271-45e5-90d8-d5377575854f` (`🔧 Bookmarks pipeline tab in Mission Control`)
- Existing reference dashboard: `tools/bookmark-dashboard/index.html` + `tools/bookmark-dashboard/serve.py` (the standalone dashboard this tab replaces-in-place)
- Tasks API record: `http://localhost:4001/api/v1/tasks/35c96cef-0271-45e5-90d8-d5377575854f`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-35c96cef-mc-bookmarks-tab`
- Worktree: `~/workspaces/rowan/sindustries-task-35c96cef-mc-bookmarks-tab`
- No secondary repos; this is a Mission Control app change. The standalone `tools/bookmark-dashboard/` is left in place as a fallback per the product spec's non-goals.

## Product intent (from approved product spec)

- Outcome: The bookmark pipeline dashboard becomes a first-class tab in Mission Control, so operators can see pipeline state (`summarized`, `approval_pending`, `approved`, `spec_created`, `tasked`, `declined`, plus topics and approval status) without running a separate `python tools/bookmark-dashboard/serve.py` server.
- The existing standalone dashboard already does the data model + visualization work. This task is a **port, not a rewrite**: same data source (`brain/state/bookmark-review-state.json` + `bookmark-transitions.jsonl`), same counts, same time-window / topic filters — but rendered in React, on Mission Control's design tokens, behind the existing tab registry.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals: removing the standalone dashboard; write/edit capability from the tab; real-time WebSocket streaming.

## Acceptance criteria recap

- AC1: A "Bookmarks" tab is registered in Mission Control at `/bookmarks` and is accessible from the tab bar.
- AC2: The tab displays pipeline state by review status, by topic, and by approval status.
- AC3: Data is loaded from `brain/state/bookmark-review-state.json` (same source as the existing tools dashboard).
- AC4: The tab auto-refreshes or provides a manual refresh control.
- AC5: Renders correctly in both light and dark mode using Mission Control's theme.

## `.openclaw` boundary

None. Mission Control is a static SPA served by Vite in dev. The brain state file lives in the workspace at `brain/state/`, which is already a workspace-relative path the existing `tools/bookmark-dashboard/serve.py` resolves. No runtime, tooling, or `.openclaw/` changes are required for this task.

## Implementation plan

### File / module scope

- **`apps/mission-control/src/tabs/BookmarksTab.jsx`** *(replace placeholder)* — Top-level React component. Owns the fetch lifecycle (loading / error / data states), the toolbar (time window + topic select + refresh button), and renders the section cards. Same pattern as `FlowMetricsTab.jsx`: `useState` for data, `useEffect` for fetch + cleanup, `useMemo` for derived counts.
- **`apps/mission-control/src/tabs/BookmarksTab.test.jsx`** *(new)* — Vitest unit tests:
  - Renders loading state on mount, data state after fetch resolves.
  - Renders error state when the fetch fails.
  - Toolbar changes (time window, topic) re-trigger derivation.
  - Refresh button re-fetches.
  - Each section is present (KPIs, Curations, Funnel, Topics, Recent transitions).
  - Filters respect the topic + time window.
- **`apps/mission-control/src/bookmarkPipeline.js`** *(new)* — Pure functions, mirroring the structure of `flowMetrics.js`. Exports:
  - `itemList(snapshot)` / `itemByKey(snapshot)` / `statusOf(item)`
  - `parseDate(value)` / `cutoffFromWindow(value, now)`
  - `inScopeItem(item, { topic, since })`, `inScopeTransition(event, item, { topic, since })`
  - `kpiCounts(items)` → `{ pending, summarized, approval_pending, … }` keyed on `reviewStatus`
  - `curationGroups(items, threshold)` → `{ implementBound, curatedWaiting, uncurated, threshold }`
  - `funnelRows(items, statuses)` → ordered list of `{ status, count }`
  - `topicCounts(items)` → `[{ topic, count }]`
  - `recentTransitions(transitions, items, limit)` → `[{ at, key, from, to, reason }]`
  - No React, no DOM. Trivially unit-testable.
- **`apps/mission-control/src/bookmarkPipeline.test.js`** *(new)* — Unit tests for the pure compute: empty snapshot, multi-status, time-window filter, topic filter, curation group boundaries, recent-transitions ordering.
- **`apps/mission-control/src/bookmarkStateSource.js`** *(new)* — Tiny fetch wrapper. Exports `loadBookmarkState({ baseUrl } = {})` that hits `${baseUrl}/api/state` and `${baseUrl}/api/transitions` in parallel, returning `{ snapshot, transitions, loadedAt, error }`. The `baseUrl` defaults to `import.meta.env.VITE_BOOKMARK_STATE_BASE_URL` and falls back to `''` (same-origin). The wrapper also exports `BOOKMARK_STATES` (the canonical set the KPIs surface) so `bookmarkPipeline.js` and the tab agree on names without a copy-paste.
- **`apps/mission-control/vite.config.js`** *(modified)* — Add a small inline Vite plugin (`brainStateApi`) inside `defineConfig`'s `plugins` array. It uses `configureServer` to mount two endpoints in dev only:
  - `GET /api/state` → reads `<workspace>/brain/state/bookmark-review-state.json` and returns it as JSON.
  - `GET /api/transitions` → reads `<workspace>/brain/state/bookmark-transitions.jsonl`, parses each non-empty line as JSON, and returns the array.
  - The workspace root is resolved via `process.env.WORKSPACE_ROOT` (default `path.resolve(__dirname, '../..')` relative to the Vite config — i.e. `sindustries/..`). Mirrors how `tools/bookmark-dashboard/serve.py` finds the brain root via parent traversal, so the two stay in lockstep.
  - The plugin is dev-only and returns 404 in `vite build` (no production behaviour change).
- **`apps/mission-control/vitest.config.js`** *(modified)* — Add the same `/api/state` + `/api/transitions` aliases as the Vite config (so unit tests can `fetch('/api/state')` against a tiny in-memory mock fixture) OR — preferred — `bookmarkPipeline.test.js` is purely compute-driven and never hits the network; the only test file that fetches is `BookmarksTab.test.jsx`, which mocks `bookmarkStateSource` directly. Decision: mock `bookmarkStateSource` in the tab test, leave the Vite config change dev-only.
- **`apps/mission-control/package.json`** *(modified)* — Add `d3-sankey` and `d3-shape` as dependencies. **`d3` itself is NOT a dep** — we only need the small, tree-shakable `d3-sankey` + `d3-shape` for the Sankey and a thin helper for time-bucketed state counts. (See Q1 below for the rationale + Sankey v1 deferral.)
- **`apps/mission-control/SPEC.md`** *(modified)* — Update the Bookmarks row in the Screens table: "Static placeholder" → "Pipeline dashboard (KPIs, curations, funnel, topics, recent transitions)". Update the "Reach the placeholder tabs" flow → "View bookmark pipeline." Update E2e coverage table with the new Vitest file.
- **`apps/mission-control/README.md`** *(modified)* — Add a one-line note under the routes table: `/bookmarks` reads from `brain/state/bookmark-review-state.json` (served by the dev plugin) — so a fresh clone without `brain/` will see an empty state, not a hard error.

### Section composition (mapped to the existing dashboard)

Each section is a `Card` from the Design System, composed top-to-bottom in this order, matching the current standalone dashboard:

1. **Header** — Title + subtitle. No "chrome bar" or traffic lights (those are dev-only artefact from the standalone tool).
2. **Toolbar** — `Field` + `Select` for time window (`7 / 30 / 90 / all`), `Field` + `Select` for topic (populated from items), and a `Button` "Refresh" that re-runs the fetch. Filter state lives in the tab; pure compute reads it via `useMemo`.
3. **Pending approvals banner** — Only rendered when `items.filter(reviewStatus === 'approval_pending').length > 0`. Lists the items, sorted by recency. Uses `Card` with a high-visibility tone.
4. **KPIs** — A `CardContainer` of small `Card`s, one per canonical state. Pure compute via `kpiCounts(items)`. Matches the existing dashboard's KPI row.
5. **Curations** — Three-column `CardContainer` (Implement-bound, Curated-waiting, Uncurated). Each item shows title, topic, score pill, relative age. Pure compute via `curationGroups`.
6. **Curation Pipeline Flow (Sankey)** — A single `Card` containing the Sankey diagram of `pending → ingested → summarized → (monitoring | high-signal) → spec_requested → spec_created → approval_pending → tasked → approved | declined`. Drawn with `d3-sankey` (compute) + React-managed SVG (render). Default is collapsed; the card has a `Button variant="ghost"` to expand.
7. **Pipeline Funnel + By Topic** — Two-column layout (matches the existing dashboard's `.grid`). Funnel is a sequence of label/bar/count rows inside a `Card`. Topics is a sorted bar list inside a `Card`.
8. **State counts over time** — A `Card` containing an inline-SVG line chart drawn from a small set of pure React helpers (no d3). One line per active status; crosshair + tooltip reuse the same SVG pattern from the existing dashboard.
9. **Recent transitions** — A `Card` with the most recent 20 transitions that fall inside the current filter scope, formatted as `time | key | from → to | reason`.

### Design system usage

- `Card`, `CardContainer`, `Field`, `Select`, `Button` from `@sindustries/ui/react` — same primitives `FlowMetricsTab` uses.
- `Badge` for the score pill in the Curations section.
- No new colors: Sankey + line chart use the existing `packages/design-tokens` palette. Status colors come from the existing `--si-color-status-*` tokens where they exist; where they don't, the new tab borrows the existing dashboard's hex values (which are also used elsewhere in the system) — codified as a single `bookmarkStatusColors` map in `BookmarksTab.jsx`, **not** as inline styles scattered across components.
- Light/dark mode: every visible color flows from `packages/design-tokens` (via the existing CSS import in `main.jsx`). No new opaque colors. AC5 holds by construction.

### Data source + refresh (AC3, AC4)

- The Vite dev plugin serves `brain/state/*.json` on the same-origin `/api/*` paths. Mission Control's tab fetches with `fetch('/api/state')` + `fetch('/api/transitions')` in parallel (mirroring the existing dashboard).
- Manual refresh: `Button` in the toolbar. Re-runs the fetch, updates `loadedAt`.
- Auto-refresh: `useEffect` adds a `focus` listener on `window`. When the user returns to the tab after backgrounding, the data refetches. No polling timer in v1 (the user can hit Refresh; the focus listener handles the common case).
- Error state: if either fetch fails or the JSON is malformed, render a `Card` with a destructive tone and a one-line hint. Don't throw; don't auto-retry.

## Test plan

- **Unit (compute) — `bookmarkPipeline.test.js`:** snapshot → `itemList`, `kpiCounts` (multi-status), `curationGroups` (threshold boundary at 7), `funnelRows` (ordering), `topicCounts` (sort), `recentTransitions` (sort + limit + time window filter), `inScopeItem` / `inScopeTransition` (topic + time filters).
- **Unit (component) — `BookmarksTab.test.jsx`:** with `bookmarkStateSource` mocked, render in loading state → data state; toolbar change re-derives; refresh button re-fetches; error state renders when fetch rejects; section-level `data-testid` assertions for `pulse-bookmarks-kpis`, `pulse-bookmarks-curations`, `pulse-bookmarks-funnel`, `pulse-bookmarks-topics`, `pulse-bookmarks-transitions`.
- **Unit regression:** existing `App.test.jsx`, `flowMetrics.test.jsx`, `Sidebar.test.jsx` (from PR #194, once merged) must still pass.
- **Build:** `npm --workspace @sindustries/mission-control run build` — confirms d3-sankey / d3-shape tree-shake and the new Vite plugin don't break the production bundle.
- **Dev smoke:** `npm --workspace @sindustries/mission-control run dev` → click Bookmarks → confirm each section renders, filters work, refresh works, light/dark both render.
- **E2e:** Playwright suite for Pulse remains deferred per `SPEC.md`. This PR doesn't move that needle.

## Open questions / risks

- **Q1 — Sankey in v1?** The existing dashboard uses `d3-sankey` for the curation-pipeline flow. The Sankey is **not in the ACs** (AC2 covers review-status / topic / approval counts). Including the Sankey adds `d3-sankey` + `d3-shape` as deps and ~80 lines of SVG wiring. **Default plan: include the Sankey in v1** because the existing dashboard has it and the product spec says "reuse or port rather than rebuild." If during implementation the d3-sankey integration starts to dominate the PR, we cut the Sankey from v1 and add it as a follow-up — ACs still pass without it.
- **Q2 — Auto-refresh strategy.** v1 is `focus`-only (no polling timer). Polling at 30s would be friendlier for a long-running operator, but it means every open tab hammers the JSON files. The standalone dashboard does no auto-refresh — users hit Refresh. Decision: match the standalone dashboard's behaviour (focus + manual). If operators want polling, that's a v2.
- **Q3 — `brain/` not in this repo.** The state files live in the workspace `brain/` directory, not the `sindustries` repo. The Vite plugin resolves the path via `process.env.WORKSPACE_ROOT` or parent traversal. If someone clones `sindustries` without the workspace, the dev plugin serves an empty array. The tab's empty state must read "No bookmark state found — check `WORKSPACE_ROOT` and `brain/state/`" rather than crash. Cover this in the error / empty branch.
- **Q4 — Filter state persistence.** Should time window + topic persist across reloads like the sidebar collapse state? Default: no — the existing standalone dashboard doesn't persist them. If a user reloads, they get the defaults (`30 days` + `all`). Keep the contract identical to the standalone tool.
- **Q5 — Sankey is interactive (hover tooltips).** The standalone dashboard's Sankey has hover tooltips on links. v1 matches that behaviour: a small tooltip on hover showing `source → target: value`. Same SVG approach, just driven by React state instead of d3 events.
- **Q6 — Status color tokens.** Some of the existing dashboard's status colors don't have a matching `--si-color-status-*` token. Plan: use the dashboard's hex values directly inside a single `bookmarkStatusColors` map in `BookmarksTab.jsx`. If we want to add proper tokens later, that's a one-line edit and a single Design System PR — not a blocker for v1.

## Out of scope

- Removing the standalone `tools/bookmark-dashboard/` (per the product spec's non-goals).
- Write/edit capability from the tab (per the product spec's non-goals).
- Real-time WebSocket streaming of state changes (per the product spec's non-goals).
- Persisting the tab's filter selections across reloads (see Q4).
- New `--si-color-status-*` Design System tokens (see Q6).
- Mobile / responsive layout (Pulse is desktop ≥ 1280px per `SPEC.md`).
- Sankey in v1 if d3-sankey integration becomes a blocker (see Q1).

## Companion doc updates

- `apps/mission-control/SPEC.md` — update the Bookmarks screen row, the "View bookmark pipeline" flow, and the E2e coverage table.
- `apps/mission-control/README.md` — note that `/bookmarks` reads from `brain/state/bookmark-review-state.json` via the dev plugin.
- No `docs/systems/` change needed — Mission Control is a static SPA, not a cross-cutting system; per the feature-factory-v2 system-spec policy this task records `[no-system-spec-change]` with the above rationale. The standalone `tools/bookmark-dashboard/` is documented inline; it doesn't get a system spec either.

## Later todos (parking lot)

- Sankey in a follow-up if it's cut from v1 (Q1).
- Polling auto-refresh (Q2).
- Real-time WebSocket streaming (per the product spec's non-goals, but worth filing as an idea).
- New `--si-color-status-*` tokens (Q6).
- A shared "Operator panels" cookbook in `packages/ui` so future tabs (SIndustries brand, Design System, etc.) don't each reinvent the Card / Toolbar pattern.
- Move the standalone `tools/bookmark-dashboard/` from `tools/` to `apps/` if it ever gets upgraded to a real Mission Control tab; the spec file moves with it.
