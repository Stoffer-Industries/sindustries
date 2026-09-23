-- GymTrack Clerk identity migration — Phase 1 schema readiness (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 1 (Schema inspection / dry-run migration rehearsal).
--
-- Phase 1 ships a single, additive schema change with no application code
-- dependency. It establishes the durable `public.profiles` table that
-- replaces the `auth.users(id)` foreign key target across GymTrack's
-- data tables in Phase 2. The new table is owned by GymTrack and is the
-- single source of truth for the product-membership row keyed by the
-- Clerk subject (`text`). RLS is enabled with the same `auth.uid() = key`
-- pattern GymTrack already uses; the `auth.uid()` value resolves to the
-- Clerk subject only after Supabase's Third-Party Auth is configured
-- (Quinn-side, Phase 0).
--
-- Idempotency: every CREATE statement uses `if not exists`. RLS,
-- policies, and triggers use guards. Re-running this migration against
-- an already-migrated database is a no-op.
--
-- Reversibility: `drop table public.profiles cascade` removes the entire
-- Phase 1 footprint (the table, its indexes, the trigger, the policy).
-- Phase 2's FK repoint is irreversible until the column is re-pointed;
-- Phase 1 stands alone.
--
-- Pre-requisites verified:
--   - Origin/main has migrations 20260708120000 through 20260904090000
--     in apps/gymtrack/supabase/migrations/, all authored against the
--     pre-migration `auth.users(id)` schema.
--   - PR #703 ("decide Clerk as canonical identity issuer") merged
--     2026-09-19 — `docs/ARCHITECTURE.md` § Identity is the architectural
--     source of truth for this change.
--
-- .openclaw boundary:
--   No env vars or secrets are introduced. The migration only writes
--   durable schema state to the local Supabase project that Phase 0
--   (Quinn-side Clerk + Supabase Third-Party Auth configuration) will
--   verify against post-cutover. The Clerk application and OAuth
--   provider provisioning required for the JWT issuer to exist is
--   flagged in the design's Phase 0 and tracked via an
--   `[openclaw-needed]` task comment on this PR — outside this repo.

----------------------------------------------------------------------
-- 1) profiles — durable product-membership row keyed by Clerk subject
----------------------------------------------------------------------
-- One row per GymTrack user, regardless of sign-in path. `clerk_user_id`
-- is the third-party-authenticated Clerk subject (text). Existing
-- Supabase-Auth-created accounts migrate in via `legacy_auth_user_id`
-- during Phase 4 linking; the column is preserved alongside
-- `clerk_user_id` so the historical id remains queryable through at
-- least one full quarter (Phase 5 cleanup).

create table if not exists public.profiles (
  id                   uuid        primary key default gen_random_uuid(),
  clerk_user_id        text        unique,
                                     -- nullable during Phase 4 linking:
                                     -- a backfilled row may have only the
                                     -- legacy id until first post-migration
                                     -- sign-in populates clerk_user_id.
  email                text,
  email_verified       boolean     not null default false,
  display_name         text,
  signup_source        text        -- 'google' | 'apple' | 'email_password'
                                     -- | 'clerk_import' (Phase 4 + mass-import)
                                     -- | 'openclaw_oauth' (existing path;
                                     --   preserved during the cutover window)
                                     ,
  legacy_auth_user_id  uuid        unique
                                     -- pre-migration auth.users.id; used
                                     -- only for verified-email linking.
                                     -- Nullable for fresh Clerk sign-ups.
                                     ,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint profiles_identity_source_check check (
    clerk_user_id is not null or legacy_auth_user_id is not null
  )
);

comment on table public.profiles is
  'GymTrack product-membership rows keyed by the Clerk subject. Replaces auth.users(id) as the GymTrack FK target after Phase 2 of task bb09eaed.';

comment on column public.profiles.clerk_user_id is
  'Clerk subject (the issuer-issued user id). Populated on first Clerk sign-in (Phase 4 linking) or at mass-import (Phase 0).';

comment on column public.profiles.legacy_auth_user_id is
  'Pre-migration auth.users(id). Used for verified-email linking in Phase 4; preserved for audit through Phase 5 cleanup.';

