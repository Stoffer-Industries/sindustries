-- GymTrack MVP — initial schema (task 18256740).
--
-- Two tables: workouts + workout_sets. RLS user-isolation policies restrict
-- all reads/writes to the row owner. workout_sets policies check the parent
-- workout's user_id (sets don't carry user_id directly).
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260708120000_init_workouts.sql

create table if not exists public.workouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  performed_at timestamptz not null default now(),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.workout_sets (
  id            uuid primary key default gen_random_uuid(),
  workout_id    uuid not null references public.workouts(id) on delete cascade,
  exercise_name text not null,
  set_index     int  not null,
  reps          int  not null check (reps > 0),
  weight        numeric not null check (weight >= 0),
  unit          text not null default 'kg' check (unit in ('kg', 'lb')),
  created_at    timestamptz not null default now()
);

-- Index supports the last-30-days history view (user-scoped, newest first).
create index if not exists workouts_user_performed_at_idx
  on public.workouts (user_id, performed_at desc);

create index if not exists workout_sets_workout_idx
  on public.workout_sets (workout_id, set_index);

-- updated_at trigger for workouts
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists workouts_set_updated_at on public.workouts;
create trigger workouts_set_updated_at
  before update on public.workouts
  for each row execute function public.set_updated_at();

-- RLS
alter table public.workouts      enable row level security;
alter table public.workout_sets  enable row level security;

drop policy if exists workouts_user_isolation on public.workouts;
create policy workouts_user_isolation on public.workouts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists workout_sets_user_isolation on public.workout_sets;
create policy workout_sets_user_isolation on public.workout_sets
  for all
  using (
    exists (
      select 1 from public.workouts w
      where w.id = workout_sets.workout_id and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workouts w
      where w.id = workout_sets.workout_id and w.user_id = auth.uid()
    )
  );