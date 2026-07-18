# Pulse — App Specification

## Overview

Pulse is the Sindustries desktop shell. It hosts multiple operational apps
behind a single URL and a vertical collapsible sidebar on the left, so
users stay oriented and the team can add new tools without fragmenting the
surface.

- **Audience:** internal Sindustries operators (Tom and the agent team).
- **Route:** `apps/mission-control` is deployed at the `/` surface.
- **Tabs in MVP:** Tasks, Bookmarks, Flow metrics, Design System, Content, SIndustries.
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
     a pending-approvals banner when `approvalLocks` has entries, a
     single-row KPI grid of `reviewStatus` counts (pending approvals sit
     above the row in their own Card), a three-column curation breakdown
     (Implement-bound / Monitoring / Uncurated), a Sankey diagram of the
     curation pipeline (collapsed by default; Expand to render), a
     pipeline funnel and per-topic count, a line chart of state counts
     over time (with hover crosshair + tooltip), and the most recent 20
     transitions in scope.
   - Auto-refresh on `window.focus`; manual refresh via the toolbar
     button. Filter state does NOT persist across reloads.
6. **View the Design System.** User is on the Design System tab.
   - Renders the shared `DesignSystemPage` specimen from
     `@sindustries/ui/specimen` (the same component that previously lived
     inside the Tasks app).
   - The specimen owns its own design-kit navigation, theme toggle, and
     kit-page state (Tokens / Pulse / Brand).
   - Renders correctly in both light and dark mode via the
     `@sindustries/design-tokens/styles.css` palette that the shell
     already loads — no new opaque colours.
7. **Manage the Content Scheduler 10-day calendar.** User is on the Content tab.
   - On mount, fetches the queue from the Tasks API
     (`/api/v1/content-scheduler/items`) and today's publish status
     (`/api/v1/content-scheduler/today-status`).
   - Renders the **day-status banner** ("✓ 0/1 posts published today" etc.)
     at the bottom so the operator can see at-a-glance whether the daily
     X-post cap is reached.
   - **Composer (top).** The "Add to queue" form takes a tweet body
     (≤1000 chars), a source (`ops_notes` / `cto_craft` / `manual` /
     `other`), and an optional `scheduledFor` timestamp. Submit posts to
     the Tasks API and reloads the calendar.
   - **Calendar grid.** The primary view is a 10-day forward calendar
     from today through today + 9 in `Pacific/Auckland`. Each day is a
     column labelled "Wed 16 Jul" style (weekday short + day + month
     short). Approved, queued, and published items render as cards in
     the day column matching their `scheduledFor` date.
   - **Unscheduled overflow.** Items with no `scheduledFor` or a date
     outside the 10-day window appear in an "Unscheduled" overflow panel
     after the calendar grid.
   - **Drag-and-drop reschedule.** Tom drags a non-published card onto
     a different day column. The client computes the new ISO via
     `Intl.DateTimeFormat` (handles NZST/NZDT and the DST start edge),
     preserving the existing HH:MM or defaulting to 09:00, and PATCHes
     `/api/v1/content-scheduler/items/:id`. **No reorder API call is
     made when the drop is refused at the UI layer** — see the max-one
     guard below.
   - **Published cards.** `draggable={false}`, greyed style, with a
     "Published" badge and the X post URL link when present. The day
     column header shows a `✓ Published` indicator when a card on that
     day has already published.
   - **Approve gate.** Items are not publishable until `approvedAt` is
     set. The Publish button is disabled with a tooltip when the item is
     unapproved. Manual publish is still available in the composer flow
     for on-demand posting; event-driven auto-publish on `scheduledFor`
     arrival is documented in the [auto-post system spec](../systems/content-scheduler-auto-post.md).
   - **Max-one-published-per-day guard.** When Tom drags a card onto a
     day column that already has a published item, the drop is refused
     at the UI layer with the inline error `"Already has a published
     post — choose another day."`. No API call is made. The same rule is
     enforced server-side by `guardPublish` (`code:
     already_published_today`, `409 Conflict`) for manual and auto-post
     publish attempts. The day boundary is computed in
     `Pacific/Auckland` on both sides.


## Screens

