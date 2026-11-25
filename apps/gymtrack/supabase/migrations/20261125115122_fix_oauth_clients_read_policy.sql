-- Fix gymtrack_oauth_clients read policy for Clerk Third-Party Auth
--
-- Every user-owned GymTrack table was repointed to auth.jwt()->>'sub' by
-- 20260924000000_clerk_rls_third_party_auth_assert.sql. public.gymtrack_oauth_clients
-- has no user_id (it is a public client catalogue, not user-owned data), so it was
-- correctly left out of that migration's scope -- but its original read policy was
-- never revisited:
--
--   create policy gymtrack_oauth_clients_authenticated_read on public.gymtrack_oauth_clients
--     for select using (auth.role() = 'authenticated');
--
-- auth.role() resolves from a `role` claim on the request JWT. Native Supabase Auth
-- JWTs always carry `role: "authenticated"`; a Clerk-issued session JWT verified via
-- Supabase Third-Party Auth only carries that claim if it was explicitly added as a
-- custom claim in Clerk's session token configuration (a Clerk-dashboard-only setting,
-- outside this repo). That configuration step was never verified against a real
-- production token -- the Slice B assertion migration's own self-test synthesizes the
-- `role` claim with set_config() rather than proving a live Clerk token carries it.
--
-- Effect in production (2026-11-25): every OAuth consent screen -- for every
-- dynamically-registered MCP client (Claude, OpenClaw, etc.) -- failed closed with a
-- generic "Unknown OAuth client." error, because the SELECT silently returned zero rows
-- under RLS rather than erroring, and the frontend (AgentConsentPage.jsx) cannot
-- distinguish "no such client" from "RLS filtered the row".
--
-- First attempt (reverted below): `using ((select auth.jwt()) is not null)`. Reviewer
-- Rowan Stoffer caught that this is also true for an anonymous publishable-key request
-- -- Supabase supplies JWT-shaped claims for anon requests too, so a bare non-null
-- check does not distinguish a signed-in user from an anonymous Data API caller.
-- Confirmed live against production: the publishable key alone returned HTTP 200 and
-- all 31 rows in this table, which broadens a previously authenticated-only catalogue
-- to fully public. This migration lands the corrected predicate instead.
--
-- Fix: gate on the presence of the verified user-identity claim (`sub`), the same
-- claim every user-owned policy in this schema already keys on, rather than a bare
-- "is this a JWT" check or a provider-specific `role` claim. An anonymous publishable
-- key request carries no `sub`; a real Clerk session JWT always does.
--
-- Both directions verified directly against production via the Supabase Management
-- API on 2026-11-25:
--   * publishable key only (no user bearer token)   -> REST call returns 0 rows
--   * simulated Clerk JWT with `sub`, no `role`     -> SELECT returns the requested row
-- The broader interim policy was already live in production from the first attempt;
-- it has been repaired to this corrected predicate as part of landing this migration,
-- so `supabase db push` on the next deploy is a no-op against production and every
-- other environment picks up the corrected policy, not the interim one.

alter policy gymtrack_oauth_clients_authenticated_read on public.gymtrack_oauth_clients
  using ((auth.jwt() ->> 'sub') is not null);

----------------------------------------------------------------------
-- Assert the policy lands on the sub claim, not a bare non-null JWT check
----------------------------------------------------------------------

do $$
declare
  policy_qual text;
begin
  select qual
    into policy_qual
  from pg_policies
  where schemaname = 'public'
    and tablename = 'gymtrack_oauth_clients'
    and policyname = 'gymtrack_oauth_clients_authenticated_read';

  if policy_qual is null then
    raise exception 'gymtrack_oauth_clients_authenticated_read policy is missing';
  end if;

  if policy_qual ilike '%auth.role()%' then
    raise exception 'gymtrack_oauth_clients_authenticated_read regressed to the provider-specific role() claim';
  end if;

  if policy_qual not ilike '%''sub''%' then
    raise exception 'gymtrack_oauth_clients_authenticated_read regressed to a bare non-null JWT check (does not key on sub)';
  end if;

  -- Anonymous: JWT-shaped claims with no `sub` (what Supabase supplies for a
  -- publishable-key-only request) must NOT satisfy the policy.
  perform set_config('request.jwt.claims', '{}'::text, true);
  if (auth.jwt() ->> 'sub') is not null then
    raise exception 'Regression harness error: anonymous claims unexpectedly produced a sub';
  end if;

  -- Authenticated: a Clerk session JWT with `sub` and no `role` claim must
  -- satisfy the policy (the original bug this migration fixes).
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', 'user_oauth_clients_regression_check')::text,
    true
  );
  if (auth.jwt() ->> 'sub') is null then
    raise exception 'Regression harness error: a Clerk-shaped sub claim was not readable via auth.jwt()';
  end if;

  raise notice 'gymtrack_oauth_clients_authenticated_read: sub-gated, anon rejected, Clerk-shaped sub accepted';
end $$;
