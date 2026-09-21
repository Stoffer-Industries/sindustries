-- GymTrack Clerk identity migration — Phase 2: repoint planned_workouts +
-- planned_workout_sets FKs at public.profiles (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 2 (Schema migration — FK repoint).
--
-- The original Phase 2 design group "gymtrack_agent_api_keys + planned_*"
-- collapsed to just planned_workouts + planned_workout_sets because
-- `gymtrack_agent_api_keys` was decommissioned in
-- `20260815010000_decommission_legacy_agent_keys.sql`. planned_workouts
-- retained `user_id` (and lost `agent_key_id` in the decommission).
-- planned_workout_sets is gated through the parent planned_workouts.
--
-- This file follows the same shape as `20260922000100_repoint_workouts_fk.sql`:
--   1. Add clerk_user_id text column.
--   2. Backfill from auth.users.
--   3. Drop the old FK to auth.users.
--   4. Add the new FK to public.profiles(id) (NOT VALID + VALIDATE).
--   5. Replace the RLS policy with Option A (subquery through profiles).
--   6. Smoke-test assertion that the migration landed.

----------------------------------------------------------------------
-- 1) planned_workouts — repoint user_id at public.profiles(id)
----------------------------------------------------------------------

-- 1a) Add clerk_user_id text column.
alter table public.planned_workouts
  add column if not exists clerk_user_id text;

-- 1b) Backfill from auth.users. Re-runnable: WHERE skips rows that already
--     have clerk_user_id set (Phase 4 may have populated them with the
--     real Clerk subject).
update public.planned_workouts pw
   set clerk_user_id = au.id::text
  from auth.users au
 where pw.user_id = au.id
   and pw.clerk_user_id is null;

-- 1c) Defensive: no NULL clerk_user_id after backfill.
do $$
declare
  missing_count bigint;
begin
  select count(*) into missing_count
    from public.planned_workouts
   where clerk_user_id is null;

  if missing_count > 0 then
    raise exception
      'Phase 2 planned_workouts backfill left % rows without clerk_user_id',
      missing_count;
  end if;
end $$;

-- 1d) Promote clerk_user_id to NOT NULL.
alter table public.planned_workouts
  alter column clerk_user_id set not null;

-- 1e) Drop the old FK.
alter table public.planned_workouts
  drop constraint if exists planned_workouts_user_id_fkey;

-- 1f) Repoint user_id at public.profiles(id).
alter table public.planned_workouts
  add constraint planned_workouts_user_id_fkey
    foreign key (user_id) references public.profiles(id)
    on delete cascade
    not valid;

alter table public.planned_workouts
  validate constraint planned_workouts_user_id_fkey;

-- 1g) Update the user-isolation RLS policy to Option A.
drop policy if exists planned_workouts_user_isolation on public.planned_workouts;
create policy planned_workouts_user_isolation on public.planned_workouts
  for all
  using (
    auth.uid()::text = (
      select p.clerk_user_id
        from public.profiles p
       where p.id = planned_workouts.user_id
    )
  )
  with check (
    auth.uid()::text = (
      select p.clerk_user_id
        from public.profiles p
       where p.id = planned_workouts.user_id
    )
  );

----------------------------------------------------------------------
-- 2) planned_workout_sets — repoint through the parent planned_workouts row
----------------------------------------------------------------------
-- Same pattern as workout_sets: no own user_id; RLS joins through parent.
-- parent_workout.user_id is now FK'd to public.profiles(id), so the join
-- goes: sets → planned_workouts → profiles → clerk_user_id (text).

drop policy if exists planned_workout_sets_user_isolation on public.planned_workout_sets;
create policy planned_workout_sets_user_isolation on public.planned_workout_sets
  for all
  using (
    exists (
      select 1
        from public.planned_workouts pw
        join public.profiles p on p.id = pw.user_id
       where pw.id = planned_workout_sets.planned_workout_id
         and auth.uid()::text = p.clerk_user_id
    )
  )
  with check (
    exists (
      select 1
        from public.planned_workouts pw
        join public.profiles p on p.id = pw.user_id
       where pw.id = planned_workout_sets.planned_workout_id
         and auth.uid()::text = p.clerk_user_id
    )
  );

----------------------------------------------------------------------
-- 3) Defensive state assertion
----------------------------------------------------------------------

do $$
declare
  missing text;
begin
  -- 3a) planned_workouts FK to profiles
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class rt on rt.oid = c.confrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_namespace rn on rn.oid = rt.relnamespace
     where n.nspname = 'public' and t.relname = 'planned_workouts'
       and rn.nspname = 'public' and rt.relname = 'profiles'
       and c.contype = 'f'
       and c.conname = 'planned_workouts_user_id_fkey'
  ) then
    raise exception 'Phase 2 regression: planned_workouts FK to public.profiles not in expected state';
  end if;

  -- 3b) No FK to auth.users on planned_workouts
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class rt on rt.oid = c.confrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_namespace rn on rn.oid = rt.relnamespace
     where n.nspname = 'public' and t.relname = 'planned_workouts'
       and rn.nspname = 'auth' and rt.relname = 'users'
       and c.contype = 'f'
  ) then
    raise exception 'Phase 2 regression: planned_workouts still has an FK to auth.users';
  end if;

  -- 3c) clerk_user_id populated
  if exists (
    select 1
      from public.planned_workouts
     where clerk_user_id is null
  ) then
    raise exception 'Phase 2 regression: planned_workouts has rows with NULL clerk_user_id';
  end if;

  -- 3d) RLS policies reference profiles
  select string_agg(policyname, ', ' order by policyname)
    into missing
  from (
    values
      ('planned_workouts_user_isolation'),
      ('planned_workout_sets_user_isolation')
  ) as expected(policyname)
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = replace(expected.policyname, '_user_isolation', '')
      and policyname = expected.policyname
      and qual like '%profiles%'
  );

  if missing is not null then
    raise exception 'Phase 2 regression: RLS policies missing profiles join: %', missing;
  end if;
end $$;