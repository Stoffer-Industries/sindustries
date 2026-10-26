# Budget App + Akahu MVP Spec

## Objective

Deliver an iOS-first budgeting app that connects to Akahu, tracks card spending against a monthly card limit, visualizes category trends, and sends proactive spend warnings.

## MVP Scope

- Akahu account link and transaction sync via backend service.
- Monthly budget limit per card.
- Category time-series graph on dashboard.
- LLM-assisted transaction categorization.
- Manual recategorization with feedback memory.
- Push notifications as primary channel; email fallback.

## Core User Flows

1. User links their account via Akahu.
2. Transactions are ingested and categorized.
3. App shows spend summary by card and category trend graph.
4. User manually changes incorrect transaction category.
5. Future similar transactions inherit learned category behavior.
6. User receives warning notifications at threshold stages.

## Budget + Alerting Rules

- Budgets are card-scoped and monthly.
- Threshold stages:
  - Warning: 80%
  - Critical warning: 95%
  - Breached: 100%+
- Dedupe: only one alert per stage per card per month unless user drops below and re-crosses stage.
- Channels:
  - Primary: iOS push
  - Fallback: email

## Categorization Strategy

### Inputs

- Merchant name
- Transaction memo/reference
- Amount and direction
- Existing user feedback rules

### Decision Order

1. Apply exact user override rules (highest priority).
2. Apply fuzzy user rules (merchant similarity threshold).
3. Call LLM categorization if no high-confidence rule match.
4. If confidence below threshold, mark as `uncertain` and surface for user review.

### Learning Loop

- Every manual recategorization creates feedback records:
  - user id
  - normalized merchant key
  - original category
  - corrected category
  - timestamps
- Feedback records are used in future categorization before LLM inference.

## Data Model (MVP)

- `User`
- `LinkedCard`
- `Transaction`
- `CardMonthlyBudget`
- `TransactionCategoryOverride`
- `CategorizationFeedback`
- `NotificationEvent`

## API Surface (MVP)

- Auth/session (MVP placeholder)
  - `POST /api/v1/session/dev-login` create a dev session (local only).
  - `GET /api/v1/me` return current user and linked cards.
- `POST /api/v1/akahu/sync` sync transactions.
- `POST /api/v1/cards/:cardId/budget` set monthly budget limit for a card.
- `GET /api/v1/cards/:cardId/spend-summary?month=YYYY-MM`
- `GET /api/v1/categories/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `PATCH /api/v1/transactions/:transactionId/category`
- `POST /api/v1/categorize/predict`
- `GET /api/v1/alerts`

## Category Taxonomy (MVP)

Fixed enum-like set to prevent “creative” model outputs:

- groceries
- dining
- transport
- shopping
- utilities
- entertainment
- health
- travel
- subscriptions
- fees
- transfers
- other

## Confidence + Precedence

- Manual override always wins.
- User feedback rule wins over model output when rule score ≥ model confidence.
- Default model confidence threshold:
  - `>= 0.75`: auto-apply category
  - `< 0.75`: mark `uncertain` and surface in UI

## Akahu Provider Contract and Sync Semantics

The provider contract is enforced in `services/budget-api` and is documented in full in `docs/systems/budget-api.md`. The product-level rules:

### Paging and completeness

- Akahu pages `GET /v1/transactions` at 100 rows per page. The continuation token is `cursor.next`; `cursor.next === null` is the only completion signal and is never sent back to the provider.
- `start` and `end` are repeated on every page of a traversal.
- The sync traverses the whole requested window before it advances the checkpoint. The checkpoint (`AkahuConnection.lastSyncedAt`) is the watermark of the last **complete** sync.
- A partial traversal — a hit page cap, a repeated cursor, or a failure on a later page — leaves the checkpoint unchanged and is reported as `complete: false` in a `200` response. The next sync re-requests the same window, which is safe because the upsert is idempotent by `providerTransactionId`.

### Deadlines and retries

- Every provider call is bounded by a per-call deadline (10 s) that covers the header response and the body read, and by a whole-sync deadline (20 s) shared by every call and every pagination round of a request. Both are env-configurable.
- Read calls (`/v1/accounts`, `/v1/transactions`, `/v1/transactions/pending`) are retried on `429`, `502`, `503`, `504` and on timeouts, bounded by the attempt cap and the remaining whole-sync budget.
- Write calls (the authorization-code exchange and `/v1/refresh`) are never retried: authorization codes are single-use and a retried refresh deepens provider throttling.
- A client disconnect is reported as `AKAHU_CANCELLED` and a deadline overrun as `AKAHU_TIMEOUT` — distinguishable from an ordinary provider failure.

### Backfill

- A bounded, dry-run-first, idempotent backfill repairs history that the pre-fix sync truncated. It is an operator script (`services/budget-api/scripts/akahu-backfill.ts`), not an endpoint.
- The window must sit inside the provider's own historical allowance, read from `access_granted_at` on `GET /v1/me`. A window outside it is refused before any transaction page is requested; the allowance is never guessed.
- A dry run writes nothing — no transaction upserts and no run record. Apply mode records the run in `AkahuBackfillRun`.
- The backfill never deletes a settled row and never touches the checkpoint.

### Client-facing contract

- `POST /api/v1/akahu/sync` returns `complete`, `checkpointAdvanced`, `pagesFetched` and `transactionsFetched` alongside the existing fields. The mobile app treats `complete === false` as "some history may be missing" and does not present a partial sync as complete.

## Security + Privacy

- Akahu secrets and token exchange handled only by backend.
- Minimal PII persisted.
- Encrypt secrets at rest and in transit.
- Log token operations in audit-safe form (no raw tokens in logs).

## Non-Goals (MVP)

- Multi-currency portfolio analytics.
- Multi-user shared budgets.
- Automated bill detection.
- Fully autonomous AI budgeting advice.
