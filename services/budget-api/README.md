# budget-api

Express + Prisma backend for the Akahu budget app.

## Local dev

1. Copy env file:

```bash
cp .env.example .env
```

2. Install deps:

```bash
npm install
```

3. Generate Prisma client:

```bash
npm run prisma:generate
```

4. Apply migrations to your local Postgres (recommended via repo tooling):

```bash
# from repo root
make migrate-db MODE=dev
```

5. Run dev server:

```bash
npm run dev
```

## Database notes

- `DATABASE_URL` must include `?schema=budget_api` (see `.env.example`).
- If you see Prisma `P2021` errors like `The table budget_api.User does not exist`, it means migrations have not been applied yet.

## MVP endpoints

- `GET /health`
- `POST /api/v1/session/dev-login`
- `GET /api/v1/me`
- `POST /api/v1/akahu/sync` (demo stub)
- `GET /api/v1/transactions?userId=...`
- `PATCH /api/v1/transactions/:transactionId/category`
- `GET /api/v1/categories/timeseries?userId=...&from=...&to=...`
- `GET /api/v1/alerts?userId=...`

## Security posture

> **MVP scope: dev/Tailnet only — auth is not yet enforced.**
>
> Every route except `/api/v1/me` accepts a `userId` from the request body or
> query and operates on that user without verifying a session token. Treat the
> service as reachable only over a trusted Tailnet and never expose it on the
> public internet until the `requireSession` middleware in
> `services/budget-api/src/app.ts` lands (tracked in the repo audit under
> "Theme 1 — Lock down `budget-api` before any non-Tailnet deployment").

