# tasks-api Dockerfile — staging.
#
# Mirror of services/gymtrack-mcp/Dockerfile adapted for the pnpm-workspace
# layout and the TypeScript/tsx runtime. node:22-alpine base matches the
# existing precedent; pnpm is the workspace package manager (repo root
# pnpm-lock.yaml).
#
# Workspace deps: @sindustries/otel-node is referenced as
# `file:../../packages/otel-node` from services/tasks-api/package.json, so we
# copy packages/otel-node/package.json for install-time resolution and the
# full package source for runtime.
#
# The tasks-api prestart script (`prisma generate`) runs automatically before
# `tsx --require @sindustries/otel-node/register src/server.ts`, so we don't
# pre-generate here. The Prisma client is created at /app/services/tasks-api/
# node_modules/.prisma/client on first boot.
#
# PORT=4001 pairs with the prodlike DATABASE_URL port 7432 (the existing
# assertApiPortDbPortPairing guard in services/tasks-api/src/server.ts).
# ALLOW_PORT_DB_MISMATCH=1 is the documented escape hatch for the cloud
# case where DATABASE_URL may not match the local prodlike pairing.

FROM node:22-alpine AS base

# pnpm via corepack (matches the repo's workspace package manager).
RUN corepack enable

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY services/tasks-api/package.json ./services/tasks-api/

# Install tasks-api + its workspace deps with a frozen lockfile.
# The trailing `...` after the filter installs the package AND its
# workspace dependencies (per pnpm docs).
RUN pnpm install --frozen-lockfile --filter @sindustries/tasks-api...

# Runtime source — workspace package + service.
COPY packages/otel-node ./packages/otel-node
COPY services/tasks-api ./services/tasks-api

# Production runtime config.
# PORT=4001 matches the prodlike pairing (services/tasks-api/src/server.ts
# expectedDbPortForApiPort). ALLOW_PORT_DB_MISMATCH=1 is the documented
# escape hatch when DATABASE_URL points at a non-prodlike DB (e.g., Neon
# staging on port 5432). Quinn rotates this off once the staging DB lands
# on the canonical 7432 → 5432 mapping.
ENV NODE_ENV=production
ENV PORT=4001
ENV ALLOW_PORT_DB_MISMATCH=1

EXPOSE 4001

# Start: `pnpm --filter @sindustries/tasks-api start` runs the service's
# `prestart` (`prisma generate`) then `start`
# (`tsx --require @sindustries/otel-node/register src/server.ts`).
CMD ["pnpm", "--filter", "@sindustries/tasks-api", "start"]