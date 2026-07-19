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

Content Scheduler endpoints (`/api/v1/content-scheduler/*`, see
`docs/specs/content-scheduler-tab-tech-design.md`):
- `GET /items?status=` — list non-`removed` items; sorted by status, position, createdAt.
- `POST /items` — create (body, source, sourceRef, scheduledFor).
- `PATCH /items/:id` — edit body/scheduledFor/source/sourceRef; 409 on published/removed.
- `POST /items/:id/approve` — sets `status=approved`, `approvedAt`, `approvedBy`.
- `POST /items/:id/unapprove` — clears approval (status back to `queued`).
- `POST /items/:id/publish` — guarded; posts to X via the configured X client.
- `POST /items/:id/remove` — soft-delete (status=`removed`); 409 on published.
- `POST /reorder` — `{ ids: [...] }` rewrites `position` per id in a transaction.
- `GET /today-status` — `{ date, publishedCount, publishedItemId, cap }` for `Pacific/Auckland` today.

### Content Scheduler env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `X_CLIENT` | `fake` | `fake` returns a deterministic FakeXClient (dev/test). `real` calls `api.twitter.com/2/tweets`. |
| `X_API_BEARER_TOKEN` | unset | Required when `X_CLIENT=real`; missing token → publish returns 503 `MISSING_CREDENTIALS`. |
| `X_HANDLE` | `sindustries` | Used to build the published post URL when `X_CLIENT=real`. |

### Content Scheduler timezone

The "max one X post per day" rule is computed in `Pacific/Auckland` (Tom's
local time). UTC `publishedAt` timestamps are stored; the daily window is
derived via `Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland' })`
on each publish/today-status request.

## X tweet route

`POST /api/v1/x/tweets` exposes the same OAuth 1.0a X client that the
content-scheduler publish path uses as a generic "post a tweet" endpoint
for sibling services. The first caller is the bookmark approval workflow
(`agents/workflows/bookmarks/scripts/x_author_tweet.py`), which posts a
reply at the original X author when an approved X-sourced bookmark lands
in `tasked`. See `docs/systems/bookmark-workflow.md` → "Author tweet
notification" and `docs/specs/bookmark-approval-author-tweet-tech-design.md`
for the full contract.

- Request body: `{ text: string, in_reply_to_tweet_id?: string }`
- Response: `{ data: { url: string, postedAt: ISO-8601 } }`
- 400 `TWEET_TOO_LONG` — `text.length > 280` (with `maxLength` and `length`)
- 400 `INVALID_BODY` — missing or empty `text`, non-string `in_reply_to_tweet_id`
- 502 `X_API_ERROR` — the underlying `XClient.createTweet` call threw; the truncated upstream message is surfaced for diagnostics but never includes secrets
- 503 `MISSING_CREDENTIALS` — `getXClient()` returned `null`; **no upstream X HTTP call was attempted** (AC5 reframed — fail fast without burning a doomed request)

The same OAuth 1.0a env vars the content-scheduler publish path consumes
apply here: `X_CLIENT` (`fake` default; `real` for production),
`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`,
and the optional `X_HANDLE`. No new credentials are needed.

**Auth:** the endpoint trusts `localhost` — matching the existing pattern
where the bookmark lobster's Python process calls
`http://localhost:4001/api/v1` unauthenticated. If `tasks-api` ever stops
being localhost-only, this route MUST be locked down (header token or LAN
allowlist) before exposing it externally. The auth caveat is also
documented in the route's header comment.

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
