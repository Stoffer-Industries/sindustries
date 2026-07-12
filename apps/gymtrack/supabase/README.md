# GymTrack — Supabase setup

This directory holds the SQL migrations for the GymTrack app's standalone Supabase project.

## Apply the migration

Once Quinn has provisioned the Supabase project, apply the migration:

```bash
# Option A: Supabase CLI (preferred — also tracks applied migrations)
supabase db push

# Option B: psql one-shot
psql "$DATABASE_URL" -f apps/gymtrack/supabase/migrations/20260708120000_init_workouts.sql
```

After applying, verify the tables exist and RLS is enabled:

```sql
\dt public.*
\dp public.workouts
\dp public.workout_sets
```

You should see `workouts` and `workout_sets`, both with RLS enabled (privileges show "none" for `anon`/`authenticated` until policies match).

## Seed Tom's user

The MVP is single-user. Create Tom's account via Supabase Studio:

1. Open Supabase Studio → Authentication → Users → Add user → Create new user.
2. Enter Tom's email + password (Tom supplies these out-of-band).
3. Confirm the user appears in the `auth.users` table.
4. The RLS policies will restrict all workouts/sets to this user's `auth.uid()`.

## RLS smoke test

From the Supabase SQL editor, while signed in as Tom:

```sql
select * from public.workouts;       -- should be empty (no rows yet)
select * from public.workout_sets;   -- should be empty
```

After logging a workout in the app, the same query should show the new row.

## Env vars (Vercel)

Quinn wires these into the Vercel project's environment:

- `VITE_SUPABASE_URL` — project URL (e.g. `https://abcdefg.supabase.co`)
- `VITE_SUPABASE_ANON_KEY` — anon/public JWT from Project Settings → API

Both are public-by-design (Vite inlines them at build time). The anon key is intentionally shippable; RLS is the gate.