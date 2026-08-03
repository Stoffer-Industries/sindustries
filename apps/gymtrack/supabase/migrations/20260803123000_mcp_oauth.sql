-- GymTrack MCP Server with OAuth Auth — OAuth 2.1 + PKCE storage (task 1474d515).
--
-- Four tables back the agent OAuth flow:
--   1) gymtrack_oauth_clients          — registered MCP clients (allowlist of well-known agents like
--                                        claude-desktop, chatgpt). No user_id; admin-managed via
--                                        service role. RLS left off: clients must be lookable by
--                                        anon users hitting /api/oauth/authorize BEFORE sign-in.
--   2) gymtrack_oauth_authorization_codes — short-lived PKCE-bound auth codes (10 min TTL). One row
--                                        per code; consumed_at flips on exchange.
--   3) gymtrack_oauth_tokens            — hashed access + refresh tokens. Only SHA-256 hashes are
--                                        persisted; plaintext is never written. token_family_id
--                                        groups a refresh chain so replay detection revokes the
--                                        entire family (OAuth 2.1 best practice).
--   4) gymtrack_oauth_consents          — durable record of "user U granted client C scope-set S",
--                                        drives the user-facing "Connected Agents" settings panel.
--
-- Backward compat (AC5): the existing /api/agent/* REST endpoints continue to authenticate via
-- gymtrack_agent_api_keys (hand-issued static keys). This migration does NOT touch those tables.
-- The MCP server is a parallel path that resolves OAuth tokens only.
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260803123000_mcp_oauth.sql
--
-- .openclaw boundary:
--   No Vercel env vars or secrets are set in this migration. The client allowlist rows
--   (claude-desktop, chatgpt, local-dev sentinel) are seeded out-of-band via service-role
--   SQL — see WS2 follow-up; if missing during WS4 testing, post `[openclaw-needed]` with
--   the exact client_id allowlist payload.

----------------------------------------------------------------------
-- 1) gymtrack_oauth_clients — admin-managed MCP client allowlist
----------------------------------------------------------------------

create table if not exists public.gymtrack_oauth_clients (
  -- client_id per OAuth 2.1: opaque string, NOT a UUID. Examples: "claude-desktop", "chatgpt".
  client_id        text primary key,
  display_name     text not null,
  homepage_url     text,
  -- Public clients (PKCE-only, no secret) leave this NULL. Confidential clients store a
  -- SHA-256 hex digest of the client_secret; plaintext is never persisted.
  client_secret_hash text,
  -- Registered redirect URIs for the authorization-code round-trip. Exact-match enforcement
  -- happens in WS2; this column is the source of truth.
  redirect_uris    text[] not null default '{}',
  -- Scopes the client is allowed to request. Restricting the union here keeps the consent
  -- screen honest; the user still has to approve per-grant.
  allowed_scopes   text[] not null default '{}',
  -- Soft-disable without dropping history rows. Disabled clients can't start new flows but
  -- existing tokens/consents keep working until they expire or are revoked.
  disabled_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists gymtrack_oauth_clients_disabled_idx
  on public.gymtrack_oauth_clients (disabled_at)
  where disabled_at is null;

drop trigger if exists gymtrack_oauth_clients_set_updated_at on public.gymtrack_oauth_clients;
create trigger gymtrack_oauth_clients_set_updated_at
  before update on public.gymtrack_oauth_clients
  for each row execute function public.set_updated_at();

----------------------------------------------------------------------
-- 2) gymtrack_oauth_authorization_codes — short-lived PKCE-bound codes
----------------------------------------------------------------------

create table if not exists public.gymtrack_oauth_authorization_codes (
  -- SHA-256 hex digest of the one-time code. Plaintext code is delivered to the client in the
  -- redirect URL and never persisted.
  code_hash             text primary key,
  client_id             text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  -- Nullable until the user finishes the consent screen. The /authorize handler inserts the
  -- row at flow-start (anon) and back-fills user_id after social-login callback succeeds.
  user_id               uuid references auth.users(id) on delete cascade,
  redirect_uri          text not null,
  scopes                text[] not null default '{}',
  -- PKCE: S256 only. The verifier is never stored; we keep the challenge + method so the
  -- /token endpoint can recompute and compare.
  code_challenge        text not null,
  code_challenge_method text not null default 'S256' check (code_challenge_method in ('S256')),
  -- Optional CSRF/state echo from the client; passed through verbatim on the redirect back.
  state                 text,
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists gymtrack_oauth_authorization_codes_user_idx
  on public.gymtrack_oauth_authorization_codes (user_id);

create index if not exists gymtrack_oauth_authorization_codes_expiry_idx
  on public.gymtrack_oauth_authorization_codes (expires_at)
  where consumed_at is null;

----------------------------------------------------------------------
-- 3) gymtrack_oauth_tokens — hashed access + refresh tokens with family rotation
----------------------------------------------------------------------

create table if not exists public.gymtrack_oauth_tokens (
  -- SHA-256 hex digest. Access + refresh tokens live in the same table, discriminated by
  -- token_type; this lets us share one rotation/revocation index.
  token_hash      text primary key,
  token_type      text not null check (token_type in ('access', 'refresh')),
  -- Every token issued in a single user↔client authorization belongs to one family. If a
  -- refresh token is replayed (reused after rotation), we revoke the entire family — see WS2
  -- /token endpoint.
  token_family_id uuid not null default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  client_id       text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  scopes          text[] not null default '{}',
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  -- Refresh-token rotation chain: when a refresh is exchanged, the new refresh's hash is
  -- recorded here so we can walk back and detect re-use of an already-rotated token.
  replaced_by_hash text references public.gymtrack_oauth_tokens(token_hash) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists gymtrack_oauth_tokens_user_idx
  on public.gymtrack_oauth_tokens (user_id);

create index if not exists gymtrack_oauth_tokens_family_idx
  on public.gymtrack_oauth_tokens (token_family_id);

create index if not exists gymtrack_oauth_tokens_expiry_idx
  on public.gymtrack_oauth_tokens (expires_at)
  where revoked_at is null;

----------------------------------------------------------------------
-- 4) gymtrack_oauth_consents — durable user↔client grants
----------------------------------------------------------------------

create table if not exists public.gymtrack_oauth_consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   text not null references public.gymtrack_oauth_clients(client_id) on delete cascade,
  scopes      text[] not null default '{}',
  granted_at  timestamptz not null default now(),
  -- Revoking a consent must cascade-revoke every still-live token in the family (done in WS2
  -- /revoke endpoint). We keep a history row here so the user sees "previously connected"
  -- entries in the settings panel even after revoke.
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  -- One active consent per (user, client). Revoked rows stay around for audit; new grants
  -- either UPDATE the active row or INSERT a new one if the previous was revoked.
  unique (user_id, client_id)
);

create index if not exists gymtrack_oauth_consents_user_idx
  on public.gymtrack_oauth_consents (user_id);

----------------------------------------------------------------------
-- 5) RLS — clients are admin-managed; codes/tokens/consents are user-scoped
----------------------------------------------------------------------

-- clients: no RLS. Reads must work for anon users at /api/oauth/authorize. Writes are
-- gated at the API/service-role layer. This matches the same posture as
-- service_role-only seed data elsewhere in the schema.
-- (intentionally: no `alter table ... enable row level security` for clients)

alter table public.gymtrack_oauth_authorization_codes enable row level security;
alter table public.gymtrack_oauth_tokens            enable row level security;
alter table public.gymtrack_oauth_consents          enable row level security;

-- Authorization codes: server-side flows only. No policy = no anon/authenticated client
-- access; only the service-role key can read/write. (RLS-enabled + no policy = deny all
-- to non-service-role. Confirmed against Supabase docs.)
-- (intentionally: no policy for codes — service-role only)

-- Tokens: same posture — the MCP server authenticates via service role per request (it
-- resolves the bearer once, then uses the resolved user_id for downstream RLS checks on
-- workouts / planned_workouts / workout_sets). End users never query this table directly.
-- (intentionally: no policy for tokens — service-role only)

-- Consents: the connected-agents settings panel reads/writes through this table scoped to
-- the authenticated user. This is the one table in this migration that end users touch.
drop policy if exists gymtrack_oauth_consents_user_isolation on public.gymtrack_oauth_consents;
create policy gymtrack_oauth_consents_user_isolation on public.gymtrack_oauth_consents
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
