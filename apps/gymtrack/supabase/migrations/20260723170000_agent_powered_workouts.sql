-- GymTrack Agent-Powered Workouts — agent API keys + planned workouts (task f520c396).
--
-- Adds three tables that let a user generate per-user API keys, allow external
-- agents to submit planned workouts, and link actual logged sets back to the
-- planned targets. Also adds two nullable foreign-key columns on the existing
-- workouts / workout_sets tables so a logged workout can reference its plan.
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260723170000_agent_powered_workouts.sql
--
-- .openclaw boundary:
--   No Vercel env vars or secrets are set in this migration.
--   Deployment secrets (VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.) are
--   outside repo scope; if missing during implementation, post `[openclaw-needed]`
--   with the exact env var names and target deployment.

----------------------------------------------------------------------
-- 1) agent API keys — one row per agent credential a user has generated
----------------------------------------------------------------------

create table if not exists public.gymtrack_agent_api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  -- SHA-256 hex digest of the bearer token. Plaintext tokens are never stored.
  token_hash    text not null unique,
  -- First 8 chars of the plaintext token for display in the UI list only.
  token_prefix  text not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists gymtrack_agent_api_keys_user_idx
  on public.gymtrack_agent_api_keys (user_id);

-- Lookup by hash on every request; partial index excludes revoked keys.
create index if not exists gymtrack_agent_api_keys_hash_idx
  on public.gymtrack_agent_api_keys (token_hash)
  where revoked_at is null;

----------------------------------------------------------------------
-- 2) planned workouts — created by an agent on behalf of a user
----------------------------------------------------------------------

create table if not exists public.planned_workouts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  agent_key_id    uuid references public.gymtrack_agent_api_keys(id) on delete set null,
  scheduled_for   date not null,
  title           text not null,
  notes           text,
  status          text not null default 'planned'
                    check (status in ('planned', 'started', 'completed', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists planned_workouts_user_scheduled_idx
  on public.planned_workouts (user_id, scheduled_for desc);

-- Reuse the set_updated_at() function from the init migration.
drop trigger if exists planned_workouts_set_updated_at on public.planned_workouts;
create trigger planned_workouts_set_updated_at
  before update on public.planned_workouts
  for each row execute function public.set_updated_at();

----------------------------------------------------------------------
-- 3) planned workout sets — one row per target set
----------------------------------------------------------------------

create table if not exists public.planned_workout_sets (
  id                 uuid primary key default gen_random_uuid(),
  planned_workout_id uuid not null references public.planned_workouts(id) on delete cascade,
  exercise_name      text not null,
  set_index          int  not null,
  target_reps        int  not null check (target_reps > 0),
  target_weight      numeric not null check (target_weight >= 0),
  unit               text not null default 'kg' check (unit in ('kg', 'lb')),
  notes              text,
  created_at         timestamptz not null default now()
);

create index if not exists planned_workout_sets_plan_idx
  on public.planned_workout_sets (planned_workout_id, set_index);

----------------------------------------------------------------------
-- 4) link logged workouts / sets back to their plan
----------------------------------------------------------------------

alter table public.workouts
  add column if not exists planned_workout_id uuid
    references public.planned_workouts(id) on delete set null;

alter table public.workout_sets
  add column if not exists planned_set_id uuid
    references public.planned_workout_sets(id) on delete set null;

create index if not exists workouts_user_plan_idx
  on public.workouts (user_id, planned_workout_id);

----------------------------------------------------------------------
-- 5) RLS
----------------------------------------------------------------------

alter table public.gymtrack_agent_api_keys enable row level security;
alter table public.planned_workouts       enable row level security;
alter table public.planned_workout_sets   enable row level security;

-- API keys: user sees/creates/revokes only their own. Token plaintext is never
-- stored, so reads return metadata (prefix / label / timestamps) only.
drop policy if exists gymtrack_agent_api_keys_user_isolation on public.gymtrack_agent_api_keys;
create policy gymtrack_agent_api_keys_user_isolation on public.gymtrack_agent_api_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Planned workouts: user sees/inserts/updates only their own.
drop policy if exists planned_workouts_user_isolation on public.planned_workouts;
create policy planned_workouts_user_isolation on public.planned_workouts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Planned sets: scoped through the parent planned_workout's user_id.
drop policy if exists planned_workout_sets_user_isolation on public.planned_workout_sets;
create policy planned_workout_sets_user_isolation on public.planned_workout_sets
  for all
  using (
    exists (
      select 1 from public.planned_workouts p
      where p.id = planned_workout_sets.planned_workout_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.planned_workouts p
      where p.id = planned_workout_sets.planned_workout_id
        and p.user_id = auth.uid()
    )
  );
