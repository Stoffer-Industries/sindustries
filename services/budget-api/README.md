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
- The Prisma client writes to `services/budget-api/generated/prisma` (see `prisma/schema.prisma`). Worktrees branched before `c8dbac8` may still have a stale `services/budget-api/src/generated/` directory — it is gitignored but unused, and can be removed with `rm -rf services/budget-api/src/generated` to silence editor warnings.

## MVP endpoints

- `GET /health`
- `POST /api/v1/session/dev-login` (development mode only — see Security posture)
- `GET /api/v1/me` (requires an active session)
- `POST /api/v1/akahu/sync` (demo stub; requires an active session)
- `GET /api/v1/transactions` (requires an active session)
- `PATCH /api/v1/transactions/:transactionId/category` (requires an active session)
- `GET /api/v1/categories/timeseries?from=...&to=...` (requires an active session)
- `GET /api/v1/alerts` (requires an active session)

## Security posture

> **Source behavior (see Deployment notes for the runtime exposure):**
>
> All user-data routers (`akahu`, `cards`, `transactions`, `categories`,
> `categorize`, `alerts`) are gated by `requireSession` in
> `services/budget-api/src/app.ts`. The `userId` is sourced from
> `req.session` and never trusted from the request body or query string.
> `GET /api/v1/me` also requires an active session.
>
> The `POST /api/v1/session/dev-login` endpoint remains mounted but is
> correctly disabled outside development (`NODE_ENV !== 'development'`).
> Production deployments must not run with `NODE_ENV=development`; the
> rate limiter on this endpoint is in-memory and not multi-instance safe.
>
> The Session model has no `expiresAt` column today (see audit finding F8
> in `docs/repo-audits/2026-W42.md`); a leaked session therefore remains
> valid while its row exists. Treat the service as reachable only over a
> trusted network and never expose it on the public internet until a
> session-lifetime policy is recorded and shipped (task `8a2846e3`-style
> decision brief expected before commissioning identity/migration work).

## HTTP hardening

All responses include baseline Helmet security headers and JSON request bodies are capped.
The OAuth exchange and dev-login endpoints also use an in-memory rate limiter.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUDGET_API_JSON_LIMIT` | `100kb` | Maximum accepted JSON request body size. |
| `BUDGET_API_RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window (15 minutes). |
| `BUDGET_API_RATE_LIMIT_MAX` | `100` | Requests allowed per client IP during the window. |

The default in-memory limiter is appropriate for the current single-instance deployment.
Use a shared store before scaling the service to multiple instances. Invalid or missing
numeric rate-limit values fall back to the defaults.
