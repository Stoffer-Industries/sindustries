---
status: draft
task_id: 1e13a1e1-baf1-41b9-9484-0bf0b5766aa2
product_spec: brain/tasks/specs/mc-vertical-collapsable-nav-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Vertical collapsable sidebar nav using Design System — Tech Design

## Links

- Product spec: `brain/tasks/specs/mc-vertical-collapsable-nav-2026-07-07.md`
- Tech design: `docs/specs/mc-vertical-collapsable-sidebar-nav-tech-design.md`
- Task: `1e13a1e1-baf1-41b9-9484-0bf0b5766aa2` (`🔧 Vertical collapsable sidebar nav using Design System`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/1e13a1e1-baf1-41b9-9484-0bf0b5766aa2`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-1e13a1e1-mc-vertical-sidebar-nav`
- Worktree: `~/workspaces/rowan/sindustries-task-1e13a1e1-mc-vertical-sidebar`
- No secondary repos; this is a Mission Control shell change only.

## Product intent (from approved product spec)

- Outcome: Mission Control tab bar moves from its current horizontal layout to a vertical sidebar on the left. The sidebar is collapsable (icon-only when collapsed, icons + labels when expanded) and built entirely from Design System components.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals: mobile / responsive, drag-to-reorder tabs, per-user tab visibility.

## Acceptance criteria recap

- AC1: Vertical sidebar on the left replaces the horizontal tab bar.
- AC2: Collapsable — icons-only when collapsed, icons + labels when expanded.
- AC3: Collapse/expand state persists across page reloads (localStorage).
- AC4: Built using Design System components only (no one-off styles that don't come from the design system).
- AC5: All tabs (Tasks, Bookmarks, Flow metrics, SIndustries, Design System, future) accessible with no routing regression.
- AC6: Renders correctly in both light and dark mode.

## `.openclaw` boundary

None. No runtime, tooling, or `.openclaw/` changes are required for this task. Mission Control is a static SPA delivered from the existing dev workflow (`npm run dev` / Vite). All changes stay inside this repo.

## Implementation plan

### File / module scope

- **`apps/mission-control/src/App.jsx`** — Replace the existing horizontal `<nav class="pulse-tabbar">` with a new `<Sidebar>` element. The `<Sidebar>` owns the collapse/expand toggle and routes the active tab into `<main class="pulse-content">` exactly as today. No change to `useLocation`, `pulseTabs`, or the iframe-embedded tabs.
- **`apps/mission-control/src/Sidebar.jsx`** *(new)* — Sidebar component. Reads `pulseTabs`, renders each tab as a `Button` (Design System) with `variant="nav"` so the look matches the rest of the design system. In collapsed state, only the icon shows; in expanded state, icon + label. Reads/writes the collapse state via `localStorage` (key: `pulse.sidebar.collapsed`).
- **`apps/mission-control/src/Sidebar.test.jsx`** *(new)* — Unit tests (Vitest + Testing Library) for:
  - Renders one nav row per tab and the collapse toggle.
  - Clicking a tab updates the URL (`useLocation`).
  - Clicking the toggle flips the `data-collapsed` attribute and updates `localStorage`.
  - Initial render honours a `localStorage` value from a previous session.
  - The active tab carries `aria-current="page"` (parity with AC5).
- **`apps/mission-control/src/pulseTabs.js`** — Each tab gains an `icon` field (an inline SVG, semantically described via `aria-hidden` so the icon is decorative). Icons are static, lightweight, and added inline (no extra dependency, no asset pipeline change). Icon shape per tab: `tasks` (clipboard), `bookmarks` (bookmark), `flow-metrics` (bar-chart), `design-system` (palette), `sindustries` (logo monogram). No icon for the collapse toggle itself — it uses a unicode glyph (◀ / ▶) that hides via `sr-only` text.
- **`apps/mission-control/src/styles/layout.css`** — Replace `.pulse-shell` grid from `grid-template-rows: var(--si-pulse-tabbar-height) 1fr` to `grid-template-columns: <sidebar-width> 1fr`. Add new classes `.pulse-sidebar`, `.pulse-sidebar__toggle`, `.pulse-sidebar__item`, `.pulse-sidebar__item--icon`, `.pulse-sidebar__item--label`, `.pulse-sidebar--collapsed`. Widths: expanded `200px`, collapsed `48px`. Mobile is not a goal; existing `--si-pulse-shell-height` and `min-width: 1280px` stay.
- **`apps/mission-control/src/styles/variables.css`** — Add `--si-pulse-sidebar-width-expanded: 200px`, `--si-pulse-sidebar-width-collapsed: 48px`, `--si-pulse-sidebar-transition: 160ms ease`. Remove `--si-pulse-tabbar-height` (no longer referenced) or leave it as a no-op alias.
- **`apps/mission-control/SPEC.md`** — Update the "persistent tab bar" line, swap the "Screens / Components / Key interactions" row referring to the horizontal tab bar, and document the vertical sidebar behaviour. E2e coverage table stays (Playwright is deferred); add Vitest coverage entries for `src/Sidebar.test.jsx`.
- **`apps/mission-control/README.md`** — Out-of-scope for this task; no dev-loop changes.
- **`apps/mission-control/src/styles/components.css`** — May need a thin override so `Button` with `variant="nav"` inside `.pulse-sidebar` adopts the vertical/collapsed layout (full-width, justify-start, gap). The base `.si-button--nav` looks already close — checking the kit-pulse overrides is part of the implementation spike below.

### Design system usage

The Design System's `Button` component with `variant="nav"` is the closest existing primitive for the row items: rounded, quiet background, accent border on `hover` / `is-active`. The sidebar compositions:

- Each tab row → `<Button as="a" variant="nav" href={t.path} active={isActive} …>` with an inline-SVG icon and a `<span>` label that visually hides when collapsed.
- Collapse/expand toggle → `<Button variant="ghost" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={!collapsed}>` at the top of the sidebar.
- No `Tooltip` is invoked. The current `si-tooltip` primitive is a styled badge, not a hover-popup, so collapsed-mode labels are surfaced via the persistent toggle and the aria-label on the row's interactive element (no visible label text when collapsed).

If during implementation we discover the collapse toggle needs a hover-popup to show labels, we file a follow-up to add a `Tooltip` primitive to the Design System rather than ad-hoc CSS — that keeps AC4 holding.

### Routing parity (AC5)

No routing changes. `useLocation.js`, `pulseTabs.js`, and each `tabs/*.jsx` stay byte-identical. The active attribute + URL behaviour is identical to today's horizontal bar — `aria-current="page"` is forwarded onto the active item.

### Persistence (AC3)

- Key: `pulse.sidebar.collapsed`
- Values: `"true"` / `"false"` (string form to keep localStorage portable)
- Read at mount; default `false` (expanded). Write on toggle.
- Migration of older localStorage shape: none (no key collision; this is new).

### Light / dark mode (AC6)

We rely entirely on tokens that already exist in `packages/ui/src/react/base.css` (`--si-color-bg-section`, `--si-color-border-subtle`, `--si-color-cta-primary`, `--si-color-text-primary`). No new colour tokens. Mission Control already picks up these tokens via its existing CSS imports, so light/dark support is free as long as we don't introduce opaque colours.

## Test plan

- **Unit (Vitest):** new `Sidebar.test.jsx` covers render, click → URL change, toggle flips `data-collapsed` and writes localStorage, initial localStorage honoured, active item carries `aria-current`.
- **Unit regression:** existing `App.test.jsx` must still pass — `data-testid="pulse-tabbar"` is replaced with `data-testid="pulse-sidebar"` and `data-testid="pulse-sidebar-tab-<id>"` per row. Either keep `pulse-tabbar` as an alias wrapper or update the existing tests to the new `data-testid`s. Decision: rename to `pulse-sidebar` and update the 4 existing assertions.
- **Lint / format:** `npm run lint` clean (Biome / eslint as configured for the workspace).
- **Type-check:** `npm run type-check` (TypeScript `tsc --noEmit`) — Mission Control is JSX, so this is more of a structural lint pass.
- **Build:** `npm run build` (Vite production bundle) — confirms the new CSS class surface compiles cleanly.
- **Manual smoke:** `npm --workspace @sindustries/mission-control run dev` and visually confirm: expanded → collapsed transition; active highlight tracks URL; reload preserves state; theme switch (current Mission Control already supports this via the budget-mobile route so we won't introduce dark-mode toggling here — we only verify both palettes render correctly).

## Open questions / risks

- **Q1 — Tab icons.** Should the icons come from the Design System or stay inline? Today's Design System has no icon set. Plan: inline SVG, semantically hidden — if we ever add an icon primitive, we can swap without API changes because each tab's icon is a single `icon` field in `pulseTabs.js`.
- **Q2 — `data-testid` rename break.** The existing `App.test.jsx` uses `pulse-tab-tasks` etc. Renaming to `pulse-sidebar-tab-tasks` will touch tests in this PR; the alternative is dual `data-testid`s, which is a small but real split of the test contract. Plan: rename + update the 4 assertions in `App.test.jsx` in this same PR.
- **Q3 — Collapse toggle ergonomics.** Should the toggle live inside the sidebar header (current plan) or float above the content? Sticking to header — keeps everything in one Design System container.
- **Q4 — `persistence` failure path.** If `localStorage` is unavailable (private mode quirks), the toggle still works for the session but resets on reload. Plan: try/catch around the localStorage read/write and a console warning at most; behaviour degrades to a non-persistent toggle rather than throwing.
- **Q5 — E2e coverage gap.** Playwright e2e for Pulse remains deferred per `SPEC.md`. This PR doesn't move that needle. The new `Sidebar.test.jsx` is the explicitly tested surface.

## Out of scope

- Mobile / responsive layout (per the product spec's non-goal).
- Drag-to-reorder tabs (also a non-goal).
- Per-user tab visibility (also a non-goal).

## Companion doc updates

- `apps/mission-control/SPEC.md` — replace the "persistent tab bar" language with "vertical sidebar on the left, collapsable". Update the Screens / Components row and add the Vitest coverage entry.
- No `docs/systems/` change needed — Mission Control shell lives inside the app's own SPEC, not as a cross-cutting system; the existing `docs/systems/` set covers Python services, Rust workflows, etc. Per the feature-factory-v2 system-spec policy, this task records `[no-system-spec-change]` with the above rationale.

## Later todos (parking lot)

- Real `Tooltip` primitive in the Design System so collapsed-mode labels can show on hover.
- Icon primitive in the Design System so all shells can stop inline-SVGing icons.
- Playwright e2e suite for the sidebar when the team's viewport styling settles.
