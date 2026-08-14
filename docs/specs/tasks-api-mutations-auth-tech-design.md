---
status: draft
task_id: 0719a8e3-8502-4554-8080-77d53fe91514
product_spec: n/a (security task from repo-audit-2026-W33, tag `repo-audit-2026-w33`)
shipped_pr: null
shipped_date: null
---

# Tasks-api: authenticate mutations with existing user credentials

## Links

- Product spec: n/a — task is from the weekly repo audit (`repo-audit-2026-w33`); goal is "protect the current tasks-api mutation surface using the existing username/password authentication until Tasks moves to the cloud and adopts the shared cloud authentication system"
- Tech design: `docs/specs/tasks-api-mutations-auth-tech-design.md`
- Task: `0719a8e3-8502-4554-8080-77d53fe91514`
- Tasks API record: `http://localhost:4001/api/v1/tasks/0719a8e3-8502-4554-8080-77d53fe91514`
- Tags: `security`, `tasks-api`, `auth`, `repo-audit-2026-w33`
- Follow-up (cloud auth): task `206927ed-d851-47af-8864-0056487e0c4e` — "Define and secure production runtime configuration"
- Related sibling work: PR #316 (budget-api sessions middleware, task `ec42d3a1`), PR #341 (budget-api encrypted tokens, task `f1175b18`) — the same "browser session OR service credential" pattern was already adopted for budget-api; this task ports it to tasks-api for the broader mutation surface

## Problem statement

The tasks-api mutation surface is currently unauthenticated save for one carve-out (the approval endpoints). Today the API trusts `localhost`: any script on the same host can `POST /api/v1/tasks`, `PATCH /api/v1/tasks/:id`, `DELETE /api/v1/tasks/:id`, `POST /api/v1/tasks/:id/comments`, mutate `tags`, and mutate `content-scheduler/items` without credentials. The single existing identity claim — the `x-actor` header on content-scheduler writes — defaults to `"unknown"` and is caller-supplied, so it is not a real authentication signal.

A second gap is comment-author impersonation: `POST /api/v1/tasks/:id/comments` accepts `{ author, text }` with the author taken verbatim from the request body. Today nothing stops Tom from posting a comment credited as Quinn, and nothing stops a script from posting as Tom without a session.

The fix is a temporary username/password + service-credential boundary that mirrors the existing `approvalAuth.ts` pattern: the same `TASKS_API_APPROVAL_USERS` env (scrypt-hashed username/password list) plus an expanded `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` env that options per-agent actors. The middleware is the seam; the cloud-auth migration (task `206927ed`) replaces the credential-verification implementation behind that seam without touching the route handlers.

## Scope

In scope:

- `POST /api/v1/tasks` (create)
- `PATCH /api/v1/tasks/:id` (update)
- `DELETE /api/v1/tasks/:id` (archive)
- `POST /api/v1/tasks/:id/comments` (create — plus derive author from auth)
- `POST /api/v1/tags`, `PATCH /api/v1/tags/:id`, `DELETE /api/v1/tags/:id` (if present)
- `POST /api/v1/content-scheduler/items`, `PATCH /items/:id`, `POST /items/:id/approve`, `POST /items/:id/unapprove`, `POST /items/:id/publish`, `POST /items/:id/remove`, `POST /content-scheduler/reorder`
- `POST /api/v1/feature-task-analytics/events`
- Not yet gated today but analog writes to investigate: `POST /api/v1/required-approvals`, `PATCH /api/v1/required-approvals/:id`, `POST /api/v1/content-scheduler/imports/cto-craft`

Out of scope (deferred to cloud auth task `206927ed`):

- Replacing username/password with the shared cloud auth system
- LAN/network-level auth (the API still trusts `localhost`; only the application layer is being hardened)
- GET endpoints — read traffic stays open so dashboards, the agent task queue, and the tasks app ship without friction

## Current state

### Auth surface that exists today