| Screen | Route | Component | Key interaction |
|---|---|---|---|
| Sidebar | `(shell-level)` | `Sidebar.jsx` | Vertical collapsible nav with collapse toggle + day/night theme toggle (Design System `Button` `variant="nav"` and `variant="ghost"`); state persisted via `localStorage` |
| Tasks | `/tasks` | `Tabs/TasksTab.jsx` (iframe) | Embedded tasks app — all existing flows remain available |
| Bookmarks | `/bookmarks` | `Tabs/BookmarksTab.jsx` | Bookmark pipeline dashboard (KPIs, curations, Sankey of the curation pipeline, funnel, per-topic counts, state counts over time, recent transitions); toolbar filters by time window + topic |
| Flow metrics | `/flow-metrics` | `Tabs/FlowMetricsTab.jsx` | Filter row (assignee, tag), metric cards, throughput chart, WIP chart |
| Design System | `/design-system` | `Tabs/DesignSystemTab.jsx` | Shared `DesignSystemPage` specimen (Tokens / Pulse / Brand); follows the shell's `data-si-theme` (the Mission Control tab bar is the canonical navigation — no in-page back link, no in-page theme toggle) |
| Content | `/content-scheduler` | `Tabs/ContentSchedulerTab.jsx` | Content scheduler 10-day calendar: composer + 10-column day grid (Pacific/Auckland) + Unscheduled overflow + drag-and-drop reschedule; max-one-published-per-day drop guard at the UI layer |
| SIndustries | `/sindustries` | `Tabs/SIndustriesTab.jsx` | Embedded `sindustries.co.nz` via iframe; falls back to an external-link card if the upstream `X-Frame-Options`/`CSP` blocks embedding (timeout-based detection, ~8s) |
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
| Design System specimen mount | Vitest: `tabs/DesignSystemTab.test.jsx` covers kit nav, default active kit tab, no in-page back link, no in-page theme toggle, mirror of `data-si-theme` on first render and on shell theme flip |
| Recent transitions | Vitest: `bookmarkPipeline.test.js` covers `recentTransitions` scope + ordering |
| State source fetch | Vitest: `bookmarkStateSource.test.js` covers parallel fetch + 404 → empty defaults |
| BookmarksTab render | Vitest: `tabs/BookmarksTab.test.jsx` covers loading/data/error/refresh paths |
| SIndustries tab iframe + fallback | Vitest: `tabs/SIndustriesTab.test.jsx` covers initial iframe render, fallback after timeout, and success-path load event |
| Content Scheduler 10-day calendar | Vitest: `tabs/ContentSchedulerTab.test.jsx` covers composer create/approve/publish/remove, calendar grid layout, Unscheduled overflow, drag-and-drop reschedule (HH:MM preservation + 09:00 default), max-one-per-day drop guard, published read-only badge, today-status banner; pure helpers in `tabs/contentSchedulerCalendar.test.js` cover NZST/NZDT offset + DST start edge + day-key grouping |

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
  The publish flow is server-side (Tasks API posts to X with OAuth 1.0a);
  the Mission Control client never holds X credentials. The "max one
  X post per day" rule is computed in `Pacific/Auckland` on both the
  client (UI drop guard) and the server (`guardPublish`). The calendar
  grid uses native HTML5 drag-and-drop; pure timezone helpers live in
  `apps/mission-control/src/tabs/contentSchedulerCalendar.js` and use
  `Intl.DateTimeFormat` to handle the NZST/NZDT offset and DST start
  edge. Auto-publish on `scheduledFor` arrival is a separate subsystem
  documented in [`docs/systems/content-scheduler-auto-post.md`](../systems/content-scheduler-auto-post.md).
  See [`docs/systems/content-scheduler.md`](../systems/content-scheduler.md)
  for the full system contract.
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
- Filter persistence across reloads (deferred per Q4 — matches the
  standalone dashboard's behaviour before `tools/bookmark-dashboard/`
  was retired on 2026-07-16).
- Migrate the Bookmarks tab off `bookmark-transitions.jsonl` to
  `analytics.bookmark_transitions` once Postgres has enough rows to
  render Sankey + states-over-time directly from the analytics schema
  (separate feature task).
