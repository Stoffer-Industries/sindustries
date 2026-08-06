# GymTrack

A multi-tenant workout tracker SPA backed by Supabase. Users can sign up with email/password or Google, log workouts, browse planned workouts, and now review/revoke connected MCP clients from the in-app **Agents** settings screen.

GymTrack also exposes two agent surfaces:

- **Legacy REST endpoints** under `/api/agent/*` for already-issued static bearer keys.
- **A dedicated MCP OAuth server** in `services/gymtrack-mcp` for discoverable tool access via OAuth Code + PKCE.

## Stack

- Vite + React 18 + React Router
- Supabase (Auth + Postgres)
- Vitest + React Testing Library
- Playwright (mobile emulation)

## Development

```bash
npm install
npm --workspace gymtrack run dev
# → http://localhost:5179
```

Required app env vars (`apps/gymtrack/.env`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GYMTRACK_MCP_BASE_URL` when the MCP service is on a different origin than the SPA

See `.env.example`.

## Test

```bash
npm --workspace gymtrack test
npm --workspace gymtrack run test:e2e
npm --workspace @sindustries/gymtrack-mcp test
```

## Build

```bash
npm --workspace gymtrack run build
npm --workspace gymtrack run preview
```

## Supabase

See `supabase/README.md` for migration apply steps.

New schema for task `1474d515` lives in:

- `supabase/migrations/20260804070000_mcp_oauth.sql`

That migration adds:

- `gymtrack_oauth_clients`
- `gymtrack_oauth_consents`
- `gymtrack_oauth_authorization_codes`
- `gymtrack_oauth_tokens`

All user-owned tables are RLS-protected.

## Browser auth UX

- `/login` supports email/password and Google sign-in.
- `/signup` supports Google sign-up plus a collapsed email/password fallback.
- `/workouts` shows a **Connect to your agent** CTA when the signed-in user has no active MCP consent. Claude and ChatGPT links open the provider's real connector setup, where that client creates the OAuth state + PKCE request.
- `/agent-consent` is the protected approval page used by external MCP clients.
- `/settings/agents` lists active MCP connections and lets the user revoke them.

Production provider setup and exact URLs/client IDs are documented in [`docs/runbooks/gymtrack-agent-connect.md`](../../docs/runbooks/gymtrack-agent-connect.md).

Apple remains hidden until Quinn removes `'apple'` from `src/lib/authFlow.js` after the Supabase provider is wired.

## Legacy REST agent API

These routes still work unchanged for existing static bearer keys:

```bash
curl -X POST https://<deployment>/api/agent/planned-workouts \
  -H "Authorization: Bearer gym_sk_example..." \
  -H "Content-Type: application/json" \
  -d '{
    "scheduledFor": "2026-08-01",
    "title": "Upper Body Strength",
    "exercises": [
      { "name": "Bench Press", "sets": [{ "reps": 8, "weight": 80, "unit": "kg" }] }
    ]
  }'

curl https://<deployment>/api/agent/history?limit=10 \
  -H "Authorization: Bearer gym_sk_example..."

curl https://<deployment>/api/agent/exercises/Bench%20Press/progression?limit=20 \
  -H "Authorization: Bearer gym_sk_example..."
```

## MCP OAuth server

See `services/gymtrack-mcp/README.md` for runtime details. At a high level it exposes:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `POST /mcp`

Available MCP tools:

- `plan_workout`
- `read_history`
- `read_exercise_progression`

## Files of interest

- `src/App.jsx` — routes, including `/agent-consent` and `/settings/agents`
- `src/components/LoginScreen.jsx` — email/password + Google sign-in
- `src/components/AgentConsentPage.jsx` — MCP approval screen
- `src/components/ConnectedAgentsPage.jsx` — connected-agent management UI
- `src/lib/connectedAgents.js` — consent listing/revocation + approval POST helper
- `server/agentData.js` — shared query/validation logic for legacy REST + MCP
- `api/agent/*` — legacy static-key handlers
- `services/gymtrack-mcp/` — standalone MCP OAuth service