- `POST /api/v1/auth/session` (`services/tasks-api/src/routes/approvalSessions.ts`) — verifies username/password against `TASKS_API_APPROVAL_USERS` (scrypt-hashed), creates an `ApprovalSession` row keyed by `tokenHash`, sets the `tasks_api_session` cookie (HttpOnly, SameSite=Lax, Secure in production).
- `requireApprovalPrincipal` middleware (`services/tasks-api/src/middleware/approvalAuth.ts`) — accepts either the session cookie OR a Bearer service credential from `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`, sets `req.approvalPrincipal = { actor, approvalTypes, kind }`. Currently only `taskApprovalsRouter` and `requiredApprovalsRouter` use it.
- `TASKS_API_APPROVAL_USERS` and `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` are parsed at module load; malformed config fails process boot.
- `x-actor` header on content-scheduler writes (`services/tasks-api/src/routes/contentScheduler.ts:54`) — currently the audit-trail signal, defaults to `"unknown"`. After auth, this becomes redundant with `req.user.actor` and should be derived from auth.
- `x-actor-secret` header gate on the content-scheduler publish path (`services/tasks-api/src/routes/contentScheduler.ts:348`) — layered defense, only active when `X_ACTOR_SECRET` is set. Stays unchanged.

### Comment-author impersonation

`POST /api/v1/tasks/:id/comments` (`services/tasks-api/src/routes/tasks.ts:558`) takes `{ author, text }` from the body and persists `author` verbatim. The author is then surfaced via `mapTaskComment` and `TaskComment.author` in the Prisma schema. Impersonation is undetectable after the fact.

### Trusted task-writing agents today (AC3 inventory)

| Agent | Mutating calls | Audit-trail actor today | Notes |
| --- | --- | --- | --- |
| `agents/workflows/bookmarks/scripts/lobster_create_tasks_from_proposals.py` | `POST /tasks`, `PATCH /tasks/:id` | no `x-actor`; defaults to `"unknown"` | Needs own service credential |
| `agents/workflows/content-tasks/scripts/common.py` (`AUTHOR = "Lobster"`) | `POST /tasks/:id/comments`, `PATCH /tasks/:id` | `Lobster` (body-supplied author) | Comment author must be derived from auth, not body |
| `agents/workflows/feature-task/src/main.rs` (approval writes) | already uses `TASKS_API_APPROVAL_TOKEN` (Bearer) | `Quinn` (approval service credential actor) | Approved; stays as-is |
| `agents/workflows/feature-task/src/analytics.rs` | `POST /feature-task-analytics/events` (idempotent) | `x-actor` header from the Rust call | Needs own service credential OR reuses parent |
| `agents/skills/ops/tasks-api/tasks_api_client.py` | arbitrary CRUD from terminals and agents | depends on caller | Caller supplies the credential; the client already supports `TASKS_API_APPROVAL_TOKEN` |
| `agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py` | GET only | n/a | Not a mutation; no change |
| Tasks app UI (browser) | POST/PATCH/DELETE via the app | session cookie | Already supported via `auth/session` + cookie |

The actor list will extend with two new entries for the agents that don't have one today: `bookmark_lobster` and `feature_task_lobster`. The `Lobster` actor for content-tasks stays as-is, but it moves from body-supplied to auth-derived.

## Architecture approach

### Source of truth for identity

The natural source of truth for "who is making this mutation" is the database-backed `ApprovalSession` cookie and the `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` env-driven service credentials. Today this surface is wired exclusively to the approval routes. The fix is to **widen the use of the existing identity primitive, not introduce a new one**. The username/password + service-credential mechanism is the temporary boundary; the middleware boundary is the seam.

Cross-cutting principle: do not introduce a second identity system. Use the same `cookie OR Bearer` parsing, the same `approvalSession` cookie name, the same `TASKS_API_APPROVAL_USERS` schema, and the same `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` schema. The cloud-auth migration (`206927ed`) will swap the credential-verification implementation in one place.

### New middleware: `requireAuthenticatedUser`

Add `requireAuthenticatedUser` to `services/tasks-api/src/middleware/`. It mirrors `requireApprovalPrincipal`:

- Parse the `tasks_api_session` cookie. If present and valid, look up the `ApprovalSession` row; on success set `req.user = { username, actor, kind: 'browser_session' }`.
- Else, parse `Authorization: Bearer <token>`. If the token matches a configured service credential, set `req.user = { actor, kind: 'service' }`.
- If neither succeeds, return `401 AUTH_REQUIRED` with a body like `{ error: { code: 'AUTH_REQUIRED', message: 'A valid session or service credential is required' } }`.
- The middleware never enforces a permission boundary; it only authenticates. Per-route authorization (e.g. "comments are allowed for any authenticated user") is the route's responsibility.

