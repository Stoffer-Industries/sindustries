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
pnpm install

# 2. Copy the env template.
cp services/content-scheduler-api/.env.example services/content-scheduler-api/.env

# 3. Run the bootstrap smoke (no DB yet — only /health).
pnpm --filter @sindustries/content-scheduler-api dev
```

Port defaults to `4003` (dev) so it does not collide with `tasks-api` (4000)
or `budget-api` (4002). The Tiltfile will be updated to wire this service in a
later commit.

## Acceptance criteria

The full extraction is tracked under task `94d5e4fc-1b31-4d04-a13b-4f69a7ec297a`.
This commit owns the **service scaffold** needed before any route move.
