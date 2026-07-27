---
status: draft
task_id: f39a20a7-8eeb-42cb-9a3c-fced84754ad6
product_spec: n/a (audit-driven: docs/repo-audits/2026-W29.md Theme 1 / Milestone 1-B)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: add budget-api ownership checks

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W29.md` Theme 1 / Milestone 1-B
- Tech design: `docs/specs/cloud-readiness-budget-api-ownership-tech-design.md`
- Task: `f39a20a7-8eeb-42cb-9a3c-fced84754ad6`
- Tasks API record: `http://localhost:4001/api/v1/tasks/f39a20a7-8eeb-42cb-9a3c-fced84754ad6`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f39a20a7-cloud-readiness-budget-api-ownership`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none.

## Scope

After sessions middleware lands (task `ec42d3a1`), `services/budget-api` still has an IDOR risk: authenticated users can pass any `cardId`, `alertId`, or `transactionId` in the URL and read/mutate resources owned by other users. This task adds an ownership check layer that verifies the path-parameter resource belongs to the session user before any handler runs.

This is purely an authorization hardening pass. It does not change request/response shapes; it only short-circuits cross-user access with 403.

## Ownership boundary

- Authorization is a `budget-api` concern. The session middleware (sibling task) provides `req.session.userId`; this task provides the per-resource check helpers.
- We introduce a small `requireOwnership(resourceLoader)` factory in `services/budget-api/src/middleware/requireOwnership.ts` that takes a loader (`(req) => Promise<{ ownerId: string } | null>`) and either attaches the loaded resource to `req` for the handler or returns 403.
- We deliberately do **not** introduce a generic policy DSL or ABAC engine. The check is "the resource's ownerId must equal req.session.userId" — anything more is premature.

## Implementation plan

File/module scope:

- `services/budget-api/src/middleware/requireOwnership.ts` — new. `requireOwnership(loader)` returns Express middleware. Loads via `loader(req)`; if null → 404 (don't reveal existence); if `ownerId !== req.session.userId` → 403 with `{ error: "forbidden" }` and no resource leakage; otherwise attaches resource to `req.resource` and calls `next()`.
- `services/budget-api/src/middleware/loaders.ts` — new. Exports `loadCardById(cardId)`, `loadAlertById(alertId)`, `loadTransactionById(transactionId)`. Each returns `{ ownerId } | null`. Implemented against the existing Prisma client.
- `services/budget-api/src/routes/cards.ts` — apply `requireOwnership(loadCardById)` to:
  - `GET /cards/:cardId/alert-config`
  - `POST /cards/:cardId/alert-config`
  - `DELETE /cards/:cardId/alert-config`
  - card summary and budget routes that take `:cardId`
- `services/budget-api/src/routes/alerts.ts` — apply `requireOwnership(loadAlertById)` to `DELETE /alerts/:alertId`.
- `services/budget-api/src/routes/transactions.ts` — apply `requireOwnership(loadTransactionById)` to `PATCH /transactions/:transactionId/category`.
- `services/budget-api/test/auth-contract.test.ts` — replace today's "documents the gap" expectations with positive assertions: same-user → 200; cross-user → 403; unknown id → 404.
- `services/budget-api/test/ownership.test.ts` — new. Table-driven cases per route family: same-user success, cross-user 403, unknown id 404, response body never leaks other-user fields.

## Data model / API contract

- No schema changes.
- API behavior change: routes listed in AC1–AC3 now return 403 (or 404 for unknown ids) instead of 200/4xx-via-missing-row when the resource belongs to another user.
- Response bodies for 403: `{ error: "forbidden" }`. No leakage of resource shape, owner, or any field beyond what the error code conveys.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — card alert-config + summary/budget routes verify card belongs to session user | `ownership.test.ts` covers all four routes; same-user 200, cross-user 403, unknown 404. |
| AC2 — `DELETE /alerts/:alertId` verifies alert ownership | Same test file, alerts table. |
| AC3 — `PATCH /transactions/:transactionId/category` verifies transaction ownership | Same test file, transactions table. |
| AC4 — cross-user access returns 403, no resource revelation | Asserts response body is `{ error: "forbidden" }` only; no `name`, `balance`, `category` fields leak. Asserts Prisma update was not called. |
| AC5 — `auth-contract.test.ts` flips to expecting 401 on unauthenticated + 403 on cross-user | Existing contract test updated; CI gate. |

User-visible ACs: AC1–AC5 are authorization-only; no app UI flow changes. E2E is not applicable. Coverage is at the route contract test layer.

## Open questions and risks

- **404 vs 403 consistency**: returning 403 reveals existence; returning 404 for both unknown and forbidden hides it. We pick 403 for known-but-foreign and 404 for unknown, matching common REST guidance. If Quinn prefers uniform 404, that's a one-line change in `requireOwnership`.
- **Performance**: each check is one Prisma read. For high-traffic endpoints we could cache the ownership lookup on the session, but at current scale this is unnecessary.
- **Migration order**: this task must land **after** `ec42d3a1` (sessions middleware) because it depends on `req.session.userId`. The two tasks should ship as a stacked PR or this one must wait.

## Linked audit

- `docs/repo-audits/2026-W29.md` — Theme 1 (Budget-API auth), Milestone 1-B, severity High.