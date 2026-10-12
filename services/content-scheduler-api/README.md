# `@sindustries/content-scheduler-api`

Content Scheduler backend service. Owns the content scheduling queue, approval
metadata, publishing guard rules, and X publishing integration for the
Sindustries Content Scheduler tab. Extracted from `services/tasks-api` as part
of task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a` (see
`docs/specs/content-scheduler-service-extraction-tech-design.md`).

## Layout

- `src/server.ts` — bootstrap entrypoint (binds PORT, validates env, starts
  HTTP listener).
- `src/app.ts` — Express app factory (helmet, CORS, rate limit, route
  mounting). Owns the full route surface: service-to-service (x-actor-secret
  + x-content-ingest-secret gated), authenticated user mutations
  (method-scoped via `methodGate(WRITE_METHODS, ...)` so the public GETs
  under `/api/v1/content-scheduler` stay open per the Phase-1 Auth matrix
  in `docs/specs/content-scheduler-auth-tech-design.md`).
- `src/config/env.ts` — env validation (zod), parsed and frozen at module
  load.
- `src/routes/` — Content Scheduler HTTP routes. The
  `services/tasks-api/src/routes/contentScheduler*` paths were retired
  during the extraction under task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`;
  this service is now the only owner of those routes.
- `prisma/` — schema and migrations. The `ContentSchedulerItem`,
  `ContentSchedulerPublishAttempt`, and related models moved from
  `services/tasks-api` as part of the same extraction; the `tasks-api`
  Prisma client no longer references them.

## Local dev

```bash
# 1. Install deps from the repo root.
npm ci

# 2. Copy the env template.
cp services/content-scheduler-api/.env.example services/content-scheduler-api/.env

# 3. Run the bootstrap smoke (no DB yet — only /health).
npm run dev --workspace services/content-scheduler-api
```

Port defaults to `4003` (dev) so it does not collide with `tasks-api` (4000)
or `budget-api` (4002). The prodlike local stack uses port `4004` because its
budget API uses `4003`. Tilt wires the service into both local modes.

## Acceptance criteria

The full extraction shipped under task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`
(see `docs/specs/content-scheduler-service-extraction-tech-design.md`).
This README describes the **post-extraction** service, which owns its full
route surface, schema, and migrations; subsequent work tracks the
post-extraction tech designs (`content-scheduler-auth-tech-design.md`,
`thread-publish-atomic-claim-w42-tech-design.md`, etc.) and the
`content-scheduler-api` follow-up tasks, not any further service split.

## Manual reply drafts (task 5279b310)

`ContentSchedulerItem` rows can now carry a `kind` discriminator
(`scheduled` | `manual_reply`). `manual_reply` rows are never
auto-published and exist to back the bookmark-approval build-in-public
reply-draft flow. See `docs/specs/bookmark-approval-author-mention-tweet-2026-08-19-tech-design.md`
and its post-extraction refresh at `docs/specs/bookmark-approval-author-mention-tweet-2026-08-23-refresh.md`.

New / extended routes:

- `POST /content-scheduler/items` — accepts `kind`, `linksToItemId` on
  manual_reply rows. Rejects `manualPostedUrl`/`manualPostedAt` on create
  (use PATCH /posted-url instead). Rejects `scheduledFor` when
  `kind = "manual_reply"`.
- `PATCH /content-scheduler/items/:id` — accepts `kind`, `linksToItemId`.
  Rejects `scheduledFor` writes when the existing or incoming kind is
  `manual_reply`.
- `PATCH /content-scheduler/items/:id/posted-url` — captures AC5's
  `manualPostedUrl` and server-clock `manualPostedAt` on a
  `manual_reply` row. Idempotent on the same URL (re-PATCHing the same
  URL returns 200 with the original `manualPostedAt` untouched).
  409 `NOT_MANUAL_REPLY` for scheduled rows; 400
  `INVALID_MANUAL_POSTED_URL` for non-x.com/non-twitter.com URLs.
- `POST /content-scheduler/items/:id/publish` — refuses
  `manual_reply` rows with 409 `MANUAL_REPLY_NOT_PUBLISHABLE` so the
  auto-post worker and the manual button share the same publish-skip
  decision via `guardPublish`.

The `ContentSchedulerItem.kind` column has a Postgres default of
`'scheduled'`, so every existing row flows through the publish loop
unchanged — no data migration required.
