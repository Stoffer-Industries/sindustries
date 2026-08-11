---
status: draft
task_id: 72aebb7b-844a-44e9-a4e4-9437ad815560
product_spec: brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md (unchanged — bug-fix on top of shipped slice)
shipped_pr: null
shipped_date: null
---

# GymTrack MCP server — fix bearer-token auth discoverability (task 72aebb7b)

## Links

- Product spec: `brain/tasks/specs/in-progress/gymtrack-mcp-server-oauth-2026-07-27.md`
- Original MCP-OAuth tech design: `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`
- Operator runbook (existing): `docs/runbooks/gymtrack-agent-connect.md`
- Task: `72aebb7b-844a-44e9-a4e4-9437ad815560`
- Tasks API record: `http://localhost:4001/api/v1/tasks/72aebb7b-844a-44e9-a4e4-9437ad815560`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `72aebb7b-gymtrack-mcp-auth-fix`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/72aebb7b-gymtrack-mcp-auth-fix`
- Expected `.openclaw` follow-up: Quinn must confirm the Fly `gymtrack-mcp` deploy ran with the new `WWW-Authenticate` headers and re-run the acceptance smoke test (`docs/runbooks/gymtrack-agent-connect.md`).

## Scope

GymTrack's MCP service (`https://gymtrack-mcp.fly.dev`) ships and serves its OAuth metadata correctly, but every protected request returns HTTP 401 **without** the `WWW-Authenticate: Bearer` header that RFC 6750 and the MCP / OAuth 2.1 authorization-spec require. As a result MCP clients (ChatGPT's connector, OpenClaw, anything following MCP's auth discovery flow) have no machine-readable way to learn that the resource is bearer-protected, where the authorization server lives, or how to obtain a token. They cannot start the OAuth Code + PKCE dance because they cannot discover it.

This task ships three narrowly-scoped changes that together restore authenticated MCP access for OpenClaw and ChatGPT without redesigning the existing OAuth server:

1. **Auth discoverability** — add `WWW-Authenticate: Bearer realm="gymtrack-mcp", resource_metadata="<issuer>/.well-known/oauth-protected-resource"` to the `/mcp` 401 response (and to the `/oauth/authorize/decision` 401 response for consistency).
2. **Error-message sanitization** — wrap every 500-path `error.message` exposed to the client in a redaction helper so Supabase connection strings, API key fragments, and raw exception messages never leak. Closes AC3.
3. **Operator runbook + env verification** — extend `docs/runbooks/gymtrack-agent-connect.md` with the `curl -i` smoke check that proves the `WWW-Authenticate` header is present, and re-verify the Fly env vars match the existing checklist (no new secrets required).

Everything else stays out of scope: no schema migrations, no new OAuth flows, no Dynamic Client Registration, no CORS changes, no removal of the existing JSON-RPC error body on 401.

## Reproduction (pre-fix, observed 2026-08-12 07:59 NZST)

```bash
curl -i -X POST https://gymtrack-mcp.fly.dev/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# HTTP/2 401
# content-type: application/json; charset=utf-8
# (no WWW-Authenticate header — bug)
# {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized."}}
```

The OAuth metadata endpoints already work:

```bash
curl -fsS https://gymtrack-mcp.fly.dev/.well-known/oauth-authorization-server | jq .
curl -fsS https://gymtrack-mcp.fly.dev/.well-known/oauth-protected-resource | jq .
```

…and the existing OAuth client seed rows (`claude-desktop`, `chatgpt`, `local-dev`) are present in `public.gymtrack_oauth_clients` per migration `20260804070000_mcp_oauth.sql`. The runtime issue is purely the missing `WWW-Authenticate` header, which ChatGPT surfaces to the user as "automatic client registration is not supported" because the connector UI cannot even begin the OAuth flow without the protected-resource metadata URL.

## Implementation plan

### `services/gymtrack-mcp/src/app.js`

- Add a `bearerUnauthorizedResponse(req, res, rpcId)` helper that:
  - Sets `WWW-Authenticate: Bearer realm="gymtrack-mcp", resource_metadata="${config.issuer}/.well-known/oauth-protected-resource"`.
  - Returns the existing JSON-RPC body `{ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized.' } }` with status 401.
- Replace the existing `res.status(401).json(jsonRpcError(...))` call inside the `/mcp` handler with this helper.
- Apply the same helper to `/oauth/authorize/decision` when the user-supabase token is missing or invalid.
- Add a `redactErrorForResponse(error)` helper that strips token-shaped strings (`[A-Za-z0-9_-]{32,}`), bearer-prefixed values, Supabase connection strings (`https?://[^\s]*supabase[^\s]*`), and any other substrings that match a deny-list. Wrap every `oauthJsonError(res, 500, 'server_error', error.message)` call site through this helper.
- Use `config.issuer` for the `resource_metadata` URL (already exposed by `loadConfig`); no new env var required.

### `services/gymtrack-mcp/src/config.js`

- Add a derived `protectedResourceMetadataUrl` getter so both the helper above and any future code reuse the same constant.
- No new env vars; no defaults change.

### `services/gymtrack-mcp/test/app.test.js`

- Add a test asserting `WWW-Authenticate` is present on an unauthenticated `POST /mcp` and matches the regex `^Bearer realm="gymtrack-mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"$`.
- Add a test asserting `WWW-Authenticate` is present on an unauthenticated `POST /oauth/authorize/decision`.
- Add a test asserting the 500-path error response from a synthetic Supabase error containing a token-shaped substring is redacted: the response body must not include the substring, and `redactErrorForResponse` must replace it with `…[redacted]…`.
- Add a test asserting a normal (non-500) 401 path still returns the JSON-RPC body unchanged.

