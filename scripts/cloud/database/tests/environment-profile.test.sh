#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck source=scripts/cloud/database/common.sh
# environment-profile.test.sh — unit tests for the environment profile
# layer in scripts/cloud/database/common.sh.
#
# The staging profile behaves exactly as it always has: a staging run
# refuses any DSN carrying a production marker. The production profile
# is new, and it is the part of this change that can touch production
# data, so it gets its own contract test.
#
# The production profile exists because the production cutover runs
# through the same harness. Two facts drive its shape:
#
#   1. The production Neon branch database is named `neondb` — the same
#      name staging uses — so a database-name prefix CANNOT identify a
#      production target. The profile identifies its target by declared
#      endpoint instead, and REQUIRES the operator to declare it.
#   2. A production run needs two independent keys: the environment
#      label on the command line, and an acknowledgement that can only
#      come from the environment (CLOUD_DB_PRODUCTION_ACK=1). A command
#      line alone must never be able to start a production run.
#
# Covered:
#   1. staging profile refuses a production DSN (unchanged behaviour).
#   2. staging profile accepts a clean DSN.
#   3. production profile refuses a run with no declared endpoint.
#   4. production profile refuses an endpoint outside the declared list.
#   5. production profile accepts an endpoint inside the declared list.
#   6. production profile refuses a staging-prefixed database name.
#   7. production profile requires the environment acknowledgement key.
#   8. the acknowledgement key is ignored outside production.
#   9. per-profile artifact directory and envelope kind prefix.
#  10. per-profile database-name rule (staging prefix required /
#      staging prefix refused).
#  11. an unknown environment label is refused.
#  12. the endpoint allowlist can come from the environment variable.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

SCRIPT="$REPO_ROOT/scripts/cloud/database/common.sh"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { echo "  ok $1"; }
fail() { echo "  FAIL $1"; failures=$((failures + 1)); }

# Runs a sourced-script body with stderr captured to $1 and stdout
# discarded. Always returns 0 so the caller inspects the log.
run_capture() {
  local log_path="$1"
  shift
  set +e
  "$@" 2>"$log_path" >/dev/null
  set -e
  return 0
}

assert_log_contains() {
  local label="$1"
  local pattern="$2"
  local log="$3"
  if grep -Eq -- "$pattern" "$log"; then
    pass "$label"
  else
    fail "$label — expected log to contain [$pattern], was:"
    sed 's/^/      /' "$log"
  fi
}

assert_log_lacks() {
  local label="$1"
  local pattern="$2"
  local log="$3"
  if grep -Eq -- "$pattern" "$log"; then
    fail "$label — expected log NOT to contain [$pattern], was:"
    sed 's/^/      /' "$log"
  else
    pass "$label"
  fi
}

PROD_DSN='postgres://u:p@prod-db.internal:5432/neondb?sslmode=require'
STAGING_DSN='postgres://u:p@staging-db.internal:5432/sindustries_staging_tasks?sslmode=require'
PROD_HOST='prod-db.internal:5432'

# ---------------------------------------------------------------------------
# 1 + 2. The staging profile is unchanged: a production marker refuses,
# a clean DSN passes.
# ---------------------------------------------------------------------------

LOG="$TMP/staging-prod.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment staging; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_contains "staging profile refuses a production DSN" \
  "contains production substring" "$LOG"

LOG="$TMP/staging-clean.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment staging; cloud_db_assert_target_dsn source '$STAGING_DSN'"
assert_log_lacks "staging profile accepts a clean DSN" \
  "level=error" "$LOG"

# ---------------------------------------------------------------------------
# 3. A production run with no declared endpoint refuses — the allowlist
#    is mandatory, because the database name cannot identify the target.
# ---------------------------------------------------------------------------

LOG="$TMP/prod-no-host.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_contains "production profile refuses a run with no declared endpoint" \
  "must declare the endpoints they may touch" "$LOG"

# ---------------------------------------------------------------------------
# 4 + 5. A declared endpoint is enforced: outside the list refuses,
#      inside the list passes.
# ---------------------------------------------------------------------------

LOG="$TMP/prod-wrong-host.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_add_expected_host 'other-db.internal:5432'; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_contains "production profile refuses an endpoint outside the declared list" \
  "is not in the declared endpoint allowlist" "$LOG"

LOG="$TMP/prod-right-host.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_add_expected_host '$PROD_HOST'; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_lacks "production profile accepts an endpoint inside the declared list" \
  "level=error" "$LOG"

# ---------------------------------------------------------------------------
# 6. A staging-prefixed database name is refused in a production run even
#    when the endpoint is declared — the cross-environment bleed guard.
# ---------------------------------------------------------------------------

