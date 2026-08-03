# GymTrack

**Status:** Live (SPA + legacy REST agent API) / Draft rollout on branch `task-1474d515-gymtrack-mcp-server-oauth-redo` (MCP OAuth server)
**Last updated:** 2026-08-04
**Owner:** Rowan (engineering) · Tom (product)
**Repos:** `Stoffer-Industries/sindustries`
**Related tasks:** `18256740`, `f520c396`, `72d7cc3b`, `1474d515`
**Related tech designs:**
- [GymTrack MVP](../specs/gymtrack-mvp-tech-design.md)
- [Agent-powered workouts](../specs/gymtrack-agent-powered-workouts-tech-design.md)
- [Public signup + social login](../specs/gymtrack-public-signup-social-login-tech-design.md)
- [MCP server + OAuth auth](../specs/gymtrack-mcp-server-oauth-auth-tech-design.md)

---

## What this is

GymTrack is a Supabase-backed workout tracker SPA (`apps/gymtrack`) plus two server-side agent integration surfaces:

1. **Legacy REST endpoints** under `apps/gymtrack/api/agent/*` that authenticate a static bearer key from `public.gymtrack_agent_api_keys`.
2. **A dedicated MCP OAuth server** under `services/gymtrack-mcp` that exposes tool discovery and invocation through JSON-RPC, with OAuth 2.1 Authorization Code + PKCE, hashed tokens, refresh-token rotation, and user revocation.

The browser app remains the user-facing product. The MCP service is a separate machine-facing boundary that uses the same Supabase project and the same per-user data model.

---

## Architecture and ownership

### Code

- `apps/gymtrack/` — Vite + React SPA, Supabase browser client, public sign-up/sign-in, workout logging/history/planned-workout UI, and the new `AgentConsentPage` + `ConnectedAgentsPage`.
- `apps/gymtrack/api/agent/*` — legacy REST handlers kept stable for task `f520c396` compatibility.
- `apps/gymtrack/server/agentAuth.js` — static-key auth lookup for the legacy REST surface.
- `apps/gymtrack/server/agentData.js` — shared data access/validation used by both the legacy REST handlers and the new MCP service so behaviour cannot drift silently.
- `services/gymtrack-mcp/src/app.js` — Express app exposing OAuth metadata, `/oauth/*`, and `/mcp`.
- `services/gymtrack-mcp/src/mcpTools.js` — MCP tool registry and per-tool scope enforcement.
- `services/gymtrack-mcp/src/repo.js` — Supabase-backed repository for OAuth clients, consents, codes, and tokens.
- `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` — static clients + consent/code/token schema + RLS.

### Service boundary

GymTrack owns its own domain in `apps/gymtrack` and its Supabase project. The MCP server is a separate runtime because it has a different transport and auth lifecycle from the browser SPA, but it still belongs to the GymTrack product boundary rather than to `services/tasks-api` or another shared backend.

The MCP service owns:

- OAuth authorization, token exchange, refresh rotation, and revocation for GymTrack agent access
- MCP tool discovery and invocation
- Verification that OAuth bearer tokens map to a single GymTrack user

The SPA owns:

- Human sign-in/sign-up UX
- Consent review UX (`/agent-consent`)
- Connected-agent visibility and revocation UX (`/settings/agents`)
- Workout logging, history, and planned-workout browsing

---

## Runtime behaviour and operational flow

### Browser auth and consent

1. The user signs in to GymTrack via Supabase Auth (email/password or Google).
2. An external MCP client starts OAuth against `services/gymtrack-mcp`.
3. `/oauth/authorize` validates the client + redirect URI + PKCE parameters, then redirects the browser into `apps/gymtrack` at `/agent-consent`.
4. The app checks the Supabase session via `<AuthGate>`; if needed, it redirects through `/login` and preserves the full destination.
5. `AgentConsentPage` loads the client metadata from `public.gymtrack_oauth_clients`, then POSTs the user's approve/deny decision back to the MCP service with the current Supabase access token.
6. The MCP service verifies that Supabase token server-side, creates or updates `gymtrack_oauth_consents`, stores a hashed authorization code, and returns the client redirect URL.

### OAuth token lifecycle

1. The external client exchanges the authorization code at `POST /oauth/token` with `code_verifier`.
2. GymTrack validates PKCE, checks consent status, and issues:
   - a short-lived access token;
   - a long-lived refresh token.
3. Only SHA-256 hashes are stored in `public.gymtrack_oauth_tokens`; plaintext tokens are never written to the database.
4. `grant_type=refresh_token` rotates the refresh token. Re-using an already-rotated refresh token revokes the whole consent family.
5. `POST /oauth/revoke` revokes the full consent family for the presented token.
6. Browser-side revocation from `/settings/agents` sets `consent.revoked_at`; every MCP access-token validation and refresh exchange checks that field, so revoked connections stop working immediately.

