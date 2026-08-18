# GymTrack agent connection rollout

GymTrack's Workouts CTA hands the user to Claude or ChatGPT's connector setup. This is intentional: the agent client must generate the OAuth `state` and PKCE challenge before requesting `GET /oauth/authorize`; the GymTrack SPA cannot safely manufacture a provider request on its behalf.

## Production values

| Setting | Value |
| --- | --- |
| GymTrack SPA | `https://gymtrack-sigma-pied.vercel.app` |
| MCP base / OAuth issuer | `https://gymtrack-mcp.fly.dev` |
| Remote MCP endpoint | `https://gymtrack-mcp.fly.dev/mcp` |
| Authorization metadata | `https://gymtrack-mcp.fly.dev/.well-known/oauth-authorization-server` |
| Protected-resource metadata | `https://gymtrack-mcp.fly.dev/.well-known/oauth-protected-resource` |
| GymTrack consent page | `https://gymtrack-sigma-pied.vercel.app/agent-consent` |

The CTA links to Claude and ChatGPT connector configuration:

- **Claude:** `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=GymTrack&connectorUrl=https%3A%2F%2Fgymtrack-mcp.fly.dev%2Fmcp` — Claude's `modal=add-custom-connector` deep link (anthropics/claude-ai-mcp#74, closed completed 2026-05-13; per maintainer @localden's comment on that issue) opens the Add Custom Connector modal with the Name and Remote MCP server URL fields pre-filled from the query params. **The path is `/customize/connectors` and the param names are `connectorName` / `connectorUrl`** — the originally-proposed `/settings/connectors` + `mcpName` + `mcpServerUrl` shape from the issue's opener was *not* what shipped; do not regress to it.
- **ChatGPT:** `https://chatgpt.com/settings/connectors` — the user-level custom-connector page. The previously-documented `/admin/ca` path is an admin console route that 404s to the ChatGPT home page for a normal/plus account; that URL is no longer in the source.

The CTA also displays the MCP endpoint and the static public OAuth client ID to enter in the provider UI.

## Operator checklist

No client secret is committed or required by GymTrack; both seeded clients are OAuth public clients using Authorization Code + PKCE.

### Vercel / SPA

- [ ] Set `VITE_GYMTRACK_MCP_BASE_URL=https://gymtrack-mcp.fly.dev` in the production Vercel project and redeploy. The app has a production Fly fallback, but the explicit setting is the operational source of truth.
- [ ] Keep `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configured in Vercel.
- [ ] In Supabase Auth URL Configuration, set the Site URL to `https://gymtrack-sigma-pied.vercel.app` and allow `https://gymtrack-sigma-pied.vercel.app/**` as a redirect URL. This preserves `/agent-consent?...` when an unauthenticated user signs in during authorization.
- [ ] Keep the Google provider enabled if Google sign-in is offered on `/login`; its provider callback remains the Supabase callback shown in the Supabase dashboard.

### Fly MCP service

Verify these non-secret values and existing secrets in the `gymtrack-mcp` Fly app; do not put the service-role key in Vercel client env or the repo.

- [ ] `GYMTRACK_MCP_ISSUER=https://gymtrack-mcp.fly.dev`
- [ ] `GYMTRACK_APP_URL=https://gymtrack-sigma-pied.vercel.app`
- [ ] `GYMTRACK_WEB_ORIGIN=https://gymtrack-sigma-pied.vercel.app`
- [ ] `VITE_SUPABASE_URL` points to the same Supabase project used by the SPA.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is present as a Fly secret.

Smoke checks:

```bash
curl -fsS https://gymtrack-mcp.fly.dev/health
curl -fsS https://gymtrack-mcp.fly.dev/.well-known/oauth-authorization-server
curl -fsS https://gymtrack-mcp.fly.dev/.well-known/oauth-protected-resource
curl -i -X POST https://gymtrack-mcp.fly.dev/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  | grep -i '^www-authenticate'
```

The unauthenticated `POST /mcp` must respond with `401` **and** a `WWW-Authenticate` header of the form `Bearer realm="gymtrack-mcp", resource_metadata="https://gymtrack-mcp.fly.dev/.well-known/oauth-protected-resource"`. This header is the discovery pre-requisite for ChatGPT's connector UI, OpenClaw clients, and any other MCP client following RFC 6750 / OAuth 2.1 — without it the OAuth dance cannot start.

### Supabase OAuth clients

Static clients are seeded by migrations and live in `public.gymtrack_oauth_clients` with `registration_type='static'`. Dynamic clients are registered at runtime via `POST /oauth/register` (RFC 7591) and land in the same table with `registration_type='dynamic'`.

#### Static clients

Migration `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` seeds these exact allowlist values:

| Provider | Client ID | Allowed redirect URI |
| --- | --- | --- |
| Claude | `claude-desktop` | `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT | `chatgpt` | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Local dev | `local-dev` | `http://localhost:8788/callback` |

Migration `apps/gymtrack/supabase/migrations/20260815070000_openclaw_oauth_client.sql` adds the OpenClaw static row (task `30251df0`):

| Provider | Client ID | Allowed redirect URI |
| --- | --- | --- |
| OpenClaw | `openclaw` | `http://127.0.0.1:8789/callback` |

`127.0.0.1:8789` is the loopback redirect OpenClaw binds for the duration of the OAuth dance (RFC 8252 §7.3 / OAuth 2.1 §10.2); it is one port above `local-dev`'s `8788` so no two seeded clients collide. If port `8789` is unavailable on a host, surface an actionable error to the user — do not silently bind a different port.

Confirm the production rows have not drifted:

