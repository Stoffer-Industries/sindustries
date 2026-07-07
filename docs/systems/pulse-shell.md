# Pulse Shell — iframe embed architecture decision

**Type:** Architecture decision record (system reference)
**Status:** Accepted
**Last updated:** 2026-07-07
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries`
**App:** `apps/mission-control/`

---

## Context

`apps/mission-control` ("Pulse") is the Sindustries desktop shell. It hosts
multiple operational apps behind a single URL and a persistent tab bar.
The MVP tabs are:

- **Tasks** — embeds the existing `@sindustries/tasks-app` via `<iframe>`.
- **Bookmarks** — placeholder, tracked under a separate spec.
- **Flow metrics** — fetches directly from the Tasks API.

This document captures the architectural decision for the Tasks tab's
iframe embed and the related port/CSP/sandbox posture. It exists so the
follow-up work flagged in the W28 audit (H1 hard-coded iframe URL, M4
missing sandbox/CSP) can be revisited against a written baseline instead
of tribal knowledge.

For the behavioural spec, see `apps/mission-control/SPEC.md`.

---

## Decision

**Pulse embeds the Tasks app via `<iframe>` rather than a route-level
React mount.**

This decision applies to the MVP. It may be revisited if any of the
triggers in [Revisit triggers](#revisit-triggers) fires.

### Why iframe over route-level mount

1. **No duplicated implementation.** The Tasks app already owns its
   routing, state, and component tree; mounting it inside Pulse would
   mean either copying the app into the Pulse bundle (duplicates the
   build, the tests, and the bug surface) or reorganising the Tasks app
   into a library that Pulse composes from. Both options are larger
   than the iframe embed and were not justified for an MVP shell.
2. **Independent deploy cadence.** The Tasks app ships at its own pace
   (W22-W27 feature work, e2e suite, ongoing UI refactors). An iframe
   keeps the two apps loosely coupled — Pulse does not need to bump a
   library version or re-run the Tasks app's build pipeline every time
   the Tasks app changes.
3. **Standalone parity.** The Tasks app continues to be deployable and
   usable on its own. A reader hitting the Tasks app directly sees the
   same UI a Pulse user sees — Pulse is a tab-bar wrapper, not a
   separate product surface.

### Why iframe over opening in a new tab

A new-tab escape hatch is still available for users who want it, but
the iframe keeps the workflow inside the tab bar so the user stays
oriented (the W27 SPEC's flow 1 contract).

---

## Posture

### Local development

- The Tasks tab maps the Pulse dev-server port to a Tasks-app URL via
  `apps/mission-control/src/tabs/TasksTab.jsx:3-14`. The current map is
  a `localhost:517X` neighbour-port lookup with a same-port fallback.
  See [Known gaps](#known-gaps).
- The Tasks API base URL is resolved by `tasksApiBaseUrl()` in
  `apps/mission-control/src/tasksApi.js`. It reads
  `import.meta.env.VITE_TASKS_API_BASE_URL` first, then falls back to a
  port-keyed map, then to a hard-coded default. See [Known gaps](#known-gaps).

### Authentication and authorisation

- Pulse is currently deployed on the Sindustries Tailnet and runs
  without a session check of its own.
- The Tasks app runs the same way it does standalone — when it gains
  authentication (a stated goal in `docs/systems/task-tracking.md`), the
  iframe will share the parent's origin and therefore the parent's
  cookies. The mitigation is a reverse proxy in production that
  attaches an authenticated session to the iframe URL (see
  [Production](#production) below).
- `docs/systems/task-tracking.md` is the source of truth for the
  Tasks app auth contract.

### Sandbox and CSP

- The iframe is currently emitted without a `sandbox` attribute, a
  `referrerpolicy`, or a CSP `frame-ancestors` directive on the Tasks
  app side. This is acceptable for the current Tailnet-only
  deployment. See [Revisit triggers](#revisit-triggers).

### Unknown paths

- Pulse falls back to the Tasks tab for any URL path not in the tab
  registry (`apps/mission-control/src/pulseTabs.js:37-40`). The
  behaviour is asserted by `App.test.jsx`. A `NotFoundTab` component
  in the registry would be a clean alternative; the silent fallback
  is intentional today so a typo like `/task` (missing "s") still
  routes to Tasks rather than dead-ending.

---

## Known gaps

The W28 audit flagged two structural issues with the current
implementation that are tracked but not yet fixed.

### H1 — hard-coded Tasks-app iframe URL

`apps/mission-control/src/tabs/TasksTab.jsx:6-18` builds the iframe
URL from `window.location.port` via a `localhost:517X` lookup table
and falls back to `http://localhost:5173`. There is no `VITE_TASKS_APP_URL`
override, no discussion of production deploy, and no same-origin /
frame-ancestor policy. This blocks single-URL production deploy until
either the Tasks app is built into the Pulse bundle or both apps are
fronted by a reverse proxy. **Quick win Q3 in the W28 task plan** —
env override + corrected port map — addresses the dev-side ergonomics;
production deploy remains a separate piece of work.

