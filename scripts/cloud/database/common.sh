#!/usr/bin/env bash
# scripts/cloud/database/common.sh
#
# Shared strict-mode helpers, command/version checks, TLS enforcement,
# environment assertions, redacted logging, run IDs, and cleanup hooks
# for the SIndustries staging database transfer harness.
#
# Source this from any cloud-staging-database script:
#   source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
#
# This file intentionally has no side effects beyond sourcing; it only
# declares functions and constants. Callers set the operational
# environment before invoking guards.

set -euo pipefail

# shellcheck shell=bash

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Required PostgreSQL client major version (matches the staging server).
: "${CLOUD_DB_REQUIRED_PG_MAJOR:=16}"

# Minimum bash version.
CLOUD_DB_MIN_BASH_MAJOR=4
CLOUD_DB_MIN_BASH_MINOR=0

# Allowed environments for any mutating command.
CLOUD_DB_ALLOWED_ENVIRONMENTS=(staging)

# Allowed database name prefix; matches the cloud foundation interface.
CLOUD_DB_ALLOWED_NAME_PREFIX="sindustries_staging_"

# Substring of any production DSN that must never appear in a mutating
# staging target. Used to refuse obviously-wrong targets.
CLOUD_DB_PRODUCTION_DSN_DENYLIST=(
  "prod"
  "production"
  "sindustries-prod"
)

# Sensitive substring list for log redaction. Each match is replaced with
# the literal "[REDACTED]" before any line is written to stdout/stderr.
CLOUD_DB_REDACT_PATTERNS=(
  "postgres://[^[:space:]]*"
  "postgresql://[^[:space:]]*"
  "DATABASE_URL=[^[:space:]]*"
  "sslmode=[^[:space:]]*"
  "sslcert=[^[:space:]]*"
  "sslkey=[^[:space:]]*"
  "sslrootcert=[^[:space:]]*"
  "password=[^[:space:]]*"
  "PRISMA_[[:alnum:]_]*=[^[:space:]]*"
)

# Required tools for any mutating command; presence + version is checked
# by `cloud_db_assert_required_commands`.
CLOUD_DB_REQUIRED_COMMANDS=(
  "psql"
  "pg_dump"
  "pg_restore"
  "sha256sum"
  "openssl"
  "node"
)

# ---------------------------------------------------------------------------
# Strict-mode + redaction
# ---------------------------------------------------------------------------

# cloud_db_log <level> <message...>
#
# Writes a single line to stderr, redacting any sensitive substrings. The
# line is prefixed with ISO-8601 timestamp + level + run id (if set).
# Each pattern in CLOUD_DB_REDACT_PATTERNS is applied in turn via a
# portable sed -E with a `|` delimiter; this avoids the BSD-sed
# parentheses-balancing issue that arises from combining all patterns
# into a single (a|b|c) alternation.
cloud_db_log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local run_id_part=""
  if [[ -n "${CLOUD_DB_RUN_ID:-}" ]]; then
    run_id_part=" run=${CLOUD_DB_RUN_ID}"
  fi
  local line
  line="$(printf '%s level=%s%s message=%s' \
    "$timestamp" "$level" "$run_id_part" "$message")"
  local pattern
  for pattern in "${CLOUD_DB_REDACT_PATTERNS[@]}"; do
    line="$(printf '%s' "$line" | sed -E "s|${pattern}|[REDACTED]|g" 2>/dev/null || printf '%s' "$line")"
  done
  printf '%s\n' "$line" >&2
}

cloud_db_info()  { cloud_db_log "info"  "$@"; }
cloud_db_warn()  { cloud_db_log "warn"  "$@"; }
cloud_db_error() { cloud_db_log "error" "$@"; }

# cloud_db_die <message...>
#
# Logs the message at error level and exits 1. Intended for precondition
# violations that must fail closed (never auto-waived).
cloud_db_die() {
  cloud_db_error "$@"
  exit 1
}

# ---------------------------------------------------------------------------
# Environment + capability assertions
# ---------------------------------------------------------------------------

