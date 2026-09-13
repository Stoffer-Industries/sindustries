# Two-stage build for the GymTrack MCP service.
#
# Stage 1 installs production dependencies from the ROOT package-lock.json
# so the released image's installed versions match what CI already verified
# via its own `npm ci`. Stage 2 carries only the runtime artefact plus
# `apps/gymtrack/server/agentData.js` (referenced by an absolute path from
# services/gymtrack-mcp/src/mcpTools.js).
#
# Why every workspace tree is copied in stage 1: `npm ci` at the workspace
# root walks the whole graph and resolves `file:` links between workspaces
# (see apps/budget-mobile, apps/mission-control, etc. in package-lock.json).
# Copying every workspace's package metadata makes the install graph exactly
# equal to CI's graph, which is the durable boundary this image enforces.
FROM node:22-alpine AS deps
WORKDIR /repo

# Bring the workspace trees so `npm ci` at the root can verify every
# workspace's `package.json` against the lockfile and resolve `file:`
# links across workspaces. `.dockerignore` (at the build context root)
# excludes .git, node_modules, agents/, brain/, worktrees/, and .env* so
# the COPY layer stays narrow.
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

# npm 10's peer-set resolver can crash with `edgesOut` on this dependency
# graph; the service has no peer-dependency contract to resolve at runtime.
# `--omit=dev` matches the previous install intent; the flag is preserved
# here for the same reason as before — see issue tracker for npm upgrade.
RUN npm ci --omit=dev --legacy-peer-deps

FROM node:22-alpine AS runtime
WORKDIR /app

# Lift the hoisted production node_modules straight from the deps stage.
# We deliberately do NOT run `npm prune` post-install; trimming here would
# re-introduce drift from CI's view of the graph.
COPY --from=deps /repo/node_modules ./node_modules
COPY services/gymtrack-mcp/package.json ./package.json
COPY services/gymtrack-mcp/src ./src

# The MCP implementation reuses GymTrack's canonical server-side data
# helpers. This absolute path matches the existing
# ../../../apps/gymtrack/server import in src/mcpTools.js.
COPY apps/gymtrack/server/agentData.js /apps/gymtrack/server/agentData.js

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/server.js"]
