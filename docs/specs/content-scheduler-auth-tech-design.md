---
status: draft
task_id: bd755ad4-314e-410d-84ec-0083178a7ea2
product_spec: n/a (security task from repo-audit-2026-W36, tag `repo-audit-2026-w36`)
shipped_pr: null
shipped_date: null
---

# Content-scheduler-api: authenticate mutations with service credentials

## Links

- Product spec: n/a — task is from the weekly repo audit (`repo-audit-2026-w36`); goal is "wire `requireAuthenticatedUser` into `content-scheduler-api` so that `actor()` reads an authenticated identity rather than falling through to the client-supplied `x-actor` header, before any `[http_service]` Fly app exposes the write surface."
- Tech design: `docs/specs/content-scheduler-auth-tech-design.md`
- Task: `bd755ad4-314e-410d-84ec-0083178a7ea2`
- Tasks API record: `http://localhost:4001/api/v1/tasks/bd755ad4-314e-410d-84ec-0083178a7ea2`
- Audit finding: `docs/repo-audits/2026-W36.md` finding **A1** (PR #546, merged 2026-08-31)
- Prior carryover: W35 finding #2 ("audit 2026-W35 T1.2") referenced in `src/routes/contentScheduler.ts:59` and the `.skip`ed test at `test/contentScheduler.test.ts:437`; originally tracked as task `0719a8e3` in code/test text — that comment predates the Tasks API record. The current task supersedes the code-comment reference.
- Sibling pattern: `docs/specs/tasks-api-mutations-auth-tech-design.md` (task `0719a8e3`) — same shape, same "browser session OR service credential" primitive, applied to tasks-api mutations
- Sibling pattern: PR #316 (budget-api sessions middleware, task `ec42d3a1`), PR #341 (budget-api encrypted tokens, task `f1175b18`) — already adopted for budget-api; this task ports the pattern to content-scheduler-api
- Follow-up (cloud auth): task `206927ed-d851-47af-8864-0056487e0c4e` — "Define and secure production runtime configuration" — the seam is the middleware boundary; the credential-verification implementation can be swapped without touching route handlers

## Problem statement

`content-scheduler-api`'s HTTP `createApp` (`services/content-scheduler-api/src/app.ts:63-110`) mounts every write route with **no authentication middleware**. Only helmet, CORS, JSON parsing, a rate-limit on `publish`, and shared-secret gates on `publish` (`x-actor-secret` → `X_ACTOR_SECRET`) and `imports/cto-craft` (`x-content-ingest-secret` → `CONTENT_SCHEDULER_INGEST_SECRET`) are present.

The `actor()` helper (`src/routes/contentScheduler.ts:58-77`) prefers `req.user?.actor` (authoritative) over the client-supplied `x-actor` header (audit-only). Nothing populates `req.user`, so the helper falls through to `x-actor` — meaning `approvedBy` on an approval is attacker-chosen. The code comment at `routes/contentScheduler.ts:59` ("After the requireAuthenticatedUser middleware (task 0719a8e3)") and the `.skip`ed test at `test/contentScheduler.test.ts:437` ("gated on audit 2026-W35 T1.2 requireAuthenticatedUser") both confirm the middleware was planned and never landed.

A second effect: `POST /api/v1/content-scheduler/items/:id/approve` (and the other write paths) accept `x-actor` as the audit-trail actor for the `approvedBy` column on `ContentSchedulerItem`. Until the middleware lands, that column is unauthenticated.

**Severity is High-latent, not live-Critical**: the HTTP `createApp` is not Fly-deployed today (only the headless BullMQ worker is, via `auto-post-worker.fly.toml` without an `[http_service]`). Exposure today is localhost / prodlike. It becomes Critical the moment a `content-scheduler-api` Fly app with `[http_service]` is added. The audit's Open Question 2 ("when is `content-scheduler-api` scheduled to get its own HTTP Fly app?") makes the timing of that exposure the trigger for this fix.

The fix is a **near-clone of the tasks-api mutation-auth pattern**: a `requireAuthenticatedUser` middleware that authenticates the request via `Authorization: Bearer <token>` matched against a new `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` env var, sets `req.user = { actor, kind }`, returns `401 AUTH_REQUIRED` on failure. No new identity primitive; no new credential store shape; the cloud-auth migration (`206927ed`) replaces the credential-verification implementation behind this middleware seam.

## Scope

In scope:

- `POST /api/v1/content-scheduler/items` (create)
- `PATCH /api/v1/content-scheduler/items/:id` (edit body / scheduledFor / source / sourceRef / kind / linksToItemId)
- `POST /api/v1/content-scheduler/items/:id/approve` (mark approved + enqueue)
- `POST /api/v1/content-scheduler/items/:id/unapprove` (clear approval + cancel auto-post)
- `POST /api/v1/content-scheduler/items/:id/remove` (soft-delete + cancel auto-post)
- `POST /api/v1/content-scheduler/reorder` (rewrite positions from an id list)

Out of scope (existing shared-secret gates stay as-is):

- `POST /api/v1/content-scheduler/items/:id/publish` — already gated by `x-actor-secret` matching `X_ACTOR_SECRET` (`src/routes/contentSchedulerPublish.ts`). Service-to-service trigger from the auto-post-worker; the shared secret is the gate. Layered defense (Bearer auth too) is a Phase-2 call — see Open Questions.
- `POST /api/v1/content-scheduler/imports/cto-craft` — already gated by `x-content-ingest-secret` matching `CONTENT_SCHEDULER_INGEST_SECRET`. CTO Craft pipeline → cto-craft import. Stays as-is.
- `GET /api/v1/content-scheduler/items`, `GET /api/v1/content-scheduler/items/:id`, `GET /api/v1/content-scheduler/today-status` — read traffic stays public (no auth required) so the tasks-app Content Scheduler tab and any future dashboard ship without friction. See "Auth matrix" below.
- `GET /api/v1/content-scheduler/health`, `GET /health` — public probes.
- Browser session auth (`tasks_api_session` cookie equivalent for content-scheduler-api) — deferred to Phase 2 (cloud auth). The current call paths are server-to-service or local-dev only; a username/password flow is not justified for Phase 1. The middleware boundary is the seam; Phase 2 adds cookie parsing without changing route handlers.

Out of scope (deferred to cloud auth task `206927ed`):

- Replacing service credentials with the shared cloud auth system
- LAN / network-level auth (the API still trusts `localhost`; only the application layer is being hardened)
- Per-actor permission policy refinement beyond "any authenticated actor can call any gated mutation" — the audit's task description explicitly says the Phase-1 fix widens the existing identity primitive, not introduces a permission system

## Current state

### Auth surface that exists today

- `requireAuthenticatedUser` middleware exists for tasks-api (`services/tasks-api/src/middleware/requireAuth.ts`) — accepts either `tasks_api_session` cookie OR `Authorization: Bearer <token>`, parses `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` at module load (fail-fast on malformed JSON), sets `req.user = { actor, kind }`. Currently only the tasks-api mutation routers use it.
- `x-actor` header on content-scheduler writes (`src/routes/contentScheduler.ts:64-77`) — currently the audit-trail signal, defaults to `"unknown"`. After auth, this becomes redundant with `req.user.actor` and is kept only as an audit-trail comparison (helper logs a `console.warn` when `x-actor` disagrees with the authenticated actor).
- `x-actor-secret` header gate on the content-scheduler publish path (`src/routes/contentSchedulerPublish.ts`) — layered defense, only active when `X_ACTOR_SECRET` is set. Stays unchanged in Phase 1.
- `x-content-ingest-secret` header gate on `imports/cto-craft` (`src/routes/contentSchedulerImport.ts`) — only active when `CONTENT_SCHEDULER_INGEST_SECRET` is set. Stays unchanged in Phase 1.
- Rate limit on `/items/:id/publish` (`src/app.ts:88-91`) — stays unchanged.

### `.skip`ed regression test

`test/contentScheduler.test.ts:437` — `it.skip('POST /content-scheduler/items/:id/approve sets approvedAt + approvedBy [gated on audit 2026-W35 T1.2 requireAuthenticatedUser]')` — already wired with `authedRequest(app)` (`test/helpers/auth.ts:24`) which injects the `IntegrationTest` Bearer credential. The test asserts `approvedBy: 'IntegrationTest'` even when the `x-actor` header is set to a different value, and expects a warn log about the header mismatch. **Un-skip is mechanical once the middleware lands.**

### Test helper already in place

`test/helpers/auth.ts` already exists with `authedRequest(app)` injecting the `IntegrationTest` Bearer token. The file's leading comment explicitly notes the middleware isn't mounted yet: "the extracted Content Scheduler service does not yet mount a `requireAuthenticatedUser` gate (see audit 2026-W35 finding T1.2), so this header is currently a no-op for these tests." All `contentScheduler*.test.ts` suites already use `authedRequest(app)` for their mutation assertions, so the test rewrite is "remove the `.skip`" plus a handful of new "returns 401 without Bearer" tests.

### Trusted task-writing actors today (Phase-1 inventory)

| Actor | Calls into content-scheduler-api | Auth today | After this PR |
| --- | --- | --- | --- |
| Tasks app UI (browser, Tom) | `POST/PATCH/.../approve/.../remove/.../reorder` from the Content Scheduler tab | none (host = localhost) | `tasks_app_browser` service credential (long-lived Bearer tied to a service principal) |
| Auto-post worker (Fly `auto-post-worker` app) | calls `processAutoPostJob` directly (BullMQ consumer), no HTTP | n/a — separate process, no API call | n/a — still no HTTP path |
| CTO Craft LangGraph (X draft pipeline, task `9dfe56e4`) | `POST /imports/cto-craft` | `x-content-ingest-secret` shared secret | unchanged — separate gate, different trust boundary |
| Agent / terminal direct (e.g. rowan running scripts from this workspace) | `POST/PATCH/approve/remove` via `tasks_api_client.py`-style helpers | none | depends on caller-supplied credential |
| Future `content-scheduler-api` Fly HTTP app (when `[http_service]` ships) | all browser-driven write paths | (currently nothing) | Bearer required |

The Phase-1 minimum credential set is **one service credential per trusted actor**: `tasks_app_browser`, `rowan`, and any future agent that needs to script writes. The auto-post worker doesn't need one because it doesn't hit HTTP.

## Architecture approach

### Source of truth for identity

The natural source of truth for "who is making this write" is the same `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` shape that tasks-api uses, scoped under a **new** env var `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS`. We do **not** reuse `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` directly because:

1. **Service boundary**: content-scheduler-api owns its own Prisma schema (`content_scheduler`); its deployment lifecycle is independent (Fly app, scaling, secret rotation). Sharing the env var forces a coordinated rotation and a shared parse failure mode across both services.
2. **Independent revocation**: rotating `tasks-api` credentials must not silently rotate `content-scheduler-api` credentials, and vice versa.
3. **Schema is reusable, env var name is not**: the `[{ token, actor, approvalTypes }]` shape is shared; only the env var name differs. The middleware is a near-clone of `tasks-api`'s `requireAuthenticatedUser` — same parser, same `tokenHash` / `timingSafeEqual` crypto, same `req.user = { actor, kind: 'service' }` shape.

The Phase-1 boundary is the **middleware**. The credential-verification implementation (Phase 2 cloud auth, task `206927ed`) replaces the token-matching logic behind `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` without touching route handlers.

### Auth matrix (Phase-1)

| Route | Method | Auth required | Why |
| --- | --- | --- | --- |
| `/health` | GET | none | probe |
| `/api/v1/health` | GET | none | probe |
| `/api/v1/content-scheduler/items` | GET | none | read; tasks app reads it |
| `/api/v1/content-scheduler/items/:id` | GET | none | read |
| `/api/v1/content-scheduler/today-status` | GET | none | read |
| `/api/v1/content-scheduler/items` | POST | **Bearer required** | write — audit trail actor |
| `/api/v1/content-scheduler/items/:id` | PATCH | **Bearer required** | write |
| `/api/v1/content-scheduler/items/:id/approve` | POST | **Bearer required** | write — `approvedBy` |
| `/api/v1/content-scheduler/items/:id/unapprove` | POST | **Bearer required** | write |
| `/api/v1/content-scheduler/items/:id/remove` | POST | **Bearer required** | write |
| `/api/v1/content-scheduler/reorder` | POST | **Bearer required** | write |
| `/api/v1/content-scheduler/items/:id/publish` | POST | `x-actor-secret` shared secret | service-to-service (worker) |
| `/api/v1/content-scheduler/items/:id/posted-url` | PATCH | **Bearer required** | write (manual_reply capture) |
| `/api/v1/content-scheduler/imports/cto-craft` | POST | `x-content-ingest-secret` shared secret | service-to-service (CTO Craft) |

GETs stay public to keep the Content Scheduler tab shipping without an auth flow in the browser. This is a **deliberate Phase-1 trade-off**: read traffic reveals `body` / `scheduledFor` / `approvedBy` to anyone with network access. The audit's "match the existing tasks-api auth pattern" guidance explicitly accepts this for Phase 1; Phase 2 (cloud auth, task `206927ed`) adds per-actor policy and likely tightens the read surface.

### Mount point in `createApp`

`requireAuthenticatedUser` mounts as Express middleware **on the `contentSchedulerRouter` write paths only**, not on the whole `/api/v1` prefix. The cleanest implementation is a sub-router:

```ts
// src/app.ts (sketch — Phase 1 PR)
import { requireAuthenticatedUser } from './middleware/requireAuth.ts';

const writeGated = express.Router();
writeGated.use(requireAuthenticatedUser);
writeGated.use(contentSchedulerWriteRouter);
app.use('/api/v1/content-scheduler', writeGated);

const readOpen = express.Router();
readOpen.use(contentSchedulerReadRouter);
app.use('/api/v1/content-scheduler', readOpen);
```

Where `contentSchedulerWriteRouter` and `contentSchedulerReadRouter` are subsets of the current `contentSchedulerRouter`. This split keeps the mount point explicit and avoids accidentally gating the shared-secret routes (`publish`, `imports`) behind a Bearer requirement.

Alternative considered: `app.use('/api/v1', requireAuthenticatedUser)` before the routers, with per-route `@skip` annotations on the shared-secret routes. Rejected because:

1. It puts auth in front of every shared-secret gate, making the trust boundaries ambiguous (which secret wins on conflict?).
2. It assumes a per-route skip mechanism in Express; sub-router split is more reviewable.

### Middleware shape

```ts
// src/middleware/requireAuth.ts (sketch)
export type MutationUser =
  | { actor: string; kind: 'service' };

declare global {
  namespace Express {
    interface Request {
      user?: MutationUser;
    }
  }
}

type ServiceCredential = { token: string; actor: string };

export async function requireAuthenticatedUser(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const credential = match
    ? SERVICE_CREDENTIALS.find((c) => tokenMatches(match[1], c.token))
    : null;
  if (!credential) {
    return sendError(res, 401, 'AUTH_REQUIRED', 'A valid service credential is required');
  }
  req.user = { actor: credential.actor, kind: 'service' };
  return next();
}
```

Near-clone of `services/tasks-api/src/middleware/requireAuth.ts` with two Phase-1 simplifications:

- **No cookie session**: Phase 1 doesn't add browser session auth. Cookie parsing is Phase 2.
- **`approvalTypes` removed**: the tasks-api service credential schema carries `approvalTypes: string[]` because tasks-api mixes identity with permission gates (approval writes). content-scheduler-api has no equivalent permission gates — any authenticated actor can call any gated mutation route — so the schema is `[{ token, actor }]`.

`actor()` in `src/routes/contentScheduler.ts:58-77` already prefers `req.user.actor`; **no `actor()` change is required** once the middleware populates `req.user`. The only observable change is that the `if (headerValue && authenticated && headerValue !== authenticated) console.warn(...)` branch now fires in tests where `x-actor` disagrees with the Bearer actor.

### Env var contract

```
CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS='[
  {"token":"<openssl rand -hex 32>","actor":"tasks_app_browser"},
  {"token":"<openssl rand -hex 32>","actor":"rowan"},
  {"token":"integration-test-token-long-enough","actor":"IntegrationTest"}
]'
```

- Schema parsed at module load; malformed JSON fails process boot (same fail-fast pattern as tasks-api).
- Token min length 16 chars (matches tasks-api).
- `integration-test-token-long-enough` / `actor: IntegrationTest` is the seeded credential that `authedRequest(app)` (`test/helpers/auth.ts:6`) already sends. The test helper is already in place — adding the env-var entry makes the existing test suite run green, with `.skip` removed on the regression test.

`CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` is parsed via `zod`'s JSON-string schema in `src/config/env.ts` (same pattern as `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` in `services/tasks-api/src/config/env.ts:65-66`).

### Test surface changes

1. **Un-skip the regression test** (`test/contentScheduler.test.ts:437`) — remove `.skip`, confirm it asserts `approvedBy: 'IntegrationTest'` and the warn log fires.
3. **Add a "returns 401 without Bearer" test** for each gated write route (six tests; cheap; uses plain `request(app)` not `authedRequest(app)`). This is the "red without middleware" guard AC4 calls for.
4. **Add a "401 on unknown Bearer" test** — wrong token returns 401 with `AUTH_REQUIRED` body shape.
5. **Confirm the existing read-route tests stay green** without changes (GETs stay public).
6. **Confirm the `publish` / `imports/cto-craft` shared-secret tests stay green** without Bearer (existing tests use `process.env.X_ACTOR_SECRET` / `CONTENT_SCHEDULER_INGEST_SECRET` injection).

### Configuration rollout

`CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` is unset today (default `[]`). When unset, `SERVICE_CREDENTIALS` is empty and `requireAuthenticatedUser` returns 401 on every request. This is the **desired fail-closed default** for a service that is about to be exposed. The audit's "High-latent → Critical when `[http_service]` ships" framing means the credential must be configured *before* the Fly app is added, not after.

For Phase 1, the credential set is populated:

- In local dev: `.env` for content-scheduler-api (matches the existing `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` rollout pattern)
- In CI: the vitest job's `setup.ts` seeds the IntegrationTest credential (matches `services/tasks-api/test/setup.ts`)
- In Fly: secret injection at deploy time (matches the budget-api sessions rollout in PR #316)

### Out-of-scope items explicitly deferred

- **Browser session / cookie auth**: Phase 2 (cloud auth, task `206927ed`). Phase 1 is service-credential-only.
- **Permission policy per actor**: not in scope. Any authenticated actor can call any gated mutation route. Per-actor policy is a Phase-2 decision and requires a real permission model (the tasks-api `ACTOR_PERMISSIONS` table is approval-specific and doesn't translate directly).
- **Read-route gating**: not in scope. GETs stay public.
- **`x-actor` header removal**: not in scope. Kept as audit-only metadata. The `actor()` helper already prefers `req.user.actor`; the header disagreement path logs a warn. Removal is Phase 2 once every caller is authenticated.
- **Layered Bearer on `publish` / `imports`**: not in scope. The existing shared-secret gates stay. Adding Bearer on top is a Phase-2 call (the worker would need a credential).

## Open Questions

1. **When does the `content-scheduler-api` Fly `[http_service]` ship?** This PR converts A1 from High-latent to landable. The deploy must include `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` in the Fly secrets. Is there a WS milestone for the HTTP Fly app?
2. **Should `publish` add a Bearer check on top of `x-actor-secret`?** The shared secret is enough for the worker-to-API trust boundary, but a defense-in-depth Bearer check makes a stolen `X_ACTOR_SECRET` less catastrophic. Defer to Phase 2 unless the worker credential is cheap to add now.
3. **Who owns the `tasks_app_browser` service credential?** Phase 1 needs at least one credential populated so the existing browser-driven write paths don't 401 the moment this lands. Concretely: does the tasks-app Content Scheduler tab have a backend-issued service credential today (e.g. injected at build time by the tasks app's deploy), or do we need to add one?
4. **Should `IntegrationTest` be the only seeded credential in CI, or do we also want per-test impersonation** (e.g. test that one actor's approval cannot be unapproved by a different actor)? Audit's AC list doesn't require per-actor policy, so the answer is "no, Phase 1 is identity-only." Surfacing here so Phase 2 picks it up.

## Acceptance Criteria mapping

| AC | Where it lands | Verification |
| --- | --- | --- |
| AC1 — middleware in place, populates `req.user` | `src/middleware/requireAuth.ts`, `src/app.ts` mount point | unit test asserts `req.user` after `requireAuthenticatedUser` for valid Bearer; 401 otherwise |
| AC2 — write routes return 401 without auth | per-route sub-router split | six "401 without Bearer" tests + six "200 with authedRequest" tests |
| AC3 — `approvedBy` reflects authenticated identity | `actor()` helper (no change; relies on `req.user.actor`) | `.skip`ed regression test at `test/contentScheduler.test.ts:437` un-skipped; asserts `approvedBy: 'IntegrationTest'` when `x-actor: 'Tom'` |
| AC4 — `.skip`ed test green with middleware, red without | same regression test, run twice | vitest run with middleware: green; comment-out mount: red (manual verification only — Phase 1 ships the green case) |
| AC5 — tech design committed and reviewed | this doc | PR open, Quinn approval gate (`tech_design` approval) flips to `approved` |

## Implementation sketch

1. Add `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` (zod JSON-string schema) to `services/content-scheduler-api/src/config/env.ts`. Parsed at module load; malformed fails process boot.
2. Add `services/content-scheduler-api/src/middleware/requireAuth.ts` — near-clone of `services/tasks-api/src/middleware/requireAuth.ts` minus the cookie path and the `approvalTypes` field. Export `MutationUser`, mount `requireAuthenticatedUser` with the same `sendError(res, 401, 'AUTH_REQUIRED', …)` shape as tasks-api.
3. Split `src/routes/contentScheduler.ts` into `contentSchedulerWriteRouter` and `contentSchedulerReadRouter` (or add a per-route `requireAuthenticatedUser` call inside the existing router — see Open Question on Express ergonomics). Phase 1 PR picks whichever is smaller to review; both end up with the same test outcome.
4. Mount the write sub-router (or per-route guards) in `src/app.ts` ahead of `contentSchedulerRouter` — see "Mount point in `createApp`" above.
5. Un-skip the regression test (`test/contentScheduler.test.ts:437`).
6. Add the six "401 without Bearer" tests + the "401 on unknown Bearer" test.
7. Update `docs/specs/cloud-deployment-foundation-tech-design.md` (if it exists) or `infra/cloud/fly/content-scheduler-api.fly.toml` (when the HTTP app is added) to require `CONTENT_SCHEDULER_API_SERVICE_CREDENTIALS` in the Fly secrets.