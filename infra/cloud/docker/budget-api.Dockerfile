# budget-api Dockerfile — staging.
#
# Mirror of infra/cloud/docker/tasks-api.Dockerfile, adapted for budget-api's
# runtime: pure Express/tsx, no otel-node registration, default port 4002.
#
# Workspace deps: @sindustries/budget-domain is referenced as
# `file:../../packages/budget-domain` (via the workspace `*` alias) from
# services/budget-api/package.json, so we copy packages/budget-domain/package.json
# for install-time resolution and the full package source for runtime.
#
# The budget-api prestart script (`prisma generate`) runs automatically before
# `tsx src/server.ts`, so we don't pre-generate here. The Prisma client is
# created at /app/services/budget-api/node_modules/.prisma/client on first boot.
#
# PORT=4002 is budget-api's documented default (services/budget-api/src/server.ts
# falls back to 4002 when PORT is unset). No ALLOW_PORT_DB_MISMATCH guard exists
# in budget-api; Quinn sets DATABASE_URL to point at the prodlike pairing in
# staging, or the budget-api app fails fast on boot — this matches the
# tasks-api posture minus the escape hatch.

FROM node:22-alpine AS base

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
# Repo uses npm-style `workspaces` in root package.json (apps/*, packages/*,
# services/*); `npm ci --workspace ... --include-workspace-root` resolves
# them deterministically from package-lock.json.
COPY package-lock.json package.json ./
COPY packages/budget-domain/package.json ./packages/budget-domain/
COPY services/budget-api/package.json ./services/budget-api/

# Install budget-api + its workspace deps with a frozen lockfile.
RUN npm ci --workspace services/budget-api --workspace packages/budget-domain --include-workspace-root

# Runtime source — workspace package + service.
COPY packages/budget-domain ./packages/budget-domain
COPY services/budget-api ./services/budget-api

# Production runtime config.
# PORT=4002 matches services/budget-api/src/server.ts default.
ENV NODE_ENV=production
ENV PORT=4002

EXPOSE 4002

# Start: `npm run start --workspace services/budget-api` runs the service's
# `prestart` (`prisma generate`) then `start` (`tsx src/server.ts`).
CMD ["npm", "run", "start", "--workspace", "services/budget-api"]
