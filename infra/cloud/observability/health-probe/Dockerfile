# health-probe Dockerfile — staging.
#
# Mirror of infra/cloud/docker/tasks-api.Dockerfile adapted for the
# single-purpose health-probe service. Same npm-workspace install
# pattern, same node:22-alpine base, no Prisma (probe does not touch
# application schemas).
#
# Probe deps: @sindustries/otel-node, express, ioredis, pg, prom-client.
# Quinn-owned secrets are read at runtime from Fly secrets — they
# never enter the image.

FROM node:22-alpine AS base

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
COPY package-lock.json package.json ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY infra/cloud/observability/health-probe/package.json ./infra/cloud/observability/health-probe/

RUN npm ci \
      --workspace infra/cloud/observability/health-probe \
      --workspace packages/otel-node \
      --include-workspace-root

# Runtime source — workspace package + probe.
COPY packages/otel-node ./packages/otel-node
COPY infra/cloud/observability/health-probe ./infra/cloud/observability/health-probe

ENV NODE_ENV=production
ENV PORT=9090
ENV PROBE_INTERVAL_SECONDS=30

EXPOSE 9090

CMD ["npm", "run", "start", "--workspace", "infra/cloud/observability/health-probe"]