### MCP tool flow

1. The external client calls `POST /mcp` with `Authorization: Bearer <oauth access token>`.
2. The MCP service hashes the token, loads the token row and consent row, verifies expiry and revocation, and derives the acting `user_id` from the token record.
3. `tools/list` advertises:
   - `plan_workout`
   - `read_history`
   - `read_exercise_progression`
4. `tools/call` dispatches into `apps/gymtrack/server/agentData.js`, which reuses the same validation and Supabase query logic the legacy REST handlers use.
5. The acting user is always the token's `user_id`; tool arguments never supply the owner id, which is how the service enforces per-user isolation.

### Legacy REST compatibility

The existing `/api/agent/planned-workouts`, `/api/agent/history`, and `/api/agent/exercises/:name/progression` routes still authenticate only against `public.gymtrack_agent_api_keys`. Their request/response contracts are unchanged, which preserves existing integrations from task `f520c396`.

---

## Data contracts

### Supabase tables

| Table | Purpose | Notes |
|---|---|---|
| `workouts` | Logged workout sessions | `user_id`-scoped via RLS |
| `workout_sets` | Logged sets | Scoped through parent workout |
| `planned_workouts` | Planned workout shells | Shared by legacy REST and MCP |
| `planned_workout_sets` | Planned target sets | Shared by legacy REST and MCP |
| `gymtrack_agent_api_keys` | Legacy static REST credentials | Hashed token only |
| `gymtrack_oauth_clients` | MCP client allowlist | Static redirect-URI registration |
| `gymtrack_oauth_consents` | User-visible MCP connections | One active consent per user/client |
| `gymtrack_oauth_authorization_codes` | PKCE-bound authorization codes | Hashed code only |
| `gymtrack_oauth_tokens` | Access + refresh tokens | Hashed tokens only; family metadata for rotation/replay detection |

### MCP tools

| Tool | Required scope | Behaviour |
|---|---|---|
| `plan_workout` | `workouts:write` | Creates a `planned_workouts` row and child `planned_workout_sets` rows for the token's user |
| `read_history` | `history:read` | Reads recent workouts and set history for the token's user |
| `read_exercise_progression` | `progression:read` | Reads per-exercise progression for the token's user |

### OAuth metadata

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- Public-client OAuth only (`token_endpoint_auth_methods_supported: ["none"]`)
- Authorization Code + PKCE (`code_challenge_method=S256`)
- Supported scopes: `workouts:write`, `history:read`, `progression:read`

---

## Runbook notes and failure modes

### Required env/config

SPA (`apps/gymtrack`):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GYMTRACK_MCP_BASE_URL` when the MCP service is on a different origin

MCP service (`services/gymtrack-mcp`):
- `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GYMTRACK_MCP_ISSUER`
- `GYMTRACK_APP_URL`
- `GYMTRACK_WEB_ORIGIN`

### Common failure modes

- **Supabase Google provider not configured** — Google buttons exist in the UI, but the backend provider wiring still lives outside this repo. The button-level `providerDisabled` heuristic degrades gracefully if the provider is missing.
- **MCP client redirect URI mismatch** — `/oauth/authorize` returns `invalid_client` / `redirect_uri is not registered`. Fix the row in `gymtrack_oauth_clients` (or add the right client metadata before rollout).
- **Consent appears revoked but a client still holds a token** — expected: the client may still possess the old plaintext token, but MCP requests fail because the service checks `consent.revoked_at` at request time.
- **Refresh-token replay** — the family is revoked. The user must reconnect the client through the browser flow.
- **Missing service-role key** — both legacy REST and MCP OAuth server fail closed; they do not fall back to browser anon auth for server-side routes.

### Manual checks after deploy

1. Hit `GET /.well-known/oauth-authorization-server` and confirm issuer + endpoints are correct.
2. Start an OAuth flow from a registered client and confirm `/agent-consent` loads with the expected scopes.
3. Approve, exchange the code, call `tools/list`, then revoke from `/settings/agents` and verify the same token stops working.
4. Re-run the three legacy REST curl examples from `apps/gymtrack/README.md` with an existing static key.

---

## Related specs, tasks, and PRs

- Tasks: `18256740`, `f520c396`, `72d7cc3b`, `1474d515`
- Tech designs:
  - `docs/specs/gymtrack-mvp-tech-design.md`
  - `docs/specs/gymtrack-agent-powered-workouts-tech-design.md`
  - `docs/specs/gymtrack-public-signup-social-login-tech-design.md`
  - `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`
- Current implementation branch: `task-1474d515-gymtrack-mcp-server-oauth-redo`
