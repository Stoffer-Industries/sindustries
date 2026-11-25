# Mission Control — iframe embed architecture decision

**Type:** Architecture decision record (system reference)
**Status:** Accepted
**Last updated:** 2026-11-21 (Vercel frontend hosting shape, task 5044e708)
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

- Mission Control and the Tasks app now both sit behind Clerk sign-in
  (task `ddd2f57d`, tech design
  `docs/specs/mission-control-tasks-clerk-auth-tech-design.md`). The
  Tailnet-only, no-session-check posture described above is retired: both
  apps have live public URLs, so an unauthenticated visitor must not be
  able to view or mutate task data.
- **GymTrack's existing Clerk domain remains the sole primary.** Mission
  Control and Tasks are both Clerk satellites: each uses the existing primary
  sign-in route and satellite auto-sync. A session established on the primary
  is recognized by Mission Control and by Tasks when it loads cross-origin
  inside the iframe, with no second prompt inside the frame. A clean standalone
  visit to either satellite may still round-trip through sign-in independently
  — that is expected, not a regression.
- Both apps reuse the **existing Sindustries Clerk identity pool** — the
  same application GymTrack uses in production. A second user pool or a
  GymTrack public sign-up flow is explicitly out of scope; creating an
  identity through GymTrack never grants Tasks access.
- Neither app exposes a public sign-up surface. Product access is a
  server-side allowlist on the Tasks API keyed by Clerk's immutable user
  ID; an authenticated-but-unauthorized identity sees a clear "not
  authorized" state, never an invitation to create an account.
- Agents remain machine identities. Their
  `Authorization: Bearer <service credential>` contract is unchanged and
  Clerk user tokens are never issued to them.
- `docs/systems/tasks.md` is the source of truth for the
  Tasks app auth contract.

### Sandbox and CSP

- The iframe is now emitted with an explicit least-privilege sandbox:
  `sandbox="allow-scripts allow-same-origin allow-forms"`, plus
  `allow="clipboard-write"` and
  `referrerPolicy="strict-origin-when-cross-origin"`. Top-navigation and
  popup permissions are deliberately **not** granted: the embedded board is
  already authenticated, and standalone sign-in is not sandboxed. If live
  satellite evidence ever requires more, the exact blocked Clerk capability
  has to be named before the sandbox is widened.
- The Tasks app emits a `Content-Security-Policy: frame-ancestors` header
  restricted to the exact approved Mission Control origins (production and
  staging). No wildcard, no generic subdomain, no preview domain, no
  unrelated product. The header applies to the SPA fallback responses too,
  and does not conflict with `X-Frame-Options`.
- The sandbox limits what the framed document can do; `frame-ancestors`
  limits who may embed it. Both are required — neither substitutes for the
  other. This resolves the M4 gap below.

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
implementation; H1 is resolved below and M4 remains tracked.

### H1 — hard-coded Tasks-app iframe URL (resolved)

The iframe URL is resolved from the explicit `VITE_TASKS_APP_URL` build
variable (`apps/mission-control/src/tabs/TasksTab.jsx`). Local development
falls back to `http://localhost:5173`, but deployed builds fail closed when
the variable is absent rather than silently selecting a host. The Vercel
environment matrix supplies the environment-appropriate Tasks hostname for
staging (`https://tasks.staging.sindustries.co.nz`) and production
(`https://tasks.sindustries.co.nz`), preventing a missing staging value from
embedding production data or a deployed bundle from embedding localhost.

### M4 — no sandbox, referrerpolicy, or CSP frame-ancestors (resolved)

**Resolved by task `ddd2f57d` (Clerk login for Mission Control and the
Tasks app).** `apps/mission-control/src/tabs/TasksTab.jsx` now emits the
iframe with `sandbox="allow-scripts allow-same-origin allow-forms"`,
`allow="clipboard-write"` and
`referrerPolicy="strict-origin-when-cross-origin"`, and the Tasks app
side answers with an exact-origin CSP `frame-ancestors` directive. The
gap was opened precisely because "revisit when authentication lands" — and
authentication landed in the same task. The residual known gap is
M4-adjacent: gating Mission Control hides its *other* tabs from anonymous
users, but it does not add Clerk verification to the Bookmarks or Content
Scheduler APIs. Making every underlying service API private is additional
cross-service scope that needs its own owner-specific design.

