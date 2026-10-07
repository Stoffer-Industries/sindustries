# content-scheduler-api Dockerfile — staging.
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
