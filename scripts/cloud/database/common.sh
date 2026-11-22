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
# cloud_db_assert_recovery_isolation <source-host> <destination-host> <recovery-host> <label>
#
# The recovery target proves that a verified backup restores into a
# usable state, so it must be a database of its own:
#
#   * NOT the destination — restoring the archive into the destination
#     and then reconciling the destination against itself produces
#     evidence that looks green and proves nothing.
#   * NOT the source — the source stays authoritative until the
#     observation period ends, and it is the rollback target. A recovery
#     DSN that pointed at the source would write the archive back over
#     it.
#
# The comparison is on the HOST, not on the DSN string: two DSNs that
# differ only in their credentials still address the same database.
cloud_db_assert_recovery_isolation() {
  local source_host="$1"
  local destination_host="$2"
  local recovery_host="$3"
  local label="$4"

  if [[ -z "$source_host" || -z "$destination_host" || -z "$recovery_host" ]]; then
    cloud_db_die "recovery isolation cannot be checked: a host is empty (source='$source_host' destination='$destination_host' recovery='$recovery_host')"
  fi
  if [[ "$recovery_host" == "$destination_host" ]]; then
    cloud_db_die "$label recovery target host '$recovery_host' is the destination's host — the recovery restore would reconcile the destination against itself; refusing"
  fi
  if [[ "$recovery_host" == "$source_host" ]]; then
    cloud_db_die "$label recovery target host '$recovery_host' is the source's host — the recovery restore would overwrite the rollback source; refusing"
  fi
}

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
# Cross-schema isolation
# ---------------------------------------------------------------------------
#
# The production topology gives each schema its own service role
# (`databaseServiceRoles` in
# infra/cloud/platform/platform-environments.mjs), and the platform's own
# `neon.service-role-scope` gate requires that each production service
# role can write only inside its own schema and holds no cross-schema
# access.
#
# THE PREDICATE IS `has_schema_privilege(current_user, <other schema>,
# 'USAGE')`, and it is deliberately the same predicate everywhere it is
# used. Two shapes of this question are easy to confuse, and they are NOT
# interchangeable:
#
#   * `has_schema_privilege` asks whether the role CAN reach the other
#     schema. That is the security question, and it is the one the
#     platform gate asks.
#   * `aclexplode(nspacl)` asks whether the other schema's EXPLICIT ACL
#     list mentions the role. That is a bookkeeping question.
#
# Measured against a reproduction of the production role model: the
# explicit ACL for `content_scheduler` named only its own owner role, so
# an explicit-ACL-only check read CLEAN, while the same role read AND
# wrote the other schema's rows. The reason is role membership — a role
# that is a member of a role carrying `pg_read_all_data` or
# `pg_write_all_data` holds USAGE, SELECT, INSERT, UPDATE and DELETE on
# every schema in the database, and NO explicit grant can withdraw it,
# because no explicit grant was the source.
#
# So the explicit-ACL view would report a green light on a live
# cross-schema write, and would silently disagree with the platform gate
# of the same name. The predicate below is `has_schema_privilege`, and it
# is shared by the pre-destructive preflight and the post-restore
# end-state assertion so the two cannot drift apart.
#
# ---------------------------------------------------------------------------
# Accepted cross-schema access (a recorded decision, not a default)
# ---------------------------------------------------------------------------
#
# Per-schema confinement is NOT enforceable in the production Neon role
# model, and that is now a recorded decision rather than an open
# question (task f2c23e26; Quinn recorded Tom's decision on
# 2026-11-23 07:25 NZDT).
#
# WHY THE ACCESS EXISTS. Both production service roles are members of
# `neon_superuser`, which carries `pg_read_all_data` and
# `pg_write_all_data`. A member of such a role holds USAGE — and read
# and write — on EVERY schema in the database, and no explicit GRANT can
# withdraw it, because no explicit grant was the source. The decision is
# to ACCEPT that shared access rather than revoke the membership, which
# would be a wider change to the production role model than the
# decision authorises.
#
# WHAT "ACCEPTED" IS NOT. It is not a switch that turns the assertion
# off. The assertion still runs, still computes the same predicate, and
# still refuses whenever the access it finds is not the accepted one.
# The acceptance is narrow on four axes:
#
#   1. it applies only to a PRODUCTION run. Staging keeps the strict
#      behaviour, and staging is single-role anyway.
#   2. it applies only when the recorded declaration names EXACTLY the
#      two roles this run is connecting as. A declaration for any other
#      pair does not apply, and the run refuses.
#   3. it requires a non-empty reason, so an acceptance is never an
#      unexplained widening.
#   4. it is reported loudly and recorded in the run envelope, so an
#      accepted run is distinguishable from an isolated one afterwards.
#
# The operator supplies the declaration:
#
#   CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES    two role names, comma separated
#   CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON   the decision that accepted it
#
# Those role names are the production topology's service roles, declared
# in infra/cloud/platform/platform-environments.mjs
# (`databaseServiceRoles` and `databaseServiceRoleSharedAccess`) and
# recorded as the `neon.service-role-scope` gate's accepted-shared-access
# evidence. The harness does not invent them: it matches the declaration
# against the roles the server says it is actually running as, and
# refuses when they are not the same pair.