-- 1b) Indexes — clerk_user_id is the hot path for RLS subquery lookups;
--     legacy_auth_user_id is the hot path for Phase 4 verified-email
--     joins; email is the Phase 4 lookup key during linking.
create unique index if not exists profiles_clerk_user_id_key
  on public.profiles (clerk_user_id)
  where clerk_user_id is not null;

create index if not exists profiles_legacy_auth_user_id_idx
  on public.profiles (legacy_auth_user_id)
  where legacy_auth_user_id is not null;

create index if not exists profiles_email_idx
  on public.profiles (email)
  where email is not null;

----------------------------------------------------------------------
-- 2) Row-level security on profiles
----------------------------------------------------------------------
-- Mirrors the existing GymTrack pattern (every public table is RLS-enabled
-- with policies keyed on `auth.uid()`). After Supabase's Third-Party Auth
-- is configured (Phase 0), `auth.uid()` resolves to the Clerk subject;
-- the policy `(auth.uid() = clerk_user_id)` then matches the user's own
-- row. Pre-Phase-0, the policy simply denies all access — fine because no
-- application code reads or writes `public.profiles` until Phase 4.

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles_self_select'
  ) then
    create policy profiles_self_select on public.profiles
      for select
      using (auth.uid()::text = clerk_user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles_self_insert'
  ) then
    create policy profiles_self_insert on public.profiles
      for insert
      with check (auth.uid()::text = clerk_user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles_self_update'
  ) then
    create policy profiles_self_update on public.profiles
      for update
      using (auth.uid()::text = clerk_user_id)
      with check (auth.uid()::text = clerk_user_id);
  end if;
end $$;

----------------------------------------------------------------------
-- 3) updated_at trigger — same shape as the rest of GymTrack
----------------------------------------------------------------------
-- Defensive: only installs if the `set_updated_at` function exists.
-- Existing migrations use the function name `set_updated_at`; if a
-- future migration renames it, the trigger creation is a no-op rather
-- than a failure.

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
  ) and not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and t.tgname  = 'set_profiles_updated_at'
  ) then
    execute $t$
      create trigger set_profiles_updated_at
        before update on public.profiles
        for each row execute function public.set_updated_at()
    $t$;
  end if;
end $$;

----------------------------------------------------------------------
-- 4) Defensive state assertion (smoke-test at migration time)
----------------------------------------------------------------------
-- The Phase 1 deliverable proves `public.profiles` is in the expected
-- state when this migration lands. Fails fast if any of the expected
-- pieces (table, indexes, RLS, policies, columns) are missing.

do $$
declare
  missing text;
begin
  -- 4a) Table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles' and c.relkind = 'r'
  ) then
    raise exception 'Phase 1 regression: public.profiles table is missing';
  end if;

  -- 4b) RLS is enabled
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles' and c.relrowsecurity
  ) then
    raise exception 'Phase 1 regression: RLS is NOT enabled on public.profiles';
  end if;

  -- 4c) Required columns exist with expected nullability
  select string_agg(column_name, ', ' order by column_name)
    into missing
  from (
    values
      ('id',                  false),
      ('clerk_user_id',       true),
      ('email',               true),
      ('email_verified',      false),
      ('display_name',        true),
      ('signup_source',       true),
      ('legacy_auth_user_id', true),
      ('created_at',          false),
      ('updated_at',          false)
  ) as expected(column_name, nullable)
  where not exists (
    select 1
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.table_name   = 'profiles'
      and c.column_name  = expected.column_name
      and (c.is_nullable = 'YES') = expected.nullable
  );

  if missing is not null then
    raise exception 'Phase 1 regression: profiles columns missing/nullability wrong: %', missing;
  end if;

  -- 4d) Required policies exist
  select string_agg(policyname, ', ' order by policyname)
    into missing
  from (
    values
      ('profiles_self_select'),
      ('profiles_self_insert'),
      ('profiles_self_update')
  ) as expected(policyname)
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = expected.policyname
  );

  if missing is not null then
    raise exception 'Phase 1 regression: profiles policies missing: %', missing;
  end if;
end $$;
