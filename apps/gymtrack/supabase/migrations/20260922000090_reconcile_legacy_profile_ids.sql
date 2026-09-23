-- GymTrack Clerk identity migration — reconcile legacy ownership rows
-- (task bb09eaed)
--
-- The Phase 2 FK migrations repoint legacy user_id columns from
-- auth.users(id) to public.profiles(id). Legacy profiles were initially
-- inserted with the profiles table's random UUID default, so their ids do
-- not necessarily match the old auth.users ids. Align those ids before the
-- FK repoint runs.
--
-- A broken production row also exists whose user_id no longer appears in
-- auth.users and therefore has no profile to reconcile. Tom confirmed that
-- preserving such orphaned legacy data is not required. Remove only those
-- rows; valid legacy-owned rows are retained.
--
-- This migration is deliberately timestamped between the profile repair
-- migration and the first FK repoint migration. It must run before
-- 20260922000100_repoint_workouts_fk.sql, including on databases where the
-- earlier 00075 migration has already applied and 00100 has failed.

----------------------------------------------------------------------
-- 1) Remove rows whose legacy owner has no profile
----------------------------------------------------------------------
-- Delete children first where the OAuth schema has explicit child FKs.
-- The workouts and planned-workouts child tables use ON DELETE CASCADE or
-- SET NULL, so deleting their parent rows is sufficient.

delete from public.gymtrack_oauth_tokens t
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = t.user_id
);

delete from public.gymtrack_oauth_authorization_codes c
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = c.user_id
);

delete from public.gymtrack_oauth_consents c
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = c.user_id
);

delete from public.planned_workouts pw
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = pw.user_id
);

delete from public.workouts w
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = w.user_id
);

----------------------------------------------------------------------
-- 2) Align profile ids with the old auth user ids
----------------------------------------------------------------------
-- No Phase 2 foreign keys reference profiles yet, so this is safe before
-- the subsequent repoint migrations. Refuse to continue if an unrelated
-- profile already occupies a target id rather than silently merging rows.

do $$
begin
  if exists (
    select 1
    from public.profiles legacy
    join public.profiles existing
      on existing.id = legacy.legacy_auth_user_id
     and existing.id <> legacy.id
    where legacy.legacy_auth_user_id is not null
  ) then
    raise exception
      'Legacy profile id reconciliation found a conflicting public.profiles.id';
  end if;
end $$;

update public.profiles
   set id = legacy_auth_user_id
 where legacy_auth_user_id is not null
   and id <> legacy_auth_user_id;

----------------------------------------------------------------------
-- 3) Assert the reconciliation contract
----------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from public.profiles
    where legacy_auth_user_id is not null
      and id <> legacy_auth_user_id
  ) then
    raise exception
      'Legacy profile id reconciliation left profiles whose id differs from legacy_auth_user_id';
  end if;

  if exists (
    select 1
    from public.workouts w
    where not exists (
      select 1
      from public.profiles p
      where p.id = w.user_id
    )
  ) then
    raise exception
      'Legacy ownership cleanup left orphaned workouts';
  end if;

  if exists (
    select 1
    from public.planned_workouts pw
    where not exists (
      select 1
      from public.profiles p
      where p.id = pw.user_id
    )
  ) then
    raise exception
      'Legacy ownership cleanup left orphaned planned_workouts';
  end if;
end $$;
