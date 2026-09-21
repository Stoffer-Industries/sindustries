-- GymTrack Clerk identity migration — Phase 2: repoint gymtrack_oauth_*
-- user-scoped FKs at public.profiles (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 2 (Schema migration — FK repoint).
--
-- The GymTrack MCP OAuth schema (`20260804070000_mcp_oauth.sql`) has four
-- tables. Only three carry a `user_id` column and need FK repointing:
--
--   - gymtrack_oauth_clients              (no user_id; public catalogue)
--   - gymtrack_oauth_consents             (user_id → profiles)
--   - gymtrack_oauth_authorization_codes  (user_id → profiles)
--   - gymtrack_oauth_tokens               (user_id → profiles)
--
-- RLS state from the original migration:
--
--   - gymtrack_oauth_consents: ONE policy `gymtrack_oauth_consents_user_read`
--     (SELECT only, `auth.uid() = user_id`). No INSERT/UPDATE/DELETE
--     policies — those run via service_role from `services/gymtrack-mcp`.
--   - gymtrack_oauth_authorization_codes, gymtrack_oauth_tokens: NO
--     user-facing policies. All access is through `security definer`
--     functions (`gymtrack_consume_oauth_authorization_code`,
--     `gymtrack_rotate_oauth_refresh_token`) granted to `service_role`.
--     RLS on these tables remains enabled but unused by user traffic;
--     Phase 2 does not add policies where none existed before.
--
-- The `security definer` functions are NOT modified in Phase 2: they
-- read `user_id` from rows they look up by token / code hash, and that
-- `user_id` is now a `profiles.id` (UUID) instead of an `auth.users.id`
-- (UUID). The functions continue to work without code changes because
-- the column shape is unchanged.

----------------------------------------------------------------------
-- 1) gymtrack_oauth_consents — repoint user_id at public.profiles(id)
----------------------------------------------------------------------

-- 1a) Add clerk_user_id text column.
alter table public.gymtrack_oauth_consents
  add column if not exists clerk_user_id text;

-- 1b) Backfill from auth.users.
update public.gymtrack_oauth_consents gc
   set clerk_user_id = au.id::text
  from auth.users au
 where gc.user_id = au.id
   and gc.clerk_user_id is null;

-- 1c) Defensive: no NULL clerk_user_id.
do $$
declare
  missing_count bigint;
begin
  select count(*) into missing_count
    from public.gymtrack_oauth_consents
   where clerk_user_id is null;

  if missing_count > 0 then
    raise exception
      'Phase 2 gymtrack_oauth_consents backfill left % rows without clerk_user_id',
      missing_count;
  end if;
end $$;

-- 1d) Promote to NOT NULL.
alter table public.gymtrack_oauth_consents
  alter column clerk_user_id set not null;

-- 1e) Drop the old FK.
alter table public.gymtrack_oauth_consents
  drop constraint if exists gymtrack_oauth_consents_user_id_fkey;

-- 1f) Repoint user_id at public.profiles(id).
alter table public.gymtrack_oauth_consents
  add constraint gymtrack_oauth_consents_user_id_fkey
    foreign key (user_id) references public.profiles(id)
    on delete cascade
    not valid;

alter table public.gymtrack_oauth_consents
  validate constraint gymtrack_oauth_consents_user_id_fkey;

-- 1g) Update the SELECT RLS policy to Option A. No INSERT/UPDATE/DELETE
--     policies exist (service_role only); Phase 2 does not add any.
drop policy if exists gymtrack_oauth_consents_user_read on public.gymtrack_oauth_consents;
create policy gymtrack_oauth_consents_user_read on public.gymtrack_oauth_consents
  for select
  using (
    auth.uid()::text = (
      select p.clerk_user_id
        from public.profiles p
       where p.id = gymtrack_oauth_consents.user_id
    )
  );

----------------------------------------------------------------------
-- 2) gymtrack_oauth_authorization_codes — repoint user_id
----------------------------------------------------------------------

alter table public.gymtrack_oauth_authorization_codes
  add column if not exists clerk_user_id text;

update public.gymtrack_oauth_authorization_codes gac
   set clerk_user_id = au.id::text
  from auth.users au
 where gac.user_id = au.id
   and gac.clerk_user_id is null;

do $$
declare
  missing_count bigint;
