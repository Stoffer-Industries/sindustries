# GymTrack — Behavioural spec

Task: `18256740` (Shape GymTrack MVP from saved prototype), `f520c396` (Agent-Powered Workouts), `72d7cc3b` (Public Sign-Up with Social Login), `1474d515` (GymTrack MCP Server with OAuth Auth), `2306125e` (Workouts Tab with Connect to Your Agent CTA).
Tech design: `docs/specs/gymtrack-mvp-tech-design.md`, `docs/specs/gymtrack-agent-powered-workouts-tech-design.md`, `docs/specs/gymtrack-public-signup-social-login-tech-design.md`, `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`, `docs/specs/gymtrack-workouts-tab-connect-agent-cta-tech-design.md`.
Product spec: `brain/tasks/specs/gymtrack-mvp-2026-07-07.md`, `brain/tasks/specs/in-progress/gymtrack-agent-powered-workouts.md`, `brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md`, `brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md`, `brain/tasks/specs/in-progress/gymtrack-workouts-tab-connect-agent-2026-07-27.md`.

## Overview

GymTrack is a workout tracker SPA deployed at a stable URL, accessible from iOS Safari without an app install. Workouts are persisted in Supabase, scoped per-user via RLS. Any visitor can create their own account via a public sign-up page — GymTrack is a real multi-tenant product, not a single-user app.

GymTrack now exposes **two agent surfaces**:

1. **Legacy REST agent endpoints** under `/api/agent/*` for already-issued static bearer keys from task `f520c396`.
2. **A discoverable MCP server** (`services/gymtrack-mcp`) that uses OAuth 2.1 Authorization Code + PKCE, issues hashed access/refresh tokens, and lets a user approve or revoke an external client without any manual database work.

The user-facing app surfaces planned workouts (created via either agent surface), lets the user log actuals against planned sets, and now includes an **Agents** settings screen where the user can see and revoke connected MCP clients.

## Users

- **Anyone** — can self-sign-up at `/signup` with email + password or Google. Apple is gated on the Supabase project having Apple configured — currently disabled, so the Apple button is not rendered.
- **Existing GymTrack users** — can sign in at `/login` with email + password, or with Google when the flow originates from a protected route such as `/agent-consent`.
- **MCP clients** — authenticate through the GymTrack MCP OAuth flow. The issued bearer token is scoped to one GymTrack user and one consent record; it can discover tools, plan workouts, read history, and read exercise progression, but only for that user. The same OAuth token is accepted by both the MCP server (`/mcp`) and the REST endpoints under `/api/agent/*`.

## Flows

### Sign up

1. An unauthenticated visitor can reach `/signup` directly or from the `/login` link.
2. The page renders Google as the primary OAuth CTA. Apple stays hidden while it remains in `DISABLED_OAUTH_PROVIDERS`.
3. A collapsed "Use email + password instead" panel reveals the fallback form.
4. On success, Supabase creates the user and the visitor is redirected to `/workout` or to the originally intended protected destination.
5. Errors render inline and the buttons re-enable for retry.

### Sign in

1. Open the app while signed out → land on `/login`.
2. Sign in with email + password, or with Google when continuing into a protected route.
3. On success → redirect to `/workout` or back to the protected destination that triggered the redirect.
4. On error → inline error banner; controls re-enable.

### Connect and authorize an external MCP client

1. When `/workouts` finds no active OAuth consent, it shows **Connect to your agent** with explicit Claude and ChatGPT options, the remote MCP URL, and each seeded public client ID.
   - **Claude deep link.** `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=<name>&connectorUrl=<url>` — the contract Anthropic actually shipped, per the maintainer's closing comment on [anthropics/claude-ai-mcp#74](https://github.com/anthropics/claude-ai-mcp/issues/74) (@localden, 2026-05-13). The path (`/customize/connectors`) and param names (`connectorName`, `connectorUrl`) are load-bearing: the earlier proposal in that issue's opener used `/settings/connectors?mcpName=...&mcpServerUrl=...`, which Anthropic did *not* ship. With the wrong shape the Add Custom Connector modal opens generically without pre-filling the Name and Remote MCP server URL fields. `connectorName` is the seeded OAuth client display name; `connectorUrl` is the GymTrack MCP base URL with `/mcp` appended (URL-encoded). The link opens Claude's Add Custom Connector modal with both fields pre-filled.
   - **ChatGPT option.** Pending removal from the CTA entirely; tracked under task `5d3c5c57-c483-4d16-beeb-7f2b176d47ad`. OpenAI's custom MCP connector is documented for Business / Enterprise / Edu tiers only, not normal/plus accounts; the previously-linked `/admin/ca` path 404s to the ChatGPT home page for the users GymTrack targets. The ChatGPT option is intentionally left in place in this PR so the removal ships in a dedicated follow-up. See `docs/runbooks/gymtrack-agent-connect.md` § Provider-URL drift for the operator live-UI verification step on the Claude link.
