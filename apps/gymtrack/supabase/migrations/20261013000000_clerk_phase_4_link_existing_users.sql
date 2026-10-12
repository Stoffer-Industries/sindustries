-- GymTrack Clerk identity migration — Phase 4 linking (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 4 (Existing-user linking + first-login cutover).
--
-- Phase 4 closes the identity-migration story by linking every existing
-- Supabase-Auth-created GymTrack user to their Clerk subject on the next
-- Clerk sign-in. The function `public.link_clerk_user_to_profile` is the
-- single, atomic entry point: it accepts the Clerk subject + verified
-- email and either (a) returns the already-linked profile, (b) links the
-- pre-migration profile by verified-email match, or (c) creates a new
-- profile for a fresh sign-up.
--
-- Why SECURITY DEFINER:
--   The linking flow needs to look up a pre-migration profile by
--   `email = $clerk_email` BEFORE the user is linked. The RLS policy
--   `profiles_self_select` only allows the user to see rows where
--   `auth.uid()::text = clerk_user_id`, but for a not-yet-linked
--   pre-migration row `clerk_user_id IS NULL`, so the user cannot
--   read it through RLS. SECURITY DEFINER lets the function run with
--   the migration-owner's privileges (bypassing RLS) to do the lookup
--   and the link write atomically. The function's input validation
--   keeps the surface narrow: only a Clerk subject shape, an email
--   string, and a boolean are accepted; the function never accepts
--   arbitrary SQL or rows from the caller.
--
-- Why a function instead of a service-role edge function:
--   The function lives next to the data it mutates (same schema,
--   same transaction). Atomicity is guaranteed: the read, the link
--   write, and the audit column update all happen in one transaction.
--   No service-role key in the browser bundle. No additional deploy
--   target. Same `supabase.rpc('...')` shape the rest of GymTrack
--   already uses.
--
-- Idempotency:
--   - Already linked: returns the existing profile.
--   - Race between two concurrent first-sign-ins for the same Clerk
--     subject: caught by the partial unique index on `clerk_user_id`
--     and re-read on `unique_violation`.
--   - Email collision between a legacy row and a freshly inserted
--     non-legacy row: the fresh row has no `legacy_auth_user_id` so
--     the linking path skips it; the function falls through to the
--     insert path, which succeeds or fails on the unique index.
--
-- Reversibility:
--   Setting `clerk_user_id = NULL` on a linked profile undoes the link.
--   The pre-migration row is preserved with `legacy_auth_user_id` still
--   populated, so the user can re-link from a different Clerk account.
--   Phase 5 cleanup is the durable removal of `legacy_auth_user_id`.
--
-- Pre-requisites verified:
--   - Phase 1 (`20260922000000_clerk_profiles_schema_readiness.sql`):
--     `public.profiles` exists with `clerk_user_id`, `email`,
--     `email_verified`, `signup_source`, `legacy_auth_user_id`.
--   - Phase 2 prep (`20260922000050_backfill_profiles_from_auth_users.sql`):
--     pre-migration rows are present with `signup_source = 'pre_migration'`
--     and `clerk_user_id IS NULL`.
--   - Phase 3 Slice A + Slice B (PRs #734 + #792) merged: the Clerk
--     session JWT is accepted by Supabase's Third-Party Auth control
--     plane and `auth.uid()` resolves to the Clerk subject at the RLS
--     boundary.
--
-- .openclaw boundary:
--   No env vars or secrets are introduced. The migration only writes
--   durable schema state. The Phase 4 function is called from the
--   client side with the user's own Clerk session JWT (which Supabase
--   has already verified); the function itself does not authenticate
--   the caller, but the function's mutation is bounded by the
--   `clerk_user_id` it receives (a Clerk subject is unforgeable from
--   the caller's perspective — a caller cannot impersonate another
--   Clerk subject because they would need that subject's session JWT,
--   which only Clerk can issue).

----------------------------------------------------------------------
-- 1) link_clerk_user_to_profile function
----------------------------------------------------------------------
-- The single entry point for the Phase 4 linking flow. Returns the
-- `public.profiles` row representing the caller (idempotent on repeated
-- calls). Three cases inside, in order:
--
--   1. **Already linked.** A profile with `clerk_user_id = $p_clerk_user_id`
--      exists. Return it without mutation. This is the steady-state
--      call from the client on every sign-in.
--
--   2. **Link pre-migration profile by verified email.** A profile
--      with `email = lower($p_email) AND clerk_user_id IS NULL AND
--      legacy_auth_user_id IS NOT NULL` exists. The caller has supplied
--      `p_email_verified = true`, so per
--      `docs/ARCHITECTURE.md` § Account linking, we link by setting
--      `clerk_user_id = $p_clerk_user_id`, `email_verified = true`,
--      and `signup_source = $p_signup_source`. The `for update` lock
--      prevents two concurrent sign-ins from racing on the same
--      legacy row.
--
--      If `p_email_verified = false` but a legacy profile with the same
--      email exists, the function raises `unverified_email_cannot_link`
--      so the UI can prompt the user to verify before retrying. This
--      matches the architecture rule that unverified-email merging is
--      explicitly disallowed.
--
--   3. **Fresh sign-up.** No profile with the Clerk subject exists and
--      no legacy profile matches the email. Insert a new profile row
--      keyed by the Clerk subject. The unique partial index on
--      `clerk_user_id` (Phase 1 schema) protects against a concurrent
--      insert race; the function re-reads the winning row on
--      `unique_violation`.

