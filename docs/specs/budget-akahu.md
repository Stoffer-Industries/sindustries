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
