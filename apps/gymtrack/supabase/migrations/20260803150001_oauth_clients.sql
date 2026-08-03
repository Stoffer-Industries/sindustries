-- GymTrack MCP Server with OAuth Auth — oauth_clients table + seed (task 1474d515, WS1).
--
-- Static allowlist of well-known MCP clients that can request OAuth
-- authorization. Dynamic client registration (RFC 7591) is deferred to a
-- future task per the product spec's non-goals.
--
-- Seeded with the three clients the MCP service knows how to talk to:
--   - claude-desktop: Anthropic Claude (remote MCP connector)
--   - chatgpt:        OpenAI ChatGPT (custom GPT / MCP)
--   - local-dev:      dev sentinel for integration tests
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260803150001_oauth_clients.sql
--
-- .openclaw boundary:
--   No secrets or external config are set in this migration. Provider-specific
--   OAuth client secrets (Google, Apple) are owned by Quinn (.openclaw).

----------------------------------------------------------------------
-- 1) oauth_clients — allowlist of registered MCP clients
----------------------------------------------------------------------

create table if not exists public.oauth_clients (
  client_id     text primary key,
  provider      text not null
                  check (provider in ('claude-desktop', 'chatgpt', 'local-dev', 'other')),
  -- The redirect URI the client uses during the authorization code flow.
  -- Multiple rows per client_id are allowed via composite (client_id, redirect_uri)
  -- in a future migration if a single client supports several endpoints.
  redirect_uri  text not null,
  -- Optional human-readable display name for the settings UI.
  display_name  text,
  created_at    timestamptz not null default now()
);

----------------------------------------------------------------------
-- 2) Seed: known MCP clients
----------------------------------------------------------------------

insert into public.oauth_clients (client_id, provider, redirect_uri, display_name)
values
  ('claude-desktop', 'claude-desktop', 'https://claude.ai/api/mcp/auth_callback', 'Claude (Anthropic)'),
  ('chatgpt',        'chatgpt',        'https://chatgpt.com/gpts/authorization',  'ChatGPT (OpenAI)'),
  ('local-dev',      'local-dev',      'http://localhost:8765/callback',          'Local dev sentinel')
on conflict (client_id) do update
  set provider     = excluded.provider,
      redirect_uri = excluded.redirect_uri,
      display_name = excluded.display_name;

----------------------------------------------------------------------
-- 3) Row-level security — service-role only on the client side
----------------------------------------------------------------------

-- The user does not need to read this table directly. The MCP service uses
-- the service-role key to look up clients during the OAuth handshake. No
-- policies are granted to `authenticated`; RLS is enabled with no permissive
-- policies so all client-side access is denied.
alter table public.oauth_clients enable row level security;