# ---------------------------------------------------------------------------
# Schema DDL ownership
# ---------------------------------------------------------------------------
#
# The two production service roles do NOT own the production schemas:
# the schemas are owned by the database's owner role (`neondb_owner`).
# `DROP SCHEMA ... CASCADE` and `CREATE SCHEMA` are therefore owner-only
# statements, and running them as a service role fails closed with
# "must be owner of schema" — before anything is dropped, but the run
# cannot proceed either.
#
# So the destructive DDL runs through an OWNER connection while the
# service roles keep their own DML-scoped connections for the data load.
# The owner connection is optional: when it is not supplied the scripts
# behave exactly as before (the service role creates and owns its own
# schema), which is what the staging topology needs.

# cloud_db_grant_schema_access <owner_dsn> <schema> <role> <label>
#
# Grants the schema-level privileges a service role needs to load data
# into a schema it does not own: USAGE to resolve the schema, and
# CREATE to create objects inside it. A freshly created schema has no
# ACL of its own — `DROP SCHEMA ... CASCADE` took the previous grants
# with it — so without this the data load fails with "permission denied
# for schema".
#
# The grant is deliberately minimal and explicit: it names the schema
# and the role, it does not widen to `GRANT ALL`, and it does not touch
# any role membership. The accepted cross-schema access between the two
# production service roles comes from their membership of
# `neon_superuser`, not from this grant.
cloud_db_grant_schema_access() {
  local owner_dsn="$1" schema="$2" role="$3" label="$4" out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --variable=ON_ERROR_STOP=1 \
      --dbname="$owner_dsn" \
      --command="GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role};" \
      2>&1
  )" || cloud_db_die \
    "could not grant USAGE, CREATE on schema '${schema}' to role '${role}' (${label}): ${out}. The schema owner must be able to grant schema-level privileges to the service role that loads the data."
  cloud_db_info "granted USAGE, CREATE on schema '${schema}' to role '${role}' (${label})"
}

# cloud_db_assert_shared_access_declaration
#
# Validates the accepted-shared-access declaration. Called DIRECTLY (not
# in a command substitution) so that a malformed declaration stops the
# run: an acceptance that names roles without a reason, or a reason
# without roles, or more or fewer than two roles, is an unexplained
# widening of the assertion and must not be carried into a production
# run.
cloud_db_assert_shared_access_declaration() {
  local roles="${CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES:-}"
  local reason="${CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON:-}"

  if [[ -z "$roles" && -z "$reason" ]]; then
    return 0
  fi
  if [[ -z "$roles" ]]; then
    cloud_db_die \
      "CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON is set but CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES is not; an acceptance must name the role pair it accepts"
  fi
  if [[ -z "$reason" ]]; then
    cloud_db_die \
      "CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES is set but CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON is not; an acceptance must record why the shared access is accepted"
  fi

  local first second extra
  IFS=',' read -r first second extra <<<"$roles"
  first="$(printf '%s' "$first" | tr -d '[:space:]')"
  second="$(printf '%s' "$second" | tr -d '[:space:]')"
  if [[ -z "$first" || -z "$second" || -n "${extra:-}" ]]; then
    cloud_db_die \
      "CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES must be exactly two comma-separated role names; got '${roles}'"
  fi
  if [[ "$first" == "$second" ]]; then
    cloud_db_die \
      "CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES names the same role twice ('${first}'); an acceptance covers two DIFFERENT service roles"
  fi
}