2. Selecting a provider opens its real MCP connector configuration. The user adds `https://gymtrack-mcp.fly.dev/mcp`; the external client generates OAuth state + a PKCE challenge and starts OAuth against `GET /oauth/authorize` on the GymTrack MCP server.
3. The MCP server validates `client_id`, `redirect_uri`, requested `scope`, and PKCE (`code_challenge`, `code_challenge_method=S256`), then redirects the browser into GymTrack at `/agent-consent?...`.
4. If the user is not signed in, `<AuthGate>` redirects them to `/login`, preserving the full consent URL. The user can continue with Google or email/password and lands back on `/agent-consent`.
5. `/agent-consent` shows the client name, redirect URI, and requested scopes.
6. Approve → GymTrack POSTs the decision to the MCP server with the signed-in Supabase access token; the MCP server verifies the user session, creates/updates the consent row, stores a hashed authorization code, and returns the client redirect URL with `code` and `state`.
7. Cancel → the user is redirected back with `error=access_denied`.
8. The external client exchanges the code at `POST /oauth/token` with a PKCE verifier. GymTrack returns a short-lived bearer access token plus a rotated refresh token. Plaintext tokens are never stored in Supabase.

### Manage connected agents

1. From `/workouts`, tap the **Agents** tab to open `/settings/agents`.
2. The page lists active MCP consents, newest first, showing client name, granted time, requested scopes, and last-used time when available.
3. Tap **Revoke access** → the consent row is marked revoked immediately.
4. Any future MCP tool call or refresh-token exchange for that consent fails because the server checks `consent.revoked_at` on every use.

### Log a workout

1. From `/workout`, the date defaults to today.
2. Pick an exercise from the catalogue or choose "Other" and type a custom name.
3. Enter reps and weight; select kg/lb.
4. Tap "Add set" → the set appears under "In this workout", grouped by exercise.
5. Repeat for additional sets/exercises. Remove a set via its Remove button.
6. Tap "Save workout" → creates the workout + all sets in Supabase.
7. On success → success banner; pending list cleared.
8. On error → error banner; pending list retained so the user can retry.

### View history

1. From `/history`, the last 30 days of workouts load.
2. Workouts are grouped by date (newest first). Each workout shows its set count and the per-set breakdown.
3. Empty state: "No workouts in the last 30 days. Log one from the Log tab."

### Browse planned workouts

1. From `/workout` or `/history`, tap the "Workouts" tab → land on `/workouts`.
2. The page fetches the signed-in user's pending planned workouts (`planned` or `started`), ordered soonest-first by `scheduled_for` ascending.
3. Each workout renders as a card with title, scheduled date, exercise/set summary, and Today/Overdue badge when relevant.
4. If there is no active agent consent, the provider-specific connection CTA appears independently of whether pending workouts exist.
5. Empty state: "No upcoming workouts yet. Once connected, your agent can plan one for you."
6. Tap a workout card → land on `/workout?date=YYYY-MM-DD`; if a plan exists for that date, plan mode is rendered.
7. Error state: inline error banner with retry by reload.

### Log a workout against a plan

1. From `/workout`, if a planned workout exists for the selected date (`planned`/`started`), the screen renders plan mode instead of the freeform form.
2. Plan mode shows the plan title and optional notes, then one table per exercise. Each row shows target reps/weight and editable actual inputs pre-filled from the target values.
3. An "Add an extra (non-planned) set" form remains available below the plan.
4. Tap "Save workout" → creates a `workouts` row linked to the plan and one `workout_sets` row per planned set, plus any extra freeform sets. The plan is marked `completed`.
5. On success → success banner; completed plans no longer re-render for that date.
6. If no plan exists for the selected date, the screen falls back to freeform logging.

### Sign out

- From `/workout`, tap "Sign out" → session cleared → redirect to `/login`.

## Screens

| Route | Component | Notes |
|---|---|---|
| `/` | redirect | → `/workout` if signed in, else `/login`. |
| `/login` | `LoginScreen` | Email/password form plus Google CTA when available; preserves protected-route destination. |
| `/signup` | `SignUpPage` | Public sign-up — Google CTA + collapsed email/password panel. |
| `/agent-consent` | `AgentConsentPage` | Protected consent review screen for external MCP clients. |
| `/workout` | `WorkoutLogger` | Date picker + exercise picker + pending sets; accepts `?date=YYYY-MM-DD`. |
| `/history` | `HistoryList` | Last-30-days grouped history. |
| `/workouts` | `WorkoutsTab` | Pending planned workouts, soonest-first, with Today/Overdue badges; users with no active consent also see the Claude connector deep link. The ChatGPT option on the same CTA is pending removal (task `5d3c5c57-c483-4d16-beeb-7f2b176d47ad`) — see "Connect and authorize an external MCP client" §1. |
| `/settings/agents` | `ConnectedAgentsPage` | Lists and revokes active MCP consents. |
| `*` | redirect | → `/`. |

All protected routes (`/workout`, `/history`, `/workouts`, `/agent-consent`, `/settings/agents`) are wrapped in `<AuthGate>` which renders a loading placeholder while the session resolves and redirects to `/login` when no session exists.

## Persistence

