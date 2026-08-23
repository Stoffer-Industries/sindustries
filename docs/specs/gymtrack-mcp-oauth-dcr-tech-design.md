---
status: pending-review
task_id: de19b186-dda6-47dc-94f1-ef52d2dc9383
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Add OAuth 2.0 Dynamic Client Registration (DCR) to gymtrack-mcp

## Links

- Tech design: `docs/specs/gymtrack-mcp-oauth-dcr-tech-design.md`
- Task: `de19b186-dda6-47dc-94f1-ef52d2dc9383`
- Tasks API record: `http://localhost:4001/api/v1/tasks/de19b186-dda6-47dc-94f1-ef52d2dc9383`
- Supersedes (decision, not the static-client PR): tech design `docs/specs/gymtrack-mcp-openclaw-oauth-client-tech-design.md` (PR #454, merged 2026-08-15) — that design explicitly rejected DCR/CIMD as overkill. Tom reversed that decision 2026-08-18 because the static-client path does not match what OpenClaw's spec-following MCP client actually speaks.
- Predecessor tech design (auth model + table layout): `docs/specs/gymtrack-mcp-server-oauth-auth-tech-design.md`
- Predecessor migration this design extends: `apps/gymtrack/supabase/migrations/20260804070000_mcp_oauth.sql`
- Spec reference: RFC 7591 (OAuth 2.0 Dynamic Client Registration), RFC 8414 (Authorization Server Metadata)

## Problem

`gymtrack-mcp`'s OAuth authorization server recognises only four hardcoded client_ids (`claude-desktop`, `chatgpt`, `local-dev`, `openclaw`), each seeded by a SQL migration. PR #454 added `openclaw` to unblock the OpenClaw agent runtime, on the assumption that OpenClaw could be configured with a static `client_id` + redirect URI.

That assumption was wrong. Confirmed 2026-08-18 (see comment on task 30251df0): OpenClaw's MCP OAuth client (`mcp.servers.*.oauth`, `additionalProperties: false`) only supports `scope`, `redirectUrl`, and `clientMetadataUrl` — there is no way to wire a static pre-shared `client_id`. OpenClaw only knows how to do Dynamic Client Registration (RFC 7591, default behaviour) or Client ID Metadata Documents (RFC 9470, when `clientMetadataUrl` is set). Result: `openclaw mcp login gymtrack` still fails with `Incompatible auth server: does not support dynamic client registration` after PR #454 merged.

Decision (Tom, 2026-08-18): implement DCR rather than CIMD. DCR needs no separately hosted metadata document, is the more common / better-supported path across the MCP client ecosystem, and lets any future third-party agent self-register without GymTrack maintaining a hardcoded client list per onboarded client.

This task supersedes the remaining scope of 30251df0 (its AC2/AC3, which were explicitly deferred as "Quinn-owned follow-up" and turned out to be blocked on this).

## Goals (mapped to task ACs)

- **AC1** — produce this design (the design itself is the AC).
- **AC2** — gymtrack-mcp exposes a working `POST /oauth/register` endpoint per RFC 7591, and `registration_endpoint` is advertised in `/.well-known/oauth-authorization-server` so MCP clients can discover it.
- **AC3** — `openclaw mcp login gymtrack` completes end-to-end against the deployed gymtrack-mcp endpoint and OpenClaw obtains a valid access token. (Real verification, not just unit tests.)
- **AC4** — an authenticated OpenClaw MCP session can list and invoke the GymTrack MCP tools (`plan_workout`, `read_history`, `read_exercise_progression`).
- **AC5** — no new client can access GymTrack data beyond what the user has consented to; dynamically-registered clients still go through GymTrack's existing agent-consent approval screen before any token exchange succeeds.

## Service boundary and data ownership

- **Service:** `services/gymtrack-mcp` (the OAuth authorisation server and MCP resource server). Owns the OAuth client registry, consent ledger, token storage, and authorisation-code lifecycle. No extraction.
- **Schema owner:** `apps/gymtrack/supabase` (single Postgres, schema `public`). New columns land on `public.gymtrack_oauth_clients`; no new table is required. This keeps the data plane co-located with the existing consent / token / code tables and avoids a cross-schema join.
- **Direct consumers:** `services/gymtrack-mcp` (the OAuth server that performs `validateClientRedirect` and `getOAuthClient` on every authorize/token request). No other service reads `gymtrack_oauth_clients` today, so the schema extension has blast radius of one.
- **Why this is the right place:** the OAuth client registry is a single-tenant concept owned by the MCP server. Spreading it across a shared package or a different service would create a second source of truth for which clients GymTrack trusts. Durable shape lives in the migration; the API surface lives in `services/gymtrack-mcp/src/app.js`.

## Approach

Add a minimal RFC 7591 `client registration endpoint` to `services/gymtrack-mcp`, extend the `gymtrack_oauth_clients` table with a small set of nullable metadata columns + a `registration_type` discriminator, and advertise `registration_endpoint` in the server metadata document. The endpoint is **public-only** — no `client_secret` is generated, no confidential-client semantics — matching the existing trust model (all current clients are public PKCE, `gymtrack_oauth_clients` has no secret column, `token_endpoint_auth_methods_supported: ["none"]`).

### 1. Discovery surface change

Add one field to the JSON served by `GET /.well-known/oauth-authorization-server`:

```json
{
  "issuer": "…",
  "authorization_endpoint": "…",
  "token_endpoint": "…",
  "registration_endpoint": "<issuer>/oauth/register",
  "revocation_endpoint": "…",
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": […],
  "registration_endpoint_auth_methods_supported": ["none"]
}
```

`registration_endpoint_auth_methods_supported` is set to `["none"]` to make the open-registration posture explicit per RFC 7591 §3.1.1 (clients know in advance they don't need to send credentials). This is the single discovery signal OpenClaw (and any future MCP client) needs to stop emitting `Incompatible auth server`.

### 2. Registration endpoint shape

`POST /oauth/register` (JSON, no auth):

**Request body** (RFC 7591 §2 client metadata):

| Field | Required | Notes |
| --- | --- | --- |
| `redirect_uris` | yes | Array, ≥1 entry. Each entry must be absolute http/https, no fragment, no wildcard. Localhost/loopback URIs allowed per RFC 8252 §7.3. |
| `client_name` | optional | Display string, ≤200 chars. Stored verbatim. |
| `client_uri` | optional | https URL, ≤2000 chars. Validated if present. |
| `logo_uri` | optional | https URL, ≤2000 chars. Validated if present. |
| `contacts` | optional | Array of email-shaped strings, ≤10 entries. |
| `policy_uri` | optional | https URL. |
| `tos_uri` | optional | https URL. |
| `software_id` | optional | Opaque string ≤64 chars. |
| `software_version` | optional | Semver-ish string ≤32 chars. |
| `token_endpoint_auth_method` | optional | Must be `"none"` if present; reject anything else. |

Unknown fields are silently dropped per RFC 7591 §2 — clients sending extra metadata must not be rejected for it. The endpoint never echoes secrets (because no secrets are generated).

**Response (201 Created)** per RFC 7591 §3.2.1:

```json
{
  "client_id": "<uuid v4>",
  "client_id_issued_at": 1755475200
}
```

`client_secret` and `client_secret_expires_at` are intentionally omitted (we never issue secrets). RFC 7591 explicitly allows omitting these fields for public clients.

**Error responses** per RFC 7591 §3.2.2:

| HTTP | error | error_description |
| --- | --- | --- |
| 400 | `invalid_redirect_uri` | One or more `redirect_uris` is malformed, contains a fragment, uses a wildcard, or fails scheme/host validation. |
| 400 | `invalid_client_metadata` | Other metadata validation failure (e.g. `token_endpoint_auth_method` is not `"none"`). |
| 400 | `invalid_request` | Body is not JSON, or missing required `redirect_uris`. |
| 413 | `request_entity_too_large` | Body exceeds 100KB (matches existing `express.json({ limit: '100kb' })` in app.js). |
| 500 | `server_error` | Catch-all; `error_description` redacted per existing `redactErrorForResponse` helper. |

### 3. Storage: extend `gymtrack_oauth_clients`

Migration `apps/gymtrack/supabase/migrations/<yyyymmddhhmmss>_oauth_dcr.sql` adds the following columns to `public.gymtrack_oauth_clients` (all `ADD COLUMN ... NULL` except where noted — backwards-compatible with the four existing static rows):

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `registration_type` | `text` | `'static'` NOT NULL | Discriminator. `CHECK (registration_type IN ('static','dynamic'))`. Existing rows keep `'static'`; new DCR-registered rows get `'dynamic'`. |
| `registered_at` | `timestamptz` | NULL | Set on insert for dynamic rows; NULL for static rows. |
| `client_uri` | `text` | NULL | RFC 7591 §2 `client_uri`. |
| `logo_uri` | `text` | NULL | RFC 7591 §2 `logo_uri`. |
| `contacts` | `text[]` | NULL | RFC 7591 §2 `contacts`. |
| `policy_uri` | `text` | NULL | RFC 7591 §2 `policy_uri`. |
| `tos_uri` | `text` | NULL | RFC 7591 §2 `tos_uri`. |
| `software_id` | `text` | NULL | RFC 7591 §2 `software_id`. |
| `software_version` | `text` | NULL | RFC 7591 §2 `software_version`. |

**No `client_secret_hash` column** — by deliberate design. If a confidential client ever needs to register, that is a separate task: add `client_secret_hash text`, `client_secret_expires_at timestamptz`, secret generation in the registration endpoint, and update `token_endpoint_auth_methods_supported` to advertise `["none","client_secret_basic"]`. Doing it now would be premature (no consumer needs it) and would introduce a secret-rotation lifecycle surface that has no operator owner yet.

**Indexes:** none needed for v1. The PK on `client_id` already serves the read path. If `registration_type='dynamic'` rows grow past ~10k and we add an admin list endpoint, a partial index `(registered_at desc) WHERE registration_type='dynamic'` is a follow-up.

**RLS:** unchanged. The existing `gymtrack_oauth_clients_authenticated_read` policy covers both static and dynamic rows. Service-role writes (insert from `/oauth/register`) bypass RLS.

### 4. Disposition of the `openclaw` static row from PR #454

**Decision: leave it in place, marked `registration_type='static'`.** Three reasons:

1. DCR-generated `client_id` values are random UUIDs (RFC 4122 §4.4). They will not collide with the literal string `openclaw`.
2. Deletion is a separate decision that should happen after AC3/AC4 are verified end-to-end (i.e. once OpenClaw is registering dynamically and the static row has zero traffic). Doing it now couples two risky changes.
3. The static row's `registration_type='static'` makes it easy to identify and drop in a follow-up cleanup task. A targeted `DELETE FROM public.gymtrack_oauth_clients WHERE client_id='openclaw' AND registration_type='static'` (after verifying no dynamic registration took that name) is a small, safe operation.

**Follow-up task (out of scope here):** once AC3/AC4 pass against the deployed endpoint, file a separate code task to (a) drop the static `openclaw` row and (b) remove the now-redundant migration `20260815070000_openclaw_oauth_client.sql` from the deploy chain (or leave it as historical record — depends on Tom's preference). This design does not commit to either option.

### 5. Consent gate — AC5

The existing consent gate applies to dynamic clients **without modification**. The relevant invariants:

- `validateClientRedirect(repo, client_id, redirect_uri)` does `repo.getOAuthClient(client_id)` and checks `oauthClient.redirect_uris.includes(redirect_uri)`. Whether the row was seeded or registered dynamically is irrelevant — same lookup, same array comparison.
- `upsertConsent({ userId, clientId, scope, grantedAt })` keys on `(userId, clientId)`. The active-consent unique index `gymtrack_oauth_consents_active_user_client_idx ON (user_id, client_id) WHERE revoked_at IS NULL` already enforces one active consent per `(user, client)` regardless of how the client was registered.
- `consumeAuthorizationCode` returns `null` when no active consent row exists for the consent_id, so the token endpoint returns `invalid_grant` if the user revoked the consent before the code is exchanged.
- `/oauth/revoke` revokes the entire token family by `consent_id`, again regardless of client registration provenance.

In short: dynamic clients go through **exactly the same consent and revocation flow** as static clients, because the existing code paths are already keyed on `client_id` as an opaque string.

**Test plan for AC5 (in addition to the existing static-client tests):** add a test that (a) registers a dynamic client via `POST /oauth/register`, (b) hits `/oauth/authorize` → `/oauth/authorize/decision` → `/oauth/token` without ever granting consent, (c) asserts the token endpoint returns `400 invalid_grant`. Mirrors the existing static-client regression test for `client_id=openclaw`.

### 6. Edge cases and error handling

- **Empty `redirect_uris` array.** Reject 400 `invalid_redirect_uri`. Existing CHECK constraint `array_length(redirect_uris, 1) >= 1` enforces this at the DB level; surface a meaningful error before hitting it.
- **Wildcard in `redirect_uri`** (e.g. `https://*.example.com/cb`). Reject 400 `invalid_redirect_uri` with `error_description="redirect_uris must not contain wildcards."`. RFC 7591 §2 explicitly forbids wildcards.
- **Fragment in `redirect_uri`** (e.g. `https://example.com/cb#foo`). Reject 400 `invalid_redirect_uri`. RFC 6749 §3.1.2 forbids fragments.
- **Non-http(s) scheme** (e.g. `javascript:`, `file:`, custom schemes). Reject 400 `invalid_redirect_uri`. RFC 7591 §2 only mentions http/https; custom schemes are not part of this profile.
- **Duplicate `client_name` from a different registrant.** Allow it. Two registrants may legitimately use the same display name.
- **Same `redirect_uris` from two registrants.** Allow it. Each gets a distinct `client_id`; consent is per-(user, client_id).
- **Body exceeds 100KB.** Reject 413. Express middleware `express.json({ limit: '100kb' })` already enforces this.
- **`token_endpoint_auth_method` is anything other than `"none"`** (e.g. `"client_secret_basic"`). Reject 400 `invalid_client_metadata` with description `"token_endpoint_auth_method must be 'none'."`. This is a deliberate v1 constraint — see §3.
- **Concurrent registrations.** Postgres serialises inserts on `client_id` (PK). Two concurrent requests will get distinct UUIDs. No race.
- **Malformed JSON body.** Express returns 400 by default; wrap to return RFC 7591-shaped error `{ error: 'invalid_request', error_description: 'Body is not valid JSON.' }`.

### 7. Out of scope (explicit non-goals)

These are tempting to bundle into the same PR. Resist: each is a meaningful scope expansion with its own risks and review surface.

- **Confidential client support** (`client_secret` generation, hashing, rotation, expiry). Needs an operator owner for secret rotation; defer until a concrete consumer requires it.
- **Initial access tokens** for the registration endpoint (RFC 7591 §3.1). Would let us lock down registration to holders of a Tom-issued token. Defer until open registration becomes an abuse vector.
- **Per-IP rate limiting** on `POST /oauth/register`. Needs Redis or similar; no rate-limit infra exists in `services/gymtrack-mcp` today. Defer until abuse is observed in logs.
- **Admin endpoint to list or revoke dynamically-registered clients.** Admins can use psql / Supabase Studio today; a UI is a UX win, not a security need. Defer until the dynamic client population warrants it.
- **Dynamically-registered client lifecycle management** (deactivate, delete, transfer). RFC 7591 §4.2 mentions a management endpoint; defer until a real need arises.
- **Internationalisation of client metadata fields** (RFC 7591 §2 supports `client_name#lang`). Skip for v1; everything is English.

## Implementation plan

### `apps/gymtrack/supabase/migrations/<yyyymmddhhmmss>_oauth_dcr.sql` (new)

`ALTER TABLE public.gymtrack_oauth_clients ADD COLUMN …` for the columns in §3, plus the `CHECK (registration_type IN ('static','dynamic'))` constraint. No new table, no RLS change, no policy change. Existing four static rows are unaffected.

### `services/gymtrack-mcp/src/app.js` (extend)

1. **Discovery endpoint** (existing handler at `/.well-known/oauth-authorization-server`): add `registration_endpoint` and `registration_endpoint_auth_methods_supported` to the response payload.
2. **New route `POST /oauth/register`**: validate the request body per §2 (client metadata validation), generate a UUIDv4 `client_id` (via `randomUUID()` from `node:crypto`, already imported), `INSERT` a row into `gymtrack_oauth_clients` with `registration_type='dynamic'`, `registered_at=now()`, and the supplied metadata columns, return 201 with the RFC 7591 response shape.
3. **Repo extension in `services/gymtrack-mcp/src/repo.js`**: add `createDynamicOAuthClient({ clientId, clientName, redirectUris, clientUri, logoUri, contacts, policyUri, tosUri, softwareId, softwareVersion, registeredAt })` that performs the insert and returns the stored row. Mirrors the existing `createToken` / `createAuthorizationCode` patterns.

### `services/gymtrack-mcp/test/app.test.js` (extend)

Add the following test cases in the existing vitest suite, using the existing `FakeRepo` (extended with `createDynamicOAuthClient` matching the new repo method):

1. **Discovery advertises registration_endpoint.** Hit `GET /.well-known/oauth-authorization-server`; assert `body.registration_endpoint === '<issuer>/oauth/register'` and `body.registration_endpoint_auth_methods_supported` deep-equals `['none']`.
2. **Register valid client.** `POST /oauth/register` with `{ redirect_uris: ['http://127.0.0.1:8789/callback'], client_name: 'Test', token_endpoint_auth_method: 'none' }`; assert 201, response has `client_id` matching a UUIDv4 regex, response omits `client_secret`. Assert the row exists in the `FakeRepo` with `registration_type='dynamic'` and the supplied metadata.
3. **Register rejects missing redirect_uris.** Assert 400 `invalid_request`.
4. **Register rejects empty redirect_uris.** Assert 400 `invalid_redirect_uri`.
5. **Register rejects wildcard redirect_uri.** Assert 400 `invalid_redirect_uri`.
6. **Register rejects fragment in redirect_uri.** Assert 400 `invalid_redirect_uri`.
7. **Register rejects javascript: scheme.** Assert 400 `invalid_redirect_uri`.
8. **Register rejects `token_endpoint_auth_method=client_secret_basic`.** Assert 400 `invalid_client_metadata`.
9. **Register silently drops unknown fields.** Send `{ redirect_uris: [...], client_name: 'Test', extra_unknown_field: 'foo' }`; assert 201 and the unknown field is not stored.
10. **Dynamic client participates in consent gate (AC5).** Register a dynamic client via `POST /oauth/register`, then attempt the full `authorize → decision → token` flow **without** inserting a consent row first; assert `/oauth/token` returns 400 `invalid_grant`. Mirror the existing static-client test for `client_id=openclaw`.
11. **Dynamic client full happy path.** Register → seed consent → complete the authorize/token flow → call `POST /mcp tools/list` with the issued access token; assert 200 and the three MCP tools are returned.
12. **Dynamic client goes through existing revocation.** Register → seed consent → token → call `POST /oauth/revoke`; assert a follow-up `/mcp tools/list` call returns 401 with `WWW-Authenticate`. Mirrors the existing static-client revocation test.

No new test fixtures — the `FakeRepo` extension is mechanical.

### `docs/runbooks/gymtrack-agent-connect.md` (extend)

Add a short section: "Dynamic client registration" explaining how to register an MCP client against a deployed gymtrack-mcp endpoint (curl example showing `POST /oauth/register` with a minimal payload, the resulting `client_id`, and how that flows into the existing authorize-decision-token pattern). Add a confirmation query to the existing operator checklist that surfaces both registration types:

```sql
select client_id, registration_type, client_name, registered_at
from public.gymtrack_oauth_clients
order by registration_type, registered_at desc nulls last, client_id;
```

## Risks

- **Open registration = abuse surface.** Anyone who knows the issuer URL can register a client. Mitigations deferred: rate limiting, initial access tokens. **Real risk:** registration spam could grow `gymtrack_oauth_clients` unboundedly. The `gymtrack_oauth_clients_authenticated_read` RLS policy means a logged-in user can `SELECT` all rows; a malicious registrant could enumerate by spamming and reading. **Mitigation in scope:** cap `client_name` at 200 chars and reject obviously-spammy payloads at validation time. **Mitigation deferred:** rate-limit + admin cleanup endpoint.
- **Consent gate relies on user approval at /agent-consent.** A user who clicks "Approve" on a malicious dynamic client has consented to that client reading their data. This is inherent to OAuth consent flows and is not new to DCR — same risk applies to the four static clients. Document in the runbook that users should verify the `client_name` and `redirect_uri` shown on the consent screen.
- **`client_id` collision is not a meaningful risk.** UUIDv4 from `crypto.randomUUID()` has negligible collision probability. The PK constraint will surface a collision as a 500; we should never see one.
- **Discovery surface change is observable to all clients.** Any existing MCP client that does strict metadata validation may break. Mitigation: `registration_endpoint` is an additive field per RFC 8414 §2 — clients that ignore unknown fields are unaffected. No known consumer parses strict schemas today.
- **No `client_secret` means no defence-in-depth against `client_id` theft for public clients.** This is the existing trust model (public PKCE) and is unchanged. Defence comes from the consent screen, redirect-URI exact-match, and PKCE binding.
- **`openclaw` static row left in place could confuse operators.** Mitigated by the `registration_type` column making the distinction explicit in queries. Cleanup follow-up task will remove it.

## Open questions

- **Q1. Should we log dynamic registrations to an audit table?** Tempting, but no audit table exists for OAuth client lifecycle events today (consents are the closest thing and are per-user, not per-client). Defer until Tom asks. **Default answer for now: log to stdout, parse Fly logs.**
- **Q2. Should `/oauth/register` require `User-Agent` to be non-empty?** RFC 7591 doesn't say. Defer.
- **Q3. Should we expose a `client_id_issued_at` in the response as a Unix epoch (RFC 7591 default) or ISO-8601?** RFC 7591 §3.2.1 says epoch. Stick with epoch; document in the runbook.

## Test plan (AC verification matrix)

| AC | Verification |
| --- | --- |
| AC1 | This design (merged to `feat/de19b186-oauth-dcr` branch and posted as `[tech-design] <url>` comment on task `de19b186-dda6-47dc-94f1-ef52d2dc9383`) + the `[tech-design-approved]` audit comment from Quinn. |
| AC2 | `npx vitest run services/gymtrack-mcp/test/app.test.js` passes (existing 13 tests + 12 new tests in §Implementation plan). Deployed smoke: `curl -sS https://gymtrack-mcp.fly.dev/.well-known/oauth-authorization-server \| jq -e '.registration_endpoint'` returns the expected URL. |
| AC3 | Manual end-to-end smoke against the deployed Fly endpoint: `openclaw mcp login gymtrack` → log entry observed in `/var/log/gymtrack-mcp` for `POST /oauth/register` with `client_name="OpenClaw"` → follow-on `POST /oauth/authorize` → user approves at `/agent-consent` → `POST /oauth/token` → OpenClaw stores the access token. Verifiable by Tom running the command and confirming the access token file is written. |
| AC4 | Same end-to-end as AC3: with the issued access token, `openclaw` calls `POST /mcp` `tools/list` and observes `plan_workout`, `read_history`, `read_exercise_progression` in the response. Then `tools/call plan_workout` returns a non-error payload for Tom's account. |
| AC5 | Test #10 above (dynamic client cannot exchange a code without an active consent row). Mirrors the existing static-client regression test for `client_id=openclaw`. The test exercises the production consent gate (`getConsent(...).revoked_at` check in `/oauth/token`) by deliberately not seeding a consent row. |

## Notes for Quinn

- The decision to leave the `openclaw` static row in place (§4) is the kind of thing that could go either way on review. If you'd rather drop it as part of this PR, the change is one DELETE inside the migration plus a corresponding test fixture update — flag and I'll fold it in.
- The decision to defer confidential-client support, rate limiting, and the admin list/revoke endpoint (§7) is the kind of thing that could also go either way. The argument for deferring is "no consumer needs it yet"; the argument for bundling is "we know we'll need it eventually". My read of the existing codebase posture is "defer until needed" (see e.g. the original tech design's reasoning for rejecting DCR/CIMD, which has now been reversed for the same reason), but happy to flip if you disagree.