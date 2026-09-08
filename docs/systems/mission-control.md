# Mission Control — iframe embed architecture decision

**Type:** Architecture decision record (system reference)
**Status:** Accepted
**Last updated:** 2026-09-08
**Owner:** Rowan
**Repos:** `Stoffer-Industries/sindustries`
**App:** `apps/mission-control/`

> **Naming history:** this app was originally called "Pulse Shell". It is now Mission Control. The `apps/mission-control/` directory and the iframe tab name were renamed; internal filenames like `pulseTabs.js` are unchanged for now (a code-only follow-up can rename them later). This ADR describes Mission Control as it exists today.

---

## Context

`apps/mission-control` is the Sindustries desktop shell. It hosts
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

**Mission Control embeds the Tasks app via `<iframe>` rather than a route-level
React mount.**

This decision applies to the MVP. It may be revisited if any of the
triggers in [Revisit triggers](#revisit-triggers) fires.

### Why iframe over route-level mount

1. **No duplicated implementation.** The Tasks app already owns its
   routing, state, and component tree; mounting it inside Mission Control would
   mean either copying the app into the Mission Control bundle (duplicates the
   build, the tests, and the bug surface) or reorganising the Tasks app
   into a library that Mission Control composes from. Both options are larger
   than the iframe embed and were not justified for an MVP shell.
2. **Independent deploy cadence.** The Tasks app ships at its own pace
   (W22-W27 feature work, e2e suite, ongoing UI refactors). An iframe
   keeps the two apps loosely coupled — Mission Control does not need to bump a
   library version or re-run the Tasks app's build pipeline every time
   the Tasks app changes.
3. **Standalone parity.** The Tasks app continues to be deployable and
   usable on its own. A reader hitting the Tasks app directly sees the
   same UI a Mission Control user sees — Mission Control is a tab-bar wrapper, not a
   separate product surface.

### Why iframe over opening in a new tab

A new-tab escape hatch is still available for users who want it, but
the iframe keeps the workflow inside the tab bar so the user stays
oriented (the W27 SPEC's flow 1 contract).

---

## Posture

### Local development

- The Tasks tab maps the Mission Control dev-server port to a Tasks-app URL via
  `apps/mission-control/src/tabs/TasksTab.jsx:3-14`. The current map is
  a `localhost:517X` neighbour-port lookup with a same-port fallback.
  See [Known gaps](#known-gaps).
- The Tasks API base URL is resolved by `tasksApiBaseUrl()` in
  `apps/mission-control/src/tasksApi.js`. It reads
  `import.meta.env.VITE_TASKS_API_BASE_URL` first, then falls back to a
  port-keyed map, then to a hard-coded default. See [Known gaps](#known-gaps).

### Authentication and authorisation

- Mission Control is currently deployed on the Sindustries Tailnet and runs
  without a session check of its own.
- The Tasks app runs the same way it does standalone — when it gains
  authentication (a stated goal in `docs/systems/tasks.md`), the
  iframe will share the parent's origin and therefore the parent's
  cookies. The mitigation is a reverse proxy in production that
  attaches an authenticated session to the iframe URL (see
  [Production](#production) below).
- `docs/systems/tasks.md` is the source of truth for the
  Tasks app auth contract.

### Sandbox and CSP

- The iframe is currently emitted without a `sandbox` attribute, a
  `referrerpolicy`, or a CSP `frame-ancestors` directive on the Tasks
  app side. This is acceptable for the current Tailnet-only
  deployment. See [Revisit triggers](#revisit-triggers).

### Unknown paths

- Mission Control falls back to the Tasks tab for any URL path not in the tab
  registry (`apps/mission-control/src/pulseTabs.js:37-40`). The
  behaviour is asserted by `App.test.jsx`. A `NotFoundTab` component
  in the registry would be a clean alternative; the silent fallback
  is intentional today so a typo like `/task` (missing "s") still
  routes to Tasks rather than dead-ending.

---

## Known gaps

The W28 audit flagged two structural issues with the current
implementation that are tracked but not yet fixed.

### H1 — hard-coded Tasks-app iframe URL (resolved for dev)

The dev-side half of H1 (no `VITE_TASKS_APP_URL` override) was
resolved by `8d19ac2 refactor(tasks): update tasks app URL handling to
use environment variable` (Tue Jul 7 2026). The iframe URL is now
derived from `import.meta.env.VITE_TASKS_APP_URL ?? 'http://localhost:5173'`
(`apps/mission-control/src/tabs/TasksTab.jsx`), with the Tilt dev
environment exporting the variable per `infra/tilt/Tiltfile`. The
single-URL production deploy half of H1 (no reverse proxy or bundled
mount in place today) remains open — see [Production](#production) for
the option set.

### M4 — no sandbox, referrerpolicy, or CSP frame-ancestors

`apps/mission-control/src/tabs/TasksTab.jsx` emits the iframe
without `sandbox`, `referrerpolicy`, or a CSP header story on the
Tasks-app side. Once Tasks auth lands, the Tasks app inside Mission Control
will share the parent origin's cookies. Even in the Tailnet case,
`sandbox="allow-scripts allow-same-origin allow-forms"` would narrow
the surface without breaking Tasks. Not urgent today; revisit when
authentication lands.

---

## Production

Mission Control and Tasks deploy to **cloud-hosted staging** as two
independent Vercel projects. PR #565 previously added Fly frontend
scaffolding but no live Fly release; PR #573 then established the
workload-fit rule that static Vite SPAs use Vercel while APIs and workers
remain on Fly. Task `9a53b122` owns the migration and live deployment.

### Chosen shape — separate Vercel projects, iframe architecture preserved

| Vercel project | Purpose |
| --- | --- |
| `sindustries-mission-control-staging` | Mission Control shell; embeds Tasks via iframe |
| `sindustries-tasks-app-staging` | Tasks app SPA, standalone and iframeable |

Each project sets its Root Directory to the matching app directory and uses the
co-located `vercel.json`. Vercel's monorepo checkout preserves access to the
root npm lockfile and shared workspace packages. Catch-all rewrites send
application routes to `index.html`.

The iframe contract from [Decision](#decision) is preserved unchanged:
Mission Control still loads the Tasks app via `<iframe>`. The build
bakes in the cross-origin URL pair — `VITE_TASKS_APP_URL` on Mission
Control and `VITE_SHELL_ORIGIN` on Tasks — so the iframe `src` and the
embedded app's CORS posture are pinned at build time, not runtime. The
two deploys must be coordinated on first rollout (Tasks first, then
Mission Control); afterwards they can ship independently because the
URL pair is stable.

### Why this shape

- **Not Option A (reverse proxy).** A reverse proxy in front of the two
  apps gives one URL, but it forces the iframe embed to be same-origin
  (or behind an authenticated proxy path) and pushes auth + CSP into
  the proxy layer. For staging that adds operational surface for no
  real benefit — the staging URL doesn't yet need authenticated users
  (non-goal in the spec).
- **Not Option B (bundle Tasks into Mission Control).** That eliminates
  the iframe question entirely but throws away the independent-deploy
  cadence that justified the iframe decision in the first place.
  Mission Control UI work and Tasks-app feature work would need
  coordinated releases again, and a Mission Control regression could
  no longer be reverted without reverting an unrelated Tasks change.
- **Separate Vercel projects keep the loose coupling** the
  [Decision](#decision) section argues for while using the native static-SPA
  platform. Each app receives its own stable HTTPS alias, preview deployments,
  and independent promotion/rollback history without maintaining an nginx
  container or Fly machine.

### Operational artefacts

- **Build configs:** `apps/mission-control/vercel.json` and
  `apps/tasks/vercel.json`.
- **Stable aliases:** the project-level `*.vercel.app` production aliases are
  the initial staging URLs. Optional custom domains can be added later without
  rebuilding either SPA.
- **Health:** `GET /` and a referenced hashed asset must both return `200`.
  The check verifies static hosting and bundle availability; API health remains
  a separate backend signal.
- **Rollback:** promote the previous known-good Vercel deployment for only the
  affected project, then repeat the root-and-asset smoke check.
- **Build-time URL contract:** Mission Control receives
  `VITE_TASKS_API_BASE_URL` and `VITE_TASKS_APP_URL`; Tasks receives
  `VITE_TASKS_API_BASE_URL` and `VITE_SHELL_ORIGIN`. These are public URLs,
  never secrets.
- **Current staging aliases (deployed 2026-09-08):**
  `https://sindustries-mission-control-staging.vercel.app` and
  `https://sindustries-tasks-app-staging.vercel.app`. Root documents, SPA
  routes, and hashed assets have been smoke-tested at HTTP 200. A second
  Mission Control release was deployed and rolled back successfully to prove
  the provider rollback path.
- **Current blocker:** the staging Tasks API hostname is not live, so frontend
  hosting is healthy but authenticated end-to-end task workflows are not yet
  validated. Vercel's GitHub integration also lacks access to the private
  repository, leaving deploys CLI-triggered until that access is granted.
- **Production cutover** is a separate workstream (task `020f423e`,
  spec `brain/tasks/specs/in-progress/sindustries-cloud-migration.md`).
  This ADR only commits to the staging shape; production decisions
  (custom domain strategy, prod Tasks API URL, prod Content Scheduler
  URL, prod observability hooks) inherit the same two-app shape but
  are not finalised here.

---

## Revisit triggers

The iframe decision should be reconsidered when any of the following
becomes true:

- **Authentication lands on the Tasks app.** Today the iframe is
  cookie-less. Once the Tasks app gains a session, the iframe needs a
  CSP `frame-ancestors` directive, a sandbox attribute, or a move to
  Option B.
- **Production deploy is scheduled.** Tailnet-only is fine; the moment
  Mission Control needs to serve anyone outside the Tailnet, H1 blocks and
  either Option A or Option B must be implemented.
- **Tasks app gains cross-app state.** If Tasks needs to share state
  with another Mission Control tab (e.g., "open in Tasks from Bookmarks"), the
  iframe contract breaks down and Option B becomes attractive.
- **Mission Control gains a third or fourth tab.** If the shell becomes a
  real product surface rather than a wrapper around Tasks, the iframe
  pattern still holds but the unknown-path fallback should become a
  `NotFoundTab`.

---

## Related

- `apps/mission-control/SPEC.md` — behavioural spec, links here.
- `apps/mission-control/README.md` — local dev setup.
- `docs/systems/tasks.md` — Tasks app auth and API contract.
- `docs/repo-audits/2026-W28.md` — audit that triggered this ADR.
- `apps/mission-control/src/tabs/TasksTab.jsx` — current iframe embed.
- `apps/mission-control/src/tasksApi.js` — Tasks API base URL resolution.