- `public.workouts` — one row per workout session. RLS: `auth.uid() = user_id`.
- `public.workout_sets` — one row per set. RLS via parent `workouts.user_id = auth.uid()`.
- `public.planned_workouts` / `public.planned_workout_sets` — planned workout state created by MCP clients via OAuth. `planned_workouts.consent_id` (FK → `gymtrack_oauth_consents.id`) records which connected agent authored the plan.
- `public.gymtrack_oauth_clients` — static allowlist of supported MCP clients and their registered redirect URIs.
- `public.gymtrack_oauth_consents` — one active consent per `user_id + client_id`; drives the Agents settings page and is the only credential path for agent access to workout data.
- `public.gymtrack_oauth_authorization_codes` — hashed authorization codes with PKCE challenge metadata.
- `public.gymtrack_oauth_tokens` — hashed access/refresh tokens, refresh-token family ids, rotation metadata, and revocation timestamps.

## Auth

- Supabase Auth remains the browser identity layer.
- Email/password sign-in and sign-up continue to work.
- Google OAuth is the minimum social-login path for both public sign-up and protected-route sign-in.
- `detectSessionInUrl: true` handles Supabase OAuth callback parsing.
- Apple remains disabled until Quinn removes `'apple'` from `DISABLED_OAUTH_PROVIDERS` after provider wiring exists in Supabase.

## Error handling

- Browser helpers return `{ data, error }` for Supabase queries and render inline banners on failure.
- The app fails fast at startup if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing.
- MCP OAuth endpoints return standard OAuth JSON errors (`invalid_request`, `invalid_grant`, etc.).
- MCP JSON-RPC errors use standard JSON-RPC envelopes with GymTrack-specific messages.

## Agent surfaces

### OAuth-protected REST endpoints

Server-side endpoints under `apps/gymtrack/api/agent/`, implemented in `apps/gymtrack/server/oauthAuth.js` plus per-route handlers.

- `POST /api/agent/planned-workouts` (scope: `workouts:write`)
- `GET /api/agent/history?limit=1..50` (scope: `history:read`)
- `GET /api/agent/exercises/:exerciseName/progression?limit=1..200` (scope: `progression:read`)

Every route authenticates with `Authorization: Bearer <oauth access token>` and resolves the caller through `gymtrack_oauth_tokens` + `gymtrack_oauth_consents` (both checked for `revoked_at` and active expiry on every request). The resolved identity is `{ user_id, consent_id, client_id, scope }`. Scope enforcement is per-route and per-method — `plan_workout` requires `workouts:write`, `read_history` requires `history:read`, `read_exercise_progression` requires `progression:read`. The legacy static-key credential system was decommissioned in task `1eb6e48c`; OAuth is the only credential path for agent access to workout data.

### MCP server

`services/gymtrack-mcp` exposes:

- `POST /mcp` — JSON-RPC endpoint supporting `initialize`, `tools/list`, and `tools/call`.
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`

Available tools:

- `plan_workout`
- `read_history`
- `read_exercise_progression`

The MCP server always derives the acting `user_id` from the validated OAuth access token. Tool arguments never supply or override the owner id, so an MCP client authorized for one user cannot read or write another user's data. The MCP server and the REST endpoints share the same `gymtrack_oauth_*` tables; a token issued by the MCP OAuth flow can be presented to either surface, with the same revocation semantics.

## Coverage and tests

| Behaviour | Coverage |
|---|---|
| Email/password login + sign-up | Existing GymTrack unit/component tests + `test/e2e/signup.spec.ts` |
| Google social login wiring | `test/e2e/signup-google.spec.ts` |
| Planned workouts browse + connect-agent CTA visibility/provider links | `test/e2e/workouts-tab.spec.ts` + `src/components/WorkoutsTab.test.jsx` |
| Connected agents list + revoke UI | `src/components/ConnectedAgentsPage.test.jsx` |
| OAuth-protected REST handlers | `src/lib/oauthAuth.test.js`, `src/lib/plannedWorkoutsHandler.test.js`, `src/lib/historyHandler.test.js`, `src/lib/progressionHandler.test.js` |
| MCP OAuth flow, PKCE exchange, refresh rotation, tool discovery | `services/gymtrack-mcp/test/app.test.js` |

Playwright still runs against the Vite dev server on port 5179 with `iPhone 13` device emulation. There is still no end-to-end Playwright spec that drives a real external MCP client through OAuth against a live Supabase project; the current branch covers that surface with service integration tests instead.

## Out of scope (v1)

- HealthKit / Apple Health sync.
- Offline queue / sync.
- Magic-link auth.
- Push notifications.
- Rest timer.
- Exercise categories / favourites.
- Volume / PR analytics.
- Automatic dynamic client registration for arbitrary MCP clients.

## Non-goals

- Building GymTrack-owned planning intelligence.
- Shipping every OAuth provider on day one; Google is the minimum supported social-login path.
- Replacing or breaking the existing `/api/agent/*` integrations (already OAuth-only; see Agent surfaces → OAuth-protected REST endpoints).