# cloud_db_shared_access_acceptance_applies <role_a> <role_b>
#
# Whether the recorded acceptance covers exactly this pair of roles in
# this run. Returns 0 when it applies, 1 when it does not. Never dies:
# the caller reports the refusal with the direction-specific message.
cloud_db_shared_access_acceptance_applies() {
  local role_a="$1" role_b="$2"
  local roles="${CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES:-}"
  local accepted_a accepted_b

  if [[ -z "$roles" ]]; then
    return 1
  fi
  if [[ "${CLOUD_DB_ENVIRONMENT:-}" != "production" ]]; then
    cloud_db_info \
      "the recorded shared-access decision applies to production runs only; this run is '${CLOUD_DB_ENVIRONMENT:-unset}'"
    return 1
  fi
  IFS=',' read -r accepted_a accepted_b <<<"$roles"
  accepted_a="$(printf '%s' "$accepted_a" | tr -d '[:space:]')"
  accepted_b="$(printf '%s' "$accepted_b" | tr -d '[:space:]')"
  if { [[ "$accepted_a" == "$role_a" ]] && [[ "$accepted_b" == "$role_b" ]]; } || \
     { [[ "$accepted_a" == "$role_b" ]] && [[ "$accepted_b" == "$role_a" ]]; }; then
    return 0
  fi
  cloud_db_info \
    "the recorded shared-access decision names '${accepted_a},${accepted_b}', which is not this run's role pair ('${role_a}', '${role_b}'); it does not apply here"
  return 1
}

# cloud_db_connection_role <dsn>
#
# The role the SERVER says this connection runs as. Taken from the
# server rather than parsed out of the DSN: the DSN's userinfo is a
# claim, `current_user` is the fact.
cloud_db_connection_role() {
  local dsn="$1" role out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT current_user;" \
      2>&1
  )" || cloud_db_die "could not read the current role of the connection: ${out}"
  role="$(printf '%s' "$out" | awk '{print $1}')"
  printf '%s' "$role"
}

# cloud_db_schema_visible <dsn> <schema>
#
# Whether the schema is present. `has_schema_privilege` ERRORS on a
# schema that does not exist ("schema ... does not exist"), so a caller
# that asks about a schema's privileges has to know first.
cloud_db_schema_visible() {
  local dsn="$1" schema="$2" count out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT count(*) FROM pg_namespace WHERE nspname = '${schema}';" \
      2>&1
  )" || cloud_db_die "could not check whether schema '${schema}' is visible: ${out}"
  count="$(printf '%s' "$out" | tr -d '[:space:]')"
  [[ "${count:-0}" != "0" ]]
}

# cloud_db_schema_privilege <dsn> <schema> <privilege>
#
# Whether the role THIS CONNECTION runs as holds a privilege on a
# schema. `current_user` rather than an interpolated role name: psql
# does not substitute variables into a `--command` string (it only does
# so for `-f` files and standard input), so a `:'role'` placeholder
# reaches the server verbatim and the query fails.
#
# Prints `t` or `f`. Strict: a schema that does not exist makes the
# query fail, which is the correct outcome for an assertion about a
# schema the caller expects to be there.
cloud_db_schema_privilege() {
  local dsn="$1" schema="$2" priv="$3" result out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT has_schema_privilege(current_user, '${schema}', '${priv}');" \
      2>&1
  )" || cloud_db_die "could not read the ${priv} privilege of the connecting role on schema '${schema}': ${out}"
  result="$(printf '%s' "$out" | awk '{print $1}')"
  printf '%s' "${result:-f}"
}

