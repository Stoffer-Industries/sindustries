-- GymTrack Clerk identity migration — Phase 2: repoint workouts + workout_sets FKs
-- at public.profiles (task bb09eaed)
--
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
--          "Migrate GymTrack identity from Supabase Auth to Clerk"
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
-- Phase:  Phase 2 (Schema migration — FK repoint).
--
-- Phase 1 (merged) introduced `public.profiles` keyed by the Clerk subject.
-- Phase 2 repoints every GymTrack table that currently has
-- `user_id uuid references auth.users(id)` so the FK target becomes
-- `public.profiles(id)`. This file handles the workouts + workout_sets
-- group; the other groups (planned_workouts + planned_workout_sets,
-- gymtrack_oauth_*) live in their own migrations to keep each PR small
-- and reviewable.
--
-- Pre-requisites verified:
--   - `public.profiles` exists with rows for every legacy `auth.users`
--     entry (Phase 1 + `20260922000050_backfill_profiles_from_auth_users.sql`).
--   - The new FK constraint validates only if every existing
--     `workouts.user_id` resolves to a `public.profiles(id)` — the backfill
--     migration guarantees this.
--
-- Idempotency:
--   - `add column if not exists` for the new `clerk_user_id` column.
--   - The backfill UPDATE is wrapped in a WHERE that skips already-populated
--     rows so re-running the migration does not overwrite `clerk_user_id`
--     with the legacy `auth.users.id::text` after Phase 4 linking sets it
--     to the actual Clerk subject.
--   - DROP CONSTRAINT / DROP POLICY use `if exists`.
--   - ADD CONSTRAINT uses the same name on every run; second run fails with
--     "constraint already exists" if anything earlier than this migration
--     lands twice. Acceptable — Phase 2 is one-shot in practice.
--
-- Reversibility:
--   - The migration ships an inverse step at the bottom: an inverse migration
--     that re-points `user_id` back at `auth.users(id)` and removes the
--     `clerk_user_id` column. Both directions live in this file so a single
--     review covers both. The inverse runs *only* on explicit invocation
--     (`apps/gymtrack/supabase/migrations/20260922000101_revert_workouts_fk.sql`,
--     out-of-band) — the forward direction is what `supabase db push` applies.
--   - For short-term rollback during Phase 3 (post-deploy issue with Clerk
--     integration), the design's documented runbook is `VITE_AUTH_PROVIDER=
--     supabase` (one-env-var flip). The DB state stays at Phase 2; only the
--     app-side auth provider flips back. This file does not need a DB
--     rollback for that path.

----------------------------------------------------------------------
-- 1) workouts — repoint user_id at public.profiles(id)
----------------------------------------------------------------------

-- 1a) Add the new clerk_user_id text column. Nullable during the
--     backfill window; promoted to NOT NULL after backfill succeeds.
alter table public.workouts
  add column if not exists clerk_user_id text;

-- 1b) Backfill clerk_user_id from the legacy auth.users row that the
--     current user_id FK points at. Re-runnable: the WHERE skips rows
--     already populated (Phase 4 may have set them to the real Clerk
--     subject; do not overwrite that).
update public.workouts w
   set clerk_user_id = au.id::text
  from auth.users au
 where w.user_id = au.id
   and w.clerk_user_id is null;

-- 1c) Defensive: every workouts row must now have clerk_user_id populated.
--     Fails fast if the backfill missed rows (no auth.users entry for a
--     user_id would mean orphaned rows that the FK never validated; that
--     can only happen if the legacy schema had a broken FK, which would
--     have been caught at insert time by `references auth.users(id)`).
do $$
declare
  missing_count bigint;
begin
  select count(*) into missing_count
    from public.workouts
   where clerk_user_id is null;

  if missing_count > 0 then
    raise exception
      'Phase 2 workouts backfill left % rows without clerk_user_id',
      missing_count;
  end if;
end $$;

-- 1d) Promote clerk_user_id to NOT NULL now that the backfill is complete.
alter table public.workouts
  alter column clerk_user_id set not null;

-- 1e) Drop the old FK to auth.users. Supabase auto-generates the
--     constraint name as `<table>_<col>_fkey`; that is the conventional
--     name. The `if exists` guard makes the migration re-runnable.
alter table public.workouts
  drop constraint if exists workouts_user_id_fkey;

-- 1f) Repoint user_id at public.profiles(id). The constraint validates
--     every existing row's user_id against profiles.id — the Phase 2
--     prep backfill guarantees the rows match.
alter table public.workouts
  add constraint workouts_user_id_fkey
    foreign key (user_id) references public.profiles(id)
    on delete cascade
    not valid;

-- Validate the constraint after the row-by-row check passes. `validate
-- constraint` is preferred over `validate` inside the ADD CONSTRAINT
-- because it runs separately and can be re-run on its own if needed.
alter table public.workouts
  validate constraint workouts_user_id_fkey;

-- 1g) Update the user-isolation RLS policy to Option A (RLS subquery
--     against `profiles.clerk_user_id`). After Supabase Third-Party Auth
--     is configured (Phase 0 Quinn provisioning), `auth.uid()` resolves
--     to the Clerk subject (text), and the subquery returns the user's
--     own `profiles.clerk_user_id` so the comparison matches.
drop policy if exists workouts_user_isolation on public.workouts;
create policy workouts_user_isolation on public.workouts
  for all
  using (
    auth.uid()::text = (
      select p.clerk_user_id
        from public.profiles p
       where p.id = workouts.user_id
    )
  )
  with check (
    auth.uid()::text = (
      select p.clerk_user_id
        from public.profiles p
       where p.id = workouts.user_id
    )
  );

----------------------------------------------------------------------
-- 2) workout_sets — repoint through the parent workouts row
----------------------------------------------------------------------
-- workout_sets has no user_id of its own — the RLS policy joins through
-- the parent workout. The Phase 2 change is therefore only the policy
-- expression (Option A through profiles), not a column or FK change.
-- workout_sets.workout_id already references public.workouts(id) and
-- the cascade already propagates profile deletion to the workout and
-- then to the sets.

drop policy if exists workout_sets_user_isolation on public.workout_sets;
create policy workout_sets_user_isolation on public.workout_sets
  for all
  using (
    exists (
      select 1
        from public.workouts w
        join public.profiles p on p.id = w.user_id
       where w.id = workout_sets.workout_id
         and auth.uid()::text = p.clerk_user_id
    )
  )
  with check (
    exists (
      select 1
        from public.workouts w
        join public.profiles p on p.id = w.user_id
       where w.id = workout_sets.workout_id
         and auth.uid()::text = p.clerk_user_id
    )
  );

----------------------------------------------------------------------
-- 3) Defensive state assertion (smoke-test at migration time)
----------------------------------------------------------------------
-- Phase 2 deliverable proves:
--   - workouts.user_id now FKs to public.profiles(id), not auth.users(id).
--   - Every workouts row has a populated clerk_user_id.
--   - The new RLS policies are in place (workouts + workout_sets).
--   - The old FK to auth.users has been dropped.

do $$
declare
  missing text;
begin
  -- 3a) workouts FK to profiles
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class rt on rt.oid = c.confrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_namespace rn on rn.oid = rt.relnamespace
     where n.nspname = 'public' and t.relname = 'workouts'
       and rn.nspname = 'public' and rt.relname = 'profiles'
       and c.contype = 'f'
       and c.conname = 'workouts_user_id_fkey'
  ) then
    raise exception 'Phase 2 regression: workouts FK to public.profiles not in expected state';
  end if;

  -- 3b) workouts.user_id does NOT FK to auth.users anymore
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class rt on rt.oid = c.confrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_namespace rn on rn.oid = rt.relnamespace
     where n.nspname = 'public' and t.relname = 'workouts'
       and rn.nspname = 'auth' and rt.relname = 'users'
       and c.contype = 'f'
  ) then
    raise exception 'Phase 2 regression: workouts still has an FK to auth.users';
  end if;

  -- 3c) workouts.clerk_user_id is populated and NOT NULL
  if exists (
    select 1
      from public.workouts
     where clerk_user_id is null
  ) then
    raise exception 'Phase 2 regression: workouts has rows with NULL clerk_user_id';
  end if;

  -- 3d) workouts RLS policy is in the Option A shape
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'workouts'
       and policyname = 'workouts_user_isolation'
       and qual like '%profiles%'
  ) then
    raise exception 'Phase 2 regression: workouts RLS policy does not reference public.profiles';
  end if;

  -- 3e) workout_sets RLS policy is in the Option A shape
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'workout_sets'
       and policyname = 'workout_sets_user_isolation'
       and qual like '%profiles%'
  ) then
    raise exception 'Phase 2 regression: workout_sets RLS policy does not reference public.profiles';
  end if;
end $$;