This is intentionally a near-clone of `requireApprovalPrincipal`. The pattern is `authenticate-then-route-handler`; the only seam that will be replaced by the cloud-auth migration is the credential verification function.

### Apply it to every mutation route

In `services/tasks-api/src/app.ts`, mount the middleware on the mutation paths via `app.use` ordering or per-router. The simplest expression is a path-prefix + method matcher:

```ts
const requireAuth = requireAuthenticatedUser();
app.use('/api/v1/tasks', (req, res, next) =>
  req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE' ? requireAuth(req, res, next) : next()
);
app.use('/api/v1/tags', (req, res, next) =>
  req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE' ? requireAuth(req, res, next) : next()
);
app.use('/api/v1/content-scheduler', (req, res, next) =>
  req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE' ? requireAuth(req, res, next) : next()
);
app.use('/api/v1/feature-task-analytics/events', (req, res, next) =>
  req.method === 'POST' ? requireAuth(req, res, next) : next()
);
```

GET requests stay open. Tests that already bypass auth via `createApp()` continue to work for read paths; only write paths need updated fixtures.

### Comment author derivation (AC2)

In `services/tasks-api/src/routes/tasks.ts:558`, replace the body-driven `author` lookup with the authenticated actor:

```ts
const author = req.user!.actor;                  // derived from auth; never body
const requestedAuthor = normalizeString(req.body?.author);
if (requestedAuthor && requestedAuthor !== author) {
  return sendError(res, 403, 'COMMENT_AUTHOR_FORBIDDEN',
    'author is derived from the authenticated session; body.author is ignored');
}
const text = normalizeString(req.body?.text);
if (!text) return badRequest(res, 'COMMENT_TEXT_REQUIRED', 'text is required');
```

This makes impersonation impossible: even if a caller sets `author: "Tom"`, the persisted author is `req.user.actor`. If a caller passes a *different* author than the authenticated one, the request is rejected with 403 (visible security signal instead of silent overwrite).

### Service credential per agent (AC3)

Each trusted agent gets its own service credential entry. The credential schema (already defined in `approvalAuth.ts`) is reused unchanged:

```json
[
  { "token": "<32+ chars>", "actor": "Quinn", "approvalTypes": ["tech_design"] },
  { "token": "<32+ chars>", "actor": "bookmark_lobster", "approvalTypes": [] },
  { "token": "<32+ chars>", "actor": "feature_task_lobster", "approvalTypes": [] },
  { "token": "<32+ chars>", "actor": "Lobster", "approvalTypes": [] }
]
```

Note the empty `approvalTypes` for the new write actors — that field is for `requireApprovalPrincipal`, not `requireAuthenticatedUser`. Empty is fine; the new middleware ignores it. The `.openclaw` boundary is the operational deployment of these credentials (Tom or Quinn provisions them in `.env`; agents read their own token from a per-agent env).

Update the call sites:

- `agents/workflows/bookmarks/scripts/lobster_create_tasks_from_proposals.py` — set `Authorization: Bearer $BOOKMARK_LOBSTER_TOKEN` (or rely on `tasks_api_client.api_request` which already reads `TASKS_API_APPROVAL_TOKEN` — rename the env to `TASKS_API_SERVICE_TOKEN` if cleaner, or keep the existing env and document which actor maps to it).
- `agents/workflows/content-tasks/scripts/common.py` — drop the `AUTHOR = "Lobster"` constant from `POST /tasks/:id/comments`; the API will derive the author. Continue to set `Authorization: Bearer $CONTENT_TASKS_TOKEN`.
- `agents/workflows/feature-task/src/analytics.rs` — add a `feature_task_lobster` Bearer credential and wire it into the request layer.

### x-actor header treatment

The `x-actor` header on content-scheduler writes was the audit-trail fallback. After auth, it is redundant. Plan:

- **Phase 1 (this task):** keep the `x-actor` header as an audit-trail redundancy. If the header is set, log a warning if it disagrees with `req.user.actor`. Do not reject on disagreement — the audit log is the safer place.
- **Phase 2 (cloud auth):** drop the header entirely and rely on `req.user.actor`.

