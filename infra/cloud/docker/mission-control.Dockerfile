# mission-control.Dockerfile — staging.
#
# Sibling of `tasks-api.Dockerfile` but for the Vite-built React SPA in
# apps/mission-control. Multi-stage build:
#   stage 1 (build): node:22-alpine, installs workspace deps with the
#                    npm lockfile, runs `npm run build --workspace
#                    apps/mission-control` which emits the static SPA to
#                    apps/mission-control/dist/.
#   stage 2 (runtime): nginx:alpine, copies the built dist/ + a shared
#                    SPA nginx config (`spa-nginx.conf`), and serves on
#                    port 8080. Healthz at /healthz for Fly http_check.
#
# Build context: repo root (`../../..` in infra/cloud/fly/*.fly.toml).
# Build-time env (VITE_TASKS_API_BASE_URL, VITE_TASKS_APP_URL) is passed
# via Fly `--build-arg` and bakes into the SPA bundle — there is no
# runtime env-var override for Vite SPAs because vite inlines `import.meta.env.*`
# references at build time.
#
# VITE_TASKS_API_BASE_URL must point at the staging Tasks API deployment
# (e.g., https://sindustries-tasks-api-staging.fly.dev/api/v1).
# VITE_TASKS_APP_URL must point at the staging Tasks app deployment
# (e.g., https://sindustries-tasks-app-staging.fly.dev/) — Mission Control
# embeds it via iframe.

FROM node:22-alpine AS build

WORKDIR /app

# Workspace manifests — install-time only; pruned in the runtime stage.
# Repo uses npm-style `workspaces` in root package.json (apps/*,
# packages/*, services/*); `npm ci --workspace ... --include-workspace-root`
# resolves them deterministically from package-lock.json.
COPY package-lock.json package.json ./
COPY packages/design-tokens/package.json ./packages/design-tokens/
COPY packages/ui/package.json ./packages/ui/
COPY apps/mission-control/package.json ./apps/mission-control/

# Install mission-control + its workspace deps with a frozen lockfile.
# `--include-workspace-root` is required so npm also installs the root
# devDependencies (jsdom, vite).
RUN npm ci \
      --workspace apps/mission-control \
      --workspace packages/design-tokens \
      --workspace packages/ui \
      --include-workspace-root

# Workspace sources needed at build time.
COPY packages/design-tokens ./packages/design-tokens
COPY packages/ui ./packages/ui
COPY apps/mission-control ./apps/mission-control

# Build args — bake URLs into the SPA bundle. Required at build time:
#   VITE_TASKS_API_BASE_URL — staging Tasks API base
#   VITE_TASKS_APP_URL      — staging Tasks app iframe URL
# Both must be passed via `fly deploy --build-arg …` (see fly.toml comment).
ARG VITE_TASKS_API_BASE_URL
ARG VITE_TASKS_APP_URL
ENV VITE_TASKS_API_BASE_URL=$VITE_TASKS_API_BASE_URL
ENV VITE_TASKS_APP_URL=$VITE_TASKS_APP_URL

# Build the SPA. `npm run build` invokes vite build; output goes to
# apps/mission-control/dist/.
RUN npm run build --workspace apps/mission-control

# ----------------------------------------------------------------------------
# Runtime — nginx serving the built SPA + a /healthz endpoint.

FROM nginx:1.27-alpine AS runtime

# Copy the built SPA bundle.
COPY --from=build /app/apps/mission-control/dist /usr/share/nginx/html

# Shared SPA nginx config (SPA fallback + healthz). `nginx -t` validates
# it during the image build so a typo here fails the deploy rather than
# silently rolling a broken image.
COPY infra/cloud/docker/spa-nginx.conf /etc/nginx/conf.d/default.conf

# Validate nginx config — catches syntax errors at image build time.
# `nginx -t` reads /etc/nginx/nginx.conf + conf.d/*.conf.
RUN nginx -t

EXPOSE 8080

# nginx:alpine's default CMD starts nginx in the foreground. Healthcheck
# hits /healthz; Fly http_check mirrors it from outside the container.
CMD ["nginx", "-g", "daemon off;"]
