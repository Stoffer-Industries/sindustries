---
status: approved
task_id: 1474d515-041b-4df0-bfd4-6ac727b6840a
product_spec: brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md
shipped_pr: null
shipped_date: null
---

# GymTrack MCP Server with OAuth Auth

## Links

- Product spec: `brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md`
- Tech design: `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`
- Task: `1474d515-041b-4df0-bfd4-6ac727b6840a`
- Tasks API record: `http://localhost:4001/api/v1/tasks/1474d515-041b-4df0-bfd4-6ac727b6840a`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-1474d515-gymtrack-mcp-server-oauth-redo`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-1474d515-gymtrack-mcp-server-oauth-redo`
- Expected `.openclaw` follow-up: Quinn must ensure Google OAuth is enabled in the GymTrack Supabase project and that the real Claude / ChatGPT redirect URIs are registered in `public.gymtrack_oauth_clients` before production rollout.

## Scope

GymTrack has no MCP server and no self-service key issuance — every agent credential in use has been hand-issued via direct Supabase service-role insert. This task ships:

1. A real MCP server that an external agent (Claude, ChatGPT, any MCP-compatible client) can connect to.
2. A self-service OAuth authorization flow so any user can grant an agent access without a manual provisioning step.
3. Per-user data isolation enforced server-side so an agent authorized for one user cannot read or write another user's data.
4. A migration path for the existing REST endpoints (`/api/agent/planned-workouts`, `/api/agent/history`, `/api/agent/exercises/:name/progression`) so the agent-powered-workouts feature shipped in task `f520c396` does not silently break.

## Ownership boundary

- GymTrack keeps ownership of workout data, planned-workout data, and OAuth consent/token tables in its Supabase project.
- The MCP server is a separate runtime under `services/gymtrack-mcp/` because it has a different transport/auth surface than the browser SPA, but it still belongs to the GymTrack product boundary.
- OAuth provider config remains a Supabase / deployment concern outside this repo.

## Implementation plan

### `services/gymtrack-mcp/`

- `src/app.js` — Express app exposing:
  - `GET /.well-known/oauth-authorization-server`
  - `GET /.well-known/oauth-protected-resource`
  - `GET /oauth/authorize`
  - `POST /oauth/token`
  - `POST /oauth/revoke`
  - `POST /mcp`
- `src/repo.js` — Supabase-backed repo for client rows, consent rows, auth codes, tokens, rotation, and revocation.
- `src/mcpTools.js` — three tools (`plan_workout`, `read_history`, `read_exercise_progression`) with per-scope enforcement.
- `test/app.test.js` — integration coverage for OAuth authorize/token/refresh/revoke plus MCP tool discovery/isolation.

### `apps/gymtrack/`

- `src/components/LoginScreen.jsx` — protected-route sign-in now also offers Google OAuth so the `/agent-consent` flow can start from social login, not only email/password.
- `src/components/AgentConsentPage.jsx` — review-and-approve screen for external MCP clients.
- `src/components/ConnectedAgentsPage.jsx` — account settings surface listing active MCP consents with revoke actions.
- `src/lib/connectedAgents.js` — browser-side Supabase queries for client metadata + consent listing/revocation, plus POST helper for approval decisions.
- `src/lib/authFlow.js` — accepts caller-provided post-OAuth redirect target so protected flows return to `/agent-consent`.
- `src/App.jsx`, `src/components/WorkoutsTab.jsx` — new routes and navigation entry to the Agents screen.
- `server/agentData.js` — shared planned-workout/history/progression query logic used by both the legacy REST surface and the MCP service.
- `api/agent/*.js` — thin wrappers updated to call the shared server module so legacy behaviour and MCP behaviour share one implementation.

### Supabase schema

- `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql`
  - `gymtrack_oauth_clients`
  - `gymtrack_oauth_consents`
  - `gymtrack_oauth_authorization_codes`
  - `gymtrack_oauth_tokens`
  - RLS policies for all new user-scoped tables
  - Seed rows for `claude-desktop`, `chatgpt`, and `local-dev`

## Data model / API contract

### OAuth

- Authorization Code + PKCE (`S256`) only.
- Public clients only (`token_endpoint_auth_methods_supported = ["none"]`).
- Access tokens are short-lived; refresh tokens rotate on every use.
- Only SHA-256 hashes of authorization codes, access tokens, and refresh tokens are stored.
- Consent revocation is the root kill-switch: every MCP call and refresh exchange checks `consent.revoked_at`.

### MCP

- Transport: JSON-RPC over `POST /mcp`.
- Supported methods:
  - `initialize`
  - `tools/list`
  - `tools/call`
- Supported tools:
  - `plan_workout`
  - `read_history`
  - `read_exercise_progression`

### Legacy REST compatibility

The existing `/api/agent/*` endpoints remain unchanged for already-issued static keys. They continue to authenticate through `gymtrack_agent_api_keys` and return the same request/response shapes. The MCP server is additive rather than a replacement.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 | `services/gymtrack-mcp/test/app.test.js` proves `tools/list` returns the three GymTrack tools and `tools/call` dispatches through the MCP server. |
| AC2 | The same service test covers `/oauth/authorize`, `/oauth/token`, refresh rotation, and consent-family revocation; `src/components/ConnectedAgentsPage.test.jsx` covers the browser revoke UI. |
| AC3 | Existing Google social-login coverage (`apps/gymtrack/test/e2e/signup-google.spec.ts`) plus the login-screen redirect wiring ensure the protected-route auth flow can start with Google. |
| AC4 | `services/gymtrack-mcp/test/app.test.js` asserts the acting `userId` comes from the bearer token identity, not from tool arguments. RLS remains in place on the underlying tables. |
| AC5 | Existing legacy REST handler tests continue to run; the handlers now delegate to `server/agentData.js` but keep the same static-key auth contract. |

## Risks and notes

- ChatGPT callback URLs may still need real-environment registration before production; the seeded row is a starting point, not a guarantee that the provider-side callback config is complete.
- Apple social login remains intentionally disabled until Supabase provider wiring exists.
- Dynamic client registration is explicitly out of scope for this slice.
