---
status: draft
task_id: 58f48ec5-2da0-4af3-bc94-6176adfd5a86
product_spec: brain/tasks/specs/mc-day-night-mode-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Move Day/Night mode to Mission Control shell — Tech Design

## Links

- Product spec: `brain/tasks/specs/mc-day-night-mode-2026-07-07.md`
- Tech design: `docs/specs/mc-day-night-mode-tech-design.md`
- Task: `58f48ec5-2da0-4af3-bc94-6176adfd5a86` (`🔧 Move Day/Night mode to Mission Control shell`)
- Mission Control sidebar: `apps/mission-control/src/Sidebar.jsx` (the home for the new toggle)
- Mission Control shell root: `apps/mission-control/src/main.jsx` (sets `data-si-theme` on `<html>`)
- Mission Control App: `apps/mission-control/src/App.jsx` (mounts sidebar + tab content)
- Tasks app existing toggle: `apps/tasks/src/App.jsx:440-447` (the in-header button this task removes)
- Tasks app existing theme storage: `apps/tasks/src/utils/storage.js:1-50` (`THEME_STORAGE_KEY = 'tasks-app-theme'`)
- Tasks app theme application: `apps/tasks/src/main.jsx:1-15` (sets `data-si-theme` on boot from localStorage)
- Design tokens theme block: `packages/design-tokens/styles.css` (`[data-si-theme="dark"]` / `[data-si-theme="light"]` rules)
- Tasks API record: `http://localhost:4001/api/v1/tasks/58f48ec5-2da0-4af3-bc94-6176adfd5a86`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-58f48ec5-mc-day-night-mode`
- Worktree: `~/workspaces/rowan/sindustries-task-58f48ec5-mc-day-night-mode`
- No secondary repos. The change is contained inside the `apps/mission-control` and `apps/tasks` apps of the same monorepo; both apps import the shared design tokens from `packages/design-tokens/styles.css`, so no token changes are needed and no cross-repo coordination is required.

## Product intent (from approved product spec)

- Outcome: the Day/Night theme toggle currently lives inside the Tasks app header. It should move to the Mission Control shell so the toggle controls the theme for every tab (Bookmarks, Flow metrics, Design System, future tabs) and persists across sessions.
- The existing theme mechanism (`data-si-theme` attribute on `<html>` + CSS rules in `packages/design-tokens/styles.css`) is correct and reusable. This task is a **relocation + a small wire-up**, not a redesign. The shell gains the toggle; the tasks app loses its toggle and listens for theme changes broadcast from the parent shell.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals: redesigning the toggle control beyond relocating it; per-tab theme overrides; introducing a third theme or a user-defined palette.

## Acceptance criteria recap

- AC1: The theme toggle is removed from the Tasks app UI; nothing in the tasks app header offers to change `data-si-theme` anymore.
- AC2: A theme toggle is added to the Mission Control shell (mounted inside the existing vertical sidebar so it shares the shell's surface) and applies `data-si-theme` to the shell's own `<html>`.
- AC3: The selected theme persists across page reloads via localStorage. The shell owns the canonical storage key and the iframe-based tabs follow the shell's setting.
- AC4: All existing tabs (Tasks via iframe, Bookmarks, Flow metrics, Design System) render correctly in both light and dark mode. For the iframe-based Tasks tab, the theme is broadcast from the shell at boot and on toggle via `window.postMessage`.

## `.openclaw` boundary

None. Both apps are static Vite SPAs. The Mission Control shell is served at `http://localhost:5174` (dev) / `http://localhost:5175` (prodlike) and the Tasks app is served at `http://localhost:5173`. They run in different browsing contexts (different ports = different origins for `localStorage` and `document` purposes), so the only cross-context communication available is `postMessage` between the shell window and the Tasks tab iframe. No tooling, runtime, cron, or `.openclaw/` changes are required.

## Implementation plan

### File / module scope

#### Mission Control (shell) — `apps/mission-control/`

- **`apps/mission-control/src/theme.js`** *(new)* — Tiny module with three pure helpers, no React:
  - `THEME_STORAGE_KEY = 'pulse-theme'` — the new canonical localStorage key (replaces the tasks-app-local `tasks-app-theme` for cross-app coordination; the old key is still read on first load in the tasks app, see below).
  - `readStoredTheme()` — returns `'dark' | 'light'`. Reads `pulse-theme` from `localStorage`; falls back to `'dark'`. Wrapped in try/catch so private-mode browsers don't throw.
  - `writeStoredTheme(theme)` — writes `'dark' | 'light'` to `pulse-theme`. Same try/catch.
  - `THEME_MESSAGE = 'pulse:theme'` — the `postMessage` event name the shell uses to broadcast to iframes.
