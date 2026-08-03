-- GymTrack MCP OAuth server (task 1474d515).
--
-- Adds static OAuth clients, authorization-code storage, hashed access/refresh
-- tokens, and user-visible consent rows so external MCP clients can connect via
-- OAuth Code + PKCE without exposing plaintext secrets in the database.

create table if not exists public.gymtrack_oauth_clients (
  client_id      text primary key,
  client_name    text not null,
  redirect_uris  text[] not null,
  created_at     timestamptz not null default now(),
  check (array_length(redirect_uris, 1) >= 1)
);

create table if not exists public.gymtrack_oauth_consents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  client_id     text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  scope         text not null,
  granted_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists gymtrack_oauth_consents_active_user_client_idx
  on public.gymtrack_oauth_consents (user_id, client_id)
  where revoked_at is null;

create index if not exists gymtrack_oauth_consents_user_idx
  on public.gymtrack_oauth_consents (user_id, granted_at desc);

create table if not exists public.gymtrack_oauth_authorization_codes (
  id                     uuid primary key default gen_random_uuid(),
  consent_id             uuid not null references public.gymtrack_oauth_consents(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  client_id              text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  code_hash              text not null unique,
  redirect_uri           text not null,
  scope                  text not null,
  code_challenge         text not null,
  code_challenge_method  text not null default 'S256' check (code_challenge_method in ('S256')),
  expires_at             timestamptz not null,
  consumed_at            timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists gymtrack_oauth_auth_codes_consent_idx
  on public.gymtrack_oauth_authorization_codes (consent_id, created_at desc);

create index if not exists gymtrack_oauth_auth_codes_client_idx
  on public.gymtrack_oauth_authorization_codes (client_id, created_at desc);

create table if not exists public.gymtrack_oauth_tokens (
  id                       uuid primary key default gen_random_uuid(),
  consent_id               uuid not null references public.gymtrack_oauth_consents(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  client_id                text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  scope                    text not null,
  family_id                text not null,
  parent_token_id          uuid references public.gymtrack_oauth_tokens(id) on delete set null,
  access_token_hash        text not null unique,
  refresh_token_hash       text not null unique,
  access_token_expires_at  timestamptz not null,
  refresh_token_expires_at timestamptz not null,
  last_used_at             timestamptz,
  rotated_at               timestamptz,
  replaced_by_token_id     uuid references public.gymtrack_oauth_tokens(id) on delete set null,
  revoked_at               timestamptz,
  revocation_reason        text,
  created_at               timestamptz not null default now()
);

create index if not exists gymtrack_oauth_tokens_consent_idx
  on public.gymtrack_oauth_tokens (consent_id, created_at desc);

create index if not exists gymtrack_oauth_tokens_user_idx
  on public.gymtrack_oauth_tokens (user_id, created_at desc);

create index if not exists gymtrack_oauth_tokens_access_active_idx
  on public.gymtrack_oauth_tokens (access_token_hash)
  where revoked_at is null;

create index if not exists gymtrack_oauth_tokens_refresh_active_idx
  on public.gymtrack_oauth_tokens (refresh_token_hash)
  where revoked_at is null;

alter table public.gymtrack_oauth_clients enable row level security;
alter table public.gymtrack_oauth_consents enable row level security;
alter table public.gymtrack_oauth_authorization_codes enable row level security;
alter table public.gymtrack_oauth_tokens enable row level security;

drop policy if exists gymtrack_oauth_clients_authenticated_read on public.gymtrack_oauth_clients;
create policy gymtrack_oauth_clients_authenticated_read on public.gymtrack_oauth_clients
  for select
  using (auth.role() = 'authenticated');

drop policy if exists gymtrack_oauth_consents_user_isolation on public.gymtrack_oauth_consents;
create policy gymtrack_oauth_consents_user_isolation on public.gymtrack_oauth_consents
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists gymtrack_oauth_authorization_codes_user_isolation on public.gymtrack_oauth_authorization_codes;
create policy gymtrack_oauth_authorization_codes_user_isolation on public.gymtrack_oauth_authorization_codes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists gymtrack_oauth_tokens_user_isolation on public.gymtrack_oauth_tokens;
create policy gymtrack_oauth_tokens_user_isolation on public.gymtrack_oauth_tokens
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

insert into public.gymtrack_oauth_clients (client_id, client_name, redirect_uris)
values
  ('claude-desktop', 'Claude Desktop', array['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1/callback']),
  ('chatgpt', 'ChatGPT', array['https://chatgpt.com/connector_platform_oauth_redirect']),
  ('local-dev', 'Local development MCP client', array['http://localhost:8788/callback'])
on conflict (client_id) do update
set client_name = excluded.client_name,
    redirect_uris = excluded.redirect_uris;
