---
status: draft
task_id: bb09eaed-c15e-4770-be5d-8a245a62afc9
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Migrate GymTrack identity from Supabase Auth to Clerk — Tech Design

## Links

- Task: `bb09eaed-c15e-4770-be5d-8a245a62afc9`
- Tasks API record: `http://localhost:4001/api/v1/tasks/bb09eaed-c15e-4770-be5d-8a245a62afc9`
- Architectural decision: PR #703 "docs(architecture): decide Clerk as canonical identity issuer" (open as of 2026-09-19, tracks the decision Tom made in chat 2026-09-19; expected to land before this tech design ships). Once merged, `docs/ARCHITECTURE.md` § Identity will state: "the canonical identity issuer is Clerk" and call out that Supabase's data plane stays in place with Third-Party Auth verifying Clerk's JWTs.
- Prior related design: `docs/specs/gymtrack-public-signup-social-login-tech-design.md` (the social-login path this task is migrating *off of*; same UI surface, different issuer).
- GymTrack app spec: `apps/gymtrack/SPEC.md` (flows and ACs for sign-up / sign-in that this design preserves).

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-bb09eaed-migrate-gymtrack-identity-to-clerk`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-bb09eaed-migrate-gymtrack-identity-to-clerk`

## `.openclaw` boundary notes

This task introduces a **new external credential** (the Clerk application + Clerk-issued session JWTs) and changes the auth boundary. Per `docs/CONVENTIONS.md` and the tasks-create skill, that warrants both this tech design and Quinn sign-off. Several pieces must be handled outside this repo before/around the code cutover:

1. **Clerk application provisioning** — Quinn creates the production Clerk application, configures the sign-in URL (GymTrack's deployed origin), and provisions the publishable + secret keys. Same pattern as the existing Supabase OAuth provider setup (`brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md` referenced that boundary). Flag `[openclaw-needed]` with exact env var names.
2. **Google OAuth provider at Clerk** — register GymTrack's Google OAuth client (or reuse the existing one) inside Clerk so Google sign-in is wired through Clerk's hosted flow rather than Supabase's. The current Supabase-side Google OAuth redirect URI must be removed only after the Clerk-side redirect is verified end-to-end.
3. **Supabase Third-Party Auth configuration** — Quinn configures the GymTrack Supabase project's Third-Party Auth to accept Clerk's JWTs (issuer + JWKS URL, claim mapping for `auth.uid()`). This is a project-level setting on Supabase's side, not a code change.
4. **Apple provider decision** — Apple is currently in `DISABLED_OAUTH_PROVIDERS` (`apps/gymtrack/src/lib/authFlow.js`). Whether Apple ships in this task or a follow-up is a Quinn/`.openclaw` decision — verify with Quinn before assuming Apple is in scope. If out of scope, the Apple button must remain absent from first paint with no live attempts to call Clerk's Apple flow (carry the same `DISABLED_OAUTH_PROVIDERS` style guard through the Clerk UI wiring).
5. **Email/password credential lifecycle** — Supabase's email/password is currently the secondary sign-in path (collapsed panel on `/signup`, primary path on `/login`). Clerk's email/password is its own credential store. Existing GymTrack email/password users have to migrate their credentials — Clerk supports an import flow via its Backend SDK (`clerkClient.users.createUser({ email_address, password })` per user) plus a one-shot invitation flow. Quinn decides whether to mass-import existing users or treat the migration as "create-a-new-account" for any user who only ever used email/password and skip the linking flow entirely. The default proposed here is mass-import: Tom and the one prior test user are the only known email/password accounts; importing them avoids a forced reset.

## Product intent summary

The task description (durable product spec since the original `brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md` is no longer in the visible workspace):

- Move GymTrack's identity layer off Supabase native Auth onto Clerk — the canonical Sindustries identity issuer per the architectural decision in PR #703.
- Keep GymTrack's workout / exercise data in Supabase. Wire Supabase's Postgres to Clerk via Supabase's [Third-Party Auth](https://supabase.com/docs/guides/auth/third-party/overview), which verifies Clerk's asymmetric JWTs and lets existing RLS policies (`auth.uid() = user_id`) keep working once they are repointed.
- Repoint every `auth.users(id)` foreign key in the GymTrack schema at a new `public.profiles` table keyed by the Clerk subject (the third-party-authenticated user never lands in Supabase's `auth.users`).
- Re-register Google OAuth against Clerk (same Google client, new redirect target) so existing users who signed up via "Continue with Google" can keep their account after the cutover.
- Link existing users to their pre-migration workout history by **verified Google email** on first post-migration login. Verified means Google returned `email_verified: true` for the address matched in `public.profiles`; unverified-email merging is explicitly disallowed by `docs/ARCHITECTURE.md` § Account linking.
- Apple: gated on Quinn's call (item 4 in `.openclaw` boundary notes).

## Service boundary and data ownership

- **Identity issuer**: Clerk (managed, outside this repo). Owned by Quinn; lifecycle, signing keys, and user directory are Clerk's responsibility.
- **Data store**: Supabase Postgres. Owned by GymTrack. Schema migrations to add `public.profiles` and repoint FKs land in `apps/gymtrack/supabase/migrations/`.
- **Token verification**: Supabase verifies Clerk's JWTs in the data plane (via Supabase Third-Party Auth), so `auth.uid()` and `auth.jwt()` resolve to the Clerk subject at the RLS layer with no policy rewrites required. The app-side supabase-js client continues to send a bearer token; that token is now a Clerk session JWT (or a one-time Clerk-issued third-party JWT that supabase-js exchanges internally), not a Supabase-issued access token.
- **MCP server** (`services/gymtrack-mcp`): unchanged contract. The MCP service issues its own bearer tokens (static and OAuth Code + PKCE paths from prior tasks) keyed to GymTrack's `public.profiles.id` rather than `auth.users.id`. The token-issuance code reads the current request's authenticated subject from supabase-js, which now resolves to a `profiles.id` after this migration — the only change is the column name in the lookup. The MCP service does **not** itself become a Clerk client; it consumes the third-party-authenticated session the GymTrack app already established.
- **Why not extend `tasks-api` or any other service?** Identity is a horizontal product surface, not a tasks domain. Each product verifies Clerk independently; routing identity through `tasks-api` would create a cross-domain dependency for every sign-up flow.

## Ownership boundary check (per `SOUL.md`)

Natural source-of-truth decisions:

- **UI-local state** — the Clerk React SDK manages session state, org claims, and user metadata locally. The app's `AuthProvider` (`apps/gymtrack/src/lib/auth.jsx`) becomes a thin wrapper around `useUser()` / `useSession()` from `@clerk/react`. No bespoke session cache.
- **API-owned resource** — the new `public.profiles` table is the GymTrack-owned profile resource, keyed by the Clerk subject (`text` storing Clerk's `user.id`, primary-keyed so RLS can do `auth.uid() = profiles.clerk_user_id` lookups). Profiles carry product-local fields (display name, signup source) that don't belong in Clerk.
- **Database-backed domain data** — workouts, workout sets, planned workouts, agent API keys, MCP OAuth rows all stay where they are; only their FK column changes target.
- **Shared package / cross-app contract** — none. Each product will eventually verify Clerk on its own (the architecture direction in `docs/ARCHITECTURE.md`). GymTrack is the first product; do not extract a shared `@sindustries/auth` package in this task — premature without a second consumer.
- **Workflow / cron / skill boundary** — no agent-side change. Heartbeats and content pipelines continue to consume `TASKS_API_APPROVAL_TOKEN`-style service credentials; Clerk does not introduce a new machine-caller pattern.

Incremental delivery posture: prefer a **phased cutover** (see Implementation plan) rather than a "stop the world and swap" because the migration touches every authenticated row in production. The phases are interleaved with the durable boundary (the `public.profiles` table) being created in phase 2, not deferred to a follow-up — adding the table before any FK repoint means RLS never sees a window where the new column is nullable but the constraint has already moved.

## Implementation plan

Phased; each phase is a separately-reviewable PR that does not require any prior phase to be merged before the next starts (parallelisation constraint noted in Open questions).

### Phase 0 — Quinn-side prerequisites (`.openclaw`, outside this repo)

- Create the Clerk application, configure the GymTrack sign-in URL.
- Register Google as an OAuth provider inside Clerk; copy the new redirect URI.
- Configure Supabase Third-Party Auth with Clerk's issuer + JWKS URL; map Clerk's `sub` claim to `auth.uid()`.
- Decide on Apple (in / out of this task) and email/password import strategy.
- Add env vars: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (server-side only, used by MCP service if it ever needs to introspect), `CLERK_JWT_KEY` (optional, only if Supabase needs it for verification). Update `apps/gymtrack/README.md` accordingly.

This task cannot begin implementation until Phase 0 is signed off in `[openclaw-needed]`-driven flow. Phase 0 is the precondition the architectural decision (PR #703) implies; this task surfaces it as an explicit pre-implementation gate, not an implicit one.

### Phase 1 — Read-only: Schema inspection, dry-run migration rehearsal

Single PR with **no application changes**, schema-only writes that are idempotent and back-out safe. Establishes the migration surface area.

- `apps/gymtrack/supabase/migrations/20260919000000_clerk_profiles_schema_readiness.sql` (new):
  - Creates `public.profiles` table — `(id uuid primary key default gen_random_uuid(), clerk_user_id text unique not null, email text, display_name text, signup_source text, legacy_auth_user_id uuid unique, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`.
  - `legacy_auth_user_id` is the pre-migration `auth.users.id` for the same human (populated during linking). The `unique` constraint enforces one profile per legacy auth user; back-fill from `auth.users` during phase 2.
  - Adds `clerk_user_id` index for the RLS lookup pattern (`auth.uid()` is text-typed; the lookup column is text-typed too).
  - Sets up RLS on `profiles` mirroring the existing pattern: `select`/`insert`/`update` restricted to `(auth.uid() = clerk_user_id)`. This works once Third-Party Auth is configured even though `auth.uid()` resolves to the Clerk subject.
  - Adds a trigger that auto-creates a `profiles` row on first authenticated request (insert into `profiles` if not present, keyed by `auth.uid()`).
- Adds `npm run check:clerk-profiles-readiness` script that asserts every GymTrack FK target column now has a matching `clerk_user_id` lookup (dry-run, no writes).

This PR is reviewable in isolation and proves the schema accepts the new identity model before any code path touches it.

### Phase 2 — Schema migration: FK repoint (no app code change)

Sequenced as several small migrations so each is back-out safe:

1. Add a `clerk_user_id text` column to every table that currently has `user_id uuid references auth.users(id)`. Backfill from `auth.users.id` lookup (the column is text, so cast via `user_id::text`).
2. `validate` the backfill (assert no NULLs).
3. Add a generated column or trigger that keeps `clerk_user_id` in sync with a future `public.profiles.id` once the linking step runs.
4. Drop the old `user_id uuid references auth.users(id)` FK, replace with `user_id uuid references public.profiles(id) on delete cascade`.
5. Update RLS policies where the policy expression referenced `auth.uid()` on `user_id` directly — actually, no: `auth.uid()` works against the **session subject** at the database boundary. After Supabase Third-Party Auth is configured, `auth.uid()` returns the Clerk subject (text). RLS expressions that say `auth.uid() = user_id` become `(auth.uid()::uuid = user_id)` only if `user_id` is still UUID — but `user_id` will now be a `profiles.id` UUID, and `auth.uid()` (the Clerk subject) is **not** a UUID. So:
   - **Option A (recommended):** keep `user_id` as UUID → `profiles.id`, change RLS to `auth.uid()::text = (select clerk_user_id from profiles where id = user_id)`. This makes the policies perform a subquery per row; acceptable at GymTrack's scale (single-tenant per request).
   - **Option B:** denormalise `clerk_user_id` onto every table, change `user_id` to `clerk_user_id text`. More storage, simpler RLS, but every join and every existing query has to be updated.
   - Pick **Option A** unless profiling shows the subquery is a hotspot. The RLS subquery is cheap because every `user_id` is already indexed by primary key. Document the call in the PR description and in `apps/gymtrack/SPEC.md`.

Files affected (one migration per table group):

- `apps/gymtrack/supabase/migrations/20260919010000_repoint_workouts_fk.sql` — `public.workouts` and `public.workout_sets` (sets inherit via parent workout lookup).
- `apps/gymtrack/supabase/migrations/20260919020000_repoint_agent_keys_fk.sql` — `public.gymtrack_agent_api_keys`, `public.planned_workouts`, `public.planned_workout_sets`.
- `apps/gymtrack/supabase/migrations/20260919030000_repoint_mcp_oauth_fk.sql` — `public.gymtrack_oauth_clients` has no `user_id`; the user-scoped rows are `gymtrack_oauth_consents`, `gymtrack_oauth_authorization_codes`, `gymtrack_oauth_tokens`.

Each migration ships with a smoke test assertion (the existing `20260731190000_signup_rls_assertion.sql` pattern: a `do $$ … raise exception … $$` block that asserts RLS state after the migration).

### Phase 3 — Code cutover: swap Supabase Auth → Clerk

Application-side. UI swap behind a feature flag (`VITE_AUTH_PROVIDER=clerk|supabase`) for one deploy cycle so the rollback path is one env-var flip rather than a re-deploy.

- `apps/gymtrack/package.json` — add `@clerk/react` (the supported Core 3 successor to the now-deprecated `@clerk/clerk-react`). Pin a version; no `^` to keep the Vite-resolution path stable.
- `apps/gymtrack/src/lib/auth.jsx` — keep the existing `AuthProvider` interface so consumers do not change. Internally, when `VITE_AUTH_PROVIDER === 'clerk'`, wrap with Clerk's `ClerkProvider` and proxy `session/user/loading/signIn/signUp/signOut` to Clerk's hooks. When `=== 'supabase'`, fall through to the current behaviour. The proxy layer keeps the consumer surface stable across the cutover.
- `apps/gymtrack/src/lib/authFlow.js` — `signInWithOAuthRedirect` becomes a Clerk OAuth redirect (`window.location.assign(clerk.buildUrlWithAuth('sso-callback-id'))` style), but the function signature stays `{ data, error, providerDisabled }`. `DISABLED_OAUTH_PROVIDERS` is sourced from Clerk's runtime config (`clerk.userSettings` or equivalent) so the Apple-hidden-on-first-paint behaviour carries over without a separate list.
- `apps/gymtrack/src/components/SignUpPage.jsx` — no DOM change. The `<button data-testid="signup-google">` stays; the `handleOAuth` calls now invoke the Clerk-backed `signInWithOAuthRedirect`. Same e2e test surface.
- `apps/gymtrack/src/components/LoginScreen.jsx` — same proxy approach for `signInWithPassword` (now `signIn.create({ identifier, password })` from Clerk).
- `apps/gymtrack/src/lib/supabase.js` — no behavioural change. The supabase-js client still uses the publishable key + URL; the only diff is that the bearer token it sends is now a Clerk-issued session JWT that Supabase's Third-Party Auth verifies before letting the request reach Postgres.
- `apps/gymtrack/test/e2e/signup-google.spec.ts` — keep the assertion that clicking "Continue with Google" navigates to the OAuth provider's consent screen. The matched URL pattern broadens from `/accounts\.google\.com|supabase\.co\/auth\/v1\/authorize/` to `/accounts\.google\.com|clerk\.your-instance\.com/` (Clerk's hosted account portal URL pattern). Update the env-var gate name to `CLERK_TEST_URL` for symmetry with the rest of the test, but keep accepting `SUPABASE_TEST_URL` as a fallback during the cutover window.
- `apps/gymtrack/src/lib/supabase-server.ts` (server-side, if present in MCP integration helpers) — same swap. Document in the PR that the server-side supabase client should continue to use the **publishable** key (Clerk session JWT in `Authorization: Bearer`) for browser-originated requests, and the **service-role** key only for migrations and admin tasks, never for end-user requests.
- `services/gymtrack-mcp` — `authenticateRequest` (or equivalent) reads the supabase client's session subject, which is now a Clerk subject resolving through `public.profiles.id`. Update the database lookup to join against `profiles` instead of `auth.users`. The MCP-issued bearer tokens are unchanged in shape; only the user-id they map to is now a `profiles.id`. No new dependencies.

This phase is the cutover. After it lands behind the feature flag, the rollback path is `VITE_AUTH_PROVIDER=supabase` until the flag flips default.

### Phase 4 — Existing-user linking + first-login cutover

- `apps/gymtrack/supabase/migrations/20260919040000_clerk_link_existing_users.sql` (new):
  - Backfill `profiles` from `auth.users`: for every `auth.users` row with a verified email, create a `profiles` row with `legacy_auth_user_id = auth.users.id` and `email = auth.users.email`. This is the **source of truth for matching** during the linking step.
  - Leave `clerk_user_id` NULL — the linking step populates it on first post-migration login.
- Linking runs **on first post-migration sign-in** from a Google account where Google's `email_verified` is `true`:
  - Clerk returns a session JWT with the Google-verified email.
  - The GymTrack sign-in handler (`apps/gymtrack/src/lib/auth.jsx` `signIn` proxy) does a one-time lookup in `profiles` by `email = $clerk_email AND legacy_auth_user_id IS NOT NULL`.
  - If a match is found, write `clerk_user_id = $clerk_sub` and clear `legacy_auth_user_id` (or keep it for audit — keep for audit; the column has `unique`, not `not null`, so the historical id stays alongside the new id).
  - If no match: create a new `profiles` row keyed by `clerk_user_id`. Fresh sign-up; no migration.
- Unverified-email matches are **rejected**. The user is asked to verify their Google email and try again. This is the `docs/ARCHITECTURE.md` § Account linking rule.
- Email/password users: handled by Quinn's mass-import decision in Phase 0. If mass-import is chosen, the import step writes `clerk_user_id` directly on each profile (no first-login linking). If not, those users re-create their account.

### Phase 5 — Cleanup

- Remove `DISABLED_OAUTH_PROVIDERS` if Clerk's Apple flow is enabled. If not, leave the gating in place and ship a follow-up task.
- Remove the Supabase Auth code paths from `auth.jsx` / `authFlow.js` (the `VITE_AUTH_PROVIDER === 'supabase'` branch).
- Drop the `legacy_auth_user_id` column from `public.profiles` after the next full audit window confirms no live lookups use it. Keep at least one full quarter before dropping.
- Update `apps/gymtrack/SPEC.md` flows (Sign up / Sign in) to reference Clerk instead of Supabase for the auth step, while keeping Supabase as the data store.

### Phase 6 — System doc + app spec updates

- `docs/systems/` — find the closest match (likely `docs/systems/cloud-platform.md` if it covers identity, otherwise create a new `docs/systems/identity.md` if the cross-cutting identity surface warrants a system doc per the `CONVENTIONS.md` self-check: yes / yes / yes — covers auth boundary across all Sindustries products, durable for ≥ 2 future changes, defines a system boundary). Reuse the existing `docs/ARCHITECTURE.md` § Identity section as the architectural source of truth and avoid duplicating content.
- `apps/gymtrack/SPEC.md` — update Sign up / Sign in flows to describe Clerk instead of Supabase Auth; preserve the same end-user UX.
- `docs/ARCHITECTURE.md` — already updated by PR #703; no further edit needed unless the cutover reveals a gap.

## Data model / API contract

- **New table:** `public.profiles` (see Phase 1 for full schema). Single source of truth for the local product-membership row keyed by Clerk subject.
- **Modified tables (FK repoint):**
  - `public.workouts`, `public.workout_sets` (via parent lookup)
  - `public.gymtrack_agent_api_keys`, `public.planned_workouts`, `public.planned_workout_sets`
  - `public.gymtrack_oauth_consents`, `public.gymtrack_oauth_authorization_codes`, `public.gymtrack_oauth_tokens`
- **RLS changes:** every existing `auth.uid() = user_id` policy becomes a subquery against `profiles.clerk_user_id` (Option A from Phase 2). Document each change inline.
- **No public REST contract change.** Supabase auto-generated REST/GraphQL endpoints continue to expose the same row shape; the only caller-visible diff is the bearer token format.
- **MCP service contract:** no external contract change. Internal: bearer-token lookup joins against `profiles` instead of `auth.users`.

## Workflow / cron / skill changes

- None. The Tasks API, content scheduler, budget API, and agent heartbeats continue to use their existing service-credential patterns. Clerk is browser-facing identity only per PR #703; machine-to-machine stays as it is.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — GymTrack sign-up / sign-in (email/password and Google) authenticate through Clerk, with RLS verifying the Clerk-issued JWT via Supabase Third-Party Auth | E2E: `signup-google.spec.ts` (extended URL match) + `signup.spec.ts` (email/password path via Clerk) + a new `signin.spec.ts` exercising the email/password path through the Clerk proxy. Integration: `pg-meta` test that sets `Authorization: Bearer <clerk-jwt>`, queries `public.workouts`, asserts `auth.uid()` resolves to the Clerk subject and RLS allows reads of the user's own workouts. |
| AC2 — workouts/workout_sets/MCP-OAuth tables reference `public.profiles` (keyed by Clerk subject) instead of `auth.users(id)`; no orphaned rows after migration | Migration-time assertion in each `*_repoint_*.sql` file: `do $$ … assert count(*) where profiles.clerk_user_id is null and legacy_auth_user_id is not null = 0 … raise exception $$`. Plus an integration test that signs in as a user with legacy workout history via Clerk, queries the same workouts through supabase-js, asserts the row count matches the pre-migration count. |
| AC3 — existing users who signed up via Supabase Google are linked to their workout history by verified Google email on first post-migration login; no data loss | E2E: seed a `profiles` row in the test DB with `email = test@example.com, legacy_auth_user_id = $uuid, clerk_user_id = null`. Run the Playwright Google-sign-in flow against a Clerk test instance with that same verified email. Assert post-login: `profiles.clerk_user_id = $clerk_subject`, `profiles.legacy_auth_user_id = $uuid` (preserved), and the workouts for that user are visible. Negative case: same scenario with `email_verified = false` — assert linking is rejected and the user is asked to verify. |
| AC4 — tech design at `docs/specs/<slug>-tech-design.md` documents Clerk setup, FK/RLS plan, and linking plan, and has Quinn's recorded tech_design approval before implementation begins | This doc satisfies AC4 structurally. Approval gate is enforced by the lobster: `[tech-design]` comment is posted on PR opening; Quinn's `approve --type tech_design` is required before `open → doing`. |

User-visible ACs (AC1, AC3) are E2E-covered. AC2 is migration-level + integration. AC4 is workflow-level.

## Open questions and risks

- **Apple provider**: in-scope or follow-up? The current `DISABLED_OAUTH_PROVIDERS = ['apple']` gating is fine if Apple is out — verify with Quinn.
- **Email/password import strategy**: mass-import via Clerk's Backend SDK or treat as new accounts? Decision lives with Quinn.
- **Option A vs Option B for RLS**: Option A (subquery through `profiles`) is the default. If the per-request RLS cost is measurable (only likely at very large workloads; GymTrack is single-user per request), move to Option B in a follow-up. Profile before declaring A the long-term shape.
- **Phase 0 vs Phase 1 ordering**: Phase 0 (Quinn provisioning) must complete before Phase 3 (code cutover), but Phases 1 and 2 can run in parallel with Phase 0 — Quinn's work is on Clerk + Supabase project config, not on this repo. The `bb09eaed` task itself is `open` until Phase 0 is done; the lobster's `[openclaw-needed]` tag will surface the unblocker.
- **Rollback**: feature flag `VITE_AUTH_PROVIDER=supabase` lets the deployed app flip back to the Supabase path without a re-deploy, until Phase 5 cleanup. Document the rollback runbook in `docs/systems/identity.md` (Phase 6).
- **Existing service-role access**: `services/gymtrack-mcp` uses the service-role key for migrations and admin tasks. Third-Party Auth does not affect service-role access; migrations land with the same `SUPABASE_SERVICE_ROLE_KEY` they always have.
- **Supabase studio / manual queries**: after the cutover, `select * from auth.users` still shows the old accounts (they were never deleted). Document for Quinn that `auth.users` is now a legacy migration surface, not a live user directory.
- **Existing test infrastructure**: the Playwright e2e suite gates on `SUPABASE_TEST_URL` today. After the cutover, gate on `CLERK_TEST_URL` (with `SUPABASE_TEST_URL` as a fallback during the cutover window). Plan to remove the fallback in Phase 5.

## Linked spec

- Task description (durable product spec for this workstream): `http://localhost:4001/api/v1/tasks/bb09eaed-c15e-4770-be5d-8a245a62afc9`
- Architectural decision: PR #703 (currently open)
- Prior social-login design (this task is migrating off it): `docs/specs/gymtrack-public-signup-social-login-tech-design.md`
- App behavioural spec: `apps/gymtrack/SPEC.md`
- Architecture principles: `docs/ARCHITECTURE.md` § Identity, § Account linking, § Required identity and tenancy questions