- **`apps/mission-control/src/main.jsx`** *(modified)* — Add `document.documentElement.setAttribute('data-si-theme', readStoredTheme());` before `createRoot(...).render(...)`. Same pattern the tasks app already uses on its own `<html>`. **AC2, AC3.**
- **`apps/mission-control/src/Sidebar.jsx`** *(modified)* — Add a new `ThemeToggle` subcomponent (private to the file) that:
  - Renders a single `Button` (variant=`ghost`, size=`md`) styled to match the existing collapse toggle, with a sun/moon glyph and an accessible label that announces the next theme ("Switch to light theme" when current is dark, "Switch to dark theme" when current is light).
  - Owns no theme state of its own — it reads/writes via the helpers in `theme.js` and reflects the current theme via a class on the toggle button (`pulse-sidebar__theme-toggle--dark` / `pulse-sidebar__theme-toggle--light`) so CSS can swap the icon if desired.
  - Mounts inside the sidebar at the **bottom**, after `pulse-sidebar__items` and a thin visual separator (`pulse-sidebar__divider`). The button stretches to the full sidebar width, mirrors the collapse toggle's label-when-expanded / icon-only-when-collapsed behaviour using the same `pulse-sidebar--sr-only` helper.
  - On click: computes the next theme, calls `writeStoredTheme(next)`, sets `document.documentElement.setAttribute('data-si-theme', next)`, and broadcasts `window.postMessage({ type: THEME_MESSAGE, theme: next }, window.location.origin)` so the Tasks app iframe (and any future iframe-based tab) receives the change live. **AC2, AC3, AC4.**
  - Subscribes to a `storage` event so if the user opens Mission Control in two browser tabs and changes the theme in one, the other tab's toggle reflects the new value without a manual reload. (Same pattern `StatefulSidebar` already uses for the collapse state.)
  - Listens for `postMessage` from iframes carrying a `pulse:theme` echo — this is a no-op for the shell (the shell is the source of truth) but the listener is included so the shell can detect echoes in dev console during debugging. No state mutation on receive.
  - Exports `ThemeToggle` and renders it inside `Sidebar` (stateless) just before the closing `</aside>`. `StatefulSidebar` does not need to wrap it — the toggle reads from localStorage on every render via `readStoredTheme()`, so it always reflects the latest committed value. **AC2.**