---

## Production

Mission Control and Tasks deploy to Vercel as four independent projects —
two staging and two production, one pair per app. PR #565 previously added
Fly frontend scaffolding but no live Fly release; PR #573 then established
the workload-fit rule that static Vite SPAs use Vercel while APIs and
workers remain on Fly. Task `9a53b122` owned the original staging
deployment and completed 2026-09-15; task `5044e708` provisioned the
production pair and bound their custom domains on 2026-11-18.

### Chosen shape — separate Vercel projects, iframe architecture preserved

| Vercel project | Purpose |
| --- | --- |
| `sindustries-mission-control-staging` | Mission Control shell; embeds Tasks via iframe |
| `sindustries-tasks-app-staging` | Tasks app SPA, standalone and iframeable |
| `sindustries-mission-control` | Production Mission Control shell; embeds Tasks via iframe |
| `sindustries-tasks` | Production Tasks app SPA, standalone and iframeable |

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
- **Stable aliases:** each project serves a stable custom domain under
  `sindustries.co.nz` — `mission-control.staging.sindustries.co.nz` and
  `tasks.staging.sindustries.co.nz` for staging, `mission-control.sindustries.co.nz`
  and `tasks.sindustries.co.nz` for production. The project-level
  `*.vercel.app` aliases are the documented provider fallback, not the live
  URL; the source of truth for the mapping is
  `infra/cloud/hostname-matrix.json`.
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
  `https://sindustries-mission-control-staging.vercel.app` <!-- stable-fallback: documented-migration; superseded by https://mission-control.staging.sindustries.co.nz — the stable Vercel domain is live (bound and certificate verified 2026-11-13, re-verified live 2026-11-20, task 5cb4a8fe) -->
  and
  `https://sindustries-tasks-app-staging.vercel.app` <!-- stable-fallback: documented-migration; superseded by https://tasks.staging.sindustries.co.nz — the stable Vercel domain is live (bound and certificate verified 2026-11-13, re-verified live 2026-11-20, task 5cb4a8fe) -->. Root documents, SPA
  routes, and hashed assets have been smoke-tested at HTTP 200. A second
  Mission Control release was deployed and rolled back successfully to prove
  the provider rollback path.
- **Current blocker:** Vercel's GitHub integration is not linked to the
  private repository on any of the four projects (verified live 2026-11-21:
  the Vercel API reports no git link for `sindustries-mission-control`,
  `sindustries-tasks`, `sindustries-mission-control-staging` or
  `sindustries-tasks-app-staging`), so Vercel cannot auto-deploy on push.
  The production pair does not depend on that integration: it deploys through
  the manually dispatchable `deploy-production-vercel-frontends.yml` workflow
  using `VERCEL_TOKEN` from the `production` environment (added 2026-11-18).
  The staging pair has no workflow path and is still deployed from the CLI.
  The staging hostnames themselves are live: the three stable API
  hostnames (`tasks-api`, `budget-api`, `content-scheduler-api`) each resolve
  to the consolidated platform app and answer HTTP 200 on `/health`
  (re-verified live 2026-11-20), and the representative authenticated staging
  workflow passed through `tasks-api.staging.sindustries.co.nz` in the
  2026-11-15 staging-validation run (`verdict: pass`, 15/15 checks). See
  `docs/systems/cloud-platform.md` for the full AC5 staging evidence.
- **Production cutover** is a separate workstream (task `020f423e`,
  spec `brain/tasks/specs/in-progress/sindustries-cloud-migration.md`).
  This ADR commits to the two-app shape, which both environments now use.
  The frontend half of the production decisions is finalised: the custom
  domain strategy and the prod Tasks API / Content Scheduler URLs are set
  and live (task `5044e708`, 2026-11-18 — see the production rows in
  `docs/cloud/production-blockers.md` and `infra/cloud/vercel-env-matrix.json`).
  The runtime cutover of the services and their callers remains open under
  task `020f423e`; the prod observability hooks are not finalised here.

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
