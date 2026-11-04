# Budget API

## Architecture and ownership

`services/budget-api` owns the Sindustries budget domain: the user's linked cards, their balances, the transactions synced from the Akahu provider, the per-card monthly budgets, the category assignment on each transaction, and the spend alerts derived from them. It is the only service that talks to Akahu. `apps/budget-mobile` is the consumer; nothing else reads the budget tables.

Akahu is a third-party bank-aggregation provider. The API is the boundary between that provider and the product: provider credentials stay in the service, the mobile app never sees an Akahu access token, and the provider's paging, retry and deadline rules are enforced in one place (`src/services/akahuClient.ts`).

## The Akahu provider contract

**Paging.** Akahu pages `GET /v1/transactions` at a fixed 100 rows per page. The continuation token is `cursor.next`, which is `null` on the final page. Two rules follow from the provider's contract and are enforced by the client:

- `start` and `end` must be repeated on **every** page of a traversal.
- A `null` cursor is never sent back to the provider — Akahu errors on it. `cursor.next === null` is the only completion signal.

**Deadlines.** Every provider call is bounded by a per-call deadline (10 s default, `AKAHU_PER_CALL_TIMEOUT_MS`) that covers both the header response and the body read, and a provider-I/O deadline (20 s default, `AKAHU_SYNC_BUDGET_MS`) shared by every provider call and pagination round of one request. It does not include the later database categorisation/write phase. The deadline is measured on a monotonic clock, so a wall-clock adjustment cannot extend an in-flight budget. A single call's deadline is clamped to whatever remains of the provider-I/O budget.

**Retries.** Retry policy is scoped by call kind, not by convention:

| Kind | Calls | Retried on |
|---|---|---|
| `read` | `/v1/accounts`, `/v1/transactions`, `/v1/transactions/pending` | `429`, `502`, `503`, `504`, network and timeout errors |
| `write` | `POST /oauth.akahu.nz/token`, `POST /v1/refresh` | never |

Authorization codes are single-use, so a retried token exchange fails; a retried refresh deepens provider throttling. The write paths are therefore excluded by construction. A read retry is bounded by both the attempt cap (4) and the remaining whole-sync budget.

**Cancellation.** A request-scoped `AbortSignal` is derived from the HTTP response's `close` event, so a client disconnect stops provider work instead of leaving it running until the deadline. A cancellation is reported as `AKAHU_CANCELLED` and a deadline overrun as `AKAHU_TIMEOUT` — the two are distinguishable, and neither is reported as a provider HTTP error.

**Error contract.** A provider HTTP failure surfaces as `400 BAD_REQUEST` with a message. A network transport failure surfaces as `502 AKAHU_NETWORK`. A deadline overrun or a client disconnect surfaces as `400` with the code `AKAHU_TIMEOUT` or `AKAHU_CANCELLED`. A **partial traversal is not an error**: it is a `200` with `complete: false`.

## The completeness invariant

`POST /api/v1/akahu/sync` traverses the requested window to exhaustion before it advances the checkpoint.

- `AkahuConnection.lastSyncedAt` advances **only** when the traversal ended with `cursor.next === null` and the page cap was not hit. It is the watermark of the last **complete** sync, not the time of the last attempt.
- A partial traversal leaves the checkpoint unchanged, so the next sync re-requests the same window. Re-requesting is safe because the upsert is idempotent by `providerTransactionId`.
- The interactive sync page cap is 5 pages (≈500 rows at 100 rows per page), bounding its serial categorisation/write phase. The operator backfill retains a 50-page cap. A capped window is reported incomplete, never as success.
- A repeated cursor stops the traversal and is reported incomplete. It is never treated as the end of the window.

The response carries the outcome explicitly:

```json
{
  "ok": true,
  "complete": true,
  "checkpointAdvanced": true,
  "pagesFetched": 3,
  "transactionsFetched": 250
}
```

`complete: false` means some history may be missing. The mobile app must not present a partial sync as complete.

### Why the invariant exists

Before this contract, the client fetched only the first page of a window and the route then advanced the checkpoint unconditionally. Any window with more than 100 settled transactions was truncated silently — no error, no log, no signal to the caller — and the omitted rows fell outside every future overlap window, so they were never requested again. A measured 60-day/250-row user lost 150 rows permanently. The invariant is what makes "the rows you can see are all the rows in the window" a property the service enforces rather than an assumption.

## The backfill

A bounded backfill repairs history that the pre-fix sync truncated. It is an operator script, not an endpoint — a data-repair operation over financial records should be run deliberately, and it should not add an administrative surface with its own auth and audit burden.

