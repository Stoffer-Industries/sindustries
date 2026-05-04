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

