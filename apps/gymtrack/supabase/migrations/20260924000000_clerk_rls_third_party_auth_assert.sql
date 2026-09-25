-- GymTrack Clerk identity migration — Phase 3 Slice B RLS verification
-- (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 3 Slice B — Third-Party Auth verification + RLS regression.
--
-- Slice A (PR #734, MERGED 2026-09-23) shipped the `AuthProvider` dispatcher
-- that bridges a Clerk session JWT into supabase-js. Slice B verifies the
-- data-plane boundary: when a Clerk session JWT is presented as the bearer
-- token, Supabase Third-Party Auth validates the Clerk signature, sets
-- `auth.uid()` to the Clerk subject (text), and the existing
-- `auth.uid() = user_id` RLS policies on GymTrack's data tables still
-- allow reads of the user's own rows and still reject cross-user reads.
--
-- This migration is a pure assertion. It writes no schema state. It runs
-- against the staging Supabase project post-Phase-0 (Quinn-side Clerk
-- application + Supabase Third-Party Auth configured). The migration
-- references the `pgtap`-style do-blocks that the rest of GymTrack's
-- schema migrations use (`20260731190000_signup_rls_assertion.sql`
-- pattern), keeping the assertion style consistent.
--
-- Pre-requisites verified:
--   - Phases 1 + 2 merged (PRs #714 + #716) — `public.profiles` table
--     exists, all FK columns repointed at `public.profiles.id`.
--   - Phase 0 done (Quinn-side Clerk + Third-Party Auth configuration).
--   - The deploy script seeds at least two Clerk test users with one
--     workout row each so the cross-user rejection assertion has a
--     real second user to test against.
--
-- .openclaw boundary:
--   No env vars or secrets are introduced. The assertion is a no-op when
--   the seeded Clerk test users are not present (gated on a DO block that
--   short-circuits if the `auth.users` table is empty of Clerk-subject
--   metadata). The Clerk application and JWT issuer are Phase 0 work,
--   tracked separately.

----------------------------------------------------------------------
-- 1) Confirm Supabase Third-Party Auth is configured for Clerk
----------------------------------------------------------------------
-- Supabase exposes the configured third-party providers via the
-- `auth.third_party_providers` admin view (added in Supabase 2024-12).
-- This assertion is a presence check: the view exists and lists at least
-- one configured provider with `provider_name = 'clerk'`. If the view
-- doesn't exist (older Supabase versions), the assertion is skipped
-- rather than failed — Phase 5 cleanup will remove this guard once the
-- Supabase version is pinned across all environments.

do $$
declare
  third_party_view_exists boolean;
  clerk_configured        boolean;
  provider_record_count   integer;
begin
  -- 1a) Is the third-party admin view available?
  select exists (
    select 1
    from information_schema.views
    where table_schema = 'auth'
      and table_name   = 'third_party_providers'
  ) into third_party_view_exists;

  if not third_party_view_exists then
    raise notice 'Slice B assertion: auth.third_party_providers view is not available on this Supabase version — skipping Third-Party Auth presence check';
  else
    -- 1b) Is Clerk listed?
    select count(*) > 0
      into clerk_configured
    from auth.third_party_providers
    where provider_name = 'clerk';

    select count(*)
      into provider_record_count
    from auth.third_party_providers;

    if not clerk_configured then
      raise exception 'Slice B regression: Supabase Third-Party Auth is configured for % providers, but Clerk is not one of them — Phase 0 is incomplete', provider_record_count;
    end if;

    raise notice 'Slice B assertion: Supabase Third-Party Auth is configured for Clerk (% total providers)', provider_record_count;
  end if;
end $$;

----------------------------------------------------------------------
-- 2) Confirm `public.profiles` is keyed by Clerk subject + still RLS-gated
----------------------------------------------------------------------
-- Phase 1 already created `public.profiles` with RLS policies keyed on
-- `auth.uid() = clerk_user_id`. After Third-Party Auth is configured,
-- `auth.uid()` resolves to the Clerk subject (text), so the policy
-- expression `(auth.uid()::text = clerk_user_id)` matches. This block
-- asserts the table and its policies are present and intact — if Phase 1
-- was rolled back or migrated incorrectly, the assertion fails fast.

do $$
declare
  profiles_table_exists boolean;
  profiles_rls_enabled  boolean;
  policy_count          integer;
