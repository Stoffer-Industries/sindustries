---
status: draft
task_id: 1eb6e48c-bef4-4658-a54a-dac93e13d5f0
product_spec: n/a (code task; spec lives in the task description)
shipped_pr: null
shipped_date: null
---

# Tech Design — Decommission legacy GymTrack agent keys and unify on OAuth

## Task and repo

- Task ID: `1eb6e48c-bef4-4658-a54a-dac93e13d5f0`
- Task title: `🔧 Decommission legacy GymTrack agent keys and unify on OAuth`
- Branch: `task-1eb6e48c-gymtrack-oauth-decommission`
- Worktree: `~/workspaces/rowan/sindustries-task-1eb6e48c-gymtrack-oauth-decommission` (current: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-1eb6e48c-gymtrack-oauth-decommission`)
- Repository: `Stoffer-Industries/sindustries`

## Background

`apps/gymtrack/api/agent/*` currently authenticates bearer tokens against `gymtrack_agent_api_keys` (a per-user legacy key table) via `apps/gymtrack/server/agentAuth.js`. The GymTrack MCP OAuth server (`services/gymtrack-mcp/`) already issues revocable bearer access tokens backed by `gymtrack_oauth_*` tables + Connected Agents revocation cascades through `apps/gymtrack/api/connected-agents/revoke.js`. This task moves the agent API surface to OAuth-only and removes the legacy key path.

The user-facing intent: one credential system for agent access to workout data, with full revocation via Connected Agents UI.

## Service boundary and data ownership

- **Source of truth for agent credentials (final):** `gymtrack_oauth_consents` + `gymtrack_oauth_tokens` (Supabase Postgres schema). The OAuth server in `services/gymtrack-mcp/` owns token issuance, rotation, and refresh; the connection between a user and an MCP client is owned by `gymtrack_oauth_consents`.
- **Source of truth for agent identity resolution at `/api/agent/*`:** a new app-local module `apps/gymtrack/server/oauthAuth.js` that mirrors the structure of the existing `apps/gymtrack/server/agentAuth.js` but reads from the OAuth tables. Both the `/api/agent/*` endpoints and any future GymTrack OAuth consumer in `apps/gymtrack/` will go through this module.
- **Source of truth for revocation:** `apps/gymtrack/api/connected-agents/revoke.js` already cascades `revoked_at` across consents, tokens, and authorization codes. No change needed there — the new module naturally inherits the same revocation behaviour because it reads `revoked_at` on both tables.
- **Audit trail for agent-created resources:** `planned_workouts` currently has `agent_key_id` (FK → `gymtrack_agent_api_keys`). The migration replaces this with `consent_id` (FK → `gymtrack_oauth_consents`) so historical "which agent created this plan" attribution survives the cutover. Pre-existing rows lose the attribution (their `agent_key_id` is gone) — acceptable per the task description ("existing legacy keys do not need to remain active").
- **Why duplicate the OAuth validation logic into `apps/gymtrack/server/oauthAuth.js` rather than import it from `services/gymtrack-mcp/src/app.js`:** the MCP server is a separately deployed Node service with its own `package.json` and `node_modules`. Cross-service runtime imports are not currently supported by the workspace layout (the MCP server is built and shipped as a Fly.io container, not pulled into the Vercel build). A pending future refactor would extract the OAuth validation into a shared package; for this PR, a small (~50-line) locally-scoped module is the lowest-cost durable move.

## `.openclaw` boundary notes

- No secrets, env vars, or external services are needed in this PR.
- No `.openclaw` workspace artifacts or non-repo config files need to change.
- The OAuth server (`services/gymtrack-mcp/`) is unchanged. Re-deploying it is not part of this PR.
- The Connected Agents UI in `apps/gymtrack/` is unchanged.

## Implementation plan

### 1. New module: `apps/gymtrack/server/oauthAuth.js`

Mirrors the existing `apps/gymtrack/server/agentAuth.js` shape, but reads from the OAuth tables.

Exports:
- `parseBearerToken(req)` — borrowed verbatim from `agentAuth.js` (also exists in `services/gymtrack-mcp/src/app.js`). Kept here so the agent endpoints only import one helper module.
- `hashToken(token)` — borrowed verbatim from `agentAuth.js` (SHA-256 hex digest).
- `resolveOAuthIdentity(req, { requireScope } = {})` — looks up `gymtrack_oauth_tokens` by `access_token_hash`, fetches the matching `gymtrack_oauth_consents` row, returns `{ user_id, consent_id, client_id, scope }` on success, or `null` on any auth failure (missing header, malformed token, no row, revoked token, revoked consent, expired token, insufficient scope).
  - Throws on database errors so the caller can distinguish server vs auth failure.
  - When `requireScope` is supplied, treats a missing scope as auth failure (returns `null`).
- `adminClient()` — memoized Supabase service-role client, identical to `agentAuth.js`'s implementation. Note: this duplicates the same helper used by `agentAuth.js`. The two functions are byte-identical; the duplication is intentional for now (see Service boundary note above). A future cleanup could promote this to a shared `apps/gymtrack/server/supabaseAdmin.js` once a third consumer appears.
- `rejectIfWrongMethod(req, res, allowed)` / `unauthorized(res, message)` / `badRequest(res, message)` — borrowed verbatim from `agentAuth.js`. Keep the agent endpoint error shape identical (`401 invalid_api_key` for auth failure, `400 invalid_request` for validation, `405 method_not_allowed`).
- `SUPPORTED_SCOPES` and `scopeAllows(scope, required)` — local copies of `services/gymtrack-mcp/src/scopes.js`. They cover the same three scopes (`workouts:write`, `history:read`, `progression:read`). A comment in the file points to the canonical source so a future shared-package refactor can collapse the duplication.

### 2. Update `/api/agent/*` route handlers

- `apps/gymtrack/api/agent/history.js`: replace `resolveAgentIdentity` import with `resolveOAuthIdentity`. Pass `requireScope: 'history:read'`. Drop the `last_used_at` fire-and-forget update (the OAuth path uses `gymtrack_oauth_consents.last_used_at` instead, which is updated by the OAuth rotation path; updating it on every read would be churn).
- `apps/gymtrack/api/agent/planned-workouts.js`: same replacement, pass `requireScope: 'workouts:write'`. The `createPlannedWorkout` call drops `legacyAgentKeyId` and gains `consentId`. The full `identity` object is passed so the data layer can record the consent.
- `apps/gymtrack/api/agent/exercises/[exerciseName]/progression.js`: same replacement, pass `requireScope: 'progression:read'`.

### 3. Update `apps/gymtrack/server/agentData.js`

- `createPlannedWorkout({ userId, consentId, body })` — replaces the `legacyAgentKeyId` parameter. The `planned_workouts.agent_key_id` insert is replaced by `planned_workouts.consent_id`.
- `fetchWorkoutHistory` and `fetchExerciseProgression` — unchanged (they only consume `userId`).

### 4. Database migration: `apps/gymtrack/supabase/migrations/<timestamp>_decommission_legacy_agent_keys.sql`

Steps in a single transaction:

1. **Invalidate existing legacy keys** (preserves audit row, no destructive cleanup):
   ```sql
   update public.gymtrack_agent_api_keys
     set revoked_at = coalesce(revoked_at, now())
   where revoked_at is null;
   ```
2. **Replace `planned_workouts.agent_key_id` with `planned_workouts.consent_id`**:
   ```sql
   alter table public.planned_workouts
     add column if not exists consent_id uuid
       references public.gymtrack_oauth_consents(id) on delete set null;
   -- Pre-existing rows with a non-null agent_key_id lose attribution on this column.
   -- That is acceptable: the task says legacy keys do not need to remain active.
   alter table public.planned_workouts
     drop column agent_key_id;
   ```
3. **Drop the legacy key table and its indexes / RLS policy**:
   ```sql
   drop policy if exists gymtrack_agent_api_keys_user_isolation on public.gymtrack_agent_api_keys;
   drop index  if exists gymtrack_agent_api_keys_hash_idx;
   drop index  if exists gymtrack_agent_api_keys_user_idx;
   drop table  if exists public.gymtrack_agent_api_keys;
   ```
4. **Update `planned_workouts` RLS** to keep the existing user-isolation policy (parent table only references `user_id`, so no policy change is needed for the new column).

### 5. Remove the legacy module

- Delete `apps/gymtrack/server/agentAuth.js`.
- Delete `apps/gymtrack/src/lib/agentAuth.test.js` (it tests the deleted module).

### 6. Tests

- **New `apps/gymtrack/src/lib/oauthAuth.test.js`** — unit tests for the new module using the same `vi.mock('@supabase/supabase-js')` pattern as the existing `agentAuth.test.js`. Cases:
  - `parseBearerToken` — same coverage as the existing test (header presence, scheme case-sensitivity, empty token, capitals).
  - `hashToken` — same SHA-256 deterministic-hash coverage as the existing test.
  - `resolveOAuthIdentity` — successful OAuth access (active token + active consent → identity returned, includes `consent_id` and `scope`), revoked-token rejection (`tokens.revoked_at` set → `null`), revoked-consent rejection (`consents.revoked_at` set → `null`), expired-token rejection (`access_token_expires_at` in past → `null`), missing Authorization header → `null` without hitting DB, malformed DB error → throws, insufficient scope when `requireScope` is set → `null`, sufficient scope → returns identity.
  - `scopeAllows` — empty-scope, missing-required, exact-match, multi-scope-string membership.
  - `adminClient` — same deploy-time env validation and memoization coverage as the existing test.
  - `unauthorized` / `badRequest` / `rejectIfWrongMethod` — same shape coverage as the existing test.
- **Update `apps/gymtrack/src/lib/plannedWorkouts.test.js`** — replace `legacyAgentKeyId` fixtures with `consentId` and assert `planned_workouts.consent_id` is written.
- **New `apps/gymtrack/test/e2e/agent-oauth-flow.spec.ts`** — Playwright E2E coverage of the full OAuth flow against `/api/agent/*`:
  1. Log in as a user, navigate to Connected Agents, connect via OAuth (using the `local-dev` client for the test), capture the access token.
  2. With the access token, `GET /api/agent/history` → 200.
  3. Revoke the consent in Connected Agents → 200.
  4. With the now-revoked access token, `GET /api/agent/history` → 401.
  5. Confirm a legacy `gymtrack_agent_api_keys` row, if any survived (it should not), does not authenticate. (Treated as a regression assertion: the legacy table is dropped, so any pre-migration key is gone.)
- **Update `apps/gymtrack/test/e2e/log-workout.spec.ts`** — if the existing flow exercises `/api/agent/*` (it does not currently; the test uses the user JWT), no change. The planned-workout e2e path is unchanged from the user side.

### 7. Documentation

- `apps/gymtrack/SPEC.md` — update the "Workout plan lifecycle" and "Connected Agents" sections to describe OAuth-only credentials and the new scope-gated `/api/agent/*` endpoints.
- `docs/specs/gymtrack-oauth-decommission-2026-08-14-tech-design.md` (this document) — frontmatter `status: shipped`, `shipped_pr`, `shipped_date` once the PR merges.
- `docs/systems/gymtrack.md` (if it exists; otherwise fold into the related system doc) — note that gymtrack-agent credentials are OAuth-only and the legacy key path is retired.

## Data model changes

| Table | Change | Reason |
| --- | --- | --- |
| `gymtrack_agent_api_keys` | Drop (rows revoked first, then table dropped) | Legacy credential path is deleted. |
| `planned_workouts.agent_key_id` | Drop, replaced by `consent_id` (FK → `gymtrack_oauth_consents.id`, ON DELETE SET NULL) | Preserve "which agent created this plan" attribution under the new credential model. |

No new indexes needed — the OAuth tables already have the right partial indexes (`gymtrack_oauth_tokens_access_active_idx`, `gymtrack_oauth_consents_user_idx`).

## API contract changes

| Endpoint | Previous auth | New auth | Required scope | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/agent/history` | `gymtrack_agent_api_keys` legacy bearer | `gymtrack_oauth_tokens` OAuth bearer | `history:read` | 401 on missing/invalid/expired/revoked token or insufficient scope. |
| `POST /api/agent/planned-workouts` | same | same | `workouts:write` | Same. |
| `GET /api/agent/exercises/:exerciseName/progression` | same | same | `progression:read` | Same. |

The HTTP error shape is preserved (`401 { "error": "invalid_api_key" }`, `400 { "error": "invalid_request", "message": "..." }`, `405 { "error": "method_not_allowed" }`). No client-visible breaking change for any consumer that already uses OAuth via the MCP server. Legacy-key consumers break by design — that is the task.

## Test plan with AC verification matrix

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 — `/api/agent/*` workout-data endpoints authenticate via the revocable GymTrack OAuth credential system, not `gymtrack_agent_api_keys` | Replace-import refactor in `apps/gymtrack/api/agent/*` to use `resolveOAuthIdentity`. New `oauthAuth.test.js` covers the OAuth success path. E2E (`agent-oauth-flow.spec.ts`) step 2 proves end-to-end. | Unit + E2E |
| AC2 — Revoking an agent in Connected Agents prevents subsequent `/api/agent/*` reads | E2E step 3 → step 4: revoke, then re-attempt read with the same bearer token, expect 401. Unit: `resolveOAuthIdentity` returns `null` when `gymtrack_oauth_consents.revoked_at` is set. | Unit + E2E |
| AC3 — Existing `gymtrack_agent_api_keys` credentials are invalidated and the legacy key authorization path is removed or made unreachable | Migration invalidates all rows then drops the table. The legacy `agentAuth.js` module is deleted. Route handlers no longer import it. Unit test for `oauthAuth.test.js` does not reference `gymtrack_agent_api_keys` (it does not exist post-migration). Static check: `grep -rn 'gymtrack_agent_api_keys' apps/gymtrack` returns 0 matches. | Unit + migration + grep |
| AC4 — Automated tests cover successful OAuth access, revoked-token rejection, and rejection of legacy API keys | `oauthAuth.test.js` covers successful OAuth access and revoked-token rejection. Legacy-API-key rejection is implicitly covered by the legacy table not existing (the new module never reads from it). E2E step 4 covers the end-to-end revoked case. | Unit + E2E |
| AC5 — Tech design documents the auth cutover, data migration or cleanup, rollback approach, and final source of truth | This document. Frontmatter flips to `shipped` in the same PR that merges the code change. | Doc |

## Rollback approach

- **Code rollback:** revert the merged PR. The agent endpoints revert to `gymtrack_agent_api_keys` lookup, which would not work post-migration because the table is dropped. To make the revert meaningful, the rollback commit must also include a migration that recreates `gymtrack_agent_api_keys` and `planned_workouts.agent_key_id`. A pre-prepared `2026MMDDHHMMSS_restore_legacy_agent_keys.sql` (held in the rollback branch, not applied) provides this recreation by inverting the original migration. The legacy keys rows were merely revoked, so re-inserting them is not possible without external backup — but the table shell + index + RLS policy recreation is sufficient to make the code revert harmless (no consumers will have valid keys, they will all 401, which is the safe direction).
- **Data rollback:** none at the row level. The pre-migration data is gone (rows revoked with `revoked_at` audit-stamped; table dropped). The revocation stamp is the audit trail — there is no functional recovery, only the option to recreate the table shell as above.
- **Rollback decision rule:** if AC1 or AC2 fails in production verification within the PR's first hour post-merge, treat as a P0 and execute the rollback branch. The OAuth path is well-trodden in the same DB (it powers the MCP server today), so the failure modes are limited to (a) the migration itself breaks and (b) the new module's lookup is wrong. Both are testable pre-merge on a fresh DB clone.

## Open questions and risks

1. **Shared OAuth scope source of truth.** This PR defines `SUPPORTED_SCOPES` and `scopeAllows` in two places: `services/gymtrack-mcp/src/scopes.js` (canonical) and `apps/gymtrack/server/oauthAuth.js` (local copy). Drift between the two would let a request through with scopes the MCP server doesn't understand (or vice versa). Mitigation: a short comment in the local copy pointing at the canonical; a follow-up task to extract into a shared package. Open question for Quinn: should I file the follow-up task now, or bundle it into this PR's scope? Recommend bundling only if the refactor is < ~50 lines; otherwise file as a follow-up.
2. **`last_used_at` semantics.** The legacy path updates `gymtrack_agent_api_keys.last_used_at` on every authenticated request. The OAuth path updates `gymtrack_oauth_consents.last_used_at` only on token rotation. The new module deliberately does not write `last_used_at` on every read (it would be churn on hot paths). This means the Connected Agents UI no longer shows "last used" for an agent that is only ever reading. Acceptable trade-off but worth noting in the PR description.
3. **OAuth cache invalidation window.** The existing `resolveOAuthIdentity` in `services/gymtrack-mcp/src/app.js` does a fresh DB lookup on every request. The new module must do the same — no caching — otherwise revocation has a delay window. The implementation uses a single query against `gymtrack_oauth_tokens` with a JOIN-equivalent (lookup token, then lookup consent in the same handler) and trusts the DB for revocation freshness. No in-memory cache.
4. **Existing MCP clients.** MCP clients that already hold OAuth access tokens (Claude Desktop, ChatGPT, local-dev) already have `history:read`, `workouts:write`, `progression:read` in their default scope. They will continue to work against `/api/agent/*` after this PR. No client migration is required.
5. **Service-role key requirement.** The new module uses the same `SUPABASE_SERVICE_ROLE_KEY` env var as the existing module. No new env vars are required. No `.openclaw` config changes.

## Workflow, cron, and skill changes

- None. No new crons, no skill changes.
- The Lobster code-task workflow handles this task via `code-task.lobster.yaml`. No workflow change.

## `.openclaw` boundary

- The only configuration touching this PR is `SUPABASE_SERVICE_ROLE_KEY` and `VITE_SUPABASE_URL`, which are already configured in production. No `.openclaw` config changes.
- If those env vars are missing at deploy time, the existing `adminClient()` throws at the first request — same behaviour as today.
