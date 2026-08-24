# auto-post-worker Dockerfile — staging.
#
# Mirror of infra/cloud/docker/budget-api.Dockerfile, adapted for the
# content-scheduler-api worker entrypoint. The worker lives in
# services/content-scheduler-api/src/workers/autoPostWorkerMain.ts and
# runs as a long-running BullMQ consumer (no HTTP exposure).
#
# Workspace deps (resolved transitively by the filter):
#   - @sindustries/otel-node: file:../../packages/otel-node (loaded via
#     --require at startup to register OpenTelemetry SDK before the
#     worker's own modules import)
#   - bullmq + ioredis: queue + Redis adapter
#   - @prisma/client + prisma: reconciliation sweep on boot
#
# No pnpm-workspace.yaml: this repo uses npm-style `workspaces` in root
# package.json (apps/*, packages/*, services/*); pnpm reads that directly.
#
# Quinn-approved answers from PR #508 (locked):
#   - Separate Fly app process for the worker (its own Dockerfile).
#   - REDIS_URL stays as the env-var contract.
#   - Quinn owns DATABASE_URL (Neon) + REDIS_URL (Upstash) secrets.

FROM node:22-alpine AS base

# pnpm via corepack (matches the repo's workspace package manager).
RUN corepack enable

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
COPY pnpm-lock.yaml package.json ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY services/content-scheduler-api/package.json ./services/content-scheduler-api/

# Install content-scheduler-api + its workspace deps with a frozen lockfile.
# The trailing `...` after the filter installs the package AND its
# workspace dependencies (per pnpm docs).
RUN pnpm install --frozen-lockfile --filter @sindustries/content-scheduler-api...

# Runtime source — service source tree (worker entrypoint + reconciliation
# + BullMQ adapter + Prisma schema).
COPY packages/otel-node ./packages/otel-node
COPY services/content-scheduler-api ./services/content-scheduler-api

# Prisma client must be generated before the worker boots — both the
# reconciliation sweep (`reconcileAutoPostItems` in
# src/routes/autoPostReconciliation.ts) and the publish service
# (publishContentSchedulerItem) instantiate PrismaClient. The
# content-scheduler-api `prestart` hook runs `prisma generate`, but the
# `content-scheduler:worker` script has no `pre*` sibling — so we run
# it explicitly here as its own layer for cacheability.
RUN cd services/content-scheduler-api && npx prisma generate

# Production runtime config.
ENV NODE_ENV=production

# Start: `pnpm --filter @sindustries/content-scheduler-api content-scheduler:worker`
# resolves to `tsx --require @sindustries/otel-node/register src/workers/autoPostWorkerMain.ts`.
# No EXPOSE: the worker has no HTTP listener (Fly process supervision
# handles liveness via the entrypoint's PID, not port reachability).
CMD ["pnpm", "--filter", "@sindustries/content-scheduler-api", "content-scheduler:worker"]
