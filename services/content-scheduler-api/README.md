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
  mounting).
- `src/config/env.ts` — env validation (zod), parsed and frozen at module
  load.
- `src/routes/` — Content Scheduler HTTP routes (to be moved from
  `services/tasks-api/src/routes/` in subsequent commits).
- `prisma/` — schema and migrations (ContentSchedulerItem ownership moves
  from `services/tasks-api` in a later commit).

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
or `budget-api` (4002). The Tiltfile will be updated to wire this service in a
later commit.

## Acceptance criteria

The full extraction is tracked under task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`.
This commit owns the **service scaffold** needed before any route move.

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
