-- Add a hosted OAuth callback URL to the seeded `openclaw` OAuth client.
--
-- Task: b7726e20-46d0-4c1a-9971-0cee313ca008
-- Tech design: docs/specs/gymtrack-oauth-mcp-ux-tech-design.md
--
-- The seeded openclaw row was added under task 30251df0 (migration
-- 20260815070000_openclaw_oauth_client.sql) with only the loopback
-- redirect URI `http://127.0.0.1:8789/callback`. On a phone, that
-- loopback port is firewalled, so the user lands on a dead tab after
-- the OAuth consent step and never sees the one-time authorization
-- code. The fix is a second redirect URI that points at the hosted
-- GymTrack callback page (`<app-host>/oauth/callback`), where the
-- success / denial / empty states render a clear message and a
-- copy-to-clipboard action.
--
-- The hosted URL defaults to the current Vercel staging host; production
-- needs the same row re-applied against the production Vercel host at
-- deploy time (one-off ops change). The runbook at
-- docs/runbooks/gymtrack-agent-connect.md calls this out under
-- "Hosted callback URL — production migration".
--
-- Pattern: same insert-on-conflict approach as
-- 20260815070000_openclaw_oauth_client.sql — append the hosted URL
-- to the existing redirect_uris array so the loopback URI is preserved
-- for desktop users who still have the listener running. The two URIs
-- share one client_id, so no second seeded client is needed.

insert into public.gymtrack_oauth_clients (client_id, client_name, redirect_uris)
values
  ('openclaw', 'OpenClaw', array[
    'http://127.0.0.1:8789/callback',
    'https://gymtrack-sigma-pied.vercel.app/oauth/callback'
  ])
on conflict (client_id) do update
set client_name = excluded.client_name,
    redirect_uris = excluded.redirect_uris;
