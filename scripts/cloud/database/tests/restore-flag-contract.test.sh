#!/usr/bin/env bash
# shellcheck shell=bash
# restore-flag-contract.test.sh — regression guard for task 020f423e.
#
# THE DEFECT. drill.sh orchestrates the production database cutover: it
# drops the destination schemas with cleanup-destination.sh and then
# restores the archive with restore.sh. The two scripts spell the
# schema-owner option DIFFERENTLY:
#
#   cleanup-destination.sh   --dest-owner-dsn-file
#   restore.sh                --destination-owner-dsn-file
#
# drill.sh built ONE flag array and forwarded it to both. The
# cleanup-destination.sh spelling therefore reached restore.sh, which
# hard-refuses an unknown argument — so the drill died AT THE RESTORE
# STEP, AFTER cleanup-destination.sh had already dropped both
# destination schemas. The destination was left empty with no restore:
# the production schemas existed but the migrations behind them did
# not, and the operator had to restore them by hand.
#
# WHY IT MATTERS. In the production profile the schemas are owned by the
# database owner role and CREATE SCHEMA is an owner-only statement, so
# the owner DSN is REQUIRED for the restore to create the schemas with
# the approved owner. Dropping it is not a cosmetic difference: without
# it the service role creates — and therefore owns — its own schema,
# which is a topology change nobody approved.
#
# THE CONTRACT, PINNED HERE.
#   1. The flag drill.sh forwards to restore.sh for the schema owner is
#      accepted by restore.sh (the defect above was invisible until a
#      production run).
#   2. Each destination script receives its OWN spelling: the restore
#      invocation references the restore-owned array, the cleanup
#      invocation references the cleanup-owned array.
#   3. restore.sh does not accept cleanup-destination.sh's spelling, so
#      the mismatch cannot creep back in unnoticed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(dirname "$SCRIPT_DIR")"

DRILL="$DB_DIR/drill.sh"
RESTORE="$DB_DIR/restore.sh"
CLEANUP="$DB_DIR/cleanup-destination.sh"

failures=0
pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; failures=$((failures + 1)); }

# The flags a script documents in its usage() text.
documented_flags() {
  sed -n '/^usage() {/,/^}/p' "$1" \
    | grep -o -- '--[a-z][a-z0-9-]*' \
    | sort -u
}

# The body of a drill.sh invocation block for the script named by the
# pattern. The block runs from the line naming the script to the
# closing paren, or to the redirection that ends the substitution.
invocation_block() {
  awk -v pat="$1" '
    $0 ~ pat && $0 !~ /^[[:space:]]*#/ { inblock = 1 }
    inblock { print }
    inblock && ($0 ~ /^[[:space:]]*\)/ || $0 ~ />[[:space:]]*\/dev\/null/) { inblock = 0 }
  ' "$DRILL"
}

# The literal flags drill.sh passes in the matched invocation block.
passed_literal_flags() {
  invocation_block "$1" | grep -o -- '--[a-z][a-z0-9-]*' | sort -u
}

# The flag name drill.sh builds a named flag array with.
array_flag() {
  grep -o "$1=(--[a-z0-9-]*" "$DRILL" \
    | grep -o -- '--[a-z][a-z0-9-]*' \
    | head -1
}

restore_documented="$(documented_flags "$RESTORE")"
cleanup_documented="$(documented_flags "$CLEANUP")"

# ---------------------------------------------------------------------------
# 1. Every literal flag drill.sh passes to a destination script is
#    accepted by that script.
# ---------------------------------------------------------------------------

restore_block="$(invocation_block 'restore\.sh"')"
cleanup_block="$(invocation_block 'cleanup-destination\.sh"')"

if [[ -z "$restore_block" ]]; then
  fail "could not find the restore.sh invocation block in drill.sh"
else
  while read -r flag; do
    [[ -z "$flag" ]] && continue
    if grep -qx -- "$flag" <<<"$restore_documented"; then
      pass "restore.sh accepts $flag, which drill.sh passes it"
    else
      fail "restore.sh does NOT accept $flag, but drill.sh passes it"
    fi
  done <<<"$(passed_literal_flags 'restore\.sh"')"
fi

if [[ -z "$cleanup_block" ]]; then
  fail "could not find the cleanup-destination.sh invocation block in drill.sh"
else
  while read -r flag; do
    [[ -z "$flag" ]] && continue
    if grep -qx -- "$flag" <<<"$cleanup_documented"; then
      pass "cleanup-destination.sh accepts $flag, which drill.sh passes it"
    else
      fail "cleanup-destination.sh does NOT accept $flag, but drill.sh passes it"
    fi
  done <<<"$(passed_literal_flags 'cleanup-destination\.sh"')"
fi

# ---------------------------------------------------------------------------
# 2. The schema-owner DSN reaches restore.sh under a name restore.sh
#    accepts. The flag arrives through a flag ARRAY, so the array is
#    resolved here rather than read off the invocation line.
# ---------------------------------------------------------------------------

restore_owner_array="$(
  grep -o '[A-Z_]*OWNER_FLAGS' <<<"$restore_block" \
    | sort -u \
    | head -1
)"

if [[ -z "$restore_owner_array" ]]; then
  fail "drill.sh's restore.sh invocation forwards no schema-owner flag array"
else
  restore_owner_flag="$(array_flag "$restore_owner_array")"
  if [[ -z "$restore_owner_flag" ]]; then
    fail "drill.sh's $restore_owner_array array is built with no flag"
  elif grep -qx -- "$restore_owner_flag" <<<"$restore_documented"; then
    pass "restore.sh accepts the schema-owner flag drill.sh forwards it ($restore_owner_flag)"
  else
    fail "drill.sh forwards $restore_owner_flag to restore.sh, which restore.sh does NOT accept"
  fi
fi

cleanup_owner_array="$(
  grep -o '[A-Z_]*OWNER_FLAGS' <<<"$cleanup_block" \
    | sort -u \
    | head -1
)"

if [[ -z "$cleanup_owner_array" ]]; then
  fail "drill.sh's cleanup-destination.sh invocation forwards no schema-owner flag array"
else
  cleanup_owner_flag="$(array_flag "$cleanup_owner_array")"
  if [[ -z "$cleanup_owner_flag" ]]; then
    fail "drill.sh's $cleanup_owner_array array is built with no flag"
  elif grep -qx -- "$cleanup_owner_flag" <<<"$cleanup_documented"; then
    pass "cleanup-destination.sh accepts the schema-owner flag drill.sh forwards it ($cleanup_owner_flag)"
  else
    fail "drill.sh forwards $cleanup_owner_flag to cleanup-destination.sh, which it does NOT accept"
  fi
fi

# The two scripts must not be handed each other's spelling.
if grep -qx -- '--dest-owner-dsn-file' <<<"$restore_documented"; then
  fail "restore.sh accepts --dest-owner-dsn-file, so the two spellings can be mixed up again"
else
  pass "restore.sh does not accept cleanup-destination.sh's --dest-owner-dsn-file spelling"
fi

if grep -qx -- '--destination-owner-dsn-file' <<<"$cleanup_documented"; then
  fail "cleanup-destination.sh accepts --destination-owner-dsn-file, so the two spellings can be mixed up again"
else
  pass "cleanup-destination.sh does not accept restore.sh's --destination-owner-dsn-file spelling"
fi

if [[ "$failures" -gt 0 ]]; then
  printf 'restore-flag-contract: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'restore-flag-contract: ok\n'
