# tasks-app.Dockerfile — staging.
#
# Sibling of `mission-control.Dockerfile`, same multi-stage pattern but
# for the Vite-built React SPA in apps/tasks. Static serve via nginx:alpine
# on port 8080 with the shared `spa-nginx.conf`.
#
# Why a separate Fly app rather than co-locating with Mission Control:
#   - independent deploy cadence (the iframe architecture decision in
#     docs/systems/mission-control.md is built on independent deploys);
#     folding tasks into Mission Control would force coordinated releases.
#   - separate health-check + revert story (AC3) — the spec calls out
#     "Mission Control deployment can be health-checked and safely reverted";
#     a single combined app would mean reverting Mission Control also
#     reverts Tasks, which is the wrong granularity when a Tasks-app-only
#     regression lands.
#   - matches the existing fly.toml pattern (one app per toml,
#     infra/cloud/fly/{tasks-api,budget-api,auto-post-worker}.fly.toml).
#
# Build-time env:
#   VITE_TASKS_API_BASE_URL — staging Tasks API base (baked into the SPA)
#   VITE_SHELL_ORIGIN       — Mission Control origin (allowed for postMessage)
#   VITE_TASKS_APP_URL      — same origin by default; only override when
#                             the iframe embed URL differs from the public URL

FROM node:22-alpine AS build

WORKDIR /app

# Workspace manifests — install-time only.
COPY package-lock.json package.json ./
COPY packages/design-tokens/package.json ./packages/design-tokens/
COPY packages/ui/package.json ./packages/ui/
COPY apps/tasks/package.json ./apps/tasks/

# Install tasks-app + its workspace deps with a frozen lockfile.
RUN npm ci \
      --workspace apps/tasks \
      --workspace packages/design-tokens \
      --workspace packages/ui \
      --include-workspace-root

# Workspace sources needed at build time.
COPY packages/design-tokens ./packages/design-tokens
COPY packages/ui ./packages/ui
COPY apps/tasks ./apps/tasks

# Build args — bake URLs into the SPA bundle.
# VITE_TASKS_API_BASE_URL: staging Tasks API base.
# VITE_SHELL_ORIGIN: Mission Control origin (the app checks this against
#   window.location.ancestorOrigins for cross-origin postMessage
#   validation). For the staging embed it should be the Mission Control
#   staging URL.
ARG VITE_TASKS_API_BASE_URL
ARG VITE_SHELL_ORIGIN
ENV VITE_TASKS_API_BASE_URL=$VITE_TASKS_API_BASE_URL
ENV VITE_SHELL_ORIGIN=$VITE_SHELL_ORIGIN

# Build the SPA. Output to apps/tasks/dist/.
RUN npm run build --workspace apps/tasks

# ----------------------------------------------------------------------------
# Runtime — nginx serving the built SPA + a /healthz endpoint.

FROM nginx:1.27-alpine AS runtime

# Copy the built SPA bundle.
COPY --from=build /app/apps/tasks/dist /usr/share/nginx/html

# Shared SPA nginx config (SPA fallback + healthz). Validated below.
COPY infra/cloud/docker/spa-nginx.conf /etc/nginx/conf.d/default.conf

# Validate nginx config — catches syntax errors at image build time.
RUN nginx -t

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