```sql
select client_id, client_name, redirect_uris, registration_type, registered_at
from public.gymtrack_oauth_clients
where registration_type = 'static'
order by client_id;
```

#### Dynamic clients (RFC 7591 DCR)

Any RFC 7591-conformant MCP client (including OpenClaw's spec-following OAuth client) can self-register against `POST /oauth/register`. The endpoint is public-only — it does not issue `client_secret`, and `token_endpoint_auth_method` is restricted to `'none'`. Static and dynamic clients share the same consent gate (`/agent-consent` → `getConsent(...).revoked_at` on `/oauth/token`), so dynamic clients cannot bypass user approval.

Discover the endpoint via `GET /.well-known/oauth-authorization-server`; the response advertises `registration_endpoint` and `registration_endpoint_auth_methods_supported: ["none"]`.

Example registration (OpenClaw or any other MCP client):

```bash
curl -fsS https://gymtrack-mcp.fly.dev/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "redirect_uris": ["http://127.0.0.1:8789/callback"],
    "client_name": "OpenClaw",
    "token_endpoint_auth_method": "none"
  }'
```

Response (201 Created):

```json
{
  "client_id": "<uuid v4>",
  "client_id_issued_at": 1755475200
}
```

The issued `client_id` then flows into the same `/oauth/authorize` → `/agent-consent` → `/oauth/token` dance as a static client. `client_secret` is intentionally omitted because GymTrack only supports public PKCE clients.

Operator query to inspect both static and dynamic registrations side-by-side:

```sql
select client_id, registration_type, client_name, registered_at
from public.gymtrack_oauth_clients
order by registration_type, registered_at desc nulls last, client_id;
```

**Out of scope for v1:** confidential-client support, initial-access-tokens, per-IP rate limiting, and admin list/revoke endpoint. See the tech design (`docs/specs/gymtrack-mcp-oauth-dcr-tech-design.md`, §Out of scope) for the rationale. If registration abuse is observed in logs, the first escalation is to add per-IP rate limiting at the Fly edge, then file a follow-up task to bundle the rest.

If any provider reports a redirect mismatch, capture the exact `redirect_uri` it sent, verify it against that provider's current documentation, and update only that client's allowlist. Do not add wildcard redirect URIs.

### Claude end-to-end

- [ ] Open `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=GymTrack&connectorUrl=https%3A%2F%2Fgymtrack-mcp.fly.dev%2Fmcp` in Claude.
- [ ] Verify the Add Custom Connector modal opens with the Name field pre-filled to `GymTrack` and the Remote MCP server URL field pre-filled to `https://gymtrack-mcp.fly.dev/mcp`. (This is the deep-link behavior added in anthropics/claude-ai-mcp#74, shipped 2026-05-13.)
- [ ] In Advanced settings, enter OAuth Client ID `claude-desktop` and leave the client secret blank (public PKCE client).
- [ ] Add/connect the connector. Claude should open GymTrack's `/agent-consent` page.
- [ ] Approve access, return to Claude, and confirm `plan_workout`, `read_history`, and `read_exercise_progression` are discovered.

### ChatGPT end-to-end

ChatGPT custom MCP apps are plan- and role-gated. The current OpenAI flow requires a supported ChatGPT plan plus developer-mode/admin access.

- [ ] Open `https://chatgpt.com/settings/connectors` in ChatGPT.
- [ ] Click **Add custom connector** (or the equivalent CTA on the current ChatGPT UI — these pages change independently of our code).
- [ ] Enable developer mode if prompted.
- [ ] Create `GymTrack` with endpoint `https://gymtrack-mcp.fly.dev/mcp` and OAuth authentication.
- [ ] Configure OAuth Client ID `chatgpt` with no client secret if the provider UI accepts a public PKCE client.
- [ ] Scan tools and complete the GymTrack consent prompt.
- [ ] Confirm all three tools are discovered.

If ChatGPT requires Client ID Metadata Documents, Dynamic Client Registration, an `offline_access` scope, or a confidential client secret rather than accepting the seeded public client, stop and capture the provider error. Those server capabilities are not implemented by the merged MCP service and need a follow-up design; do not invent a secret or weaken redirect validation.

**Regression signal:** ChatGPT surfaces a missing or malformed `WWW-Authenticate` header to the user as "automatic client registration is not supported". If the connector UI starts emitting that message after a deploy, the first place to look is the `curl -i` smoke check above — the response header must advertise the bearer scheme and protected-resource metadata URL.

## Acceptance smoke test

Use a GymTrack account with no active row in `gymtrack_oauth_consents`:

1. Open `/workouts`; verify the **Connect to your agent** panel shows Claude and ChatGPT.
2. Select each option; verify it opens the real provider connector configuration, not an in-app placeholder. For Claude, the Add Custom Connector modal should open with the Name and Remote MCP server URL fields pre-filled (deep-link prefill). For ChatGPT, the page should be the user-level Connectors page, not a 404 to the home page.
3. Add the displayed MCP URL and public client ID in one provider.
4. Verify the provider-originated OAuth request reaches GymTrack consent, approval returns to the provider, and an active consent appears under `/settings/agents`.
5. Reload `/workouts`; verify the CTA is hidden now that an active consent exists.

## Provider-URL drift

The Claude and ChatGPT connector URLs above are owned by Anthropic and OpenAI respectively, and either provider can change them independently of GymTrack. When the page is broken on a fresh visit, run the smoke checks first and treat any provider-side URL change as a bug to be fixed in `apps/gymtrack/src/components/ConnectAgentCta.jsx` (and re-pinned in this runbook). The Playwright e2e test only covers the static CTA structure, not the live provider UI, so a manual smoke check after every GymTrack release is part of the acceptance test for this surface.