### `x-actor-secret` header gate

The `x-actor-secret` header on the content-scheduler publish path stays as a layered defense. It is already only active when `X_ACTOR_SECRET` is set, and it applies to a single endpoint. No change.

### Browser session compatibility

The Tasks app UI already uses `POST /api/v1/auth/session` to log in (per `docs/systems/tasks.md:643`). The session cookie is accepted by `requireAuthenticatedUser` exactly as it is by `requireApprovalPrincipal`. No UI change is required.

### Dev mode behavior

When `TASKS_API_APPROVAL_USERS` and `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` are both empty (typical local dev), `requireAuthenticatedUser` will reject every mutation. Two options:

- **Recommended:** require at least one user OR service credential in dev. Log a loud warning at boot if both are empty. Force developers to set `TASKS_API_APPROVAL_USERS` for the local dev environment.
- **Alternative:** bypass auth entirely when `NODE_ENV !== 'production'` and both env vars are empty. Reject all mutations in production if both are empty.

This is **Open question 1**; see below.

## Data model / API contract changes

- No new Prisma models. The `ApprovalSession` row is reused as the session backing store.
- `TASKS_API_APPROVAL_USERS` — schema unchanged. New users may be added (e.g. a `rowan` user for the Tasks app; the existing `tom`/`quinn` users continue).
- `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` — schema unchanged. New entries for `bookmark_lobster`, `feature_task_lobster`, `Lobster` (content-tasks).
- `POST /api/v1/tasks/:id/comments` — `author` field in the response is now derived from the authenticated user. The request body may include `author` only if it matches the authenticated actor; mismatch is a 403.
- `x-actor` header on content-scheduler writes — accepted as before but ignored for the audit trail; the authenticated actor is authoritative. Documented in `docs/systems/tasks.md`.

## `.openclaw` boundary

This task does not require any `.openclaw` changes. Per-agent service tokens are deployed via the existing `.env` mechanism or a per-agent shell env. The `.openclaw` boundary is only touched if Rowan's heartbeat needs to surface a new prompt variable; it does not.

## Implementation plan

### File/module scope

Files to create:

- `services/tasks-api/src/middleware/requireAuth.ts` — the new middleware (or `sessions.ts`; see naming question below)
- `services/tasks-api/test/requireAuth.test.ts` — middleware unit tests
- `services/tasks-api/test/mutation-auth-integration.test.ts` — integration tests for each mutation route

Files to modify:

- `services/tasks-api/src/app.ts` — mount the middleware on the mutation paths
- `services/tasks-api/src/routes/tasks.ts` — fix the comment route to derive author; drop the body-supplied author
- `services/tasks-api/src/routes/tasks.ts` — apply middleware to `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`
- `services/tasks-api/src/routes/tasks.ts` — apply middleware to `POST /tasks/:id/comments`
- `services/tasks-api/src/routes/tags.ts` — apply middleware to `POST /tags`, `PATCH /tags/:id`, `DELETE /tags/:id`
- `services/tasks-api/src/routes/contentScheduler.ts` — apply middleware to all write paths; deprecate `x-actor` as audit-trail
- `services/tasks-api/src/routes/featureTaskAnalytics.ts` — apply middleware to `POST /events`
- `services/tasks-api/src/config/env.ts` — no schema change; ensure the existing config supports the new entries
- `services/tasks-api/src/lib/http.ts` — add a `sendError(res, 401, 'AUTH_REQUIRED', ...)` helper if not already present
- `agents/skills/ops/tasks-api/tasks_api_client.py` — generalize the credential env variable name and document the per-agent tokens
- `agents/workflows/bookmarks/scripts/lobster_create_tasks_from_proposals.py` — adopt the new service credential
- `agents/workflows/content-tasks/scripts/common.py` — drop `AUTHOR = "Lobster"` from the comment request; rely on auth
- `agents/workflows/feature-task/src/analytics.rs` — adopt the new service credential
- `docs/systems/tasks.md` — document the new auth boundary, the deprecation of `x-actor` as audit signal, and the migration path

### Workstream order

