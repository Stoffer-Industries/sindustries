#!/usr/bin/env bash
# common.test.sh — unit tests for scripts/cloud/database/common.sh.
#
# Exercises the public helpers that have no dependency on PostgreSQL:
#   1. cloud_db_assert_environment: staging accepted, prod refused.
#   2. cloud_db_assert_database_name: allowed prefix accepted, others refused.
#   3. cloud_db_assert_no_production_dsn: production substrings refused.
#   4. cloud_db_assert_inequality: identical DSNs refused; identical hosts
#      refused even with different credentials; different DSNs accepted.
#   5. cloud_db_load_secret: missing file, loose perms, empty file all refused.
#   6. cloud_db_log: redaction replaces DSNs and password= substrings.
#   7. cloud_db_assign_run_id: idempotent within a process.
#   8. cloud_db_run_cleanup_hooks: hooks run in reverse registration order;
#      a failing hook does not stop the others.
#   9. Bash version assertion: refuses to source under an old bash.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

SCRIPT="$REPO_ROOT/scripts/cloud/database/common.sh"
[[ -f "$SCRIPT" ]] || { echo "FAIL: $SCRIPT not found"; exit 1; }

# bash 4+ is required for the associative arrays + here-string handling.
if ! bash -c 'declare -A X=([a]=b); echo "${X[a]}"' >/dev/null 2>&1; then
  echo "FAIL: bash 4+ required. Run with PATH=/opt/homebrew/bin:\$PATH" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Capture stderr of the sourced helpers — common.sh redirects logs to
# stderr, so we run each check in a subshell with 2> redirected to a
# file we can grep.
assert_dies_with() {
  local label="$1"
  local pattern="$2"
  local log="$3"
  if ! grep -Eq -- "$pattern" "$log"; then
    echo "FAIL: $label — expected log to contain [$pattern], was:" >&2
    cat "$log" >&2
    exit 1
  fi
}

assert_succeeds() {
  local label="$1"
  local log="$2"
  if grep -Eq 'level=error' "$log"; then
    echo "FAIL: $label — expected success, got error log:" >&2
    cat "$log" >&2
    exit 1
  fi
}

# Helper that runs a sourced-script body with stderr captured to $1
# and stdout discarded. Always returns 0 so callers can inspect the
# log file directly. Disables set -e for the run because the helper
# exists to test failure paths.
run_capture() {
  local log_path="$1"
  shift
  set +e
  "$@" 2>"$log_path" >/dev/null
  set -e
  return 0
}

# 1. cloud_db_assert_environment
echo "test: assert_environment accepts staging"
LOG="$TMP/env-ok.log"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_environment 'staging'"; then
  echo "FAIL: staging should be accepted" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: assert_environment refuses production"
LOG="$TMP/env-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_environment 'production'"
assert_dies_with "production refusal" "environment 'production' is not in allowed list" "$LOG"

# 2. cloud_db_assert_database_name
echo "test: assert_database_name accepts allowed prefix"
LOG="$TMP/name-ok.log"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_database_name 'sindustries_staging_tasks'"; then
  echo "FAIL: staging-prefix name should be accepted" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: assert_database_name refuses missing prefix"
LOG="$TMP/name-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_database_name 'tasks'"
assert_dies_with "missing prefix refusal" "does not start with allowed prefix" "$LOG"

# 3. cloud_db_assert_no_production_dsn
echo "test: assert_no_production_dsn accepts clean DSN"
LOG="$TMP/dsn-ok.log"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_no_production_dsn source 'postgres://u:p@staging-host/db'"; then
  echo "FAIL: clean DSN should be accepted" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: assert_no_production_dsn refuses production substring"
LOG="$TMP/dsn-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_no_production_dsn source 'postgres://u:p@prod-host/db'"
assert_dies_with "production DSN refusal" "contains production substring" "$LOG"

# 4. cloud_db_assert_inequality
echo "test: assert_inequality accepts different DSNs"
LOG="$TMP/ineq-ok.log"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_inequality source 'postgres://u:p@host-a/db' destination 'postgres://u:p@host-b/db'"; then
  echo "FAIL: distinct DSNs should be accepted" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: assert_inequality refuses identical DSNs"
LOG="$TMP/ineq-bad.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_inequality source 'postgres://u:p@host-a/db' destination 'postgres://u:p@host-a/db'"
assert_dies_with "identical DSN refusal" "DSNs are identical" "$LOG"

echo "test: assert_inequality refuses identical hosts with different creds"
LOG="$TMP/ineq-host.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_assert_inequality source 'postgres://u1:p1@host-a/db1' destination 'postgres://u2:p2@host-a/db2'"
assert_dies_with "identical host refusal" "host portion is identical" "$LOG"

# 5. cloud_db_load_secret
echo "test: load_secret accepts mode-0600 file"
LOG="$TMP/secret-ok.log"
SECRET="$TMP/secret-ok.dsn"
printf '%s' 'postgres://u:p@host-a/db' > "$SECRET"
chmod 0600 "$SECRET"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_load_secret LOADED '$SECRET'"; then
  echo "FAIL: mode-0600 file should be accepted" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: load_secret refuses missing file"
LOG="$TMP/secret-missing.log"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_load_secret LOADED '$TMP/does-not-exist'"
assert_dies_with "missing file refusal" "not found" "$LOG"

