---
task_id: de9d8594-4825-40f5-bfb3-30ac31cc50e7
status: in-progress
---

# Budget API async handler inventory

This is the implementation evidence for the W42 audit F1 finding
("Budget async failures bypass the Express error boundary"). It enumerates
every async Express middleware and route callback in `services/budget-api`
and confirms each is wrapped by `asyncHandler` so rejected promises and
synchronous throws reach the registered error middleware in `app.ts`.

## Wrapper

`services/budget-api/src/lib/asyncHandler.ts` exports a single function,
`asyncHandler`, that turns `(req, res, next) => unknown | Promise<unknown>`
into an Express `RequestHandler`. The implementation is:

```ts
return (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res, next))
    .catch(next);
};
```

This is the only wrapping layer used. It catches both sync throws and
rejected promises and forwards the value to `next(err)`. Handlers that
already responded (for example via `jsonError` or `res.status(401)...`) and
then call `next()` are not double-invoked, because the wrapper does not
re-call `next()` on a resolved promise.

The same wrapper is used for the `requireSession` middleware (now
`asyncHandler(async (req, res, next) => { ... })`) and for every route
callback.

## Inventory

| Layer | File | Handler | Wrapped? | Notes |
| --- | --- | --- | --- | --- |
| middleware | `src/middleware/requireSession.ts` | `requireSession` (Bearer-token + Prisma session lookup) | yes | One consistent layer; the only Bearer-aware middleware |
| route | `src/routes/akahu.ts` | `GET  /akahu/authorize-url` | yes | Sync, but routed through `asyncHandler` for consistency |
| route | `src/routes/akahu.ts` | `POST /akahu/exchange` | yes | Wraps the `exchangeAuthorizationCode` upstream |
| route | `src/routes/akahu.ts` | `POST /akahu/sync` | yes | Longest handler; includes `prisma.linkedCard.upsert`, `prisma.transaction.{findUnique,update,create,deleteMany}`, `prisma.accountBalanceSnapshot.create`, `markAkahuSyncComplete`, `evaluateAlertsForUser` |
| route | `src/routes/alerts.ts` | `POST /alerts/evaluate` | yes | Awaits `evaluateAlertsForUser` |
| route | `src/routes/alerts.ts` | `GET  /alerts` | yes | Awaits `prisma.notificationEvent.findMany` |
| route | `src/routes/alerts.ts` | `DELETE /alerts/:alertId` | yes | Awaits `prisma.notificationEvent.findUnique` + `.delete` |
| route | `src/routes/alerts.ts` | `GET  /cards/:cardId/alert-config` | yes | Awaits `prisma.linkedCard.findUnique` + `prisma.balanceAlertConfig.findUnique` |
| route | `src/routes/alerts.ts` | `POST /cards/:cardId/alert-config` | yes | Awaits `prisma.linkedCard.findUnique` + `prisma.balanceAlertConfig.upsert` |
| route | `src/routes/alerts.ts` | `DELETE /cards/:cardId/alert-config` | yes | Awaits `prisma.balanceAlertConfig.findUnique` + `.delete` |
| route | `src/routes/cards.ts` | `GET  /cards/balance-history` | yes | Awaits `prisma.linkedCard.findMany` + `prisma.accountBalanceSnapshot.findMany` in `Promise.all` |
| route | `src/routes/cards.ts` | `POST /cards/:cardId/budget` | yes | Awaits `getCardById` (Prisma) + `upsertMonthlyBudget` |
| route | `src/routes/cards.ts` | `GET  /cards/:cardId/spend-summary` | yes | Awaits `getCardById` + `prisma.transaction.findMany` + `getMonthlyBudget` |
| route | `src/routes/categories.ts` | `GET  /categories/timeseries` | yes | Awaits `prisma.transaction.findMany` |
| route | `src/routes/categorize.ts` | `POST /categorize/predict` | yes | Awaits `categorizeTransaction` (rule + DB lookup) |
| route | `src/routes/session.ts` | `POST /session/dev-login` | yes | Awaits `prisma.user.findUnique` / `.create` + `prisma.session.create`; dev only |
| route | `src/routes/session.ts` | `GET  /me` | yes | Awaits `prisma.session.findUnique` + `prisma.linkedCard.findMany`; sits behind `requireSession` |
| route | `src/routes/transactions.ts` | `GET  /transactions` | yes | Awaits `listTransactionsForUser` (Prisma) |
| route | `src/routes/transactions.ts` | `PATCH /transactions/:transactionId/category` | yes | Awaits `getTransactionById` + `updateTransactionCategory` + `recordCategorizationFeedback` (write route) |

## App-level middleware not affected

`app.ts` registers two app-level middlewares that are intentionally not
wrapped because they are synchronous: `helmetPreset()` and the CORS
preflight short-circuit. They never `await` and cannot reject. The body
parser (`express.json`) is library-provided and already returns a
synchronous error (caught by the existing `app.use((error, ...))`
middleware via `error.type === 'entity.too.large'`).

`express-rate-limit`'s `createRateLimit(...)` is also synchronous; on
exceeded limits it sends a 429 directly.

## Test coverage

- `services/budget-api/test/async-error-boundary.test.ts` — 5 new tests:
  - rejected `prisma.session.findUnique` returns sanitized 500, no unhandled rejection
  - rejected read-route dependency returns 500, subsequent request succeeds
  - rejected write-route dependency returns 500 instead of hanging
  - missing Bearer token still returns 401 with no prisma call
  - invalid token + rejecting prisma still returns 500, never 200, no unhandled rejection

All 101 budget-api tests pass (1 suite skipped, 16 cases skipped, none
introduced by this change).

## Out of scope (deliberate)

- No Express major upgrade (still on 4.22.2) — `asyncHandler` is the
  minimal change that closes the gap on 4.x.
- No cross-service shared `asyncHandler` package — budget-api is the only
  affected service today; if a second service needs the same wrapper,
  promote to `packages/` then.
- No database schema or `.openclaw` changes.
- No changes to successful HTTP responses, status codes, authentication,
  or ownership checks. 401 / 404 / 400 contracts are preserved and
  verified by the existing `auth-contract` and `ownership-contract` suites
  plus the new `async-error-boundary` suite.
