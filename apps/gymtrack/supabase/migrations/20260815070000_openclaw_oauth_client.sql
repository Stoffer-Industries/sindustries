-- Add OpenClaw OAuth client to gymtrack-mcp.
--
-- Task: 30251df0-a8f2-4e28-9836-029edab8261d
-- Tech design: docs/specs/gymtrack-mcp-openclaw-oauth-client-tech-design.md
--
-- Mirrors the insert-on-conflict pattern at the bottom of
-- 20260804070000_mcp_oauth.sql: no schema change, no new table, no new RLS
-- policy. The existing `gymtrack_oauth_clients_authenticated_read` policy
-- covers the new row. AC4 ("no new client can bypass consent") is satisfied
-- by construction: the existing `getConsent(...) revoked_at` check on
-- /oauth/token still gates every token exchange, and the active-consent
-- unique index on (user_id, client_id) where revoked_at is null still
-- requires a user-approved consent row for client_id='openclaw'.

insert into public.gymtrack_oauth_clients (client_id, client_name, redirect_uris)
values
  ('openclaw', 'OpenClaw', array['http://127.0.0.1:8789/callback'])
on conflict (client_id) do update
set client_name = excluded.client_name,
    redirect_uris = excluded.redirect_uris;