1. **Middleware skeleton + tests** (Rowan). Add `requireAuthenticatedUser`, unit tests for cookie-only, Bearer-only, neither, both, expired, revoked. Independent of any route.
2. **Route mounting** (Rowan). Wire the middleware in `app.ts` and start skipping auth on existing tests where appropriate (mark those tests as needing credentials).
3. **Comment author derivation** (Rowan). Fix `POST /tasks/:id/comments`. Update content-tasks caller.
4. **Per-agent service credentials** (Rowan + Quinn). Provision tokens for `bookmark_lobster`, `feature_task_lobster`, `Lobster` (content-tasks). Update call sites.
5. **Integration tests** (Rowan). `mutation-auth-integration.test.ts` covers each gated route with auth success, missing auth, invalid auth, and comment-author impersonation.
6. **Docs** (Rowan). Update `docs/systems/tasks.md` to reflect the new boundary and the migration path.

### Naming question

Internet latency/import name: `requireAuthenticatedUser` vs. `requireAuth` vs. `requireSession`. The existing convention is `requireApprovalPrincipal`. Recommend `requireAuthenticatedUser` for clarity; the path is short and the existing-approval middleware is named after its principal.

## Test plan (AC verification matrix)

| AC | Test layer | Coverage |
| --- | --- | --- |
| AC1 — POST/PATCH/DELETE require valid credentials | integration | `mutation-auth-integration.test.ts` covers each of `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `POST /tags`, `POST /content-scheduler/items`, `PATCH /items/:id`, etc. Assertions: no auth → 401, wrong Bearer → 401, missing cookie → 401, valid session → 200/201, valid Bearer → 200/201. |
| AC2 — comment author is derived from auth | integration | `mutation-auth-integration.test.ts` plus a focused test in `tasks.test.ts` (or `comments.test.ts` if it exists). Cases: (a) no body.author → comment author = `req.user.actor`; (b) body.author = `req.user.actor` → accepted; (c) body.author ≠ `req.user.actor` → 403 `COMMENT_AUTHOR_FORBIDDEN`. |
| AC3 — trusted agents inventoried and updated | integration + manual | Each agent has an integration test that authenticates with its own service credential and successfully performs the mutation it performs today. Also a `docs/systems/tasks.md` section listing the actor-to-process mapping. |
| AC4 — automated tests cover auth success/rejection/forged-author | integration | Cross-cuts the prior three; the test file is the single artifact. Edge cases: expired session, revoked session, wrong credential, malformed Bearer header, missing scheme prefix. |
| AC5 — tech design documents username/password boundary + cloud migration | docs | This document is the deliverable. The migration path is the "Open questions" answered and the "Phase 2" section in `docs/systems/tasks.md`. |

### E2E coverage

The user-visible AC is "the Tasks app UI cannot perform a mutation without first logging in via `auth/session`." The existing `tasks app e2e (ui + api + db)` CI job already exercises the full login → create → patch → comment flow. Run that job against the new middleware and confirm green. Add a single explicit E2E test that asserts the unauthenticated path is rejected (the existing tests authenticate via UI, so they implicitly prove the auth path; the new test asserts the unauthenticated path now 401s).

### Lower-layer fallback

Auth behavior is a middleware contract, not a UI behavior. Unit tests on the middleware plus integration tests on each route are sufficient — there is no per-page UI surface to test. E2E is a confidence check, not a primary coverage layer.

## Migration path (AC5)

Phase 2 (cloud auth, task `206927ed`) replaces the credential-verification implementation behind `requireAuthenticatedUser` without changing the route handlers. The seam is the function that resolves `req.user` from the request. Today:

```ts
// services/tasks-api/src/middleware/requireAuth.ts (Phase 1)
async function authenticate(req: Request): Promise<User | null> {
  // 1. Try tasks_api_session cookie → ApprovalSession row
  // 2. Try Authorization Bearer → TASKS_API_APPROVAL_SERVICE_CREDENTIALS
  // 3. Return null
}
```

Phase 2 swaps the body of `authenticate` for a call to the shared cloud auth library:

```ts
// Phase 2
async function authenticate(req: Request): Promise<User | null> {
  return await cloudAuth.verify(req); // talks to the shared cloud auth system
}
```

The route handlers, the cookie name, the `Authorization` header shape, and the `TASKS_API_APPROVAL_USERS` env all become bridge-glue during the cutover. The middleware boundary is the only thing callers depend on.

Concrete migration steps:

1. Provision per-agent identities in the shared cloud auth system (mirroring `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`).
2. Deploy a phase-2 `authenticate` that accepts both the temporary cookie/Bearer and the cloud auth token.
3. Roll agents over one at a time, swapping their token source.
4. Drop the cookie/Bearer fallback once the agents are migrated.
5. Remove the temporary `TASKS_API_APPROVAL_USERS` env.

This is identical to the budget-api migration (PR #316 → future cloud auth work) and reuses the same playbook.

## Open questions and risks

1. **Dev mode behavior.** When `TASKS_API_APPROVAL_USERS` and `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` are both empty, do we hard-fail or auto-bypass? Recommend hard-fail with a clear log message naming the env vars to set. The bypass choice is too easy to leave enabled in production. **Needs Quinn's call.**
2. **GET endpoints.** ACs mention POST/PATCH/DELETE only. Confirmed: GETs stay open. If a future audit demands GET gating, that's a separate task — `tasks_api_client.py` is called by many reads-only paths that would all need updating.
3. **`x-actor` header treatment.** Keep as audit-trail redundancy (Phase 1) and drop (Phase 2)? Confirmed above.
4. **Per-agent token distribution.** Quinn provisions tokens via `.env` or per-agent env. Recommend per-agent env so each agent only knows its own token. **Needs Quinn's operational preference.**
5. **`tasks_api_client` env naming.** Today the client reads `TASKS_API_APPROVAL_TOKEN`. Rename to `TASKS_API_SERVICE_TOKEN` for clarity, or keep the existing name and document the actor mapping? Keeping the existing name avoids a breaking change for everyone who already sets it. **Recommend: keep the existing env name; document the actor mapping in `docs/systems/tasks.md`.**
6. **`x-actor` header mismatch on content-scheduler writes.** If a script sets `x-actor: Tom` but authenticates as `Rowan`, do we reject? Recommend: log a warning, accept the request, use `req.user.actor` for the audit field. That gives operators a signal to clean up the script without breaking the flow during the migration window.
7. **Password rotation.** `TASKS_API_APPROVAL_USERS` is parsed at module load. Rotating a password requires a process restart. Phase 2 should address this properly; for Phase 1, document the restart requirement.
8. **`ApprovalSession` reuse.** The user's session for `/auth/session` is currently typed as an approval session. After this task, the same session gates both approvals and general mutations. The cookie name and table are reused; the actor is the same. Acceptable for the temporary boundary.

## Risks

- **Trust-localhost assumption.** The API still trusts `localhost`. This task is application-layer hardening; LAN exposure is a separate concern. The `tasks-api` is currently `127.0.0.1` only on the dev plane (per `services/tasks-api/src/config/env.ts` defaults); exposure is a deployment question, not a code question.
- **Adapter change.** The opener may discover that some existing tests rely on unauthenticated mutation paths. The integration test pass should catch these, but the task `0719a8e3` description already requires it ("automated tests cover authenticated mutation success, unauthenticated rejection, invalid-credential rejection, and forged comment-author rejection"), so this is in scope.
- **Migration to `x-actor` header treatment.** Phase 2 must drop the header. This is a breaking change for any external script that sets `x-actor` and depends on it being persisted. None known today, but call this out in the cloud-auth task.

## `.openclaw` follow-up

None. Service tokens are env-driven; their deployment is operational, not `.openclaw`.

## Acceptance criteria mapping

| AC | Where it is verified in this design |
| --- | --- |
| AC1 — POST/PATCH/DELETE reject without valid credentials | "Apply it to every mutation route" + "Workstream order" step 2 + test plan row 1 |
| AC2 — comment author is derived from auth | "Comment author derivation (AC2)" + test plan row 2 |
| AC3 — trusted agents inventoried and updated with own credentials | "Service credential per agent (AC3)" + "Trusted task-writing agents today" + workstream step 4 + test plan row 3 |
| AC4 — automated tests cover auth success/rejection/forged-author | test plan rows 1–4 |
| AC5 — tech design documents temporary boundary + cloud migration path | This document + "Migration path" section + `docs/systems/tasks.md` update |
