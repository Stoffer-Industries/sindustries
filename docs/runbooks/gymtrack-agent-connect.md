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

The CTA links to `https://claude.ai/settings/connectors` for Claude and `https://chatgpt.com/admin/ca` for ChatGPT. It displays the MCP endpoint and the static public OAuth client ID to enter in the provider UI.

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

Migration `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` seeds these exact allowlist values:

| Provider | Client ID | Allowed redirect URI |
| --- | --- | --- |
| Claude | `claude-desktop` | `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT | `chatgpt` | `https://chatgpt.com/connector_platform_oauth_redirect` |

Confirm the production rows have not drifted:

```sql
select client_id, client_name, redirect_uris
from public.gymtrack_oauth_clients
where client_id in ('claude-desktop', 'chatgpt')
order by client_id;
```

If either provider reports a redirect mismatch, capture the exact `redirect_uri` it sent, verify it against that provider's current documentation, and update only that client's allowlist. Do not add wildcard redirect URIs.

### Claude end-to-end

- [ ] Open Claude **Settings → Connectors → Add custom connector**.
- [ ] Name it `GymTrack` and enter `https://gymtrack-mcp.fly.dev/mcp`.
- [ ] In Advanced settings, enter OAuth Client ID `claude-desktop` and leave the client secret blank (public PKCE client).
- [ ] Add/connect the connector. Claude should open GymTrack's `/agent-consent` page.
- [ ] Approve access, return to Claude, and confirm `plan_workout`, `read_history`, and `read_exercise_progression` are discovered.

### ChatGPT end-to-end

ChatGPT custom MCP apps are plan- and role-gated. The current OpenAI flow requires a supported ChatGPT plan plus developer-mode/admin access.

- [ ] Open ChatGPT workspace **Settings → Apps → Create** (the CTA opens `https://chatgpt.com/admin/ca`).
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
2. Select each option; verify it opens the real provider connector configuration, not an in-app placeholder.
3. Add the displayed MCP URL and public client ID in one provider.
4. Verify the provider-originated OAuth request reaches GymTrack consent, approval returns to the provider, and an active consent appears under `/settings/agents`.
5. Reload `/workouts`; verify the CTA is hidden now that an active consent exists.
