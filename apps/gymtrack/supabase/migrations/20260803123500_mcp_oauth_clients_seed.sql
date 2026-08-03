-- GymTrack MCP Server with OAuth Auth — client allowlist seed (task 1474d515).
--
-- Three placeholder rows are seeded so the OAuth flow can be smoke-tested in
-- dev without requiring Quinn to wire each client_id manually. The redirect
-- URIs and allowed scopes here are based on the current MCP integration
-- guides for Anthropic Claude Desktop and OpenAI ChatGPT connectors.
--
-- .openclaw boundary:
--   Real client_id, redirect_uri, and scope values for production must be
--   owned by Quinn via .openclaw. The seeded rows below are dev placeholders
--   that mirror the public-facing shapes from the MCP integration docs; if
--   they differ from production, Quinn updates the rows via service-role SQL
--   or via a follow-up migration. We deliberately do NOT seed client_secret
--   values here — these are all public clients (PKCE-only, no secret).
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260803123500_mcp_oauth_clients_seed.sql
--
-- Backward compat (AC5): this migration only touches gymtrack_oauth_clients.
-- Legacy agent API keys (gymtrack_agent_api_keys) are unaffected.

-- 1) claude-desktop — Anthropic's MCP connector for Claude Desktop.
--    The redirect URI is documented at https://modelcontextprotocol.io/docs/tutorials/use-remote-mcp.
insert into public.gymtrack_oauth_clients (
  client_id, display_name, homepage_url, redirect_uris, allowed_scopes
) values (
  'claude-desktop',
  'Claude Desktop',
  'https://claude.ai',
  array['http://localhost:6274/oauth/callback', 'https://claude.ai/api/mcp/auth/callback'],
  array['workouts:read', 'workouts:write', 'exercises:read']
)
on conflict (client_id) do update set
  display_name = excluded.display_name,
  homepage_url = excluded.homepage_url,
  redirect_uris = excluded.redirect_uris,
  allowed_scopes = excluded.allowed_scopes,
  updated_at = now();

-- 2) chatgpt — OpenAI's MCP connector for ChatGPT.
--    Redirect URI shape mirrors the OpenAI Apps SDK conventions; Quinn will
--    update this once ChatGPT ships the production endpoint.
insert into public.gymtrack_oauth_clients (
  client_id, display_name, homepage_url, redirect_uris, allowed_scopes
) values (
  'chatgpt',
  'ChatGPT',
  'https://chatgpt.com',
  array['https://chatgpt.com/oauth/callback'],
  array['workouts:read', 'exercises:read']
)
on conflict (client_id) do update set
  display_name = excluded.display_name,
  homepage_url = excluded.homepage_url,
  redirect_uris = excluded.redirect_uris,
  allowed_scopes = excluded.allowed_scopes,
  updated_at = now();

-- 3) local-dev — sentinel client for E2E tests and local MCP server
--    integration. The redirect URI points at the local Playwright runner so
--    tests can complete the round-trip without a real IdP.
insert into public.gymtrack_oauth_clients (
  client_id, display_name, homepage_url, redirect_uris, allowed_scopes
) values (
  'local-dev',
  'Local Dev Sentinel',
  'http://localhost:6274',
  array['http://localhost:6274/oauth/callback', 'http://127.0.0.1:6274/oauth/callback'],
  array['workouts:read', 'workouts:write', 'exercises:read']
)
on conflict (client_id) do update set
  display_name = excluded.display_name,
  homepage_url = excluded.homepage_url,
  redirect_uris = excluded.redirect_uris,
  allowed_scopes = excluded.allowed_scopes,
  updated_at = now();
