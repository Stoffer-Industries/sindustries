-- GymTrack Clerk identity migration — Phase 2 prep: profiles backfill from auth.users
-- (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 2 prep (profiles backfill). Phase 2's FK repoint requires every
--         existing row's `user_id` to resolve to a `public.profiles(id)`; this
--         migration backfills one profile row per existing `auth.users` row so
--         the new FK constraint can land in one transaction.
--
-- Phase 4 (linking) later populates `profiles.clerk_user_id` from the Clerk
-- subject on first post-migration sign-in. This migration only writes the
-- legacy-side columns (`legacy_auth_user_id`, `email`, `email_verified`,
-- `signup_source = 'pre_migration'`); `clerk_user_id` stays NULL until Phase 4.
--
-- Idempotency: the backfill uses `insert … on conflict (legacy_auth_user_id)
-- do nothing`, so re-running this migration against an already-backfilled
-- database is a no-op (rows with `legacy_auth_user_id` already present are
-- skipped). Empty `auth.users` is also a no-op (zero rows inserted).
--
-- Reversibility: dropping the inserted profiles is a single
-- `delete from public.profiles where signup_source = 'pre_migration'`. The
-- linked rows created by Phase 4 have a different `signup_source` value
-- (`'google' | 'apple' | 'email_password' | 'clerk_import'`) and would
-- survive an attempted rollback, so a real rollback requires also clearing
-- Phase 4's `clerk_user_id` writes. Documented in the design's Phase 5
-- cleanup section.
--
-- Pre-requisites verified:
--   - Phase 1 (`20260922000000_clerk_profiles_schema_readiness.sql`) is
--     merged on origin/main: `public.profiles` exists with the expected
--     columns and RLS.
--   - `auth.users` is Supabase-managed and continues to hold the legacy
--     accounts until Phase 5 cleanup. This migration reads it but does not
--     modify it.

----------------------------------------------------------------------
-- 1) Backfill profiles from auth.users
----------------------------------------------------------------------
-- One row per legacy account, with `legacy_auth_user_id` and `email` carried
-- across from `auth.users`. `clerk_user_id` is NULL — Phase 4 linking
-- populates it on first Clerk sign-in, gated on verified-email match (per
-- `docs/ARCHITECTURE.md` § Account linking).
--
-- `signup_source = 'pre_migration'` distinguishes these rows from rows
-- created by Phase 4 (Google sign-in → `'google'`, Apple → `'apple'`,
-- email/password → `'email_password'`, mass-import → `'clerk_import'`).
-- Phase 5 cleanup keys on this column.
--
-- `email_verified = false` on the backfilled rows is intentional: we have
-- not re-verified the email address against Clerk; Phase 4 re-verifies
-- on first sign-in by requiring Google's `email_verified` claim and
-- updating this column on match.

insert into public
.profiles (
  legacy_auth_user_id,
  email,
  email_verified,
  signup_source,
  created_at,
  updated_at
)
select
    au.id,
    au.email,
    false,                      -- re-verified in Phase 4 by Clerk's OAuth flow
    'pre_migration',
    au.created_at,
    coalesce(au.updated_at, au.created_at, now())
from auth.users au
where au.email is not null      -- skip legacy rows with no email (defensive;
                                -- no current path produces them)
on conflict (legacy_auth_user_id) do nothing;

----------------------------------------------------------------------
-- 2) Defensive state assertion
----------------------------------------------------------------------
-- Fails fast if the backfill did not produce one profiles row per legacy
-- auth.users row with an email. The assertion is informational — Phase 2
-- can proceed even if `auth.users` is empty (e.g. a fresh test database),
-- in which case the assertion is skipped.

do $$
declare
  auth_count      bigint;
  profile_count   bigint;
  missing         bigint;
begin
  select count(*) into auth_count
    from auth.users
   where email is not null;

  select count(*) into profile_count
    from public.profiles
   where signup_source = 'pre_migration';

  if auth_count > 0 then
    if profile_count < auth_count then
      missing := auth_count - profile_count;
      raise exception
        'Phase 2 prep regression: profiles backfill produced % rows, expected at least % (auth.users with email = %)',
        profile_count, auth_count, auth_count;
    end if;
  end if;

  -- Every pre_migration row must have legacy_auth_user_id populated
  if exists (
    select 1 from public.profiles
     where signup_source = 'pre_migration'
       and legacy_auth_user_id is null
  ) then
    raise exception
      'Phase 2 prep regression: a pre_migration profile row has NULL legacy_auth_user_id';
  end if;
end $$;
