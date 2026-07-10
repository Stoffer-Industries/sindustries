# Pulse — App Specification

## Overview

Pulse is the Sindustries desktop shell. It hosts multiple operational apps
behind a single URL and a vertical collapsible sidebar on the left, so
users stay oriented and the team can add new tools without fragmenting the
surface.

- **Audience:** internal Sindustries operators (Tom and the agent team).
- **Route:** `apps/mission-control` is deployed at the `/` surface.
- **Tabs in MVP:** Tasks, Bookmarks, Flow metrics, Design System.
- **Non-goal:** mobile/responsive (desktop ≥ 1280px only).

## Flows

1. **Switch tabs.** User clicks a row in the vertical sidebar.
   - Updates the URL path (e.g. `/tasks` → `/bookmarks`).
   - Renders the new tab content without a full page reload.
   - The previously active tab's state is preserved when the user returns.
   - The active row carries `aria-current="page"`.
2. **Collapse / expand the sidebar.** User clicks the toggle at the top of
   the sidebar.
   - Toggles between an expanded layout (icon + label, 200px wide) and a
     collapsed layout (icon only, 48px wide) with a 160ms ease transition.
   - Persists the choice to `localStorage` (`pulse.sidebar.collapsed`).
   - The toggle exposes `aria-pressed` and `aria-label` ("Collapse
     sidebar" / "Expand sidebar") so screen readers announce the action.
2a. **Toggle the day/night theme.** User clicks the theme toggle at the
    bottom of the sidebar (above the collapse toggle, separated by a
    thin divider).
   - Flips `data-si-theme` on the shell's `<html>` between `dark` and
     `light`. The chosen value is the source of truth and persists to
     `localStorage` under the `pulse-theme` key (the canonical storage
     key, shared with iframe-based tabs).
   - Broadcasts a `pulse:theme` postMessage to every `<iframe>` in the
     document so iframe-based tabs (currently the Tasks tab) follow
     along live without a reload.
   - The toggle's `aria-label` reflects the *next* theme ("Switch to
     light theme" when current is `dark`, "Switch to dark theme" when
     current is `light`) so screen readers announce the action.
   - When the sidebar is collapsed, the toggle is icon-only but the
     `aria-label` is preserved.
   - The shell re-renders the toggle's label when another browser tab
     updates the same key (storage event) so multi-tab users see the
     latest value.
3. **View flow metrics.** User is on the Flow metrics tab.
   - Fetches tasks from the Tasks API on mount.
   - Shows three cards: median cycle time, p90 cycle time, tasks counted.
   - Shows a weekly throughput bar chart for the last 8 weeks.
   - Shows a WIP-by-status bar chart for `open`, `ready`, `doing`, `acceptance`.
   - Filter row narrows the dataset by assignee and/or tag.
4. **Use the Tasks app from inside Pulse.** User clicks the Tasks tab.
   - Embeds the existing Tasks app via iframe at the same path the
     standalone Tasks app serves, preserving its functionality.
5. **View the bookmark pipeline.** User is on the Bookmarks tab.
   - On mount, fetches `bookmark-review-state.json` and
     `bookmark-transitions.jsonl` from the dev-only `/api/*` endpoints
     served by the Vite plugin in `vite.config.js`.
   - Renders a header, a toolbar (time window + topic select + refresh),
     a pending-approvals banner when `approvalLocks` has entries, a KPI
     grid of `reviewStatus` counts, a three-column curation breakdown
     (Implement-bound / Monitoring / Uncurated), a pipeline funnel and
     per-topic count, and the most recent 20 transitions in scope.
   - Auto-refresh on `window.focus`; manual refresh via the toolbar
     button. Filter state does NOT persist across reloads (matches the
     standalone `tools/bookmark-dashboard/` behaviour).
6. **View the Design System.** User is on the Design System tab.
   - Renders the shared `DesignSystemPage` specimen from
     `@sindustries/ui/specimen` (the same component that previously lived
     inside the Tasks app).
   - The specimen owns its own design-kit navigation, theme toggle, and
     kit-page state (Tokens / Pulse / Brand).
   - Renders correctly in both light and dark mode via the
     `@sindustries/design-tokens/styles.css` palette that the shell
     already loads — no new opaque colours.

## Screens

| Screen | Route | Component | Key interaction |
|---|---|---|---|
| Sidebar | `(shell-level)` | `Sidebar.jsx` | Vertical collapsible nav with collapse toggle + day/night theme toggle (Design System `Button` `variant="nav"` and `variant="ghost"`); state persisted via `localStorage` |
| Tasks | `/tasks` | `Tabs/TasksTab.jsx` (iframe) | Embedded tasks app — all existing flows remain available |
| Bookmarks | `/bookmarks` | `Tabs/BookmarksTab.jsx` | Bookmark pipeline dashboard (KPIs, curations, funnel, topics, recent transitions); toolbar filters by time window + topic |
| Flow metrics | `/flow-metrics` | `Tabs/FlowMetricsTab.jsx` | Filter row (assignee, tag), metric cards, throughput chart, WIP chart |
| Design System | `/design-system` | `Tabs/DesignSystemTab.jsx` | Shared `DesignSystemPage` specimen (Tokens / Pulse / Brand) with back link to Tasks |
| 404 / unknown path | `/<anything>` | falls back to Tasks tab | The default tab renders; no error surface |