# cloud_db_assert_cross_schema_isolation <tasks_dsn> <content_scheduler_dsn> <phase>
#
# Refuses unless the two destination service roles cannot reach across
# into each other's schema.
#
# `phase` names WHERE the check runs, and it is part of the message
# because the same predicate is asserted at two points on purpose:
#
#   * BEFORE the first destructive statement — the cross-schema access
#     implied by role membership is a property of the ROLES, and it is
#     knowable before anything is written. A mis-provisioned role model
#     therefore refuses the run with the destination untouched, instead
#     of aborting after the live schemas have been dropped and
#     recreated.
#   * AFTER the restore — the state the restore actually produced.
#
# A single-role environment is not subject to the assertion: staging
# genuinely restores both schemas with one role, and there is no "other"
# schema to reach across into.
cloud_db_assert_cross_schema_isolation() {
  local tasks_dsn="$1" content_scheduler_dsn="$2" phase="$3"
  local tasks_role content_scheduler_role privilege
  local cross_tasks_to_cs="f" cross_cs_to_tasks="f"

  tasks_role="$(cloud_db_connection_role "$tasks_dsn")"
  content_scheduler_role="$(cloud_db_connection_role "$content_scheduler_dsn")"

  if [[ "$tasks_role" == "$content_scheduler_role" ]]; then
    cloud_db_info \
      "${phase}: both destination connections run as role '${tasks_role}'; this environment uses one role for both schemas, so the cross-schema isolation assertion does not apply"
    CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE="not-applicable"
    export CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE
    return 0
  fi

  # The same predicate in both directions, computed before anything is
  # decided about it: an accepted access is still a REAL access, and the
  # run has to know which direction it is in order to report it.
  if cloud_db_schema_visible "$tasks_dsn" content_scheduler; then
    privilege="$(cloud_db_schema_privilege "$tasks_dsn" content_scheduler USAGE)"
    if [[ "$privilege" != "f" ]]; then cross_tasks_to_cs="t"; fi
  fi

  if cloud_db_schema_visible "$content_scheduler_dsn" tasks_api; then
    privilege="$(cloud_db_schema_privilege "$content_scheduler_dsn" tasks_api USAGE)"
    if [[ "$privilege" != "f" ]]; then cross_cs_to_tasks="t"; fi
  fi

  if [[ "$cross_tasks_to_cs" == "f" && "$cross_cs_to_tasks" == "f" ]]; then
    cloud_db_info \
      "${phase}: cross-schema isolation verified (roles '${tasks_role}' and '${content_scheduler_role}' hold no USAGE on each other's schema)"
    CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE="isolated"
    export CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE
    return 0
  fi

  # The access is real. It is ACCEPTED only by a recorded decision that
  # names exactly these two roles, in a production run, with a reason.
  if cloud_db_shared_access_acceptance_applies "$tasks_role" "$content_scheduler_role"; then
    cloud_db_warn \
      "${phase}: ACCEPTED cross-schema access between roles '${tasks_role}' and '${content_scheduler_role}' under the recorded decision: ${CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON:-}"
    CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE="accepted"
    CLOUD_DB_ACCEPTED_SHARED_ACCESS_APPLIED="${CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES:-}"
    export CLOUD_DB_CROSS_SCHEMA_ACCESS_STATE CLOUD_DB_ACCEPTED_SHARED_ACCESS_APPLIED
    return 0
  fi

  if [[ "$cross_tasks_to_cs" == "t" ]]; then
    cloud_db_die \
      "${phase}: cross-schema isolation assertion failed: role '${tasks_role}' holds USAGE on schema 'content_scheduler', which belongs to '${content_scheduler_role}'. The production topology confines each service role to its own schema, and the platform's own 'neon.service-role-scope' gate enforces that. This is a PROVISIONING gap in the destination role model, not something the restore can repair: a role that is a member of a role carrying pg_read_all_data or pg_write_all_data holds USAGE — and read and write — on EVERY schema in the database, and no explicit GRANT can withdraw it, because no explicit grant was the source. Fix the role model (revoke the membership), or record an explicit decision that per-schema isolation is not enforced in this environment. Do NOT narrow this check to the schemas' explicit ACLs: that view reads CLEAN while the access is real, and it would silently disagree with the platform gate of the same name."
  fi

  cloud_db_die \
    "${phase}: cross-schema isolation assertion failed: role '${content_scheduler_role}' holds USAGE on schema 'tasks_api', which belongs to '${tasks_role}'. The production topology confines each service role to its own schema, and the platform's own 'neon.service-role-scope' gate enforces that. This is a PROVISIONING gap in the destination role model, not something the restore can repair: a role that is a member of a role carrying pg_read_all_data or pg_write_all_data holds USAGE — and read and write — on EVERY schema in the database, and no explicit GRANT can withdraw it, because no explicit grant was the source. Fix the role model (revoke the membership), or record an explicit decision that per-schema isolation is not enforced in this environment. Do NOT narrow this check to the schemas' explicit ACLs: that view reads CLEAN while the access is real, and it would silently disagree with the platform gate of the same name."
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
cloud_db_read_secret_file() {
  local file_path="$1"
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
  printf '%s' "$value"
}

cloud_db_load_secret() {
  local var_name="$1"
  local file_path="$2"
  local value
  value="$(cloud_db_read_secret_file "$file_path")"
  printf -v "$var_name" '%s' "$value"
  # shellcheck disable=SC2163  # var_name is set by printf -v above; export intentionally takes the name.
  export "${var_name?}"
}

# cloud_db_dsn_host_from_file <path>
#
# Prints the host[:port] of the DSN in a mode-0600 secret file. The DSN
# itself is never placed in a variable or exported, so a caller that only
# needs a derived fact (which endpoint a credential points at) never has
# to hold the credential.
cloud_db_dsn_host_from_file() {
  cloud_db_dsn_host "$(cloud_db_read_secret_file "$1")"
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
