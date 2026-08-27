# tasks-api Dockerfile — staging.
#
# Mirror of services/gymtrack-mcp/Dockerfile adapted for the npm-workspace
# layout and the TypeScript/tsx runtime. node:22-alpine base matches the
# existing precedent; npm is the workspace package manager (repo root
# package-lock.json + `workspaces` field in root package.json).
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

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
# Repo uses npm-style `workspaces` in root package.json (apps/*, packages/*,
# services/*); `npm ci --workspace ... --include-workspace-root` resolves
# them deterministically from package-lock.json.
COPY package-lock.json package.json ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY services/tasks-api/package.json ./services/tasks-api/

# Install tasks-api + its workspace deps with a frozen lockfile.
# `--include-workspace-root` is required so npm also installs the root
# devDependencies (jsdom).
RUN npm ci --workspace services/tasks-api --workspace packages/otel-node --include-workspace-root

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

# Start: `npm run start --workspace services/tasks-api` runs the service's
# `prestart` (`prisma generate`) then `start`
# (`tsx --require @sindustries/otel-node/register src/server.ts`).
CMD ["npm", "run", "start", "--workspace", "services/tasks-api"]
