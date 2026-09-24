#!/usr/bin/env bash
#
# run-clerk-rls-test.sh — Slice B RLS integration test driver for the GymTrack
# Clerk identity migration (task bb09eaed, Phase 3 Slice B).
#
# Phase 3 Slice A (PR #734, MERGED 2026-09-23) shipped the AuthProvider
# dispatcher + Clerk SDK + supabase-js JWT bridge. Slice B verifies that
# when a Clerk session JWT is presented as the bearer token to Supabase:
#
#   1. Supabase Third-Party Auth validates the Clerk signature against
#      the Clerk JWKS.
#   2. `auth.uid()` resolves to the Clerk subject (text).
#   3. The existing `auth.uid() = user_id` RLS policies on `public.workouts`,
#      `public.workouts.workout_sets`, etc., still allow the user's own
#      rows and still reject cross-user reads.
#
# This script is the staging runbook that drives the cross-user rejection
# assertion. It runs against the deployed staging Supabase project,
# seeds two Clerk test users with one workout row each, simulates user
# A and user B's session via `set_config('request.jwt.claim.sub', ...)`,
# and asserts the row counts differ (proving RLS is keyed per-user).
#
# Pre-requisites:
#   - Phase 0 done: Clerk app + Google OAuth + Supabase Third-Party Auth
#     configured (Quinn / Tom).
#   - Phase 1 + 2 merged (PRs #714, #716) on staging.
#   - The migration
#     `apps/gymtrack/supabase/migrations/20260924000000_clerk_rls_third_party_auth_assert.sql`
#     has been applied to staging.
#   - Two Clerk test users exist in the Clerk application; their Clerk
#     subjects are exported as `CLERK_TEST_USER_A_SUB` and
#     `CLERK_TEST_USER_B_SUB`.
#
# Usage:
#   bash infra/cloud/scripts/run-clerk-rls-test.sh
#
# Environment overrides:
#   - CLERK_TEST_USER_A_SUB, CLERK_TEST_USER_B_SUB
#   - SUPABASE_DB_URL_STAGING (default: derived from staging secrets)
#   - PG_BINARY (default: psql)
#
# Exit codes:
#   - 0  → assertion passed
#   - 1  → assertion failed (cross-user RLS rejection is broken)
#   - 2  → pre-requisites missing (Clerk test users / staging DB)
#
# This script is run-only; it does not write durable state. Cleanup of
# the seeded workout rows happens inside the script (best-effort
# `delete from public.workouts where ...` on EXIT).

set -euo pipefail

CLERK_TEST_USER_A_SUB="${CLERK_TEST_USER_A_SUB:-}"
CLERK_TEST_USER_B_SUB="${CLERK_TEST_USER_B_SUB:-}"
PG_BINARY="${PG_BINARY:-psql}"

if [ -z "$CLERK_TEST_USER_A_SUB" ] || [ -z "$CLERK_TEST_USER_B_SUB" ]; then
  echo "ERROR: CLERK_TEST_USER_A_SUB and CLERK_TEST_USER_B_SUB must be set" >&2
  echo "       (Clerk subjects for the two test users created on the Clerk dashboard)" >&2
  exit 2
fi

if [ -z "${SUPABASE_DB_URL_STAGING:-}" ]; then
  # Derive from Fly secrets if not exported. The staging budget-api uses
  # STAGING_BUDGET_API_DATABASE_URL; if the dedicated GymTrack staging DB
  # URL is exported, prefer that.
  if [ -n "${STAGING_GYMTRACK_DB_URL:-}" ]; then
    SUPABASE_DB_URL_STAGING="$STAGING_GYMTRACK_DB_URL"
  else
    echo "ERROR: SUPABASE_DB_URL_STAGING (or STAGING_GYMTRACK_DB_URL) must be set" >&2
    exit 2
  fi
fi

cleanup() {
  # Best-effort cleanup of any workout rows we seeded for the assertion.
  "$PG_BINARY" "$SUPABASE_DB_URL_STAGING" <<SQL
    delete from public.workouts
    where user_id in (
      select id from public.profiles
      where clerk_user_id in ('$CLERK_TEST_USER_A_SUB', '$CLERK_TEST_USER_B_SUB')
        and email like '%slice-b-test%'
    );
SQL
}
trap cleanup EXIT

echo "→ Driving cross-user RLS rejection assertion..."
echo "   user A Clerk subject: $CLERK_TEST_USER_A_SUB"
echo "   user B Clerk subject: $CLERK_TEST_USER_B_SUB"

RESULT=$("$PG_BINARY" "$SUPABASE_DB_URL_STAGING" <<SQL
-- Enable the Slice B assertion block in the migration.
set local app.slice_b_rls_test to 'on';

-- Seed two profiles + one workout each for the test users (idempotent).
insert into public.profiles (clerk_user_id, email, email_verified, signup_source)
values ('$CLERK_TEST_USER_A_SUB', 'slice-b-test-a@gymtrack-test.local', true, 'clerk_import')
on conflict (clerk_user_id) do nothing;

insert into public.profiles (clerk_user_id, email, email_verified, signup_source)
values ('$CLERK_TEST_USER_B_SUB', 'slice-b-test-b@gymtrack-test.local', true, 'clerk_import')
on conflict (clerk_user_id) do nothing;

-- Seed one workout per user.
with profile_a as (
  select id from public.profiles where clerk_user_id = '$CLERK_TEST_USER_A_SUB'
), profile_b as (
  select id from public.profiles where clerk_user_id = '$CLERK_TEST_USER_B_SUB'
)
insert into public.workouts (user_id, name, performed_at)
select id, 'Slice B test workout A', now() from profile_a
where not exists (
  select 1 from public.workouts
  where user_id = (select id from profile_a)
    and name = 'Slice B test workout A'
);

with profile_b as (
  select id from public.profiles where clerk_user_id = '$CLERK_TEST_USER_B_SUB'
)
insert into public.workouts (user_id, name, performed_at)
select id, 'Slice B test workout B', now() from profile_b
where not exists (
  select 1 from public.workouts
  where user_id = (select id from profile_b)
    and name = 'Slice B test workout B'
);

-- Simulate user A's authenticated request.
set local role authenticated;
set local request.jwt.claim.sub to '$CLERK_TEST_USER_A_SUB';
select 'user_a_count' as who, count(*)::text as visible_workouts
from public.workouts;

-- Simulate user B's authenticated request.
set local request.jwt.claim.sub to '$CLERK_TEST_USER_B_SUB';
select 'user_b_count' as who, count(*)::text as visible_workouts
from public.workouts;

-- Reset role for cleanup.
reset role;
SQL
)

echo "$RESULT"

USER_A_COUNT=$(echo "$RESULT" | awk -F'|' '/user_a_count/ {gsub(/ /,"",$3); print $3}')
USER_B_COUNT=$(echo "$RESULT" | awk -F'|' '/user_b_count/ {gsub(/ /,"",$3); print $3}')

# Both users should see exactly 1 workout (their own). If either sees
# more than 1, RLS is broken (cross-user leak). If either sees 0, the
# set_config simulation is broken (RLS is too aggressive).
if [ "${USER_A_COUNT:-0}" != "1" ] || [ "${USER_B_COUNT:-0}" != "1" ]; then
  echo "FAIL: cross-user RLS rejection is broken (user A saw $USER_A_COUNT workouts, user B saw $USER_B_COUNT)" >&2
  exit 1
fi

echo "PASS: cross-user RLS rejection works as expected (each user sees exactly their own workout)"