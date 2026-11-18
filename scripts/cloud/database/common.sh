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
: "${CLOUD_DB_REQUIRED_PG_MAJOR:=18}"

# Minimum bash version.
CLOUD_DB_MIN_BASH_MAJOR=4
CLOUD_DB_MIN_BASH_MINOR=0

# Allowed environments for any mutating command. Each environment has a
# profile (see cloud_db_resolve_environment) that decides the artifact
# directory, the envelope kind prefix, the database-name rule and the
# target guard.
#
# `staging` is the conservative default and behaves exactly as it always
# has. `production` is the profile the production cutover runs through:
# it is NOT a licence to touch production — the production profile adds
# its own, stricter guards (declared endpoint allowlist + a second
# acknowledgement key that cannot come from the command line).
CLOUD_DB_ENVIRONMENTS=(staging production)

# Staging profile: the database-name prefix a staging destination must
# carry, and the substrings that must never appear in a staging DSN.
CLOUD_DB_STAGING_NAME_PREFIX="sindustries_staging_"

# Substring of any production DSN that must never appear in a mutating
# staging target. Used to refuse obviously-wrong targets.
CLOUD_DB_PRODUCTION_DSN_DENYLIST=(
  "prod"
  "production"
  "sindustries-prod"
)

# Production profile: the environment variable that carries the second
# acknowledgement key for a production run. It must be set in the
# environment, never passed on the command line, so a mistyped command
# alone can never start a production run.
CLOUD_DB_PRODUCTION_ACK_ENV="CLOUD_DB_PRODUCTION_ACK"

# Active profile state. Populated by cloud_db_resolve_environment; the
# defaults below are the staging profile, which is also the profile a
# bare `source common.sh` leaves behind.
CLOUD_DB_ENVIRONMENT="staging"
CLOUD_DB_ARTIFACT_DIR="./artifacts/cloud-staging"
CLOUD_DB_KIND_PREFIX="cloud-staging"
CLOUD_DB_NAME_PREFIX="$CLOUD_DB_STAGING_NAME_PREFIX"

# Endpoint / database allowlists for the current run. Populated by
# --expected-host / --expected-database, or by the CLOUD_DB_EXPECTED_HOSTS
# / CLOUD_DB_EXPECTED_DATABASES environment variables.
CLOUD_DB_TARGET_HOSTS=()
CLOUD_DB_TARGET_DATABASES=()

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
#
# `production` is an allowed label because the production cutover runs
# through this same harness. The label alone grants nothing: the
# production profile's own guards (cloud_db_assert_target_dsn and
# cloud_db_assert_production_ack) are strictly stricter than staging's.
cloud_db_assert_environment() {
  local env="$1"
  local allowed
  for allowed in "${CLOUD_DB_ENVIRONMENTS[@]}"; do
    if [[ "$env" == "$allowed" ]]; then
      return 0
    fi
  done
  cloud_db_die "environment '$env' is not in allowed list: ${CLOUD_DB_ENVIRONMENTS[*]}"
}

# cloud_db_resolve_environment <environment>
#
# Loads the profile for an environment label: artifact directory, envelope
# kind prefix, database-name rule, and target-guard mode.
#
# The production Neon branch database is named `neondb` — the same name
# staging uses — so a database-name prefix CANNOT identify a production
# target. The production profile therefore carries no name prefix and
# identifies its target by declared endpoint instead (see
# cloud_db_assert_target_dsn).
cloud_db_resolve_environment() {
  local env="$1"
  case "$env" in
    staging)
      CLOUD_DB_ENVIRONMENT="staging"
      CLOUD_DB_ARTIFACT_DIR="./artifacts/cloud-staging"
      CLOUD_DB_KIND_PREFIX="cloud-staging"
      CLOUD_DB_NAME_PREFIX="$CLOUD_DB_STAGING_NAME_PREFIX"
      ;;
    production)
      CLOUD_DB_ENVIRONMENT="production"
      # shellcheck disable=SC2034  # profile state is consumed by the scripts that source this file.
      CLOUD_DB_ARTIFACT_DIR="./artifacts/cloud-production"
      # shellcheck disable=SC2034  # profile state is consumed by the scripts that source this file.
      CLOUD_DB_KIND_PREFIX="cloud-production"
      CLOUD_DB_NAME_PREFIX=""
      ;;
    *)
      cloud_db_die "unknown environment profile '$env'"
      ;;
  esac
}