LOG="$TMP/prod-staging-db.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_add_expected_host '$PROD_HOST'; cloud_db_assert_target_dsn source '$STAGING_DSN'"
assert_log_contains "production profile refuses a staging-prefixed database name" \
  "carries the staging prefix" "$LOG"

# ---------------------------------------------------------------------------
# 7 + 8. The second key: CLOUD_DB_PRODUCTION_ACK=1 must be present in the
#    environment for a production run, and is irrelevant elsewhere.
# ---------------------------------------------------------------------------

LOG="$TMP/prod-no-ack.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_assert_production_ack"
assert_log_contains "production profile requires the environment acknowledgement key" \
  "require CLOUD_DB_PRODUCTION_ACK=1" "$LOG"

LOG="$TMP/prod-ack.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; CLOUD_DB_PRODUCTION_ACK=1; cloud_db_assert_production_ack"
assert_log_lacks "production profile accepts the acknowledgement key" \
  "level=error" "$LOG"

LOG="$TMP/staging-no-ack.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment staging; cloud_db_assert_production_ack"
assert_log_lacks "the acknowledgement key is not required outside production" \
  "level=error" "$LOG"

# ---------------------------------------------------------------------------
# 9. Per-profile artifact directory and envelope kind prefix.
# ---------------------------------------------------------------------------

out="$(
  bash -c "source '$SCRIPT'; cloud_db_set_environment staging; printf '%s %s' \"\$CLOUD_DB_ARTIFACT_DIR\" \"\$CLOUD_DB_KIND_PREFIX\""
)"
if [[ "$out" == "./artifacts/cloud-staging cloud-staging" ]]; then
  pass "staging profile resolves the staging artifact dir and kind prefix"
else
  fail "staging profile resolved [$out], expected [./artifacts/cloud-staging cloud-staging]"
fi

out="$(
  bash -c "source '$SCRIPT'; cloud_db_set_environment production; printf '%s %s' \"\$CLOUD_DB_ARTIFACT_DIR\" \"\$CLOUD_DB_KIND_PREFIX\""
)"
if [[ "$out" == "./artifacts/cloud-production cloud-production" ]]; then
  pass "production profile resolves the production artifact dir and kind prefix"
else
  fail "production profile resolved [$out], expected [./artifacts/cloud-production cloud-production]"
fi

# ---------------------------------------------------------------------------
# 10. Per-profile database-name rule.
# ---------------------------------------------------------------------------

LOG="$TMP/name-staging-ok.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment staging; cloud_db_assert_database_name 'sindustries_staging_tasks'"
assert_log_lacks "staging profile accepts a staging-prefixed database name" \
  "level=error" "$LOG"

LOG="$TMP/name-staging-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment staging; cloud_db_assert_database_name 'neondb'"
assert_log_contains "staging profile refuses a database name without the staging prefix" \
  "does not start with allowed prefix" "$LOG"

LOG="$TMP/name-prod-ok.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_assert_database_name 'neondb'"
assert_log_lacks "production profile accepts the production database name" \
  "level=error" "$LOG"

LOG="$TMP/name-prod-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; cloud_db_assert_database_name 'sindustries_staging_tasks'"
assert_log_contains "production profile refuses a staging-prefixed database name" \
  "carries the staging prefix" "$LOG"

# ---------------------------------------------------------------------------
# 11. An unknown environment label is refused.
# ---------------------------------------------------------------------------

LOG="$TMP/env-unknown.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment prod"
assert_log_contains "an unknown environment label is refused" \
  "is not in allowed list" "$LOG"

# ---------------------------------------------------------------------------
# 12. The endpoint allowlist can come from the environment variable.
# ---------------------------------------------------------------------------

LOG="$TMP/prod-env-host.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; CLOUD_DB_EXPECTED_HOSTS='$PROD_HOST'; cloud_db_load_expected_targets_from_env; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_lacks "the endpoint allowlist can come from the environment variable" \
  "level=error" "$LOG"

LOG="$TMP/prod-env-host-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_set_environment production; CLOUD_DB_EXPECTED_HOSTS='other-db.internal:5432'; cloud_db_load_expected_targets_from_env; cloud_db_assert_target_dsn source '$PROD_DSN'"
assert_log_contains "the environment-variable allowlist is enforced" \
  "is not in the declared endpoint allowlist" "$LOG"

if (( failures > 0 )); then
  echo "FAIL: ${failures} environment-profile check(s) failed"
  exit 1
fi

echo "ALL environment-profile checks passed"
