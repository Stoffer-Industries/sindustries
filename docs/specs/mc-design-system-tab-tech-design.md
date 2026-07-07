---
status: draft
task_id: 205d7615-3756-4b4f-9685-d08fd6381634
product_spec: brain/tasks/specs/mc-design-system-tab-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Design System tab in Mission Control — Tech Design

## Links

- Product spec: `brain/tasks/specs/mc-design-system-tab-2026-07-07.md`
- Tech design: `docs/specs/mc-design-system-tab-tech-design.md`
- Task: `205d7615-3756-4b4f-9685-d08fd6381634` (`🔧 Design System tab in Mission Control`)
- Existing page: `apps/tasks/src/main.jsx` routes `/design-system` → `DesignSystemPage` from `@sindustries/ui/specimen`
- Existing component: `packages/ui/src/specimen/DesignSystemPage.jsx` (the page this task moves, untouched)
- Existing tasks-app header link: `apps/tasks/src/App.jsx:439` (the link this task removes)
- Tasks API record: `http://localhost:4001/api/v1/tasks/205d7615-3756-4b4f-9685-d08fd6381634`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-205d7615-mc-design-system-tab`
- Worktree: `~/workspaces/rowan/sindustries-task-205d7615-mc-design-system-tab`
- No secondary repos; this is a Mission Control app change. The `DesignSystemPage` component itself stays in the shared `packages/ui/src/specimen/` package and is consumed via the existing `@sindustries/ui/specimen` alias in `apps/mission-control/vite.config.js`. No rebuild of the design system itself is required.

## Product intent (from approved product spec)

- Outcome: the Design System viewer (currently a standalone page inside the Tasks app) becomes a first-class Mission Control tab, accessible to all agents and contributors from the persistent tab bar without coupling the design system to the tasks workflow.
- The `DesignSystemPage` component already exists in `packages/ui/src/specimen/` and is shared. This task is a **move, not a rebuild**: the same component renders the same content at a new route, with the tasks-app-specific `/design-system` branch removed and the tasks-app header link removed.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals: rebuilding or redesigning the Design System viewer; adding new design tokens or components; changing the `DesignSystemPage` API.

## Acceptance criteria recap

- AC1: The Design System is removed from the Tasks app UI (header link gone, `/design-system` route in tasks app no longer serves the page).
- AC2: A "Design System" tab is registered in Mission Control at `/design-system` and renders the existing `DesignSystemPage` from `@sindustries/ui/specimen`.
- AC3: The tab is accessible from the Mission Control tab bar and renders correctly in both light and dark mode.
- AC4: No design system functionality is lost (same specimen, same component, same content).

## `.openclaw` boundary

None. Mission Control is a static SPA served by Vite in dev and built by Vite for production. The Tasks app is its own Vite app; removing the `/design-system` branch and the header link is a code change inside this repo, not an `.openclaw/` change. The `DesignSystemPage` component is already shipped via the `packages/ui` workspace; no tooling, runtime, or `.openclaw/` changes are required.

## Implementation plan

### File / module scope

- **`apps/mission-control/src/tabs/DesignSystemTab.jsx`** *(new)* — Top-level React component. A thin wrapper that imports `DesignSystemPage` from `@sindustries/ui/specimen` and renders it inside the tab slot. The `backHref` defaults to the first tab (`/tasks`); the `backLabel` reads `← Tasks` to match the prior tasks-app back link. No state, no effects, no local compute — this tab is a single render.
- **`apps/mission-control/src/tabs/DesignSystemTab.test.jsx`** *(new)* — Vitest unit tests:
  - Renders the `DesignSystemPage` specimen (smoke: design-kit navigation present, Tokens button active by default, "Sindustries design system" heading present).
  - Renders the back link with the expected `href` and label.
- **`apps/mission-control/src/pulseTabs.js`** *(modified)* — Register the new tab. Add a fourth entry to `PULSE_TABS`:
  ```js
  {
    id: 'design-system',
    label: 'Design System',
    path: '/design-system',
    component: DesignSystemTab
  }
  ```
  Plus a one-line `import { DesignSystemTab } from './tabs/DesignSystemTab.jsx';` at the top. No `App.jsx` change — the existing `App.jsx` already maps over `PULSE_TABS`.
- **`apps/mission-control/src/App.test.jsx`** *(modified)* — Update the "renders the tabbar with three tabs" test to expect four tabs (Tasks, Bookmarks, Flow metrics, Design System). Add a `pulse-tab-design-system` assertion. The "switches tabs" and "routes to URL" tests don't need changes; they don't enumerate tabs.
- **`apps/mission-control/SPEC.md`** *(modified)* — Add a row to the Screens table for Design System. Update the "Tabs in MVP" line. Update E2e coverage table with the new Vitest file. No flow changes — this adds a tab; no existing flow changes shape.
- **`apps/mission-control/README.md`** *(modified)* — Mention the new tab in the intro sentence and the "Adding a new tab" example uses Design System as the canonical worked example.
- **`apps/tasks/src/main.jsx`** *(modified)* — Remove the `import { DesignSystemPage } from '@sindustries/ui/specimen';` import, the `Root` function wrapper, and the `if (window.location.pathname === '/design-system')` branch. Restore `createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);` as the direct top-level render. **AC1.**
- **`apps/tasks/src/App.jsx`** *(modified)* — Remove the `<Button as="a" href="/design-system" variant="nav">Design System</Button>` line from the `hero-controls` block. **AC1.**

### Tab slot

The new `DesignSystemTab` is the simplest tab in the registry — it has no data fetching, no toolbar, no sections. It exists to host `DesignSystemPage` at `/design-system`. The component owns its own theme toggle (light/dark) and its own kit-tab navigation, so the new tab does not need to coordinate with any Mission Control shell state. Light/dark mode is verified by clicking the existing in-page theme toggle in the test and asserting `data-si-theme` updates — same pattern the existing `DesignSystemPage.test.jsx` already covers.

### Data source

None. The Design System viewer renders from a static, code-generated manifest (`packages/ui/src/specimen/generated/pages.js`) shipped in the `packages/ui` workspace. There is no runtime data fetch, no API call, no state. **AC4** holds by construction — the same component, the same content, the same CSS.

### Design system usage

- `DesignSystemPage` from `@sindustries/ui/specimen` — the existing specimen, imported by the new tab. No new design tokens, no new components.
- `Button` from `@sindustries/ui/react` is already used in the rest of Mission Control; not needed for the new tab itself.
- No new colors. Light/dark mode is self-contained in the `DesignSystemPage` component via `data-si-theme`. **AC3** holds by construction.

## Test plan

- **Unit (component) — `DesignSystemTab.test.jsx`:**
  - Renders the design-kit navigation from `DesignSystemPage` (`screen.getByRole('navigation', { name: 'Design kit' })`).
  - Renders the back link with `href="/tasks"` and label containing "Tasks".
  - Renders the "Tokens" kit tab as active by default (smoke check that the specimen is mounted, not a placeholder).
- **Unit (shell) — `App.test.jsx`:**
  - Update the existing "renders the tabbar with three tabs" test to expect four tabs and assert the new `pulse-tab-design-system` is present.
  - Add a small new test: clicking the Design System tab updates the URL to `/design-system` and sets `aria-current="page"` on the new tab.
- **Unit regression:** existing `flowMetrics.test.js`, `BookmarksTab.test.jsx`, and `packages/ui/src/specimen/DesignSystemPage.test.jsx` must still pass.
- **Build:** `npm --workspace @sindustries/mission-control run build` and `npm --workspace @sindustries/tasks run build` — both bundles compile cleanly with the changes.
- **Dev smoke:** `npm --workspace @sindustries/mission-control run dev` → click Design System tab → confirm the specimen renders, kit tabs switch between Tokens / Pulse / Brand, and the back link returns to Tasks. Then `npm --workspace @sindustries/tasks run dev` → confirm the Design System header link is gone and visiting `/design-system` 404s / falls through to the tasks app's default view.
- **E2e:** Playwright suite for Pulse remains deferred per `apps/mission-control/SPEC.md`. This PR doesn't move that needle.

## Open questions / risks

- **Q1 — Back link target.** Today `DesignSystemPage` uses `backHref="/"` + `backLabel="← Tasks"` because the tasks app's root IS the tasks view. In Mission Control, the tab bar IS the navigation — the back link is now somewhat redundant (the user can click the Tasks tab). Options: (a) keep the back link pointing at `/tasks` with `backLabel="← Tasks"` (matches the prior UX literally), (b) point at `/` (the default tab) with `backLabel="← Back"`, (c) keep the back link but make it minimal. **Default plan: option (a)** — same back link as before, preserves the existing user expectation, costs nothing. If Quinn wants a different label, it's a one-line change in `DesignSystemTab.jsx`.
- **Q2 — Future shell-level theme toggle.** The `mc-day-night-mode` task (separate, currently `ready`) plans to add a global light/dark toggle to the Mission Control shell. The Design System viewer already has its own in-page theme toggle. The two are independent in v1 — the Design System viewer's local toggle changes the specimen's `data-si-theme`; the shell's eventual toggle would change the shell surface. When the shell toggle lands, this tab will render the Design System viewer in whatever the shell's current theme is, and the in-page toggle will continue to work as a per-tab override. No action needed in this task; flagged here so the day/night mode task knows.
- **Q3 — Tasks-app `/design-system` direct visits.** After AC1, visiting `http://localhost:5173/design-system` (tasks-app dev port) will no longer render the design system — it'll render the tasks app's default view. Anyone who bookmarked that path inside the tasks app gets a redirect by visiting Mission Control instead. Acceptable per the product spec's intent.
- **Q4 — Pulse tab order.** The existing tabs are listed Tasks, Bookmarks, Flow metrics. Adding Design System as the fourth tab follows the existing order. If Quinn wants it elsewhere (e.g. at the end, after a settings tab), it's a one-line reorder in `pulseTabs.js`.

## Out of scope

- Any change to `packages/ui/src/specimen/DesignSystemPage.jsx` or its styles (per the product spec's non-goals).
- Any change to the `packages/ui` specimen manifest (`generated/pages.js`).
- A global shell-level theme toggle (separate `mc-day-night-mode` task).
- Removing the tasks-app iframe from Mission Control (separate decision; the tasks app is still the source of truth for task editing).
- A per-tab "Open in new tab" affordance for the Design System (the back link is sufficient in v1).

## Companion doc updates

- `apps/mission-control/SPEC.md` — add the Design System row to the Screens table; bump "Tabs in MVP" to four; add the new Vitest file to the E2e coverage table.
- `apps/mission-control/README.md` — mention the new tab in the intro and update the "Adding a new tab" example to reference `DesignSystemTab.jsx`.
- No `docs/systems/` change needed — Mission Control is a static SPA, not a cross-cutting system; per the feature-factory-v2 system-spec policy this task records `[no-system-spec-change]` with the above rationale.

## Later todos (parking lot)

- Shell-level theme toggle interaction (Q2).
- "Open in new tab" affordance for the Design System viewer.
- Removing the tasks-app iframe if Mission Control ever ships its own first-class tasks surface.