create or replace function public.link_clerk_user_to_profile(
  p_clerk_user_id text,
  p_email text,
  p_email_verified boolean,
  p_signup_source text default 'clerk_first_login'
) returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_email text;
begin
  -- 1a) Input validation — narrow surface, no SQL injection vector
  if p_clerk_user_id is null or p_clerk_user_id !~ '^user_[A-Za-z0-9]+$' then
    raise exception 'link_clerk_user_to_profile: invalid_clerk_user_id'
      using errcode = '22023';
  end if;
  if p_email is null or length(trim(p_email)) < 3 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'link_clerk_user_to_profile: invalid_email'
      using errcode = '22023';
  end if;
  if p_signup_source not in (
    'google', 'apple', 'email_password', 'clerk_first_login', 'clerk_import'
  ) then
    raise exception 'link_clerk_user_to_profile: invalid_signup_source'
      using errcode = '22023';
  end if;

  -- 1a-bis) The caller's Clerk session JWT must carry the same subject
  -- they are asking us to link. Without this check, a user
  -- authenticated as Clerk subject A could pass Clerk subject B
  -- (a user who has not yet signed in via Clerk) and either
  -- (a) look up B's already-linked profile, or (b) claim B's
  -- pre-migration row by email match. SECURITY DEFINER bypasses RLS
  -- for the lookup power the function needs, so this guard is the
  -- only thing tying the call to a real authenticated principal.
  if coalesce(auth.jwt()->>'sub', '') <> p_clerk_user_id then
    raise exception 'link_clerk_user_to_profile: caller_jwt_mismatch'
      using errcode = '42501';
  end if;

  v_email := lower(trim(p_email));

  -- 1b) Case 1: already linked (steady-state call from the client on
  --      every sign-in; idempotent).
  select * into v_profile
    from public.profiles
   where clerk_user_id = p_clerk_user_id;
  if found then
    return v_profile;
  end if;

  -- 1c) Case 2: legacy profile with this email — link or reject.
  if p_email_verified then
    select * into v_profile
      from public.profiles
     where email = v_email
       and clerk_user_id is null
       and legacy_auth_user_id is not null
     for update;
    if found then
      update public.profiles
         set clerk_user_id  = p_clerk_user_id,
             email_verified = true,
             signup_source  = p_signup_source,
             updated_at     = now()
       where id = v_profile.id
      returning * into v_profile;
      return v_profile;
    end if;
  else
    -- Unverified email with a matching legacy profile is a takeover
    -- attempt by `docs/ARCHITECTURE.md` § Account linking. Reject so
    -- the UI can prompt the user to verify before retrying.
    if exists (
      select 1 from public.profiles
       where email = v_email
         and clerk_user_id is null
         and legacy_auth_user_id is not null
    ) then
      raise exception 'link_clerk_user_to_profile: unverified_email_cannot_link'
        using errcode = 'P0001';
    end if;
  end if;

  -- 1d) Case 3: fresh sign-up. Insert and surface unique_violation as
  --      a re-read so concurrent first-sign-ins for the same Clerk
  --      subject converge on the same row.
  begin
    insert into public.profiles (
      clerk_user_id, email, email_verified, signup_source
    ) values (
      p_clerk_user_id, v_email, p_email_verified, p_signup_source
    )
    returning * into v_profile;
  exception when unique_violation then
    select * into v_profile
      from public.profiles
     where clerk_user_id = p_clerk_user_id;
  end;

  return v_profile;
end;
$$;

comment on function public.link_clerk_user_to_profile(text, text, boolean, text) is
  'Phase 4 Clerk identity linking. SECURITY DEFINER. Returns the caller''s profiles row, linking a pre-migration profile by verified email match on first sign-in or inserting a fresh row for new users. See docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md Phase 4.';

-- Grant EXECUTE to the `authenticated` role. The Clerk session JWT
-- resolves to `authenticated` after Supabase's Third-Party Auth
-- verification, so the user's own browser can call this function via
-- `supabase.rpc('link_clerk_user_to_profile', {...})`. `anon` does
-- not get the grant because the function mutates `public.profiles`.
grant execute on function public.link_clerk_user_to_profile(text, text, boolean, text) to authenticated;

----------------------------------------------------------------------
-- 2) Defensive state assertion
----------------------------------------------------------------------
-- Smoke-test at migration time: the function exists, returns the
-- expected table type, and is callable by `authenticated`. Fails fast
-- if any of these properties is missing.

do $$
declare
  missing text;
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'link_clerk_user_to_profile'
  ) then
    raise exception 'Phase 4 regression: link_clerk_user_to_profile function is missing';
  end if;

  if not exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name   = 'link_clerk_user_to_profile'
      and grantee        = 'authenticated'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception
      'Phase 4 regression: link_clerk_user_to_profile is missing EXECUTE grant to authenticated';
  end if;
end $$;
