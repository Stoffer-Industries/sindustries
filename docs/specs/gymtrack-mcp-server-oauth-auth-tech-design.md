---
status: draft
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
- Branch: `task-1474d515-gymtrack-mcp-server-oauth-auth`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must register GymTrack as an OAuth client in the Supabase project (per-provider: Google, Apple) and configure the redirect URIs Claude and ChatGPT use (boundary lives outside this repo).

## Scope

GymTrack has no MCP server and no self-service key issuance — every agent credential in use has been hand-issued via direct Supabase service-role insert. This task ships:

1. A real MCP server that an external agent (Claude, ChatGPT, any MCP-compatible client) can connect to.
2. A self-service OAuth authorization flow so any user can grant an agent access without a manual provisioning step.
3. Per-user data isolation enforced server-side (RLS or equivalent) so an agent authorized for one user cannot read or write another user's data.
4. A migration path for the existing REST endpoints (`/api/agent/planned-workouts`, `/api/agent/history`, `/api/agent/exercises/:name/progression`) so the agent-powered-workouts feature shipped in task `f520c396` does not silently break.

## Ownership boundary

- The MCP server is a new component. It belongs in `apps/gymtrack/` next to the existing app, or extracted as `services/gymtrack-mcp/`. Extraction is preferred because the MCP surface is a separate process from the web app and has different scaling/auth characteristics. Extract now — do not introduce a temporary placement.
- OAuth provider config is a Supabase project concern, owned by Quinn (`.openclaw`).
- Per-user agent credentials are a database concern. New tables live alongside the existing user-data tables in `apps/gymtrack/supabase/migrations/`.

## Implementation plan

File/module scope:

- `services/gymtrack-mcp/` — new service. Layout:
  - `src/index.ts` — HTTP entrypoint with the MCP JSON-RPC handler.
  - `src/mcp/tools.ts` — defines the three MCP tools: `plan_workout`, `read_history`, `read_exercise_progression`. Mirrors the existing REST endpoints' behavior so the same client SDK could target either.
  - `src/auth/oauth.ts` — OAuth flow handlers: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`. Implements Authorization Code with PKCE.
  - `src/auth/requireAgentCredential.ts` — middleware. Validates the bearer token issued by `/oauth/token`, loads the `agent_connection` row, asserts the connection is active and not revoked.
  - `src/auth/perUserScope.ts` — wraps every tool call so RLS-equivalent checks enforce `auth.user_id = requested_owner_id`. Uses the existing Supabase row-level security.
  - `test/` — Vitest + Playwright for the OAuth happy path and cross-user isolation.
- `apps/gymtrack/supabase/migrations/<timestamp>_agent_connections.sql` — new table `agent_connections(id, user_id, provider, access_token_hash, refresh_token_hash, scope, created_at, revoked_at)`. Index on `user_id` and `access_token_hash`. RLS: users can read/write only their own rows; the MCP service uses a service-role key.
- `apps/gymtrack/supabase/migrations/<timestamp>_oauth_clients.sql` — table `oauth_clients(client_id, provider, redirect_uri, created_at)`. Seeded via migration with the Claude and ChatGPT redirect URIs.
- `apps/gymtrack/api/agent/legacy-shim.ts` — adapter. Existing REST endpoints (`/api/agent/planned-workouts`, `/api/agent/history`, `/api/agent/exercises/:name/progression`) now check for either a legacy API key (issued pre-this-task) OR an MCP-issued bearer token. Legacy keys are accepted for 90 days post-launch; a deprecation header `X-GymTrack-Deprecated: true` is returned on legacy-key calls so clients can migrate. After 90 days the legacy path returns 410 Gone. Documented in `apps/gymtrack/README.md`.
- `apps/gymtrack/src/settings/ConnectedAgents.tsx` — new settings page listing the user's connected agents with a "Revoke" button per row.
- `apps/gymtrack/src/auth/oauthStart.ts` — front-end helper that drives the OAuth start button (used by sibling task `2306125e`'s CTA).
- `apps/gymtrack/SPEC.md` — add a new flow "Connect an agent" describing AC1–AC5.
- `apps/gymtrack/README.md` — note on the MCP endpoint URL, OAuth client IDs, and the 90-day legacy migration window.

## Data model / API contract

- New tables: `agent_connections`, `oauth_clients` (RLS-protected; MCP service uses service-role key).
- New endpoints (under `services/gymtrack-mcp`):
  - `POST /mcp` — JSON-RPC; tool listing + invocation.
  - `GET /oauth/authorize` — start the authorization code flow.
  - `POST /oauth/token` — exchange code for access + refresh tokens.
  - `POST /oauth/revoke` — revoke a connection.
- New front-end route: `/settings/connected-agents`.
- Existing REST endpoints remain functional during the 90-day migration window (with `X-GymTrack-Deprecated: true`).

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — MCP server reachable from external MCP-compatible client; tools discoverable | Integration test: MCP client SDK (e.g. `@modelcontextprotocol/sdk`) lists tools, asserts `plan_workout`, `read_history`, `read_exercise_progression` are present. |
| AC2 — user can authorize an agent via OAuth (not a hand-copied key); scoped, revocable credential; user can see and revoke from settings | E2E: user signs in, clicks Connect Claude, completes OAuth, lands back with a row in `ConnectedAgents`; clicks Revoke, asserts the bearer token is rejected on the next MCP call. |
| AC3 — sign-in for the auth flow supports social login (Google or Apple) | E2E: covers the same path as AC2 but starts from Google OAuth sign-in rather than email/password. Apple path is provider-config dependent and tested as a smoke if Quinn has provisioned it. |
| AC4 — per-user data isolation enforced server-side; cross-user read/write impossible | Security test: agent A is authorized for user A; A's bearer token attempts to read user B's workouts → 403 with no data leakage. Repeat for write. |
| AC5 — existing REST endpoints continue to work for already-issued credentials OR are cleanly migrated; no silent breakage of f520c396 | Integration test: legacy API key still returns 200 on the three endpoints; `X-GymTrack-Deprecated: true` header is present. Migrated credential works without the header. |

User-visible ACs: AC2, AC3, AC4, AC5 are user-visible or user-facing. AC1 is integration-only. E2E planned for AC2, AC3, AC5. AC4 is a security test (integration).

## Open questions and risks

- **Provider parity**: Claude and ChatGPT use different OAuth metadata conventions. The MCP server must speak the right dialect to each. We implement a small adapter layer (`src/auth/providers/{claude,chatgpt}.ts`) rather than a one-size-fits-all handler.
- **Token storage**: bearer tokens for agent connections are sensitive. Store hashed (same SHA-256 + salt approach as session tokens). Never log raw tokens. This is enforced by the auth middleware's logger config.
- **Legacy key window**: 90 days is a guess. If the rollout shows clients are slow to migrate, extend the window. The deprecation header gives clients a clear signal.
- **Sibling task dependency**: the Workouts tab CTA (`2306125e`) calls into this task's OAuth start. If that task lands first, the CTA points at a thin stub until this merges.

## Linked spec / tasks

- `brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md`
- Sibling task: `2306125e` — GymTrack Workouts Tab with "Connect to Your Agent" CTA.
- Sibling task: `72d7cc3b` — GymTrack Public Sign-Up with Social Login (shares OAuth provider config).
- Predecessor task: `f520c396` — GymTrack Agent-Powered Workouts (existing REST endpoints).