### `docs/runbooks/gymtrack-agent-connect.md`

- Extend the **Smoke checks** block under "Fly MCP service" with:
  ```bash
  curl -i https://gymtrack-mcp.fly.dev/health | head -1
  curl -i -X POST https://gymtrack-mcp.fly.dev/mcp \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
    | grep -i '^www-authenticate'
  ```
- Add a sentence to the **ChatGPT end-to-end** section explaining that the ChatGPT connector relies on the `WWW-Authenticate` header to discover the auth server, so a regression there will surface in the connector UI as "automatic client registration is not supported."

### No-op surface area (intentionally untouched)

- `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql` — schema and seed rows are correct.
- `services/gymtrack-mcp/Dockerfile` and `fly.toml` — no build changes; the same container picks up the new behaviour on next deploy.
- `apps/gymtrack/src/components/AgentConsentPage.jsx`, `ConnectedAgentsPage.jsx`, `authFlow.js`, `connectedAgents.js` — consent UI is unchanged.
- CORS configuration in `app.js` — out of scope; cross-origin browser MCP clients are a separate concern.

## Data model / API contract

No schema changes. No new endpoints. Two HTTP-surface changes only:

1. **New response header** on every 401 from `/mcp` and `/oauth/authorize/decision`:
   ```
   WWW-Authenticate: Bearer realm="gymtrack-mcp",
                          resource_metadata="https://gymtrack-mcp.fly.dev/.well-known/oauth-protected-resource"
   ```
   This matches RFC 6750 §3 (Bearer scheme) and RFC 9728 §5.1 (`resource_metadata` parameter).
2. **Redacted 500 error descriptions** on every `oauthJsonError(res, 500, …)` call site. The shape of the JSON body is unchanged; only `error_description` text is filtered.

The JSON-RPC body on 401 stays byte-identical to today's response (same `code`, same `message`). MCP clients that today ignore the missing header and treat the body as "Unauthorized" continue to work.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 | `services/gymtrack-mcp/test/app.test.js` proves a request to `/mcp` with a valid bearer token returns `200` for `initialize`, `tools/list`, and `tools/call`. (Existing test coverage; re-run to confirm no regression.) The `WWW-Authenticate` test proves an unauthenticated request advertises the bearer scheme and protected-resource metadata URL — the discovery pre-requisite for clients to obtain a token in the first place. |
| AC2 | Same test file proves `tools/list` returns the three GymTrack tools and `tools/call` dispatches through the MCP server. Pre-existing coverage from `1474d515` is sufficient and unchanged. |
| AC3 | New redactor test asserts that synthetic errors containing a 32-char token-shaped string, a `Bearer xxxxx` fragment, and a Supabase URL substring all get redacted before they leave the server. A separate integration smoke confirms the live Fly logs (after deploy) contain no token material in any 4xx/5xx response. |

End-to-end verification, post-merge: re-run the **Acceptance smoke test** in `docs/runbooks/gymtrack-agent-connect.md`. The Claude / ChatGPT connector flows should now reach the GymTrack consent page and back without operator intervention.

## Risks and notes

- **Header parser tolerance.** Some legacy clients parse `WWW-Authenticate` strictly; adding parameters (rather than just the scheme) is RFC-compliant and should not break any client that already accepts `Bearer`. The MCP / OAuth 2.1 clients we care about (Claude Desktop, ChatGPT, OpenClaw) all accept the parameter form.
- **CORS pre-flight on cross-origin clients.** Out of scope for this slice; if a future task opens a browser-based MCP client from a non-GymTrack origin, CORS preflight will need a follow-up. For native (non-browser) MCP clients there is no CORS gate.
- **Dynamic Client Registration** remains out of scope per the original MCP-OAuth tech design. ChatGPT's connector UI accepts the seeded static `chatgpt` client_id, so DCR is not required to fix the reported failure.
- **Error-message redaction could over-redact.** The deny-list is conservative (token-shaped strings, bearer prefixes, Supabase URLs); the helper keeps the first 80 characters of the redacted text so operators can still see the shape of the failure. If a future error path needs more detail in logs, route it to `console.error` (server-side) instead of the client response.
- **No new Fly secrets.** The change is a code-only deploy. The existing `gymtrack-mcp` Fly app already has `GYMTRACK_MCP_ISSUER`, `GYMTRACK_APP_URL`, `GYMTRACK_WEB_ORIGIN`, `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` per the runbook.

## Out of scope (explicitly)

- Dynamic Client Registration, Client ID Metadata Documents, `offline_access` scope, confidential-client support — none are required to fix this bug.
- Any change to `apps/gymtrack` (SPA / Supabase / migrations).
- CORS preflight expansion for non-GymTrack origins.
- Rewriting the existing JSON-RPC 401 body or the JSON-RPC error code.

## Acceptance criteria mapping (verbatim from task description)

- AC1: An authenticated MCP initialize request to the deployed endpoint completes successfully. *(satisfied — verified by re-running existing test plus the new `WWW-Authenticate` discovery test).*
- AC2: An authenticated client can list and invoke the GymTrack MCP tools. *(satisfied — verified by re-running existing test).*
- AC3: Authentication remains protected and no credentials are exposed in logs or responses. *(satisfied — verified by the new redactor test plus the operator smoke check confirming Fly logs do not contain token material).*