- **`apps/mission-control/src/Sidebar.jsx`** *(modified)* — `Sidebar` gains a new prop `theme` (the current value) passed through from `StatefulSidebar` so the toggle is consistent. `StatefulSidebar` reads `theme` via `readStoredTheme()` on mount and via the `storage` event thereafter (same shape as the collapse state).
- **`apps/mission-control/src/styles/layout.css`** *(modified)* — Add `.pulse-sidebar__divider` (1px horizontal rule using `--si-color-border-subtle`) and `.pulse-sidebar__theme-toggle` / `.pulse-sidebar__theme-toggle--collapsed` (mirroring the collapse toggle's icon-only behaviour, reusing `.pulse-sidebar--sr-only`). Glyph is rendered as a Unicode `☀` / `☾` character swapped via the `--dark` / `--light` modifier class, so no new design-system primitive is needed. **AC2.**
- **`apps/mission-control/src/Sidebar.test.jsx`** *(modified)* — Add a `ThemeToggle` describe block:
  - Renders the toggle with `aria-label` reflecting the next theme.
  - Clicking the toggle updates `document.documentElement` to the next `data-si-theme` value and writes to localStorage under `pulse-theme`.
  - Clicking the toggle fires a `window.postMessage` with the new theme.
  - The `storage` event triggers a re-render with the new label when a sibling tab updates the key.
- **`apps/mission-control/SPEC.md`** *(modified)* — Add a "Day/Night theme toggle" row to the Screens table (or to a new "Shell controls" section). Add a Vitest file row to the E2e coverage table.
- **`apps/mission-control/README.md`** *(modified)* — Mention the new toggle in the "Adding a new tab" / "Shell features" intro paragraph.

#### Tasks app (iframe consumer) — `apps/tasks/`

- **`apps/tasks/src/utils/storage.js`** *(modified)* — Add two helpers alongside the existing `tasks-app-theme` ones:
  - `PULSE_THEME_STORAGE_KEY = 'pulse-theme'`
  - `getStoredPulseTheme()` — reads `pulse-theme`; returns `'dark' | 'light' | null` (null if nothing stored so the caller can fall back).
  - `setStoredPulseTheme(theme)` — writes `pulse-theme` if value is `'dark' | 'light'`.
  - Keep the existing `tasks-app-theme` helpers and the default-to-`dark` behaviour so users who land directly on `http://localhost:5173` without ever visiting Mission Control still see a deterministic theme. The old key is now only read on first-load migration (see below).
- **`apps/tasks/src/main.jsx`** *(modified)* — Two changes:
  1. Change the boot-time `document.documentElement.setAttribute('data-si-theme', getStoredTheme())` to read the new key first, fall back to the old `tasks-app-theme` key for one-time migration, then fall back to `'dark'`. Pseudocode:
     ```js
     const initial = getStoredPulseTheme() ?? getStoredTheme();
     document.documentElement.setAttribute('data-si-theme', initial);
     if (initial !== getStoredTheme()) setStoredTheme(initial); // one-time migrate
     ```
  2. Add a small `useEffect`-equivalent at module scope (no React, plain DOM listener registered once) that listens for `window.addEventListener('message', ...)` and applies `data-si-theme` to `<html>` when the message type is `pulse:theme` and the value is a valid theme. Persists the value to the new `pulse-theme` key so a standalone refresh of the tasks app keeps the shell's choice. **AC1 (no toggle button), AC3 (persistence), AC4 (iframe follow-along).**
- **`apps/tasks/src/App.jsx`** *(modified)* — Remove the theme toggle button (currently in the `hero-controls` block alongside the search input, view buttons, and the "Design System" header link — for context, that link is being removed in a separate `mc-design-system-tab` task, so the header link will be gone independently; the theme button is the only in-header piece this task removes). Also remove the `theme` state, the `useLayoutEffect` that writes to `<html>` + localStorage, and the `nextTheme` derived value. The `getStoredTheme` / `setStoredTheme` imports are no longer needed in `App.jsx` but stay exported from `utils/storage.js` for the one-time migration read in `main.jsx`. **AC1.**
- **`apps/tasks/src/utils/storage.test.js`** *(modified)* — Add tests for `getStoredPulseTheme` / `setStoredPulseTheme` matching the existing patterns for `getStoredTheme` / `setStoredTheme` (returns `'dark'` when nothing stored, returns stored value, handles invalid input, setItem wraps in try/catch).
- **`apps/tasks/test/setup.js`** — no change needed; the tasks app's test setup already exposes an in-memory `localStorage` stub (see `apps/mission-control/test/setup.js` and `apps/tasks/test/setup.js`).
- **`apps/tasks/src/App.test.jsx`** *(modified)* — Drop the test(s) that exercise the removed theme button. Add a tiny test that asserts the `message` listener in `main.jsx` updates `<html>`'s `data-si-theme` when a `pulse:theme` message arrives (this is the AC4 cross-context contract).

### Storage key migration

The tasks app currently uses localStorage key `tasks-app-theme`. After this change:

- The shell uses `pulse-theme` exclusively.
- The tasks app reads `pulse-theme` first, then `tasks-app-theme` as a one-time migration fallback, then defaults to `'dark'`. Once the new key is set (either by the shell via `postMessage` or by a standalone visit reading the old key), the new key is canonical.
- The old `tasks-app-theme` key is left in place but is no longer written. This avoids a hard data-loss moment for users with existing preferences and keeps the migration reversible.

### Cross-origin coordination (the iframe problem)

The Mission Control shell and the Tasks app run at different ports (5174 vs 5173), so they are **cross-origin** from each other:

- They cannot read each other's `localStorage`.
- They cannot manipulate each other's `document`.

The only cross-context communication is `window.postMessage`. The contract is:

- **Shell → iframe:** shell broadcasts `{ type: 'pulse:theme', theme: 'dark' | 'light' }` to the iframe's `contentWindow` on every toggle change, and to all known iframes in the document on shell mount (so the initial sync is correct after a hard reload).
- **Iframe → shell:** the tasks app does not need to post back. The shell is the source of truth.
- **Message origin check:** the shell verifies `event.origin === window.location.origin` on receive (defensive, even though the shell isn't expected to act on theme messages). The tasks app verifies `event.origin` matches the shell's origin (the shell's `VITE_TASKS_APP_URL` minus the path, or `window.location.ancestorOrigins[0]` when available). The exact origin check is captured in the test plan.

The Tasks tab iframe element (`apps/mission-control/src/tabs/TasksTab.jsx`) is the only iframe-bearing tab today. New iframe-based tabs (e.g. a future SIndustries brand site tab) will receive the same broadcast without per-tab work — the broadcast is a document-wide fan-out to all `<iframe>` `contentWindow`s.

### Data model / API contract

None. No backend, no DB, no new API field. The only state is `localStorage.pulse-theme` on the shell, `localStorage.pulse-theme` (mirror) on the tasks app, and the in-memory `data-si-theme` attribute on each app's `<html>`.

### Workflow / cron / skill changes

None. The feature is a pure UI relocation. The task status is advanced by the lobster via the existing `[rowan-prs]` and `[tech-design-approved]` comments.

### Design system usage

- `Button` from `@sindustries/ui/react` (variant=`ghost`, size=`md`) for the new toggle — the same primitive the existing collapse toggle uses. No new design tokens, no new components. The icon is a Unicode glyph swapped via a modifier class; if Quinn wants a real icon primitive, that becomes a separate Design System task.
- Design tokens palette already supports both themes via `[data-si-theme="dark"]` and `[data-si-theme="light"]` rules in `packages/design-tokens/styles.css`. **AC4** holds by construction.

## Test plan

- **Unit — `Sidebar.test.jsx` (ThemeToggle block):**
  - Renders the toggle with `aria-label="Switch to light theme"` when current theme is `dark`, and vice versa.
  - Clicking the toggle updates `document.documentElement`'s `data-si-theme` to the next value.
  - Clicking the toggle writes the new value to `localStorage.pulse-theme`.
  - Clicking the toggle dispatches a `window.postMessage` with `{ type: 'pulse:theme', theme: <new> }`.
  - A simulated `storage` event on the `pulse-theme` key updates the toggle's `aria-label` (mirrors the cross-tab sync the collapse toggle already has).
- **Unit — `tasks-app/src/utils/storage.test.js` (new tests):**
  - `getStoredPulseTheme()` returns `null` when nothing stored, `'dark'` for invalid, the stored value otherwise.
  - `setStoredPulseTheme('dark')` / `('light')` writes through to localStorage; invalid value throws (per existing convention).
- **Unit — `tasks-app/src/App.test.jsx` (updated):**
  - Existing theme toggle tests are removed (the button is gone — AC1).
  - New test: a `message` event with `{ type: 'pulse:theme', theme: 'light', origin: 'http://localhost:5174' }` updates `document.documentElement` to `data-si-theme="light"` and writes the value to `pulse-theme` localStorage. A message with an unrecognised `origin` is ignored.
  - Migration test: a fresh `localStorage` containing only the legacy `tasks-app-theme` key results in `data-si-theme` matching the legacy value on first render and the legacy key being written through to `pulse-theme` (one-time migration).
- **Build:** `npm --workspace @sindustries/mission-control run build` and `npm --workspace @sindustries/tasks run build` — both bundles compile cleanly.
- **Dev smoke (Mission Control):**
  1. `npm --workspace @sindustries/mission-control run dev` → open `http://localhost:5174/`.
  2. Confirm the toggle is visible in the sidebar at the bottom, with a "Switch to light theme" label.
  3. Click it → shell background switches from dark to bone; toggle label updates to "Switch to dark theme".
  4. Reload the page → theme persists.
  5. Open a second tab at the same URL → toggle in the second tab updates after clicking the first.
  6. Open `localStorage` in DevTools → confirm the key is `pulse-theme` with value `light`.
- **Dev smoke (Tasks app inside Mission Control):**
  1. With the shell on `light` and the tasks tab active, confirm the tasks app iframe background is bone, not ink.
  2. Switch the shell toggle to `dark` → tasks app iframe background flips to ink live (no reload).
  3. Reload the page → both apps stay in `dark`.
  4. Reload just the tasks app iframe (right-click → Reload) → the iframe comes back in `dark` (read from its own localStorage mirror).
- **Dev smoke (Tasks app standalone):**
  1. Open `http://localhost:5173/` directly (no shell).
  2. Confirm no theme toggle button is in the header (AC1).
  3. Confirm the theme is the same value the shell last broadcast to it (its localStorage mirror) — or `dark` if it's a fresh visit.
- **E2e:** Playwright suite for Mission Control remains deferred per `apps/mission-control/SPEC.md`. This PR does not move that needle.

## Open questions / risks

- **Q1 — Toggle position in the sidebar.** Two natural homes: at the top of the sidebar (above the tab list) or at the bottom (below the collapse toggle, with a divider). The default plan is **bottom**, below the tab list and above the collapse toggle, with a subtle divider. Rationale: the toggle is a shell-level control, not a navigation control, so it sits below navigation; bottom placement also keeps it visible when the sidebar is collapsed (icon-only). If Quinn wants it at the top, it's a one-component reorder.
- **Q2 — Glyph vs icon primitive.** The toggle uses a Unicode `☀` / `☾` glyph swapped via a modifier class. If the Design System later ships an icon primitive (Sun / Moon), we can swap the glyph for the icon in a follow-up. The component contract stays the same. This task is intentionally glyph-based to avoid a Design System dependency.
- **Q3 — Cross-origin origin check.** The tasks app needs to know the shell's origin to validate `postMessage` events. Two options: (a) the tasks app reads `window.location.ancestorOrigins[0]` (works in Chromium, undefined in Firefox/Safari), (b) the tasks app reads a build-time `VITE_SHELL_ORIGIN` env var (defaults to `http://localhost:5174`). **Default plan: option (b)** with a `VITE_SHELL_ORIGIN` env var, falling back to a permissive `event.source === window.parent` check. The Vite config already exposes `VITE_TASKS_APP_URL` on the shell side; the same pattern fits here. The Q1 spec's `[openclaw]` boundary note is intentionally absent — no env-var changes are required (the default `http://localhost:5174` is a code constant in `apps/tasks/src/main.jsx`; if Tiltfile or prodlike ports ever change, the env var is the override path).
- **Q4 — Multiple iframes.** When a future tab is also iframe-based, the shell's fan-out broadcast already covers it (it iterates `document.querySelectorAll('iframe')`). No per-tab work is needed. The Q1 spec implicitly assumes one iframe (the Tasks tab) and that remains the v1 case.
- **Q5 — `DesignSystemPage` in-page toggle.** `packages/ui/src/specimen/DesignSystemPage.jsx` already has its own per-page theme toggle that controls the specimen's local `data-si-theme`. This task does **not** touch that — the in-page toggle is independent of the shell theme and remains a per-tab override. The user can switch the shell to `light` and the specimen (rendered inside the Design System tab) will still be in `dark` if they had it set that way, until they click the specimen's own toggle. This is by design (per-tab override is not in scope per the product spec's non-goals). Documented here for the test plan; no action needed.
- **Q6 — `tasks-app-theme` cleanup.** After a few weeks in production, we can drop the legacy `tasks-app-theme` key entirely. Out of scope for this PR — the migration is one-way and reversible.

## Out of scope

- Any change to `packages/design-tokens/styles.css` or the design tokens themselves.
- Per-tab theme overrides (e.g. an in-shell setting that pins the Tasks app to a different theme than the shell).
- A new Design System icon primitive for the toggle.
- Removing the legacy `tasks-app-theme` storage key (left in place for migration).
- Adding the toggle to the Tasks app's header for standalone-access users.
- A third theme or a user-defined palette.

## Companion doc updates

- `apps/mission-control/SPEC.md` — add a "Day/Night theme toggle" row to the Screens table; add the new Vitest cases to the E2e coverage table; note the `postMessage` cross-context contract under Data Sources.
- `apps/mission-control/README.md` — mention the new toggle in the "Adding a new tab" / "Shell features" intro paragraph; link to the `postMessage` contract.
- `apps/tasks/SPEC.md` *(if it exists; check before merging)* — note the removal of the in-header theme toggle and the `postMessage` follow-along behaviour.
- No `docs/systems/` change needed. Mission Control is a static SPA, not a cross-cutting system; per the feature-factory-v2 system-spec policy this task records `[no-system-spec-change]` with the above rationale. The shell itself is described in `apps/mission-control/SPEC.md`; the theme contract is local to that app.

## Later todos (parking lot)

- Design System `Icon` primitive (Sun / Moon) so the toggle can stop using Unicode glyphs.
- Optional per-tab theme override (a "Lock this tab to dark" affordance on the Design System specimen).
- Removing the legacy `tasks-app-theme` key once we have confidence no users are on the old code path.
- E2e Playwright coverage for the shell theme toggle and the cross-origin broadcast contract.