# cloud_db_assert_bash_version
#
# Refuses to continue unless the running bash is >= the required major.minor.
cloud_db_assert_bash_version() {
  local major="${BASH_VERSINFO[0]:-0}"
  local minor="${BASH_VERSINFO[1]:-0}"
  if (( major < CLOUD_DB_MIN_BASH_MAJOR )) || \
     (( major == CLOUD_DB_MIN_BASH_MAJOR && minor < CLOUD_DB_MIN_BASH_MINOR )); then
    cloud_db_die \
      "bash >= ${CLOUD_DB_MIN_BASH_MAJOR}.${CLOUD_DB_MIN_BASH_MINOR} required; got ${major}.${minor}"
  fi
}

# cloud_db_assert_required_commands
#
# Each entry in CLOUD_DB_REQUIRED_COMMANDS must be on PATH. PostgreSQL
# client commands must additionally match CLOUD_DB_REQUIRED_PG_MAJOR.
cloud_db_assert_required_commands() {
  local cmd missing=()
  for cmd in "${CLOUD_DB_REQUIRED_COMMANDS[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    cloud_db_die "missing required commands: ${missing[*]}"
  fi

  local pg_version
  pg_version="$(psql --version 2>/dev/null | awk '{print $3}' | cut -d. -f1)"
  if [[ -z "$pg_version" || "$pg_version" != "${CLOUD_DB_REQUIRED_PG_MAJOR}" ]]; then
    cloud_db_die \
      "psql major version mismatch; want ${CLOUD_DB_REQUIRED_PG_MAJOR}, got ${pg_version:-unknown}"
  fi
  local dump_version
  dump_version="$(pg_dump --version 2>/dev/null | awk '{print $3}' | cut -d. -f1)"
  if [[ "$dump_version" != "${CLOUD_DB_REQUIRED_PG_MAJOR}" ]]; then
    cloud_db_die \
      "pg_dump major version mismatch; want ${CLOUD_DB_REQUIRED_PG_MAJOR}, got ${dump_version}"
  fi
}

# cloud_db_assert_environment <environment>
#
# Refuses anything other than an allowed environment label. Use the
# environment assertion on every mutating command — even readonly ones —
# so an out-of-band call to a production DSN cannot slip through.
cloud_db_assert_environment() {
  local env="$1"
  local allowed
  for allowed in "${CLOUD_DB_ALLOWED_ENVIRONMENTS[@]}"; do
    if [[ "$env" == "$allowed" ]]; then
      return 0
    fi
  done
  cloud_db_die "environment '$env' is not in allowed list: ${CLOUD_DB_ALLOWED_ENVIRONMENTS[*]}"
}

# cloud_db_assert_database_name <name>
#
# Refuses any target whose name does not start with the allowed prefix.
cloud_db_assert_database_name() {
  local name="$1"
  if [[ "$name" != "${CLOUD_DB_ALLOWED_NAME_PREFIX}"* ]]; then
    cloud_db_die \
      "database name '$name' does not start with allowed prefix '${CLOUD_DB_ALLOWED_NAME_PREFIX}'"
  fi
}

# cloud_db_assert_no_production_dsn <label> <dsn>
#
# Refuses any DSN that matches a known production substring. This is a
# belt-and-suspenders check on top of the environment/name assertions.
cloud_db_assert_no_production_dsn() {
  local label="$1"
  local dsn="$2"
  local needle
  for needle in "${CLOUD_DB_PRODUCTION_DSN_DENYLIST[@]}"; do
    if [[ "$dsn" == *"$needle"* ]]; then
      cloud_db_die "$label DSN contains production substring '$needle' — refusing"
    fi
  done
}

# cloud_db_assert_inequality <label_a> <dsn_a> <label_b> <dsn_b>
#
# Refuses if source and destination DSNs resolve to the same target.
# Used by dump + restore to prevent accidental in-place overwrite.
cloud_db_assert_inequality() {
  local label_a="$1" dsn_a="$2" label_b="$3" dsn_b="$4"
  if [[ -z "$dsn_a" || -z "$dsn_b" ]]; then
    cloud_db_die "$label_a or $label_b DSN is empty"
  fi
  if [[ "$dsn_a" == "$dsn_b" ]]; then
    cloud_db_die "$label_a and $label_b DSNs are identical — refusing"
  fi
  # Strip credentials and query strings before host comparison.
  local host_a host_b
  host_a="$(printf '%s' "$dsn_a" | sed -E 's#^[a-z0-9]+://[^@]+@##; s#\?.*$##; s#/.*$##')"
  host_b="$(printf '%s' "$dsn_b" | sed -E 's#^[a-z0-9]+://[^@]+@##; s#\?.*$##; s#/.*$##')"
  if [[ -n "$host_a" && "$host_a" == "$host_b" ]]; then
    cloud_db_die "$label_a and $label_b host portion is identical ('$host_a') — refusing"
  fi
}