### M4 — no sandbox, referrerpolicy, or CSP frame-ancestors

`apps/mission-control/src/tabs/TasksTab.jsx:24-31` emits the iframe
without `sandbox`, `referrerpolicy`, or a CSP header story on the
Tasks-app side. Once Tasks auth lands, the Tasks app inside Pulse
will share the parent origin's cookies. Even in the Tailnet case,
`sandbox="allow-scripts allow-same-origin allow-forms"` would narrow
the surface without breaking Tasks. Not urgent today; revisit when
authentication lands.

---

## Production

Pulse is not yet deployed to production. The MVP target is the
Sindustries Tailnet. Two deployment shapes are under consideration;
this document records the decision once it lands.

**Option A — reverse proxy.** Pulse and Tasks are deployed as separate
Vite apps behind one URL. The Tasks app is mounted at a path prefix
(`/tasks` or similar), Pulse is mounted at `/`, and the proxy passes
through the iframe `src` unchanged. Authentication and CSP are
configured at the proxy. This is the cheapest deploy and the most
likely first production shape.

**Option B — bundle Tasks into Pulse.** Pulse imports `@sindustries/tasks-app`
as a workspace library and mounts the Tasks React tree directly
instead of via iframe. Loses the loose-coupling benefit above but
eliminates the iframe / auth / CSP questions entirely. Reserved for
if Option A turns out to be unworkable (e.g., Tasks app gains state
that has to be shared with Pulse siblings).

The option chosen here will be reflected in a follow-up commit and a
new section below; until then this is the placeholder.

---

## Revisit triggers

The iframe decision should be reconsidered when any of the following
becomes true:

- **Authentication lands on the Tasks app.** Today the iframe is
  cookie-less. Once the Tasks app gains a session, the iframe needs a
  CSP `frame-ancestors` directive, a sandbox attribute, or a move to
  Option B.
- **Production deploy is scheduled.** Tailnet-only is fine; the moment
  Pulse needs to serve anyone outside the Tailnet, H1 blocks and
  either Option A or Option B must be implemented.
- **Tasks app gains cross-app state.** If Tasks needs to share state
  with another Pulse tab (e.g., "open in Tasks from Bookmarks"), the
  iframe contract breaks down and Option B becomes attractive.
- **Pulse gains a third or fourth tab.** If the shell becomes a
  real product surface rather than a wrapper around Tasks, the iframe
  pattern still holds but the unknown-path fallback should become a
  `NotFoundTab`.

---

## Related

- `apps/mission-control/SPEC.md` — behavioural spec, links here.
- `apps/mission-control/README.md` — local dev setup.
- `docs/systems/task-tracking.md` — Tasks app auth and API contract.
- `docs/repo-audits/2026-W28.md` — audit that triggered this ADR.
- `apps/mission-control/src/tabs/TasksTab.jsx` — current iframe embed.
- `apps/mission-control/src/tasksApi.js` — Tasks API base URL resolution.