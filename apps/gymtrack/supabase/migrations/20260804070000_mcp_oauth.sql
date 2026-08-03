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
drop policy if exists gymtrack_oauth_consents_user_read on public.gymtrack_oauth_consents;
create policy gymtrack_oauth_consents_user_read on public.gymtrack_oauth_consents
  for select
  using (auth.uid() = user_id);

drop policy if exists gymtrack_oauth_authorization_codes_user_isolation on public.gymtrack_oauth_authorization_codes;

drop policy if exists gymtrack_oauth_tokens_user_isolation on public.gymtrack_oauth_tokens;

create or replace function public.gymtrack_consume_oauth_authorization_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_consumed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.gymtrack_oauth_authorization_codes%rowtype;
begin
  update public.gymtrack_oauth_authorization_codes
     set consumed_at = p_consumed_at
   where code_hash = p_code_hash
     and client_id = p_client_id
     and redirect_uri = p_redirect_uri
     and consumed_at is null
     and revoked_at is null
     and expires_at > p_consumed_at
   returning * into v_code;

  if not found then
    return null;
  end if;

  return to_jsonb(v_code);
end;
$$;

revoke all on function public.gymtrack_consume_oauth_authorization_code(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.gymtrack_consume_oauth_authorization_code(text, text, text, timestamptz) to service_role;

create or replace function public.gymtrack_rotate_oauth_refresh_token(
  p_refresh_token_hash text,
  p_client_id text,
  p_rotated_at timestamptz,
  p_next_access_token_hash text,
  p_next_refresh_token_hash text,
  p_next_access_token_expires_at timestamptz,
  p_next_refresh_token_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.gymtrack_oauth_tokens%rowtype;
  v_consent public.gymtrack_oauth_consents%rowtype;
  v_next public.gymtrack_oauth_tokens%rowtype;
begin
  select *
    into v_source
    from public.gymtrack_oauth_tokens
   where refresh_token_hash = p_refresh_token_hash
     and client_id = p_client_id
   limit 1
   for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select *
    into v_consent
    from public.gymtrack_oauth_consents
   where id = v_source.consent_id
   limit 1
   for update;

  if not found or v_consent.revoked_at is not null then
    update public.gymtrack_oauth_tokens
       set revoked_at = coalesce(revoked_at, p_rotated_at),
           revocation_reason = coalesce(revocation_reason, 'consent_revoked')
     where consent_id = v_source.consent_id
       and revoked_at is null;

    update public.gymtrack_oauth_authorization_codes
       set revoked_at = coalesce(revoked_at, p_rotated_at)
     where consent_id = v_source.consent_id
       and revoked_at is null;

    return jsonb_build_object(
      'status',
      'consent_revoked',
      'source_token',
      to_jsonb(v_source),
      'consent',
      coalesce(to_jsonb(v_consent), 'null'::jsonb)
    );
  end if;

  if v_source.revoked_at is not null or v_source.rotated_at is not null then
    update public.gymtrack_oauth_consents
       set revoked_at = coalesce(revoked_at, p_rotated_at)
     where id = v_source.consent_id
       and revoked_at is null;

    update public.gymtrack_oauth_tokens
       set revoked_at = coalesce(revoked_at, p_rotated_at),
           revocation_reason = coalesce(revocation_reason, 'refresh_replay_detected')
     where family_id = v_source.family_id
       and revoked_at is null;

    update public.gymtrack_oauth_authorization_codes
       set revoked_at = coalesce(revoked_at, p_rotated_at)
     where consent_id = v_source.consent_id
       and revoked_at is null;

    select *
      into v_consent
      from public.gymtrack_oauth_consents
     where id = v_source.consent_id
     limit 1;

    return jsonb_build_object(
      'status',
      'replayed',
      'source_token',
      to_jsonb(v_source),
      'consent',
      to_jsonb(v_consent)
    );
  end if;

  if v_source.refresh_token_expires_at <= p_rotated_at then
    return jsonb_build_object(
      'status',
      'expired',
      'source_token',
      to_jsonb(v_source),
      'consent',
      to_jsonb(v_consent)
    );
  end if;

  insert into public.gymtrack_oauth_tokens (
    consent_id,
    user_id,
    client_id,
    scope,
    family_id,
    parent_token_id,
    access_token_hash,
    refresh_token_hash,
    access_token_expires_at,
    refresh_token_expires_at
  )
  values (
    v_source.consent_id,
    v_source.user_id,
    v_source.client_id,
    v_source.scope,
    v_source.family_id,
    v_source.id,
    p_next_access_token_hash,
    p_next_refresh_token_hash,
    p_next_access_token_expires_at,
    p_next_refresh_token_expires_at
  )
  returning * into v_next;

  update public.gymtrack_oauth_tokens
     set rotated_at = p_rotated_at,
         revoked_at = p_rotated_at,
         revocation_reason = 'refresh_rotated',
         replaced_by_token_id = v_next.id,
         last_used_at = p_rotated_at
   where id = v_source.id
   returning * into v_source;

  update public.gymtrack_oauth_consents
     set last_used_at = p_rotated_at
   where id = v_source.consent_id
   returning * into v_consent;

  return jsonb_build_object(
    'status',
    'rotated',
    'source_token',
    to_jsonb(v_source),
    'next_token',
    to_jsonb(v_next),
    'consent',
    to_jsonb(v_consent)
  );
end;
$$;

revoke all on function public.gymtrack_rotate_oauth_refresh_token(text, text, timestamptz, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.gymtrack_rotate_oauth_refresh_token(text, text, timestamptz, text, text, timestamptz, timestamptz) to service_role;

insert into public.gymtrack_oauth_clients (client_id, client_name, redirect_uris)
values
  ('claude-desktop', 'Claude Desktop', array['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1/callback']),
  ('chatgpt', 'ChatGPT', array['https://chatgpt.com/connector_platform_oauth_redirect']),
  ('local-dev', 'Local development MCP client', array['http://localhost:8788/callback'])
on conflict (client_id) do update
set client_name = excluded.client_name,
    redirect_uris = excluded.redirect_uris;
