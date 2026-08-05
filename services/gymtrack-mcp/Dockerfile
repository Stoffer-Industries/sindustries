FROM node:22-alpine AS base
WORKDIR /app

COPY services/gymtrack-mcp/package.json ./package.json
RUN npm install --omit=dev

COPY services/gymtrack-mcp/src ./src
# The MCP implementation reuses GymTrack's canonical server-side data helpers.
# This absolute path matches the existing ../../../apps/gymtrack/server import.
COPY apps/gymtrack/server/agentData.js /apps/gymtrack/server/agentData.js

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/server.js"]
