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

4. Run dev server:

```bash
npm run dev
```

## MVP endpoints

- `GET /health`
- `POST /api/v1/session/dev-login`
- `GET /api/v1/me`
- `POST /api/v1/akahu/sync` (demo stub)
- `GET /api/v1/transactions?userId=...`
- `PATCH /api/v1/transactions/:transactionId/category`
- `GET /api/v1/categories/timeseries?userId=...&from=...&to=...`
- `GET /api/v1/alerts?userId=...`