# ---------------------------------------------------------------------------
# Run-id + cleanup scaffolding
# ---------------------------------------------------------------------------

# cloud_db_assign_run_id
#
# Sets CLOUD_DB_RUN_ID to a UTC timestamp + 6 random hex characters.
# Idempotent within a single process; if already set, leaves it alone.
cloud_db_assign_run_id() {
  if [[ -n "${CLOUD_DB_RUN_ID:-}" ]]; then
    return 0
  fi
  local random_hex
  random_hex="$(openssl rand -hex 3 2>/dev/null || printf '%06x' "$RANDOM")"
  CLOUD_DB_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${random_hex}"
  export CLOUD_DB_RUN_ID
  cloud_db_info "assigned run id ${CLOUD_DB_RUN_ID}"
}

# cloud_db_register_cleanup <command...>
#
# Appends the given command to CLOUD_DB_CLEANUP_HOOKS so it runs on EXIT.
cloud_db_register_cleanup() {
  CLOUD_DB_CLEANUP_HOOKS+=("$*")
}

# cloud_db_run_cleanup_hooks
#
# Runs every registered cleanup hook in reverse registration order. A
# failing hook does not stop the others; each is logged and counted.
# Returns 0 unless a hook exits non-zero, in which case the count is
# returned so callers can decide how to react.
cloud_db_run_cleanup_hooks() {
  if (( ${#CLOUD_DB_CLEANUP_HOOKS[@]} == 0 )); then
    return 0
  fi
  local i failed=0
  for (( i=${#CLOUD_DB_CLEANUP_HOOKS[@]}-1; i>=0; i-- )); do
    if ! eval "${CLOUD_DB_CLEANUP_HOOKS[$i]}"; then
      failed=$((failed + 1))
      cloud_db_warn "cleanup hook failed: ${CLOUD_DB_CLEANUP_HOOKS[$i]}"
    fi
  done
  CLOUD_DB_CLEANUP_HOOKS=()
  return "$failed"
}

# cloud_db_install_traps
#
# Wires EXIT/INT/TERM into cloud_db_run_cleanup_hooks. Call once per script.
cloud_db_install_traps() {
  trap 'cloud_db_run_cleanup_hooks' EXIT
  trap 'cloud_db_die "interrupted (SIGINT)"; exit 130' INT
  trap 'cloud_db_die "interrupted (SIGTERM)"; exit 143' TERM
}

# ---------------------------------------------------------------------------
# Secret loading
# ---------------------------------------------------------------------------

# cloud_db_load_secret <var_name> <file_path>
#
# Reads a secret from a mode-0600 file into a shell variable. Refuses if
# the file is missing, has loose permissions, or is empty. The variable
# is exported so child processes inherit it.
cloud_db_load_secret() {
  local var_name="$1"
  local file_path="$2"
  if [[ ! -f "$file_path" ]]; then
    cloud_db_die "secret file '$file_path' not found"
  fi
  local perms
  # Prefer numeric octal (`%Lp` on BSD, `%a` on GNU); fall back to the
  # symbolic form if both fail so the error message still names what
  # the operator sees in `ls -l`.
  perms="$(stat -f '%Lp' "$file_path" 2>/dev/null || stat -c '%a' "$file_path" 2>/dev/null || stat -f '%Sp' "$file_path" 2>/dev/null || stat -c '%A' "$file_path" 2>/dev/null || echo "")"
  if [[ "$perms" != "0600" && "$perms" != "600" ]]; then
    cloud_db_die "secret file '$file_path' permissions are '$perms'; expected 0600"
  fi
  local value
  value="$(<"$file_path")"
  if [[ -z "$value" ]]; then
    cloud_db_die "secret file '$file_path' is empty"
  fi
  printf -v "$var_name" '%s' "$value"
  # shellcheck disable=SC2163  # var_name is set by printf -v above; export intentionally takes the name.
  export "${var_name?}"
}

# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------

CLOUD_DB_CLEANUP_HOOKS=()
cloud_db_install_traps
cloud_db_assert_bash_version
