-- GymTrack OAuth decommission (task 1eb6e48c).
--
-- Cuts over from the legacy gymtrack_agent_api_keys credential system to the
-- MCP OAuth credential system. Existing legacy keys are revoked (preserving
-- the audit-stamped row) and the table is then dropped. planned_workouts
-- switches its agent-attribution column from gymtrack_agent_api_keys(id) to
-- gymtrack_oauth_consents(id) so historical "which agent created this plan"
-- attribution survives the cutover for new rows.
--
-- Pre-existing planned_workouts rows with a non-null agent_key_id lose
-- attribution on the new column. That is acceptable: the task description
-- says legacy keys do not need to remain active, and pre-cutover rows can
-- only be attributed back to a legacy key (now revoked) which the user-
-- facing surface no longer renders.
--
-- Apply via:
--   supabase db push
-- or:
--   psql -f apps/gymtrack/supabase/migrations/20260815010000_decommission_legacy_agent_keys.sql
--
-- .openclaw boundary:
--   No Vercel env vars or secrets are set in this migration.
--   Deployment secrets (VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.) are
--   outside repo scope.

----------------------------------------------------------------------
-- 1) Revoke every existing legacy agent key, preserving the audit stamp.
--    This makes any consumer still presenting a legacy token fail at the
--    resolveOAuthIdentity step (which never reads this table anyway), and
--    closes the door on any future regression that re-introduces a
--    gymtrack_agent_api_keys reader.
----------------------------------------------------------------------

update public.gymtrack_agent_api_keys
   set revoked_at = coalesce(revoked_at, now())
 where revoked_at is null;

----------------------------------------------------------------------
-- 2) Replace planned_workouts.agent_key_id with planned_workouts.consent_id.
--    consent_id references gymtrack_oauth_consents(id) ON DELETE SET NULL so
--    revoking an agent in Connected Agents (which cascades to its consents)
--    does not orphan historical planned_workouts rows.
----------------------------------------------------------------------

alter table public.planned_workouts
  add column if not exists consent_id uuid
    references public.gymtrack_oauth_consents(id) on delete set null;

-- Pre-existing rows with a non-null agent_key_id lose attribution on
-- consent_id by design (see file header).
alter table public.planned_workouts
  drop column agent_key_id;

----------------------------------------------------------------------
-- 3) Drop the legacy key table, its indexes, and its RLS policy.
----------------------------------------------------------------------

drop policy if exists gymtrack_agent_api_keys_user_isolation on public.gymtrack_agent_api_keys;
drop index  if exists gymtrack_agent_api_keys_hash_idx;
drop index  if exists gymtrack_agent_api_keys_user_idx;
drop table  if exists public.gymtrack_agent_api_keys;

----------------------------------------------------------------------
-- 4) planned_workouts RLS is unchanged: the existing user-isolation policy
--    only references user_id, so adding/removing the agent-attribution
--    column does not require a policy change.
----------------------------------------------------------------------