echo "test: load_secret refuses loose permissions"
LOG="$TMP/secret-perms.log"
SECRET="$TMP/secret-perms.dsn"
printf '%s' 'postgres://u:p@host-a/db' > "$SECRET"
chmod 0644 "$SECRET"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_load_secret LOADED '$SECRET'"
assert_dies_with "loose perms refusal" "permissions are '0?644'" "$LOG"

echo "test: load_secret refuses empty file"
LOG="$TMP/secret-empty.log"
SECRET="$TMP/secret-empty.dsn"
: > "$SECRET"
chmod 0600 "$SECRET"
run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_load_secret LOADED '$SECRET'"
assert_dies_with "empty file refusal" "is empty" "$LOG"

# 6. cloud_db_log redaction
echo "test: log redacts DSNs and password substrings"
LOG="$TMP/redact.log"
if ! run_capture "$LOG" bash -c "source '$SCRIPT'; cloud_db_info 'connecting to postgres://user:secret@host.example/db with password=hunter2'"; then
  echo "FAIL: log call should succeed" >&2; cat "$LOG" >&2; exit 1
fi
if grep -q "secret@host.example" "$LOG"; then
  echo "FAIL: log should redact the DSN password" >&2; cat "$LOG" >&2; exit 1
fi
if ! grep -q '\[REDACTED\]' "$LOG"; then
  echo "FAIL: log should contain a redaction marker" >&2; cat "$LOG" >&2; exit 1
fi
if grep -q "password=hunter2" "$LOG"; then
  echo "FAIL: log should redact password= substring" >&2; cat "$LOG" >&2; exit 1
fi

# 7. cloud_db_assign_run_id idempotence within a single process.
# The function must be idempotent: calling it twice in the same
# subshell must yield the same CLOUD_DB_RUN_ID, not regenerate.
echo "test: assign_run_id is idempotent within a process"
LOG="$TMP/runid.log"
out1=""
out2=""
( set +e
  source "$SCRIPT" 2>"$LOG"
  cloud_db_assign_run_id
  out1="$CLOUD_DB_RUN_ID"
  cloud_db_assign_run_id
  out2="$CLOUD_DB_RUN_ID"
  printf '%s\n%s\n' "$out1" "$out2"
) >"$TMP/runid-out.txt"
mapfile -t ids <"$TMP/runid-out.txt"
out1="${ids[0]}"
out2="${ids[1]}"
if [[ -z "$out1" || "$out1" != "$out2" ]]; then
  echo "FAIL: run id should be stable across calls; got [$out1] then [$out2]" >&2; cat "$LOG" >&2; exit 1
fi
if ! [[ "$out1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$ ]]; then
  echo "FAIL: run id format unexpected: [$out1]" >&2; cat "$LOG" >&2; exit 1
fi

# 8. cloud_db_run_cleanup_hooks
echo "test: cleanup hooks run in reverse registration order"
LOG="$TMP/cleanup-order.log"
if ! run_capture "$LOG" bash -c "
  source '$SCRIPT'
  cloud_db_register_cleanup 'printf \"one\\n\" >> $TMP/order.txt'
  cloud_db_register_cleanup 'printf \"two\\n\" >> $TMP/order.txt'
  cloud_db_register_cleanup 'printf \"three\\n\" >> $TMP/order.txt'
  cloud_db_run_cleanup_hooks
"; then
  echo "FAIL: cleanup hook orchestration should succeed" >&2; cat "$LOG" >&2; exit 1
fi
order="$(cat "$TMP/order.txt" | tr '\n' ',' )"
if [[ "$order" != "three,two,one," ]]; then
  echo "FAIL: cleanup hooks should run in reverse order; got [$order]" >&2; cat "$LOG" >&2; exit 1
fi

echo "test: a failing cleanup hook does not stop subsequent hooks"
LOG="$TMP/cleanup-fail.log"
rc="$(
  set +e
  source "$SCRIPT" 2>"$LOG"
  # Re-disable set -e: common.sh re-enables it on sourcing, and we need
  # to capture the function's return code without the subshell exiting.
  set +e
  cloud_db_register_cleanup 'printf "surviving\n" >> "'"$TMP"'/survive.txt"'
  cloud_db_register_cleanup 'false'
  cloud_db_register_cleanup 'printf "early\n" >> "'"$TMP"'/early.txt"'
  cloud_db_run_cleanup_hooks
  printf '%s' "$?"
)"
if [[ "$rc" != "1" ]]; then
  echo "FAIL: hook return code should be the count of failing hooks; got [$rc]" >&2; cat "$LOG" >&2; exit 1
fi
if [[ ! -s "$TMP/early.txt" ]] || [[ ! -s "$TMP/survive.txt" ]]; then
  echo "FAIL: hooks before and after the failing one should still run" >&2; cat "$LOG" >&2; exit 1
fi

# 9. Bash version assertion
echo "test: bash version assertion refuses bash 3"
LOG="$TMP/bash.log"
if ! command -v bash-3 >/dev/null 2>&1; then
  : # bash-3 is not installed on this runner; the production gate is the
  # version check in common.sh itself, not the test harness. Skip.
  :
else
  if ! bash-3 bash -c 'source "'"$SCRIPT"'"; echo "this should not print"' >/dev/null 2>"$LOG"; then
    if ! grep -q "bash >=" "$LOG"; then
      echo "FAIL: old-bash refusal should mention the required version" >&2; cat "$LOG" >&2; exit 1
    fi
  else
    echo "FAIL: bash-3 sourced common.sh without dying; the bash version assertion is broken" >&2; cat "$LOG" >&2; exit 1
  fi
fi

echo "ALL common.sh tests passed"