## E2e Coverage

The Playwright e2e suite for Pulse is **deferred** until the shell lands
in production and the team settles on viewport styling. Until then, the
unit tests in `src/App.test.jsx`, `src/Sidebar.test.jsx`,
`src/flowMetrics.test.jsx`, `src/bookmarkPipeline.test.js`,
`src/bookmarkStateSource.test.js`, `src/tabs/BookmarksTab.test.jsx`,
and `src/tabs/DesignSystemTab.test.jsx`
cover the tab registry, URL routing, sidebar collapse/expand,
localStorage persistence, the flow-metrics calculations, the
bookmark pipeline dashboard behaviour, and the Design System
specimen mount.

| Flow | Plan |
|---|---|
| Switch tabs | Vitest: `App.test.jsx` covers sidebar click → URL update |
| Sidebar collapse/expand | Vitest: `Sidebar.test.jsx` covers toggle, persistence, active-row marker, and aria-label contract |
| Day/Night theme toggle | Vitest: `Sidebar.test.jsx` covers shell toggle click → `data-si-theme` flip + `pulse-theme` write + iframe `postMessage` broadcast, aria-label reflects next theme, storage-event cross-tab sync, collapsed-state icon-only behaviour |
| Cycle-time math | Vitest: `flowMetrics.test.js` covers median, p90, windowing |
| Weekly throughput bucketing | Vitest: `flowMetrics.test.js` covers Monday-aligned buckets |
| WIP by status | Vitest: `flowMetrics.test.js` covers status grouping |
| Bookmark pipeline counts (KPIs, funnel, topics) | Vitest: `bookmarkPipeline.test.js` covers `kpiCounts`, `funnelRows`, `topicCounts` |
| Curation bucketing | Vitest: `bookmarkPipeline.test.js` covers `curationGroups` threshold + sort |
| Design System specimen mount | Vitest: `tabs/DesignSystemTab.test.jsx` covers kit nav, back link, default active kit tab |
| Recent transitions | Vitest: `bookmarkPipeline.test.js` covers `recentTransitions` scope + ordering |
| State source fetch | Vitest: `bookmarkStateSource.test.js` covers parallel fetch + 404 → empty defaults |
| BookmarksTab render | Vitest: `tabs/BookmarksTab.test.jsx` covers loading/data/error/refresh paths |

## Data Sources

- **Tasks API** at `http://localhost:4001/api/v1/tasks` (port-overridable).
- **No new backend, no new analytics warehouse.** All metrics are computed
  client-side from the tasks API response.
- **Cross-origin theme broadcast.** The shell and the Tasks app run on
  different ports (5174 vs 5173), so they cannot share `localStorage`.
  The shell owns the canonical `pulse-theme` key and broadcasts a
  `{ type: 'pulse:theme', theme: 'dark' | 'light' }` postMessage to
  every `<iframe>` `contentWindow` on toggle. Iframes verify the
  `event.origin` against the shell's `VITE_SHELL_ORIGIN` env var
  (default `http://localhost:5174`) before applying the value.
- Optional override via `VITE_TASKS_API_BASE_URL`.
- The Flow metrics dashboard issues a single GET against the Tasks API with
  `?includeArchived=true&sort=priority&limit=10000` so the dashboard covers
  the full archive (including done/closed tasks) without per-page pagination.
  This is the only Tasks API request the dashboard makes — see
  `apps/mission-control/src/tasksApi.js` (`getTasks`).
- **Content Scheduler** state is read from the Tasks API at
  `/api/v1/content-scheduler/items` and `/api/v1/content-scheduler/today-status`.
  The publish flow is server-side (Tasks API posts to X with bearer auth);
  the Mission Control client never holds X credentials. The "max one
  X post per day" rule is computed in `Pacific/Auckland`. See
  `docs/specs/content-scheduler-tab-tech-design.md` for the full design.
- **Bookmark state** is read by the Bookmarks tab from
  `brain/state/bookmark-review-state.json` and
  `brain/state/bookmark-transitions.jsonl` via the dev-only Vite plugin
  in `vite.config.js`. The plugin serves `/api/state` and
  `/api/transitions` from the workspace `brain/` directory (resolved via
  the `WORKSPACE_ROOT` env var or three levels up from the Vite config).
  In production (`vite build`) the plugin is a no-op and the tab renders
  an empty state. Optional override via `VITE_BOOKMARK_STATE_BASE_URL`
  for staging/prod.

## Open Items

- E2e Playwright suite (spec-driven, deferred).
- Promote the inline tab icons into a Design System `Icon` primitive so
  other shells can stop inlining SVGs.
- Bookmark Sankey (deferred from the Bookmarks tab PR per the Q1
  trade-off — `d3-sankey` integration dominated the diff; AC2 is met by
  the KPI grid + funnel + per-topic counts without it). Track as a
  follow-up if/when the d3-sankey dep budget is approved.
- State counts over time line chart (deferred from the Bookmarks tab PR —
  no AC requires it; the same data is reachable via the JSONL log +
  `recentTransitions`). Track as a follow-up if a use case surfaces.
- Filter persistence across reloads (deferred per Q4 — the standalone
  `tools/bookmark-dashboard/` does not persist filters either).
