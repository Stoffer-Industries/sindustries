# content-scheduler-api Dockerfile — staging.
#
# RETIRED — the per-service staging image this Dockerfile builds is no longer
# the live staging build path. The 2026-11-07 staging consolidation (task
# 219fb673) destroyed the four per-service staging Fly apps; staging now
# builds ONE image, `infra/cloud/docker/platform.Dockerfile`, via
# `infra/cloud/fly/platform.fly.toml` and
# `.github/workflows/deploy-staging-platform.yml`. This file MUST NOT be built
# or deployed as a staging image.
#
# Retained only as a historical template: the retired per-service Fly spec
# still points its `[build] dockerfile` here, and
# `infra/cloud/scripts/tests/fly-toml-context.test.sh` asserts the OpenSSL
# install line below. Its deletion is tracked in
# `docs/runbooks/platform-consolidation-rollback.md` §5. Live topology:
# `docs/systems/cloud-platform.md`.
#
# The service owns its Prisma schema and HTTP mutation surface after the
# content-scheduler extraction. Build from the repository root so npm workspace
# dependencies and the shared OpenTelemetry package resolve deterministically.

FROM node:22-alpine AS base

RUN apk add --no-cache openssl

WORKDIR /app

COPY package-lock.json package.json ./
COPY packages/otel-node/package.json ./packages/otel-node/
COPY services/content-scheduler-api/package.json ./services/content-scheduler-api/

RUN npm ci --workspace services/content-scheduler-api --workspace packages/otel-node --include-workspace-root

COPY packages/otel-node ./packages/otel-node
COPY services/content-scheduler-api ./services/content-scheduler-api

ENV NODE_ENV=production
ENV PORT=4003
ENV CONTENT_SCHEDULER_JOB_ADAPTER=bullmq

EXPOSE 4003

CMD ["npm", "run", "start", "--workspace", "services/content-scheduler-api"]
