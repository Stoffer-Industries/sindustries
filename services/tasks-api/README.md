# tasks-api (Milestone 1 foundation)

Express + Prisma + Postgres foundation for the Tasks app.

## Prerequisites
- Node.js 22+
- Postgres 14+

## Local setup
```bash
cd services/tasks-api
cp .env.example .env
npm install
```

CORS defaults to local dev origins. For non-default clients, set `CORS_ALLOWED_ORIGINS` in `.env`.

## Run locally
```bash
npm run dev
```

Health checks:
- `GET /health`
- `GET /api/v1/health`

REST API (M3 slice):
- `GET /api/v1/tasks` (status/priority/assignee/tag/q/dueBefore/dueAfter filters + cursor pagination)
- `GET /api/v1/tasks/:id`
- `POST /api/v1/tasks`
- `PATCH /api/v1/tasks/:id`
- `DELETE /api/v1/tasks/:id` (archive-only)
- `GET /api/v1/tags`
- `POST /api/v1/tags`

## Database workflow
```bash
# generate Prisma client
npm run prisma:generate

# apply checked-in migrations
npm run prisma:migrate

# seed baseline data
npm run prisma:seed
```

## Tests
```bash
npm test
```

Current M1 tests:
- API health integration test (`/health`)
- Prisma schema validation test (`prisma validate`)

## Migrations

Prisma applies migration directories in lexical order of the directory name.
The first 14 characters of each directory name are the `YYYYMMDDHHMMSS` timestamp
and must be unique across the `prisma/migrations/` tree. Sharing a prefix
between two directories leaves the apply order at the mercy of the suffix
sort and the filesystem, which can silently swap between dev and CI.

**Convention:** new migrations get a unique 14-digit prefix. If you need to
extend the same minute as a recent migration, increment the last 2 digits
(e.g. `20260627000000` → `20260627000100`).

A repo-wide check enforces this: run `make check-migrations` (or
`./scripts/check-migration-prefixes.sh`) before pushing, and the
`tasks-api-tests` job runs the same check in CI before applying migrations.

### Analytics schema (raw SQL migrations, not Prisma models)

The `analytics` schema in this database is intentionally **not** declared in
`schema.prisma`. It holds tables that are populated by Python helper scripts
outside the Tasks API domain (`agents/workflows/bookmarks/scripts/analytics_db.py`
and future equivalents) and queried directly by Pulse / analytics tools via
raw SQL.

New analytics tables must:

1. Live under `services/tasks-api/prisma/migrations/` so `make migrate-db`
   applies them.
2. Use `CREATE … IF NOT EXISTS` so the migration is idempotent.
3. Be created inside the `analytics` schema (`CREATE SCHEMA IF NOT EXISTS analytics;`).
4. **Not** be added to `schema.prisma` — they are managed by raw SQL only.
   `prisma migrate dev` may print an "unmanaged table" notice; that is
   expected.

See `docs/systems/bookmark-workflow.md` for the runtime contract of the
analytics mirror (graceful degradation when `DATABASE_URL` is unset, no
connection pooling in v1, etc.).
The check fails with a non-zero exit if any two `prisma/migrations/*`
directories share a 14-char timestamp prefix.

### Renaming an already-applied migration

If a migration has already been applied to a live database, renaming its
directory on disk does **not** update the `_prisma_migrations` table. After
shipping the rename, every environment that already applied the old name
needs a one-time SQL update so the recorded name matches the new directory:

```sql
UPDATE _prisma_migrations
SET migration_name = '<new-name>'
WHERE migration_name = '<old-name>';
```

Run this on dev, prodlike, and any cached CI DBs before the next deploy.
A fresh `prisma migrate deploy` against a clean DB will pick up the new
name directly.