begin
  select count(*) into missing_count
    from public.gymtrack_oauth_authorization_codes
   where clerk_user_id is null;

  if missing_count > 0 then
    raise exception
      'Phase 2 gymtrack_oauth_authorization_codes backfill left % rows without clerk_user_id',
      missing_count;
  end if;
end $$;

alter table public.gymtrack_oauth_authorization_codes
  alter column clerk_user_id set not null;

alter table public.gymtrack_oauth_authorization_codes
  drop constraint if exists gymtrack_oauth_authorization_codes_user_id_fkey;

alter table public.gymtrack_oauth_authorization_codes
  add constraint gymtrack_oauth_authorization_codes_user_id_fkey
    foreign key (user_id) references public.profiles(id)
    on delete cascade
    not valid;

alter table public.gymtrack_oauth_authorization_codes
  validate constraint gymtrack_oauth_authorization_codes_user_id_fkey;

----------------------------------------------------------------------
-- 3) gymtrack_oauth_tokens — repoint user_id
----------------------------------------------------------------------

alter table public.gymtrack_oauth_tokens
  add column if not exists clerk_user_id text;

update public.gymtrack_oauth_tokens gt
   set clerk_user_id = au.id::text
  from auth.users au
 where gt.user_id = au.id
   and gt.clerk_user_id is null;

do $$
declare
  missing_count bigint;
begin
  select count(*) into missing_count
    from public.gymtrack_oauth_tokens
   where clerk_user_id is null;

  if missing_count > 0 then
    raise exception
      'Phase 2 gymtrack_oauth_tokens backfill left % rows without clerk_user_id',
      missing_count;
  end if;
end $$;

alter table public.gymtrack_oauth_tokens
  alter column clerk_user_id set not null;

alter table public.gymtrack_oauth_tokens
  drop constraint if exists gymtrack_oauth_tokens_user_id_fkey;

alter table public.gymtrack_oauth_tokens
  add constraint gymtrack_oauth_tokens_user_id_fkey
    foreign key (user_id) references public.profiles(id)
    on delete cascade
    not valid;

alter table public.gymtrack_oauth_tokens
  validate constraint gymtrack_oauth_tokens_user_id_fkey;

----------------------------------------------------------------------
-- 4) Defensive state assertion
----------------------------------------------------------------------

do $$
declare
  missing text;
begin
  -- 4a) Every OAuth table has user_id FK to public.profiles
  select string_agg(t.relname, ', ' order by t.relname)
    into missing
  from (
    values
      ('gymtrack_oauth_consents'),
      ('gymtrack_oauth_authorization_codes'),
      ('gymtrack_oauth_tokens')
  ) as expected(table_name)
  join pg_class t on t.relname = expected.table_name
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and not exists (
      select 1
        from pg_constraint c
        join pg_class rt on rt.oid = c.confrelid
        join pg_namespace rn on rn.oid = rt.relnamespace
       where c.conrelid = t.oid
         and c.contype = 'f'
         and rn.nspname = 'public'
         and rt.relname = 'profiles'
    );

  if missing is not null then
    raise exception 'Phase 2 regression: OAuth tables missing profiles FK: %', missing;
  end if;

  -- 4b) No OAuth table has FK to auth.users anymore
  select string_agg(t.relname, ', ' order by t.relname)
    into missing
  from (
    values
      ('gymtrack_oauth_consents'),
      ('gymtrack_oauth_authorization_codes'),
      ('gymtrack_oauth_tokens')
  ) as expected(table_name)
  join pg_class t on t.relname = expected.table_name
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and exists (
      select 1
        from pg_constraint c
        join pg_class rt on rt.oid = c.confrelid
        join pg_namespace rn on rn.oid = rt.relnamespace
       where c.conrelid = t.oid
         and c.contype = 'f'
         and rn.nspname = 'auth'
         and rt.relname = 'users'
    );

  if missing is not null then
    raise exception 'Phase 2 regression: OAuth tables still have auth.users FK: %', missing;
  end if;

  -- 4c) gymtrack_oauth_consents RLS policy uses Option A
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'gymtrack_oauth_consents'
       and policyname = 'gymtrack_oauth_consents_user_read'
       and qual like '%profiles%'
  ) then
    raise exception 'Phase 2 regression: gymtrack_oauth_consents RLS policy does not reference public.profiles';
  end if;
end $$;