```bash
cd services/budget-api
# 1. Always start with a dry run. It writes nothing at all.
npx tsx scripts/akahu-backfill.ts --user <uuid> --start 2026-01-15 --end 2026-03-01 --dry-run
# 2. Apply once the dry run's row count looks right.
npx tsx scripts/akahu-backfill.ts --user <uuid> --start 2026-01-15 --end 2026-03-01
```

The access token is read from the encrypted `AkahuConnection` row. It is never an argument and never printed.

**Rules the script enforces:**

- The window must sit inside the provider's own historical allowance, read from `access_granted_at` on `GET /v1/me`. The allowance is always read. `--max-lookback-days` can only narrow that provider bound, never widen it. A window outside the effective bound is refused **before** any transaction page is requested.
- If the provider does not report `access_granted_at`, the script refuses unless an explicit `--max-lookback-days` bound is supplied. That required override is recorded as `allowance.source = 'override-required'`; the script never falls back to a default number.
- `--dry-run` counts rows and writes nothing: no transaction upserts and no run record.
- Apply mode pages the whole window, upserts by `providerTransactionId`, and records the run in `AkahuBackfillRun`. A second run over the same window creates no duplicates and updates the same run record's counters.
- The backfill never deletes a settled row and never touches `lastSyncedAt`. The checkpoint is the sync watermark, not a backfill artefact.
- The backfill runs under the same per-call and whole-sync budgets as a normal sync, so it can fail part-way and be re-run safely. A part-way failure still records a run with status `partial`, and the pages already fetched are upserted.

**Run record.** `AkahuBackfillRun` records the user, the window, the mode, the status (`completed` | `partial` | `failed`), the pages fetched, the rows seen and the rows upserted (`created + updated`). The CLI result uses the same `rowsUpserted` definition and also reports `rowsUpdated` separately. It is written by the same code path that performs the backfill, so there is no second source of truth.

## Data ownership

| Entity | Owner | Notes |
|---|---|---|
| `AkahuConnection` | `services/budget-api` | Access token encrypted at rest (AES-256-GCM, `src/lib/secretBox.ts`). |
| `LinkedCard` | `services/budget-api` | Provider accounts, upserted as `provider='akahu'`. |
| `Transaction` | `services/budget-api` | Keyed by the unique `providerTransactionId` (`akahu:<provider _id>`), which is what makes the sync and the backfill idempotent. |
| `AccountBalanceSnapshot` | `services/budget-api` | Written by a sync, never by a backfill. |
| `AkahuBackfillRun` | `services/budget-api` | The backfill's audit trail. |
| `CardMonthlyBudget`, `CategorizationFeedback`, `NotificationEvent` | `services/budget-api` | Budgets, user category corrections, and alerts. |

## Operational surface

- **Health**: `GET /api/v1/health`.
- **Sync**: `POST /api/v1/akahu/sync` — the user-facing entry point. Behind `requireSession`.
- **Link**: `POST /api/v1/akahu/exchange` — exchanges the authorization code. The code is single-use and is never retried.
- **Backfill**: `services/budget-api/scripts/akahu-backfill.ts` — operator-only, script-only, no route.

### Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `AKAHU_TIMEOUT` on a sync | The per-call or whole-sync deadline was exceeded. | The checkpoint did not advance. The next sync retries the same window. If it persists, the provider is slower than the budget — raise `AKAHU_SYNC_BUDGET_MS`. |
| `AKAHU_CANCELLED` on a sync | The client disconnected. | Not a provider fault; the checkpoint did not advance. |
| `AKAHU_NETWORK` on a sync | Akahu did not return an HTTP response after the bounded read retries. | Treat as a transient upstream failure and retry later. |
| `complete: false` on a `200` | The window was only partially traversed (page cap, repeated cursor, or a later page failed). | The checkpoint did not advance. Re-run the sync; if the window is legitimately large, use the backfill. |
| `400 BAD_REQUEST` from a sync | A provider HTTP failure that is not retryable (`400`, `401`, `403`) or a non-`AKAHU_*` error. | `401` usually means the connection needs re-linking via OAuth. |
| Backfill refuses a window | The window is outside the provider's historical allowance. | Narrow the window, or supply an explicit `--max-lookback-days` if the provider does not report `access_granted_at`. |

## Related documents

- `docs/specs/budget-akahu.md` — the product spec and provider contract.
- `docs/specs/budget-akahu-pagination-deadlines-tech-design.md` — the design behind the completeness invariant, the budgets and the backfill.
- `docs/systems/budget-mobile-distribution.md` — how the mobile app is distributed.
