-- GymTrack MCP Server with OAuth Auth — agent_connections table (task 1474d515, WS1).
--
-- One row per (user, OAuth-client) pair. Holds the hashed access + refresh
-- tokens issued by the MCP server's /oauth/token endpoint. Plaintext tokens
-- are never stored — only SHA-256 hex digests. The MCP service reads/writes
-- this table via the Supabase service-role key (RLS bypasses for service-role).
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260803150000_agent_connections.sql
--
-- .openclaw boundary:
--   No Vercel env vars or secrets are set in this migration.
--   The Supabase service-role key is required by the MCP service at runtime
--   and is configured via deployment secrets (outside repo scope).

----------------------------------------------------------------------
-- 1) agent_connections — one row per (user, OAuth-client) authorization
----------------------------------------------------------------------

create table if not exists public.agent_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  client_id           text not null,
  provider            text not null
                        check (provider in ('claude-desktop', 'chatgpt', 'local-dev', 'other')),
  -- SHA-256 hex digest of the bearer access token. Plaintext never stored.
  access_token_hash   text not null unique,
  -- SHA-256 hex digest of the refresh token. Nullable for clients that do
  -- not use refresh tokens (e.g. local-dev sentinel).
  refresh_token_hash  text,
  -- Space-separated OAuth scope string, e.g. "read:workouts plan:workouts".
  scope               text not null default '',
  created_at          timestamptz not null default now(),
  -- Last refresh/rotation timestamp; null until first rotation.
  rotated_at          timestamptz,
  -- Soft-revoke marker; partial indexes exclude revoked rows from lookups.
  revoked_at          timestamptz,
  -- Optional human-readable label, e.g. "Claude on MacBook Pro".
  label               text
);

create index if not exists agent_connections_user_idx
  on public.agent_connections (user_id);

-- Hot path: bearer-token validation on every MCP request. Partial index
-- excludes revoked rows so the index stays small.
create index if not exists agent_connections_access_hash_idx
  on public.agent_connections (access_token_hash)
  where revoked_at is null;

create index if not exists agent_connections_user_client_idx
  on public.agent_connections (user_id, client_id)
  where revoked_at is null;

----------------------------------------------------------------------
-- 2) Row-level security — users can only see/revoke their own connections
----------------------------------------------------------------------

alter table public.agent_connections enable row level security;

drop policy if exists agent_connections_select_own on public.agent_connections;
create policy agent_connections_select_own on public.agent_connections
  for select
  using (auth.uid() = user_id);

drop policy if exists agent_connections_insert_own on public.agent_connections;
create policy agent_connections_insert_own on public.agent_connections
  for insert
  with check (auth.uid() = user_id);

drop policy if exists agent_connections_update_own on public.agent_connections;
create policy agent_connections_update_own on public.agent_connections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists agent_connections_delete_own on public.agent_connections;
create policy agent_connections_delete_own on public.agent_connections
  for delete
  using (auth.uid() = user_id);

-- The MCP service authenticates with the service-role key, which bypasses
-- RLS. No additional policy is required for the service path.
