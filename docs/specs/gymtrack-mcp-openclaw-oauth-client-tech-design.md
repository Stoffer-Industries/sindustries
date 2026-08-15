---
status: pending-review
task_id: 30251df0-a8f4-4e28-9836-029edab8261d
shipped_pr: null
shipped_date: null
---

# Add OpenClaw OAuth client to gymtrack-mcp

## Links

- Tech design: `docs/specs/gymtrack-mcp-openclaw-oauth-client-tech-design.md`
- Task: `30251df0-a8f4-4e28-9836-029edab8261d`
- Tasks API record: `http://localhost:4001/api/v1/tasks/30251df0-a8f4-4e28-9836-029edab8261d`
- Predecessor tech design (auth model + table layout): `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`
- Runbook being extended: `docs/runbooks/gymtrack-agent-connect.md`

## Problem

`gymtrack-mcp`'s OAuth authorization server only recognizes two hardcoded public clients (`claude-desktop`, `chatgpt`), each with a redirect URI locked to a provider-controlled host. It does not implement Dynamic Client Registration (no `registration_endpoint` advertised in `/.well-known/oauth-authorization-server`) nor Client ID Metadata Documents (no `client_id_metadata_document_supported` flag).

Confirmed 2026-08-15: `openclaw mcp login gymtrack` fails immediately with `Incompatible auth server: does not support dynamic client registration`. OpenClaw cannot complete the Authorization Code + PKCE flow against the deployed endpoint.

This is now urgent: task `1eb6e48c` (Decommission legacy GymTrack agent keys and unify on OAuth) has already merged via PR #449 and is in `acceptance`. Once the legacy `gymtrack_agent_api_keys` path is fully decommissioned, OpenClaw / Quinn will have **zero** remaining path to GymTrack — no back-door key and no working OAuth client.

## Approach: third static public PKCE client (not DCR or CIMD)

Three options were on the table:

1. **Static allowlist (chosen).** Add a third row to `gymtrack_oauth_clients`. The server already reads this table on every authorize and token request (`validateClientRedirect` → `repo.getOAuthClient`).
2. **Dynamic Client Registration (RFC 7591).** Add `POST /oauth/register`, `client_secret` generation/storage/rotation, allowlisted redirect-URI pattern validation, rate limiting, and an admin revoke surface. New endpoints, new tables, new abuse-mitigation surface.
3. **Client ID Metadata Documents (RFC 9470).** Add `client_id_metadata_document_supported: true` to the metadata document and a fetcher that resolves `client_id` URLs and validates the returned metadata against an allowlisted host set. Network egress, SSRF risk, document caching, allowlist maintenance.

**Decision:** static allowlist. Reasoning:

- The existing trust model is already a static allowlist of two known public clients. A third entry extends the same surface with zero new endpoints, zero new tables, zero new code paths in `app.js`.
- DCR/CIMD solve "any first-party MCP client can self-register" — a problem we do not have. The only known first-party MCP clients we want to support are Claude, ChatGPT, and OpenClaw, all of which can ship a known `client_id` and redirect URI.
- DCR/CIMD can be revisited later if/when we onboard fourth-party MCP clients. That is a separate tech design, not a precondition for OpenClaw.

## Trust model impact (none — design constraint, not a checkbox)

Adding `openclaw` to `gymtrack_oauth_clients` does **not** widen the public-client/PKCE trust model. Every check the server performs on a request using `client_id=openclaw` is identical to the check it performs on `client_id=claude-desktop`:

| Check | Current behaviour | After this change |
| --- | --- | --- |
| `client_id` lookup | `repo.getOAuthClient(clientId)` reads `gymtrack_oauth_clients` | Identical — `openclaw` is a row in the same table. |
| `redirect_uri` validation | Exact-string match against `gymtrack_oauth_clients.redirect_uris[]` | Identical — the registered URI for `openclaw` is the single string OpenClaw sends. No wildcards. |
| PKCE | `code_challenge_method` must be `S256` (enforced in `validateAuthorizeRequest` and re-checked at `/oauth/token`) | Identical. |
| Token endpoint auth | `token_endpoint_auth_methods_supported: ["none"]` — public client | Identical — `gymtrack_oauth_clients` has no `client_secret` column at all. |
| Consent | `gymtrack_oauth_consents` row required, unique per `(user_id, client_id) where revoked_at is null`; `consumeAuthorizationCode` returns null when no active consent | Identical — `openclaw` is just another value for `client_id` in the unique index. The active-consent check (`getConsent(...) revoked_at` check in `/oauth/token`) still gates every token exchange. |
| Refresh-token rotation | `gymtrack_rotate_oauth_refresh_token` checks `consent.revoked_at` and revokes the whole family on replay | Identical. |
| Discovery surface | `/.well-known/oauth-authorization-server` advertises grants/methods/scopes | Identical — no new flags added. |

AC4 ("no new client can access GymTrack data beyond what the user has consented to") is therefore satisfied by construction. The PR adds a regression test that asserts `client_id=openclaw` cannot obtain a token without an active consent row, matching the existing test for `claude-desktop`.

## Redirect URI choice: loopback on `127.0.0.1:8789`

OpenClaw is a CLI/agent runtime that runs on Tom's Mac mini. The OAuth dance needs a browser round-trip (user must approve at GymTrack's `/agent-consent` page) and a place for the authorization server to send the `code`. Three patterns are viable:

- **(A) Loopback redirect (chosen).** OpenClaw binds `http://127.0.0.1:8789/callback` for the duration of the dance. Standard RFC 8252 §7.3 / OAuth 2.1 §10.2 pattern for public clients with no hosted callback. Matches the existing `local-dev` row pattern (`http://localhost:8788/callback`); picking port `8789` (one off from `local-dev`'s `8788`) avoids any port collision between the two clients.
- **(B) `openclaw.ai`-hosted callback.** Deploy an `https://openclaw.ai/oauth/callback` endpoint that captures the `code` and forwards it back to the OpenClaw runtime via webhook or polling. Rejected: introduces a new production service, a state-forwarding protocol, and a second trust boundary outside GymTrack's existing model. No upside for a single-tenant agent runtime.
- **(C) Dynamic port.** OpenClaw binds `127.0.0.1:<ephemeral>/callback` and tells the AS at auth-time. Rejected: `gymtrack_oauth_clients.redirect_uris` is a `text[]` with exact-string matching (no pattern / wildcard support). Dynamic-port support would need either DCR, CIMD, or a port-range allowlist — three separate design discussions, none of which are required to unblock OpenClaw.

**Operational note for the OpenClaw runtime:** if port `8789` is unavailable, surface an actionable error suggesting the user free the port. If we later need dynamic ports, that is a follow-up task to redesign `redirect_uris` validation (likely to a small CIDR/port-range allowlist or to switch to DCR for the loopback case).

## Implementation plan

### `apps/gymtrack/supabase/migrations/20260815070000_openclaw_oauth_client.sql` (new)

Mirrors the `insert ... on conflict do update` pattern at the bottom of `20260804070000_mcp_oauth.sql`:

```sql
insert into public.gymtrack_oauth_clients (client_id, client_name, redirect_uris)
values
  ('openclaw', 'OpenClaw', array['http://127.0.0.1:8789/callback'])
on conflict (client_id) do update
set client_name = excluded.client_name,
    redirect_uris = excluded.redirect_uris;
```

No schema change. No new table. No new RLS policy (the existing `gymtrack_oauth_clients_authenticated_read` policy covers the new row).

### `services/gymtrack-mcp/test/app.test.js` (extend)

Add two test cases to lock AC4 against the new client:

1. **Consent-required case.** Build a `/oauth/authorize` → `/oauth/authorize/decision` flow with `client_id=openclaw`, then assert `/oauth/token` returns `invalid_grant` when no `gymtrack_oauth_consents` row exists for `(user_id, 'openclaw')`. Mirror the existing `claude-desktop` test that asserts the same invariant.
2. **Redirect-URI enforcement case.** Submit `client_id=openclaw` with `redirect_uri=https://attacker.example/callback` (or any URI not in the registered list) and assert `validateClientRedirect` returns `{ error: 'redirect_uri is not registered for this client.' }` and the authorize endpoint returns `400 invalid_client`. Mirror the equivalent `claude-desktop` redirect-mismatch test.

Both tests reuse the existing `claude-desktop` test helpers — no new fixtures, no new test scaffolding.

### `docs/runbooks/gymtrack-agent-connect.md` (extend)

Add a row to the existing "Supabase OAuth clients" table:

```
| OpenClaw | `openclaw` | `http://127.0.0.1:8789/callback` |
```

And a confirmation query row:

```sql
select client_id, client_name, redirect_uris
from public.gymtrack_oauth_clients
where client_id in ('claude-desktop', 'chatgpt', 'openclaw')
order by client_id;
```

No new operator checklist sections — the existing Fly MCP service smoke checks (`/health`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, the unauthenticated `POST /mcp` `WWW-Authenticate` header) all apply unchanged.

## OpenClaw-side MCP client config (out of scope for this PR, blocks AC2/AC3)

Quinn / whoever owns the OpenClaw MCP client needs to register `gymtrack` as a configured MCP client with `client_id=openclaw` and `redirect_uri=http://127.0.0.1:8789/callback`, and have the client implement the loopback listener + PKCE dance. The OpenClaw MCP client already does DCR (which is why it currently fails the metadata discovery check); making it accept a configured static `client_id` instead is the unblock for AC2/AC3.

This PR does not implement that change. Once OpenClaw-side config lands, AC2/AC3 can be verified end-to-end with the same manual smoke test the runbook already documents for Claude.

## Risks and notes

- **Port 8789 collision.** If a future seeded client also wants loopback on `8789`, this design needs to change (or that client picks a different port). Documented in the runbook addition.
- **No client_secret column.** `gymtrack_oauth_clients` does not store a secret because all seeded clients are public PKCE. If OpenClaw ever needs confidential-client semantics (it does not, per OAuth 2.1 native-app guidance), that is a schema change and a separate task.
- **No discovery surface change.** This task deliberately does not advertise `registration_endpoint` or `client_id_metadata_document_supported`. Adding either is a feature, not a bug fix; tracking it as a follow-up if/when a fourth-party MCP client needs it.
- **Single-tenant assumption.** OpenClaw is currently a single-user runtime bound to Tom's GymTrack account. If multi-tenant OpenClaw support becomes a goal, the per-`client_id` consent model already handles it (each user gets their own consent row for `openclaw`), but the runbook should grow a "switch GymTrack account in OpenClaw" section.

## Test plan (AC verification matrix)

| AC | Verification |
| --- | --- |
| AC1 | This tech design (merged to `task-30251df0-openclaw-oauth-client` branch) + the `[tech-design-approved] true` comment from Quinn. |
| AC2 | `openclaw mcp login gymtrack` succeeds end-to-end against the deployed `https://gymtrack-mcp.fly.dev`. Out of scope for this PR; depends on OpenClaw-side MCP client config (see "OpenClaw-side MCP client config" above). Verified after that work lands. |
| AC3 | Same dependency as AC2: a successful OAuth dance followed by `POST /mcp` `tools/list` returns the three tools, and `tools/call plan_workout` returns expected content for Tom's account. |
| AC4 | New test case in `services/gymtrack-mcp/test/app.test.js` asserting `client_id=openclaw` cannot obtain a token without an active consent row, plus a redirect-URI mismatch case. Both ship in this PR. |