# platform.Dockerfile — the consolidated Fly staging platform (task 219fb673).
#
# ONE image for four processes. Fly bills per Machine (VM), not per logical
# service, so the cost saving only exists if tasks-api, budget-api,
# content-scheduler-api and auto-post-worker all run inside a SINGLE
# Machine. Fly gives each *process group* its own Machine, so the image's
# entrypoint is the supervisor (infra/cloud/platform/platform-supervisor.mjs),
# which spawns the four children plus the nginx router inside one Machine.
#
# This file is the union of the four per-service Dockerfiles:
#   infra/cloud/docker/tasks-api.Dockerfile
#   infra/cloud/docker/budget-api.Dockerfile
#   infra/cloud/docker/content-scheduler-api.Dockerfile
#   infra/cloud/docker/auto-post-worker.Dockerfile
#
# The four service workspaces are copied verbatim — no service source,
# Prisma schema, route or env var name is changed by this consolidation
# (AC1). The only new code is infra: the supervisor, the router config and
# the migration chain.
#
# Workspace deps resolved here:
#   @sindustries/otel-node     file:../../packages/otel-node   (tasks-api,
#                               content-scheduler-api, auto-post-worker)
#   @sindustries/budget-domain file:../../packages/budget-domain (budget-api)
#
# PORT note: no service PORT is set at the image level. The supervisor owns
# the per-child PORT map (4001/4002/4003) because Fly secrets are
# app-scoped and a single app-level PORT would collide across the children.
#
# The tasks-api PORT=4001 pairing guard (services/tasks-api/src/server.ts)
# is satisfied the same way it is today: the supervisor sets PORT=4001 and
# ALLOW_PORT_DB_MISMATCH=1 for that child only.

FROM node:22-alpine AS base

# openssl: Prisma's TLS engine needs it (same as the per-service images).
# nginx: the in-container router that serves the three hostnames.
RUN apk add --no-cache openssl nginx

WORKDIR /app

# Workspace manifests — install-time only.
# Repo uses npm-style `workspaces` in root package.json (apps/*, packages/*,
# services/*); `npm ci --workspace ... --include-workspace-root` resolves
# them deterministically from package-lock.json.
COPY package-lock.json package.json ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY packages/budget-domain/package.json ./packages/budget-domain/
COPY services/tasks-api/package.json ./services/tasks-api/
COPY services/budget-api/package.json ./services/budget-api/
COPY services/content-scheduler-api/package.json ./services/content-scheduler-api/

# Install every workspace the platform needs with a frozen lockfile.
RUN npm ci \
      --workspace services/tasks-api \
      --workspace services/budget-api \
      --workspace services/content-scheduler-api \
      --workspace packages/otel-node \
      --workspace packages/budget-domain \
      --include-workspace-root

# Runtime source — workspace packages + the three service trees.
COPY packages/otel-node ./packages/otel-node
COPY packages/budget-domain ./packages/budget-domain
COPY services/tasks-api ./services/tasks-api
COPY services/budget-api ./services/budget-api
COPY services/content-scheduler-api ./services/content-scheduler-api

# The platform's own code: supervisor, router config, migration chain.
COPY infra/cloud/platform ./infra/cloud/platform

# Prisma clients for all three schemas. The tasks-api and budget-api
# `prestart` hooks would regenerate their own client at boot, but the
# content-scheduler worker has no `pre*` sibling and instantiates
# PrismaClient directly — so all three are generated here, explicitly,
# for cacheability and so a broken schema fails the build rather than the
# boot of one service.
RUN cd services/tasks-api && npx prisma generate
RUN cd services/budget-api && npx prisma generate
RUN cd services/content-scheduler-api && npx prisma generate

ENV NODE_ENV=production

# The router is the only thing Fly exposes on 443. The children's ports
# (4001/4002/4003) and the supervisor's status port (8081) stay on
# loopback inside the Machine.
EXPOSE 8080

# The supervisor stays in the foreground: when the entrypoint exits, Fly
# kills the Machine.
CMD ["node", "infra/cloud/platform/platform-supervisor.mjs"]
