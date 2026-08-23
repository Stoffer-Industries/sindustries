-- Add OAuth 2.0 Dynamic Client Registration (DCR) support to gymtrack-mcp.
--
-- Task: de19b186-dda6-47dc-94f1-ef52d2dc9383
-- Tech design: docs/specs/gymtrack-mcp-oauth-dcr-tech-design.md
--
-- Extends public.gymtrack_oauth_clients with:
--   * registration_type discriminator ('static' default, 'dynamic' for DCR rows)
--   * RFC 7591 §2 client metadata columns (all nullable; backwards-compatible
--     with the four existing seeded static rows: claude-desktop, chatgpt,
--     local-dev, openclaw)
--   * registered_at for dynamic rows
--
-- No new table, no RLS change, no policy change. Service-role writes from
-- /oauth/register bypass RLS. AC5 ("no new client can bypass consent") is
-- satisfied by construction: the existing getConsent(...).revoked_at gate on
-- /oauth/token and the active-consent unique index on (user_id, client_id)
-- apply identically to dynamic clients because they key on client_id as an
-- opaque string.

alter table public.gymtrack_oauth_clients
  add column if not exists registration_type text not null default 'static',
  add column if not exists registered_at timestamptz,
  add column if not exists client_uri text,
  add column if not exists logo_uri text,
  add column if not exists contacts text[],
  add column if not exists policy_uri text,
  add column if not exists tos_uri text,
  add column if not exists software_id text,
  add column if not exists software_version text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'gymtrack_oauth_clients_registration_type_check'
      and conrelid = 'public.gymtrack_oauth_clients'::regclass
  ) then
    alter table public.gymtrack_oauth_clients
      add constraint gymtrack_oauth_clients_registration_type_check
      check (registration_type in ('static', 'dynamic'));
  end if;
end
$$;

-- Backfill registered_at for the four seeded static rows so operator queries
-- ordering by registered_at desc nulls last show a stable history. The values
-- are the merged date of the source migration per client.
update public.gymtrack_oauth_clients
   set registered_at = '2026-08-04T07:00:00+00:00'
 where client_id in ('claude-desktop', 'chatgpt', 'local-dev')
   and registered_at is null;

update public.gymtrack_oauth_clients
   set registered_at = '2026-08-15T07:00:00+00:00'
 where client_id = 'openclaw'
   and registered_at is null;