# cloud_db_set_environment <environment>
#
# Asserts the environment label is allowed and loads its profile in one
# step. Every script that touches a database calls this before any other
# guard, so the profile is always resolved before it is consulted.
cloud_db_set_environment() {
  cloud_db_assert_environment "$1"
  cloud_db_resolve_environment "$1"
}

# cloud_db_dsn_host <dsn>
#
# Extracts the host[:port] portion of a DSN, with credentials, path and
# query string stripped. The DSN itself is never logged.
cloud_db_dsn_host() {
  printf '%s' "$1" | sed -E 's#^[a-z0-9]+://[^@]+@##; s#\?.*$##; s#/.*$##'
}

# cloud_db_dsn_database <dsn>
#
# Extracts the database name (the path component) of a DSN.
cloud_db_dsn_database() {
  printf '%s' "$1" | sed -E 's#^[a-z0-9]+://[^@]+@[^/]+/##; s#\?.*$##'
}

# cloud_db_add_expected_host <host>
#
# Declares an endpoint this run is allowed to touch. Repeatable. Hosts
# are compared host[:port] against the DSN's host[:port], so the port
# matters: `db.internal` and `db.internal:5432` are different entries.
cloud_db_add_expected_host() {
  local host="$1"
  if [[ -z "$host" ]]; then
    cloud_db_die "an expected host must not be empty"
  fi
  CLOUD_DB_TARGET_HOSTS+=("$host")
}

# cloud_db_add_expected_database <name>
#
# Declares a database name this run is allowed to touch. Repeatable.
cloud_db_add_expected_database() {
  local name="$1"
  if [[ -z "$name" ]]; then
    cloud_db_die "an expected database name must not be empty"
  fi
  CLOUD_DB_TARGET_DATABASES+=("$name")
}

