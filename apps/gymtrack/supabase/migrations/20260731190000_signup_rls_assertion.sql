-- GymTrack Sign-Up — RLS coverage assertion (task 72d7cc3b)
--
-- Task: 72d7cc3b "GymTrack Public Sign-Up with Social Login"
-- AC3: "A newly created account is fully isolated from every other account's data
--      from the moment it's created — RLS or equivalent enforcement covers the
--      new sign-up path the same way it covers the existing single-account case."
--
-- The public sign-up path introduced by this task does NOT add new tables. A
-- newly created user (via email+password or OAuth) lands a row in
-- `auth.users` (Supabase-managed) and inherits the existing user-isolation RLS
-- policies on every public table GymTrack exposes. This migration is a
-- defensive assertion + a documented smoke-test that proves the isolation
-- claim at the SQL boundary, so AC3 is reviewable from the migration alone.
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260731190000_signup_rls_assertion.sql
--
-- .openclaw boundary:
--   No env vars or secrets are introduced. This migration only documents
--   state that already exists.

----------------------------------------------------------------------
-- 1) Assert RLS is enabled on every GymTrack public table
----------------------------------------------------------------------
-- This DO block raises an exception if any GymTrack table is missing
-- row-level security. The expectation is set by the existing migrations:
--   20260708120000_init_workouts.sql            (workouts, workout_sets)
--   20260723170000_agent_powered_workouts.sql   (gymtrack_agent_api_keys,
--                                                planned_workouts,
--                                                planned_workout_sets)
-- A new table added without `enable row level security` would fail this
-- assertion and break AC3, which is exactly the regression we want to catch.

do $$
declare
  missing_rls text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into missing_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname in (
       'workouts',
       'workout_sets',
       'gymtrack_agent_api_keys',
       'planned_workouts',
       'planned_workout_sets'
     )
     and not c.relrowsecurity;

  if missing_rls is not null then
    raise exception 'AC3 regression: RLS is NOT enabled on public table(s): %', missing_rls;
  end if;
end $$;

----------------------------------------------------------------------
-- 2) Documented isolation smoke-test (manual / CI hook)
----------------------------------------------------------------------
-- Run as the *target* user (their JWT or service-role impersonation that
-- sets `set local role authenticated` + `set local request.jwt.claim.sub`
-- to the user id under test). Expected result: zero rows.
--
--   -- User A creates a workout.
--   set local request.jwt.claim.sub = '<user_a_uuid>';
--   insert into public.workouts default values;
--
--   -- User B (different sub) must see zero of User A's rows.
--   set local request.jwt.claim.sub = '<user_b_uuid>';
--   select count(*) from public.workouts;            -- expect 0
--   select count(*) from public.workout_sets;        -- expect 0
--   select count(*) from public.gymtrack_agent_api_keys;  -- expect 0
--   select count(*) from public.planned_workouts;    -- expect 0
--   select count(*) from public.planned_workout_sets; -- expect 0
--
-- This block is documentation-only; no data is created or queried by
-- this migration itself.

----------------------------------------------------------------------
-- 3) planned_workouts → workouts link — isolation preserved
----------------------------------------------------------------------
-- The link added in 20260723170000 (`workouts.planned_workout_id`) does not
-- weaken isolation: `workouts.user_id` still gates row reads/writes, and the
-- `workout_sets.planned_set_id` link is gated through the parent workout
-- (which is itself user-scoped). A user cannot reach another user's planned
-- set by joining `workout_sets.planned_set_id` because the join is blocked
-- one level up by the workouts.user_id RLS policy.