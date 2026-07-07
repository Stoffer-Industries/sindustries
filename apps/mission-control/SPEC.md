# Pulse — App Specification

## Overview

Pulse is the Sindustries desktop shell. It hosts multiple operational apps
behind a single URL and a persistent tab bar, so users stay oriented and
the team can add new tools without fragmenting the surface.

- **Audience:** internal Sindustries operators (Tom and the agent team).
- **Route:** `apps/mission-control` is deployed at the `/` surface.
- **Tabs in MVP:** Tasks, Bookmarks, Flow metrics.
- **Non-goal:** mobile/responsive (desktop ≥ 1280px only).

## Flows

1. **Switch tabs.** User clicks a tab in the persistent tab bar.
   - Updates the URL path (e.g. `/tasks` → `/bookmarks`).
   - Renders the new tab content without a full page reload.
   - The previously active tab's state is preserved when the user returns.
2. **View flow metrics.** User is on the Flow metrics tab.
   - Fetches tasks from the Tasks API on mount.
   - Shows three cards: median cycle time, p90 cycle time, tasks counted.
   - Shows a weekly throughput bar chart for the last 8 weeks.
   - Shows a WIP-by-status bar chart for `open`, `ready`, `doing`, `acceptance`.
   - Filter row narrows the dataset by assignee and/or tag.
3. **Use the Tasks app from inside Pulse.** User clicks the Tasks tab.
   - Embeds the existing Tasks app via iframe at the same path the
     standalone Tasks app serves, preserving its functionality.
4. **Reach the placeholder tabs.** Bookmarks shows a "tracked under a
   separate spec" placeholder; the tab registry pattern lets each future
   tool replace the placeholder without shell changes.

## Screens

| Screen | Route | Component | Key interaction |
|---|---|---|---|
| Tasks | `/tasks` | `Tabs/TasksTab.jsx` (iframe) | Embedded tasks app — all existing flows remain available |
| Bookmarks | `/bookmarks` | `Tabs/BookmarksTab.jsx` | Static placeholder; returns no actions |
| Flow metrics | `/flow-metrics` | `Tabs/FlowMetricsTab.jsx` | Filter row (assignee, tag), metric cards, throughput chart, WIP chart |
| 404 / unknown path | `/<anything>` | falls back to Tasks tab | The default tab renders; no error surface |

## E2e Coverage

The Playwright e2e suite for Pulse is **deferred** until the shell lands
in production and the team settles on viewport styling. Until then, the
unit tests in `src/App.test.jsx` and `src/flowMetrics.test.jsx` cover the
tab registry, URL routing, and the flow-metrics calculations.

| Flow | Plan |
|---|---|
| Switch tabs | Vitest: `App.test.jsx` covers tab click → URL update |
| Cycle-time math | Vitest: `flowMetrics.test.js` covers median, p90, windowing |
| Weekly throughput bucketing | Vitest: `flowMetrics.test.js` covers Monday-aligned buckets |
| WIP by status | Vitest: `flowMetrics.test.js` covers status grouping |

## Data Sources

- **Tasks API** at `http://localhost:4001/api/v1/tasks` (port-overridable).
- **No new backend, no new analytics warehouse.** All metrics are computed
  client-side from the tasks API response.
- Optional override via `VITE_TASKS_API_BASE_URL`.
- The Flow metrics dashboard issues a single GET against the Tasks API with
  `?includeArchived=true&sort=priority&limit=10000` so the dashboard covers
  the full archive (including done/closed tasks) without per-page pagination.
  This is the only Tasks API request the dashboard makes — see
  `apps/mission-control/src/tasksApi.js` (`getTasks`).

## Open Items

- E2e Playwright suite (spec-driven, deferred).
- Extend the tab registry with a Real Bookmarks tab when that spec lands.
- Address the unaddressed `BookmarksTab` URL once the Bookmarks app has a route.

## Architecture decisions

The iframe embed of the Tasks app, the local-dev port assumptions, and
the deferred sandbox/CSP posture are recorded in
[`docs/systems/pulse-shell.md`](../../systems/pulse-shell.md). Revisit
that document when authentication lands, production deploy is scheduled,
Tasks gains cross-app state, or the shell grows a third or fourth tab.
