---
title: "GymTrack OAuth/MCP integration interoperability and callback UX"
slug: gymtrack-oauth-mcp-ux
task: b7726e20-46d0-4c1a-9971-0cee313ca008
---

# Tech Design — GymTrack OAuth/MCP integration interoperability and callback UX

## Context

Task: [b7726e20-46d0-4c1a-9971-0cee313ca008](https://github.com/Stoffer-Industries/sindustries) — *"GymTrack OAuth/MCP integration interoperability and callback UX"*.

This task consolidates the repeated OAuth/MCP integration attempts and the live failures observed on 2026-09-04:

1. **DCR response was incomplete.** `POST /oauth/register` returned only `client_id` + `client_id_issued_at`, so standards-conformant MCP clients (notably Claude's connector) couldn't verify the registered redirect URIs and aborted the handshake.
2. **MCP `initialize` handshake was broken.** Standard MCP clients send a `notifications/initialized` notification (no `id`, no response expected). The GymTrack MCP server treated that as `Method not found`, so the handshake never completed and `tools/list` was never reached.
3. **Loopback callback page was phone-hostile.** OpenClaw's seed OAuth client only had `http://127.0.0.1:8789/callback` registered. On a phone, the browser returns from `/oauth/authorize` to a loopback URL that never resolves, and the user is left with a dead tab and no code to paste.

Goal: make the GymTrack MCP integration usable from OpenClaw and any other standards-conformant MCP client, and replace the loopback completion page with a hosted callback page that clearly shows the one-time authorization code.

## Product spec link

`apps/gymtrack/SPEC.md` is the single behavioural spec for the GymTrack app + its MCP surface. The MCP-OAuth flow is already documented there (sections *"Connect and authorize an external MCP client"* and the agent-connect runbook `docs/runbooks/gymtrack-agent-connect.md`).

This task **adds** the following behavioural shape to that spec — to be folded into the same PR:

- **DCR response contract.** Registration responses MUST include the registered `redirect_uris` so a client can confirm what was stored server-side. The response MUST NOT include a `client_secret` (the server only supports `token_endpoint_auth_method: 'none'`).
- **MCP `initialize` handshake.** The server MUST accept a `notifications/initialized` JSON-RPC notification (no `id`, no body) and acknowledge it with `202 Accepted` (no response body, per the MCP transport spec). After acknowledgement, `tools/list` is reachable for the same bearer token.
- **Hosted OAuth callback page.** When the OpenClaw client is used on a non-loopback device, the consent flow redirects to `https://<gymtrack-app-host>/oauth/callback?<query>` and the page renders a clear success or error message with the one-time authorization code visible and a copy-to-clipboard action.
- **Seeded OpenClaw client redirect URIs.** `gymtrack_oauth_clients.client_id='openclaw'` gains the hosted callback URL alongside the existing loopback URL, so the same seeded client works from both desktop and mobile.

## Task IDs, branch, worktree, and repository names

- **Task ID (full):** `b7726e20-46d0-4c1a-9971-0cee313ca008`
- **Task title:** *"GymTrack OAuth/MCP integration interoperability and callback UX"*
- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-b7726e20-gymtrack-oauth-mcp-ux` (from `origin/main`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-b7726e20-gymtrack-oauth-mcp-ux`
- **Spec file:** `docs/specs/gymtrack-oauth-mcp-ux-tech-design.md` (this file)
- **System-spec file:** `docs/systems/gymtrack-mcp.md` (existing — updated, not created)

## `.openclaw` boundary notes

- The hosted callback URL is determined by the **public GymTrack app host** (`gymtrack-sigma-pied.vercel.app` in staging today). The callback URL is therefore a config value, not a hard-coded constant — at implementation time the URL MUST come from the existing `VITE_APP_URL` (or equivalent) env var so production can override it without code changes.
- OpenClaw's principal-side OAuth client registration is **already shipped** under task `30251df0` (`fa5b076 feat(gymtrack-mcp): seed OpenClaw OAuth client`). This task only adds a second `redirect_uri` row for that client; it does not touch OpenClaw itself.
- The MCP transport fix lives entirely in `services/gymtrack-mcp`. No changes are needed in `apps/openclaw` or in any OpenClaw workflow.

## Implementation plan

### File/module scope

| Path | Change |
| --- | --- |
| `services/gymtrack-mcp/src/app.js` | (a) Include `redirect_uris` in `POST /oauth/register` response. (b) Handle `notifications/initialized` JSON-RPC notification with `202 Accepted` (no body). |
| `services/gymtrack-mcp/test/` | Add unit tests for the two server-side fixes (registration response shape; initialize/initialized notification acknowledgement). |
| `apps/gymtrack/src/App.jsx` | Register `<Route path="/oauth/callback" element={<AgentOAuthCallbackPage />} />`. |
| `apps/gymtrack/src/components/AgentOAuthCallbackPage.jsx` | New component — reads `code` / `error` / `error_description` from `useSearchParams()`, shows success (code + copy-to-clipboard) or error states. |
| `apps/gymtrack/src/components/AgentOAuthCallbackPage.test.jsx` | New Vitest + Testing Library tests covering success (code shown, copy works), denial (error message shown), and missing-code (graceful empty state). |
| `apps/gymtrack/src/styles/index.css` | Add a small `.oauth-callback-*` block to style the new page on the existing `.container` / `.workout-card` primitives — no new design tokens. |
| `apps/gymtrack/supabase/migrations/2026XXXX_openclaw_hosted_oauth_callback.sql` | New migration — `INSERT … ON CONFLICT (client_id) DO UPDATE` the seeded `openclaw` OAuth client to add `https://<app-host>/oauth/callback` to `redirect_uris` while preserving the existing `http://127.0.0.1:8789/callback`. |
| `apps/gymtrack/SPEC.md` | Update the *"Connect and authorize an external MCP client"* section to mention the hosted callback path and the loopback-vs-hosted split. |
| `docs/runbooks/gymtrack-agent-connect.md` | Document the loopback-vs-hosted decision and the `VITE_APP_URL` env var the hosted URL is derived from. |
| `docs/systems/gymtrack-mcp.md` | Update the MCP system doc with the corrected DCR contract and the initialize handshake acknowledgement (the existing doc still describes the older shape). |

### Server-side details

**DCR response (RFC 7591 §3.2.1).** The registration endpoint already validates the request and persists the client; the response shape just needs `redirect_uris`:

```js
return res.status(201).json({
  client_id: clientId,
  client_id_issued_at: Math.floor(now().getTime() / 1000),
  redirect_uris: validation.value.redirectUris
});
```

No `client_secret` field is included — public clients using PKCE + `token_endpoint_auth_method: 'none'` do not get one.

**MCP initialize notification.** A spec-conformant MCP client sends `notifications/initialized` immediately after receiving the `initialize` response. The notification has no `id`, no `result`, and the server MUST NOT send a JSON-RPC response for it. Returning `202 Accepted` with no body is the closest HTTP semantic and matches what the spec expects (drop on the floor with an ACK).

```js
if (rpc.method === 'notifications/initialized' && !Object.hasOwn(rpc, 'id')) {
  return res.status(202).end();
}
```

The guard `!Object.hasOwn(rpc, 'id')` makes the intent explicit and prevents an `initialize`-shaped body from accidentally matching this branch.

### Client-side details

**`AgentOAuthCallbackPage`.** Three render states, all driven by `useSearchParams()`:

- `?code=…&state=…` → success: heading, the authorization code in a `<output data-testid="oauth-code">`, a Copy button (`navigator.clipboard.writeText`), help text noting the code expires shortly and is bound to the requesting app.
- `?error=…&error_description=…` → denial: heading, the `error_description` (or `error`) surfaced in a `role="alert"` banner.
- neither → "no authorization code was returned" fallback so the page never renders blank.

The page does **not** call back to any server. The connecting app (OpenClaw) is responsible for polling the GymTrack MCP `/oauth/token` endpoint with the code the user pastes in. This keeps the callback page stateless and avoids any cross-site token exchange.

**Seeded OpenClaw client redirect URIs.** The migration is `INSERT … ON CONFLICT (client_id) DO UPDATE`, preserving the existing `http://127.0.0.1:8789/callback` row and adding the hosted URL. The hosted URL is built from the existing `VITE_APP_URL` env var at migration time (with a documented default matching the current staging host) so production can override without code changes.

### Ownership boundary check

- **Natural source of truth:** the MCP server's `app.js` is the source of truth for the DCR + initialize behaviour; `AgentOAuthCallbackPage` is the source of truth for the hosted-callback UX; the `gymtrack_oauth_clients` row is the source of truth for the OpenClaw client's registered redirect URIs.
- **No interim shims:** the durable boundary is the OAuth server + a hosted page. Both already exist; this task fills in the missing pieces rather than creating a parallel contract.
- **Why a hosted page, not a CLI callback shim:** OpenClaw currently does not have a working HTTP callback listener on the user's device (loopback port 8789 is firewalled on phones and laptops that aren't on the same network). A hosted page + paste-the-code flow is the simplest contract that works from any device, and OpenClaw's OAuth client already supports `code` extraction from a paste.
- **Why two redirect URIs, not one:** keeping the loopback URI means desktop users who already have the listener running don't have to copy-paste. The hosted URI is the fallback for everyone else. Both rows share one `client_id`, so no second seeded client is needed.

### Data model / API contract changes

- `POST /oauth/register` response: adds `redirect_uris: string[]` (RFC 7591 §3.2.1). No removal. Existing consumers ignore unknown fields, so this is strictly additive.
- `POST /mcp` (JSON-RPC): when `method === 'notifications/initialized'` and no `id` is present, returns `202 Accepted` with no body. Existing `initialize` and `tools/list` responses are unchanged.
- `public.gymtrack_oauth_clients.redirect_uris` for `client_id='openclaw'`: gains `https://<app-host>/oauth/callback`. No schema change.

### Workflow / cron / skill changes

None. No cron jobs, no OpenClaw skills, no new workflows touch this surface.

### `.openclaw` changes

None — the hosted callback URL is derived from the existing `VITE_APP_URL` env var. No new OpenClaw configuration is required.

## Test plan with AC-by-AC verification matrix

| AC | Verification | Layer | Evidence |
| --- | --- | --- | --- |
| AC1 | `POST /oauth/register` with a valid body returns 201 and a body containing `client_id`, `client_id_issued_at`, and the registered `redirect_uris`; the body MUST NOT contain `client_secret`. | Unit | New test in `services/gymtrack-mcp/test/oauthRegister.test.js` asserts the full response shape and the absence of `client_secret`. |
| AC2 | A standard MCP client can call `initialize` → receive `initialize` result → send `notifications/initialized` (no `id`) → receive `202 Accepted` → call `tools/list` → receive the MCP tool list. | Unit + integration | New unit test drives the request dispatcher with a fixture `notifications/initialized` body and asserts `202` + empty body. Existing MCP tool tests cover `tools/list`. A new integration test exercises the full sequence against a running `createApp()` instance. |
| AC3 | Visiting `/oauth/callback?code=…&state=…` renders the success state with the code visible and a working Copy button. Visiting `/oauth/callback?error=access_denied&error_description=You%20cancelled` renders the denial message. Visiting `/oauth/callback` with neither shows the fallback. | Component | New `AgentOAuthCallbackPage.test.jsx` covers all three states using Testing Library. |
| AC4 | End-to-end: OpenClaw starts the OAuth flow against the GymTrack MCP server, the user lands on the hosted callback, copies the code, and OpenClaw exchanges it at `/oauth/token` with the PKCE verifier, then calls `/mcp` `tools/list` and gets the expected tools. | Integration (manual + scripted) | A new e2e Playwright spec in `apps/gymtrack/test/e2e/oauth-callback.spec.ts` covers the page-side happy + denial paths. The OpenClaw side is exercised by a shell-driven integration script in the PR description (the test environment is a CI runbook that exits non-zero if the MCP `tools/list` probe returns anything other than the seeded tool list). |
| AC5 | CI runs all of the above on the PR. New and existing tests pass; coverage on the changed files (`app.js`, `AgentOAuthCallbackPage.jsx`) stays at the repo's threshold. | CI | Green CI is the evidence. |

### E2E coverage rationale

AC3 and AC4 both have user-visible browser flows. AC3 is fully covered by Playwright. AC4's loopback vs hosted split is hard to drive in CI without standing up a second OAuth client + PKCE fixture, so the page-rendering side is Playwright and the full OAuth exchange is a documented scripted integration check the opener runs locally before requesting review. The Playwright config already supports an iPhone 13 project for mobile-shape verification.

## Risks and open questions

- **Hosted URL origin.** The migration uses the staging host `gymtrack-sigma-pied.vercel.app` as a default. Production will need a separate migration or a config-driven approach at deploy time. **Decision:** document in the runbook that the seeded `openclaw` row's `redirect_uris` MUST be re-applied for the production Vercel project (one-off ops change), and add a follow-up task if we want to automate that.
- **Empty `error_description` from the MCP server.** When the MCP `/oauth/authorize` denies a request, it currently returns `error=access_denied` with a short description. The callback page handles missing `error_description` gracefully (falls back to `error`). Worth confirming during implementation by hitting the real endpoint.
- **`state` validation on the callback.** The callback page does not validate `state` — OpenClaw owns that check at its end. Keeping the page stateless is intentional; calling this out so it's not "fixed" later in a way that breaks cross-device copy-paste.
- **OpenClaw side is out of scope.** This task fixes the GymTrack surface so OpenClaw can use it; the OpenClaw OAuth client integration is its own task (already in `acceptance` under `30251df0`).

## Out of scope

- Adding a ChatGPT or any other provider's connect CTA.
- Changing the OAuth `client_secret` policy (still public-only PKCE).
- Migrating `apps/gymtrack/SPEC.md`'s other flows (sign-up, agent consent, connected-agents management).
- Any change to OpenClaw itself.
