-- GymTrack Clerk identity migration — Phase 3 Slice B RLS repair
-- Task: bb09eaed-c15e-4770-be5d-8a245a62afc9
-- Design: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
--
-- Supabase's auth.uid() function returns uuid. Clerk subjects are text values
-- such as `user_...`, so calling auth.uid() for a Clerk JWT raises
-- invalid_text_representation before an RLS comparison can run. Third-Party
-- Auth exposes the verified Clerk subject through auth.jwt()->>'sub'; every
-- user-owned GymTrack policy must use that text claim instead.
--
-- The Third-Party Auth integration itself is control-plane configuration and
-- is intentionally verified by infra/cloud/scripts/run-clerk-rls-test.sh via
-- the Supabase Management API. It is not exposed as an auth schema view.

----------------------------------------------------------------------
-- 1) Rewrite all user-owned policies to the verified text `sub` claim
----------------------------------------------------------------------

alter policy profiles_self_select on public.profiles
  using ((select auth.jwt() ->> 'sub') = clerk_user_id);

alter policy profiles_self_insert on public.profiles
  with check ((select auth.jwt() ->> 'sub') = clerk_user_id);

alter policy profiles_self_update on public.profiles
  using ((select auth.jwt() ->> 'sub') = clerk_user_id)
  with check ((select auth.jwt() ->> 'sub') = clerk_user_id);

alter policy workouts_user_isolation on public.workouts
  using (
    (select auth.jwt() ->> 'sub') = (
      select p.clerk_user_id
      from public.profiles p
      where p.id = workouts.user_id
    )
  )
  with check (
    (select auth.jwt() ->> 'sub') = (
      select p.clerk_user_id
      from public.profiles p
      where p.id = workouts.user_id
    )
  );

alter policy workout_sets_user_isolation on public.workout_sets
  using (
    exists (
      select 1
      from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and (select auth.jwt() ->> 'sub') = p.clerk_user_id
    )
  )
  with check (
    exists (
      select 1
      from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and (select auth.jwt() ->> 'sub') = p.clerk_user_id
    )
  );

alter policy planned_workouts_user_isolation on public.planned_workouts
  using (
    (select auth.jwt() ->> 'sub') = (
      select p.clerk_user_id
      from public.profiles p
      where p.id = planned_workouts.user_id
    )
  )
  with check (
    (select auth.jwt() ->> 'sub') = (
      select p.clerk_user_id
      from public.profiles p
      where p.id = planned_workouts.user_id
    )
  );

alter policy planned_workout_sets_user_isolation on public.planned_workout_sets
  using (
    exists (
      select 1
      from public.planned_workouts pw
      join public.profiles p on p.id = pw.user_id
      where pw.id = planned_workout_sets.planned_workout_id
        and (select auth.jwt() ->> 'sub') = p.clerk_user_id
    )
  )
  with check (
    exists (
      select 1
      from public.planned_workouts pw
      join public.profiles p on p.id = pw.user_id
      where pw.id = planned_workout_sets.planned_workout_id
        and (select auth.jwt() ->> 'sub') = p.clerk_user_id
    )
  );

alter policy gymtrack_oauth_consents_user_read on public.gymtrack_oauth_consents
  using (
    (select auth.jwt() ->> 'sub') = (
      select p.clerk_user_id
      from public.profiles p
      where p.id = gymtrack_oauth_consents.user_id
    )
  );

----------------------------------------------------------------------
-- 2) Assert the schema and policy repair landed completely
----------------------------------------------------------------------

do $$
declare
  expected_policies constant text[] := array[
    'profiles.profiles_self_select',
    'profiles.profiles_self_insert',
    'profiles.profiles_self_update',
    'workouts.workouts_user_isolation',
    'workout_sets.workout_sets_user_isolation',
    'planned_workouts.planned_workouts_user_isolation',
    'planned_workout_sets.planned_workout_sets_user_isolation',
    'gymtrack_oauth_consents.gymtrack_oauth_consents_user_read'
  ];
  actual_policy_count integer;
  legacy_policy_count integer;
  bad_fk_count integer;
  synthetic_clerk_sub text := 'user_slice_b_non_uuid_subject';
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Slice B regression: public.profiles is missing';
  end if;

  if not (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles'
  ) then
    raise exception 'Slice B regression: RLS is not enabled on public.profiles';
  end if;

  select count(*)
    into actual_policy_count
  from pg_policies
  where schemaname = 'public'
    and (tablename || '.' || policyname) = any(expected_policies)
    and concat_ws(' ', qual, with_check) like '%auth.jwt()%'
    and concat_ws(' ', qual, with_check) like '%''sub''%';

  if actual_policy_count <> cardinality(expected_policies) then
    raise exception 'Slice B regression: only %/% required policies read auth.jwt()->>sub',
      actual_policy_count, cardinality(expected_policies);
  end if;

  select count(*)
    into legacy_policy_count
  from pg_policies
  where schemaname = 'public'
    and (tablename || '.' || policyname) = any(expected_policies)
    and concat_ws(' ', qual, with_check) like '%auth.uid()%';

  if legacy_policy_count <> 0 then
    raise exception 'Slice B regression: % required policies still call UUID-only auth.uid()',
      legacy_policy_count;
  end if;

  select count(*)
    into bad_fk_count
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
   and tc.table_schema = ccu.constraint_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema = 'public'
    and ccu.table_schema = 'auth'
    and ccu.table_name = 'users';

  if bad_fk_count <> 0 then
    raise exception 'Slice B regression: % public foreign keys still reference auth.users(id)',
      bad_fk_count;
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', synthetic_clerk_sub, 'role', 'authenticated')::text,
    true
  );

  if auth.jwt() ->> 'sub' <> synthetic_clerk_sub then
    raise exception 'Slice B regression: auth.jwt()->>sub did not preserve a non-UUID Clerk subject';
  end if;

  raise notice 'Slice B assertion: all % policies use the verified text sub claim',
    actual_policy_count;
end $$;
