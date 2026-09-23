-- GymTrack Clerk identity migration — repair legacy profile coverage
-- (task bb09eaed)
--
-- The preceding Phase 2 backfill intentionally selected auth.users rows with
-- an email address. The FK repoint migrations require a profile for every
-- legacy auth.users id, including accounts whose email is NULL. This additive
-- repair migration runs before the FK repoint migrations and fills that gap
-- without modifying auth.users or deleting application data.
--
-- This is a new migration rather than an edit to the already-applied
-- 20260922000050 migration. Its timestamp sorts it immediately before the
-- first FK repoint migration (20260922000100).

insert into public.profiles (
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
  false,
  'pre_migration',
  coalesce(au.created_at, now()),
  coalesce(au.updated_at, au.created_at, now())
from auth.users au
where not exists (
  select 1
  from public.profiles p
  where p.legacy_auth_user_id = au.id
)
on conflict (legacy_auth_user_id) do nothing;

do $$
declare
  missing_count bigint;
begin
  select count(*)
    into missing_count
  from auth.users au
  where not exists (
    select 1
    from public.profiles p
    where p.legacy_auth_user_id = au.id
  );

  if missing_count > 0 then
    raise exception
      'Profiles repair left % auth.users rows without a legacy profile',
      missing_count;
  end if;
end $$;