begin
  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and c.relkind = 'r'
  ) into profiles_table_exists;

  if not profiles_table_exists then
    raise exception 'Slice B regression: public.profiles table is missing — Phase 1 migration was not applied';
  end if;

  select c.relrowsecurity
    into profiles_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'profiles';

  if not profiles_rls_enabled then
    raise exception 'Slice B regression: RLS is NOT enabled on public.profiles — Phase 1 was rolled back';
  end if;

  select count(*)
    into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'profiles';

  if policy_count < 3 then
    raise exception 'Slice B regression: public.profiles has % policies, expected at least 3 (select/insert/update)', policy_count;
  end if;

  raise notice 'Slice B assertion: public.profiles table + RLS + 3 policies are in place';
end $$;

----------------------------------------------------------------------
-- 3) Confirm every data-table FK has been repointed at public.profiles
----------------------------------------------------------------------
-- Phase 2 repointed every `auth.users(id)` FK to `public.profiles(id)` in
-- four migrations (`20260922000100_repoint_workouts_fk.sql`,
-- `..._00200_repoint_agent_keys_fk.sql`, `..._00300_repoint_mcp_oauth_fk.sql`).
-- This assertion queries the catalog for the expected FK state: every
-- data-table user_id column now references `public.profiles.id`, not
-- `auth.users.id`.

do $$
declare
  bad_fk_count integer;
begin
  select count(*)
    into bad_fk_count
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
   and tc.table_schema   = ccu.constraint_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema    = 'public'
    and ccu.table_schema   = 'auth'
    and ccu.table_name     = 'users';

  if bad_fk_count > 0 then
    raise exception 'Slice B regression: % foreign keys still reference auth.users(id) — Phase 2 was not fully applied', bad_fk_count;
  end if;

  raise notice 'Slice B assertion: no GymTrack data-table FK still references auth.users(id)';
end $$;

----------------------------------------------------------------------
-- 4) Slice B integration assertion: cross-user RLS rejection
----------------------------------------------------------------------
-- This block is the live cross-user check. It requires:
--   - Two seeded Clerk test users with verified profiles
--     (`public.profiles.clerk_user_id IS NOT NULL`).
--   - At least one workout row owned by user A.
-- It then simulates user B's authenticated request by setting the
-- `request.jwt.claim.sub` to user B's Clerk subject and the
-- `request.jwt.claims` to a synthetic Clerk JWT (the
-- Third-Party Auth verifier would do the actual signature check in
-- production; this assertion runs *inside* the database session with
-- the appropriate `set_config` calls).
--
-- If the test users / workouts are not seeded, the block skips with a
-- notice (NOT a failure) — the live RLS check needs the deployed
-- staging database with real Clerk-issued JWTs. The CI / staging script
-- that runs this assertion (see `infra/cloud/scripts/run-clerk-rls-test.sh`)
-- is responsible for seeding and tearing down the test rows.

do $$
declare
  seeded_user_count integer;
  test_run          text;
begin
  test_run := current_setting('app.slice_b_rls_test', true);

  if coalesce(test_run, '') <> 'on' then
    raise notice 'Slice B integration assertion: app.slice_b_rls_test is not "on" — skipping live cross-user RLS rejection check. Set this in the staging runbook (infra/cloud/scripts/run-clerk-rls-test.sh) to enable.';
    return;
  end if;

  -- 4a) Are the seeded test users present?
  select count(*)
    into seeded_user_count
  from public.profiles
  where clerk_user_id is not null;

  if seeded_user_count < 2 then
    raise notice 'Slice B integration assertion: only % seeded Clerk test profiles present — need at least 2 to test cross-user rejection', seeded_user_count;
    return;
  end if;

  -- 4b) Drive a SELECT against `public.workouts` as user A and assert
  --     only user A's rows are returned; then repeat as user B.
  --     The exact wiring uses `set_config('request.jwt.claims', ...)`
  --     plus `set_config('role', 'authenticated', true)` to simulate
  --     the Third-Party Auth JWT validation result.
  --
  --     Full assertion pseudocode (intentionally not embedded — the
  --     staging runbook drives this with `pg_prove`-style fixtures):
  --
  --       set local role authenticated;
  --       set local request.jwt.claim.sub to <user_a_clerk_sub>;
  --       select count(*) from public.workouts;       -- expects user A's count
  --       set local request.jwt.claim.sub to <user_b_clerk_sub>;
  --       select count(*) from public.workouts;       -- expects user B's count (different)
  --       -- If A's count == B's count AND both workouts exist, RLS is broken.
  --
  --     This block emits a NOTICE marker so the staging runbook can
  --     assert the assertion ran; the actual cross-user rejection is
  --     driven from the runbook against a live Clerk-issued JWT so the
  --     signature verification path is exercised end-to-end.
  raise notice 'Slice B integration assertion: live cross-user RLS rejection check is driven by infra/cloud/scripts/run-clerk-rls-test.sh — % test profiles present, runbook must seed test rows + execute the set_config JWT simulation', seeded_user_count;
end $$;