# cloud_db_load_expected_targets_from_env
#
# Reads CLOUD_DB_EXPECTED_HOSTS and CLOUD_DB_EXPECTED_DATABASES
# (comma- or space-separated) into the allowlists when the matching flag
# was not supplied. Command-line flags win over the environment.
cloud_db_load_expected_targets_from_env() {
  local raw item
  if (( ${#CLOUD_DB_TARGET_HOSTS[@]} == 0 )); then
    raw="${CLOUD_DB_EXPECTED_HOSTS:-}"
    raw="${raw//,/ }"
    for item in $raw; do
      CLOUD_DB_TARGET_HOSTS+=("$item")
    done
  fi
  if (( ${#CLOUD_DB_TARGET_DATABASES[@]} == 0 )); then
    raw="${CLOUD_DB_EXPECTED_DATABASES:-}"
    raw="${raw//,/ }"
    for item in $raw; do
      CLOUD_DB_TARGET_DATABASES+=("$item")
    done
  fi
}

# cloud_db_assert_database_name <name>
#
# Refuses any target whose name does not satisfy the active profile's
# name rule.
#
#   staging    — the name must carry the staging prefix.
#   production — the production Neon database is named `neondb`, so there
#                is no production prefix to require. The production rule
#                is the inverse: refuse the STAGING prefix, which is the
#                cross-environment bleed this guard exists to stop.
cloud_db_assert_database_name() {
  local name="$1"
  if [[ -n "$CLOUD_DB_NAME_PREFIX" ]]; then
    if [[ "$name" != "${CLOUD_DB_NAME_PREFIX}"* ]]; then
      cloud_db_die \
        "database name '$name' does not start with allowed prefix '${CLOUD_DB_NAME_PREFIX}'"
    fi
    return 0
  fi
  if [[ "$name" == "${CLOUD_DB_STAGING_NAME_PREFIX}"* ]]; then
    cloud_db_die \
      "database name '$name' carries the staging prefix; refusing in a production run"
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

# cloud_db_assert_target_dsn <label> <dsn>
#
# Environment-scoped guard on the endpoint a command is about to touch.
#
#   staging    — refuses any DSN carrying a production marker, and
#                refuses any host outside the declared endpoint allowlist
#                when one was declared. This is the behaviour the staging
#                drill has always had.
#   production — the endpoint allowlist is REQUIRED: the operator must
#                name every endpoint the run may touch, because the
#                production Neon database is named `neondb` and cannot be
#                identified by name. A staging-prefixed database name is
#                refused outright.
#
# The optional database-name allowlist applies in both environments.
cloud_db_assert_target_dsn() {
  local label="$1"
  local dsn="$2"
  local host db needle allowed found

  host="$(cloud_db_dsn_host "$dsn")"
  db="$(cloud_db_dsn_database "$dsn")"

  if [[ "$CLOUD_DB_ENVIRONMENT" == "staging" ]]; then
    cloud_db_assert_no_production_dsn "$label" "$dsn"
  else
    if (( ${#CLOUD_DB_TARGET_HOSTS[@]} == 0 )); then
      cloud_db_die \
        "production runs must declare the endpoints they may touch (--expected-host / CLOUD_DB_EXPECTED_HOSTS); refusing"
    fi
    if [[ "$db" == "${CLOUD_DB_STAGING_NAME_PREFIX}"* ]]; then
      cloud_db_die \
        "$label database '$db' carries the staging prefix; refusing in a production run"
    fi
  fi

  if (( ${#CLOUD_DB_TARGET_HOSTS[@]} > 0 )); then
    found=0
    for allowed in "${CLOUD_DB_TARGET_HOSTS[@]}"; do
      if [[ "$host" == "$allowed" ]]; then
        found=1
        break
      fi
    done
    if (( found == 0 )); then
      cloud_db_die \
        "$label host '$host' is not in the declared endpoint allowlist: ${CLOUD_DB_TARGET_HOSTS[*]}"
    fi
  fi

  if (( ${#CLOUD_DB_TARGET_DATABASES[@]} > 0 )); then
    found=0
    for allowed in "${CLOUD_DB_TARGET_DATABASES[@]}"; do
      if [[ "$db" == "$allowed" ]]; then
        found=1
        break
      fi
    done
    if (( found == 0 )); then
      cloud_db_die \
        "$label database '$db' is not in the declared database allowlist: ${CLOUD_DB_TARGET_DATABASES[*]}"
    fi
  fi
}

# cloud_db_assert_production_ack
#
# Two-key auth for production runs. The caller already asked for the
# production profile explicitly; this second key must come from the
# environment (CLOUD_DB_PRODUCTION_ACK=1), so a command line on its own
# can never start a production run.
cloud_db_assert_production_ack() {
  if [[ "$CLOUD_DB_ENVIRONMENT" != "production" ]]; then
    return 0
  fi
  if [[ "${CLOUD_DB_PRODUCTION_ACK:-0}" != "1" ]]; then
    cloud_db_die \
      "production runs require ${CLOUD_DB_PRODUCTION_ACK_ENV}=1 in the environment (two-key auth with --environment production)"
  fi
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
  host_a="$(cloud_db_dsn_host "$dsn_a")"
  host_b="$(cloud_db_dsn_host "$dsn_b")"
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
  # Prefer numeric octal (`%a` on GNU, `%Lp` on BSD); fall back to the
  # symbolic form if both fail so the error message still names what
  # the operator sees in `ls -l`.
  # GNU stat accepts `-f` as a filesystem-stat option, so trying the BSD
  # form first can return a multi-line filesystem report instead of failing
  # and prevent the GNU branch from ever running on Ubuntu.
  perms="$(stat -c '%a' "$file_path" 2>/dev/null || stat -f '%Lp' "$file_path" 2>/dev/null || stat -f '%Sp' "$file_path" 2>/dev/null || stat -c '%A' "$file_path" 2>/dev/null || echo "")"
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

# Default profile: staging. A script that targets production resolves
# the production profile explicitly (cloud_db_set_environment) before any
# guard runs, so this default only affects a bare `source common.sh`.
cloud_db_resolve_environment "staging"
