---
status: draft
task_id: ec42d3a1-2059-4ad6-bd1c-21e96dfc9135
product_spec: n/a (audit-driven: docs/repo-audits/2026-W29.md Theme 1 / Milestone 0-A)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: require sessions on budget-api routes

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W29.md` Theme 1 / Milestone 0-A
- Tech design: `docs/specs/cloud-readiness-budget-api-require-sessions-tech-design.md`
- Task: `ec42d3a1-2059-4ad6-bd1c-21e96dfc9135`
- Tasks API record: `http://localhost:4001/api/v1/tasks/ec42d3a1-2059-4ad6-bd1c-21e96dfc9135`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-ec42d3a1-cloud-readiness-budget-api-require-sessions`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none.

## Scope

`services/budget-api` non-`/me` routes currently trust `userId` from request body or query. Before cloud exposure, every authenticated route must derive the user from a validated session — never from the client.

This task adds a reusable `requireSession` middleware, applies it to all user-data routes, and refactors `/me` onto the same middleware so there is one auth path, not two.

## Ownership boundary

- Session validation is a `budget-api` concern. The shared session-hashing primitive already exists (`services/budget-api/src/auth/session.ts`); we reuse it rather than introducing a shared auth package now.
- We do **not** move auth into a separate service in this task. That would be over-engineering for current scope; flagged as a future boundary if multiple services need the same auth.

## Implementation plan

File/module scope:

- `services/budget-api/src/middleware/requireSession.ts` — new. Reads `Authorization: Bearer <token>`, hashes with the existing session-token logic (SHA-256 of the token), looks up `Session` via Prisma, rejects missing/invalid/expired sessions with 401. On success, attaches `req.session = { id, userId, expiresAt }` and calls `next()`.
- `services/budget-api/src/server.ts` — register `requireSession` on the user-data routers: `/akahu`, `/cards`, `/alerts`, `/transactions`, `/categories`, `/categorize`. Leave `/me` and `/health` unprotected so the refactor can attach session validation there explicitly.
- `services/budget-api/src/routes/me.ts` — refactor `/me` to derive `userId` from `req.session.userId`, not from a query param. Keep the response shape identical so the existing mobile app continues to work.
- `services/budget-api/src/routes/akahu.ts`, `cards.ts`, `alerts.ts`, `transactions.ts`, `categories.ts`, `categorize.ts` — strip every `userId` query/body field; the handlers now read `req.session.userId`. Returns 401 if middleware rejected.
- `services/budget-api/test/auth-contract.test.ts` — flip today's "documents the gap" tests to "expects 401 on unauthenticated user-data routes". Same-user tests stay green; cross-user tests move to the sibling ownership task.
- `services/budget-api/test/session-middleware.test.ts` — new. Covers: missing header → 401; malformed bearer → 401; expired session → 401; valid session → attaches `req.session.userId` and calls `next`.

## Data model / API contract

- No schema changes.
- API behavior change: every user-data route now requires `Authorization: Bearer <token>`. Requests without it return 401.
- The `/me` route accepts the same header; it no longer accepts a `userId` query param.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — `requireSession` middleware validates `Authorization: Bearer`, hashes, looks up `Session`, rejects with 401 | `session-middleware.test.ts` covers missing/malformed/expired/valid cases. |
| AC2 — `/akahu`, `/cards`, `/alerts`, `/transactions`, `/categories`, `/categorize` derive user from session, not body/query | `auth-contract.test.ts` and per-route tests assert 401 when no header and 200 when valid header; grep test confirms no `req.body.userId` / `req.query.userId` reads in those routers. |
| AC3 — `/me` behavior preserved or refactored onto the same middleware | `me.test.ts` covers valid bearer → 200 with same body; missing bearer → 401. |
| AC4 — `auth-contract.test.ts` flips from documenting gap to expecting 401 | PR diff shows the flip; CI enforces. |
| AC5 — budget-api tests + CI pass | CI matrix on push. |

User-visible ACs: AC2/AC3 are app-visible (the mobile app must send the new header). E2E: there is an existing `apps/budget-mobile` Playwright/e2e that hits `/me`; extend it to assert a 401 path on missing header, otherwise the user-visible contract is "if you sign in, it still works". The mobile app's existing bearer-token handling is reused — no client change required if it already sends `Authorization`.

## Open questions and risks

- **Existing tests with `userId` in body**: many tests today inject `userId` directly. We accept the one-time churn of rewriting them to mint a session instead. If churn is excessive, we can introduce a `withSession(userId)` test helper that mints a real session in the test DB.
- **Login flow**: `/session/dev-login` is the dev login route — it issues the bearer token. AC for the sibling rate-limit task already covers hardening that endpoint; this task just needs it to continue working.

## Linked audit

- `docs/repo-audits/2026-W29.md` — Theme 1 (Budget-API auth), Milestone 0-A, severity Critical.