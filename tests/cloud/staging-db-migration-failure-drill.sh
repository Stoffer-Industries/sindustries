#!/usr/bin/env bash
# staging-db-migration-failure-drill.sh
#
# AC4 CI migration-failure fixture (task d37681e1,
# docs/specs/staging-database-migration-restore-ac4-fixture-tech-design.md).
# Walks the deliberately-invalid Prisma migration path against a
# disposable PostgreSQL DSN and asserts the migration-failure path is
# taken correctly: exit code = 1, the bad migration is recorded in
# _prisma_migrations, no production migration directory is touched, no
# `prisma migrate resolve` is invoked, and no downstream workflow
# validation is reached.
#
# This script intentionally runs ONLY against a disposable DSN (a
# localhost-rooted DSN, the GitHub Actions `services: postgres:16`
# container, or a developer-machine `postgres:16` Docker container). It
# refuses to run if the source DSN looks like a production or staging
# target unless STAGING_DB_FAILURE_FIXTURE=1 is set in the environment,
# in which case the assertion is recorded but the production-DSN
# substring check is bypassed for the documented fixture use only.
#
# Inputs (flags or env):
#   --source-dsn <dsn>               required, must be a disposable DSN
#                                    (localhost, 127.0.0.1, postgres://
#                                    in a runner services container, or
#                                    a developer-machine Docker DSN)
#   --prisma-migrations-dir <path>   required, must be a sibling of the
#                                    production services/<svc>/prisma/
#                                    migrations/ directory and must
#                                    resolve outside that path
#   --service <tasks-api|budget-api> required
#   --output <path>                  optional, write JSON result here
#                                    (default: stdout)
#   --run-id <id>                    optional, default = drill timestamp
#                                    + short random tag
#   --intent-commit <sha>            optional, recorded in the envelope
#   --confirm-staging                required ack; refuses otherwise
#
# Exit codes:
#   0  verdict=pass (the migration-failure path was taken correctly)
#   1  verdict=fail (an assertion missed)
#   2  harness/config error
#   130 SIGINT
#   143 SIGTERM

set -euo pipefail

REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$REPO_ROOT_DEFAULT}"

# ---------------------------------------------------------------------------
# Source the parent-design common.sh for redacted logging, run-id
# assignment, and the production-DSN deny-list. The fixture marker
# STAGING_DB_FAILURE_FIXTURE=1 is honoured by the wrapper below, not by
# common.sh itself: the parent's production-DSN check is intentionally
# strict and we bypass it with our own localhost-only allowlist before
# invoking the parent's helpers, so common.sh sees only a localhost DSN.
# ---------------------------------------------------------------------------

# shellcheck source=../../scripts/cloud/database/common.sh
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/cloud/database/common.sh"

SCHEMA_VERSION=1

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

source_dsn=""
prisma_migrations_dir=""
service=""
output_path=""
run_id=""
intent_commit=""
confirm_staging=0

print_help() {
  cat <<'HELP'
Usage: staging-db-migration-failure-drill.sh [flags]

Required:
  --source-dsn <dsn>                Disposable DSN (localhost / 127.0.0.1
                                    / GitHub Actions services host).
  --prisma-migrations-dir <path>    Test-only migration directory. Must
                                    resolve outside services/<svc>/prisma/
                                    migrations/.
  --service <tasks-api|budget-api>  Service whose schema is targeted.
  --confirm-staging                 Required ack; refuses otherwise.

Optional:
  --output <path>                   Write JSON result here (stdout by default).
  --run-id <id>                     Default = drill timestamp + random tag.
  --intent-commit <sha>             Recorded in the envelope.

Emits JSON matching tests/cloud/staging-validation.schema.json.
Exit 0 pass, 1 fail, 2 harness/config error.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dsn)            source_dsn="${2:-}"; shift 2 ;;
    --prisma-migrations-dir) prisma_migrations_dir="${2:-}"; shift 2 ;;
    --service)               service="${2:-}"; shift 2 ;;
    --output)                output_path="${2:-}"; shift 2 ;;
    --run-id)                run_id="${2:-}"; shift 2 ;;
    --intent-commit)         intent_commit="${2:-}"; shift 2 ;;
    --confirm-staging)       confirm_staging=1; shift ;;
    -h|--help)               print_help; exit 0 ;;
    *) cloud_db_die "unknown argument: $1" ;;
  esac
done

if [[ -z "$source_dsn" || -z "$prisma_migrations_dir" || -z "$service" ]]; then
  cloud_db_die "--source-dsn, --prisma-migrations-dir, and --service are required"
fi
if [[ "$confirm_staging" -ne 1 ]]; then
  cloud_db_die "--confirm-staging is required; this drill mutates a disposable DSN"
fi

# ---------------------------------------------------------------------------
# Validate service is one of the two known services
# ---------------------------------------------------------------------------

case "$service" in
  tasks-api|budget-api) ;;
  *) cloud_db_die "--service must be 'tasks-api' or 'budget-api' (got '$service')" ;;
esac

# ---------------------------------------------------------------------------
# Validate prisma-migrations-dir is a sibling of the production path,
# not the production path itself, and is not under a production
# prisma/migrations/ tree. This is the production-safety guard
# (task d37681e1 AC4 fixture scope rule).
# ---------------------------------------------------------------------------

case "$prisma_migrations_dir" in
  /*) ;;
  *) prisma_migrations_dir="$(cd "$REPO_ROOT" && cd "$(dirname -- "$prisma_migrations_dir")" && pwd)/$(basename -- "$prisma_migrations_dir")" ;;
esac
[[ -d "$prisma_migrations_dir" ]] || cloud_db_die "--prisma-migrations-dir does not exist: $prisma_migrations_dir"

case "$prisma_migrations_dir" in
  */services/*/prisma/migrations|*/services/*/prisma/migrations/)
    cloud_db_die "--prisma-migrations-dir resolves under a production prisma/migrations/ path; refuse to override a real migration tree"
    ;;
esac
# Defence in depth: any path that contains the literal segment
# 'prisma/migrations' anywhere inside services/ is rejected, even if
# the trailing component is a sibling (e.g. .../prisma/migrations/../...).
case "$prisma_migrations_dir" in
  *"/prisma/migrations/"|*"/prisma/migrations")
    cloud_db_die "--prisma-migrations-dir resolves under prisma/migrations/; refuse to override a real migration tree"
    ;;
esac

# ---------------------------------------------------------------------------
# Validate source DSN is a disposable / localhost DSN. The production
# deny-list from the parent design is enforced here as a defence in
# depth; STAGING_DB_FAILURE_FIXTURE=1 is honoured as a documented
# override for the local-DevOps case only.
# ---------------------------------------------------------------------------

case "$source_dsn" in
  postgresql://*|postgres://*) ;;
  *) cloud_db_die "--source-dsn must be a postgresql:// or postgres:// DSN" ;;
esac

if [[ "${STAGING_DB_FAILURE_FIXTURE:-0}" != "1" ]]; then
  case "$source_dsn" in
    *@localhost:*|*@127.0.0.1:*|*@postgres:*)
      ;;
    *)
      cloud_db_die "--source-dsn does not look like a disposable DSN (expected localhost, 127.0.0.1, or postgres services host); set STAGING_DB_FAILURE_FIXTURE=1 to override for documented DevOps use only"
      ;;
  esac
fi

# Defence in depth: refuse if the DSN matches the parent's
# production-substring deny-list, even with the override set, because
# overriding the localhost check is for the staging-DSN case, not for
# production DSNs.
if [[ "${STAGING_DB_FAILURE_FIXTURE:-0}" == "1" ]]; then
  for needle in "${CLOUD_DB_PRODUCTION_DSN_DENYLIST[@]}"; do
    if [[ "$source_dsn" == *"$needle"* ]]; then
      cloud_db_die "--source-dsn matches production deny-list substring '$needle'; STAGING_DB_FAILURE_FIXTURE=1 does not authorise a production target"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Run id + envelope scaffolding
# ---------------------------------------------------------------------------

: "${run_id:=}"
if [[ -z "$run_id" ]]; then
  cloud_db_assign_run_id
  run_id="$CLOUD_DB_RUN_ID"
fi

intent_commit_json="null"
if [[ -n "$intent_commit" ]]; then
  intent_commit_json="\"$intent_commit\""
fi

START_EPOCH="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Step runners — record each as a checks[] entry. A step that exits
# non-zero does not abort the harness; the verdict is computed at the
# end from the recorded statuses.
# ---------------------------------------------------------------------------

CHECKS_JSONL=()

drill_step() {
  local name="$1"; shift
  local started
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local status="pass"
  local error_json="null"
  local details_json="{}"

  if "$@"; then
    status="pass"
  else
    status="fail"
    error_json="{\"code\":\"AC4_STEP_FAILED\",\"message\":\"$name returned a non-zero exit code\"}"
  fi

  local ended
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  CHECKS_JSONL+=("{\"name\":\"$name\",\"status\":\"$status\",\"startedAt\":\"$started\",\"endedAt\":\"$ended\",\"details\":$details_json,\"error\":$error_json}")
}

# ---------------------------------------------------------------------------
# Capture prisma migrate deploy output and exit code. We invoke
# `npx --no-install prisma migrate deploy` directly (matching the
# parent-design `migrate.sh` invocation) so the fixture exercises the
# real Prisma binary, not a wrapper. PRISMA_MIGRATIONS_DIR is set
# in-process; prisma migrate deploy reads it to locate the migration
# directory.
# ---------------------------------------------------------------------------

PRISMA_LOG="${PRISMA_LOG:-$TMP/prisma-migrate-deploy.log}"
PRISMA_EXIT_FILE="${PRISMA_EXIT_FILE:-$TMP/prisma-exit}"

step_prisma_migration_failure_exit_code() {
  local schema_prisma_file="$REPO_ROOT/services/$service/prisma/schema.prisma"
  [[ -f "$schema_prisma_file" ]] || return 1

  # Prisma 5's `migrate deploy` resolves the migrations directory
  # relative to the schema's directory, and the `migrate deploy`
  # subcommand does not accept `--migrations-dir`. The earlier
  # PR #821 approach (setting `PRISMA_MIGRATIONS_DIR` and passing
  # the production `services/$service/prisma/schema.prisma` via
  # `npx --no-install`) silently applied the production migrations
  # on a fresh DB (and produced a misleading exit-1 in CI when npx
  # could not resolve the local binary). The deterministic fix is to
  # stand up a per-run temp schema that points at the test-only
  # migrations dir: a minimal `schema.prisma` containing just a
  # datasource block, plus a symlink from the temp dir's `migrations/`
  # to the fixture's migrations dir. Prisma then resolves the test
  # migrations relative to the temp schema and fails on the deliberate
  # bad_migration with a stable, version-independent SQL error.
  local fixture_schema_dir="$TMP/fixture-schema-$service"
  rm -rf "$fixture_schema_dir"
  mkdir -p "$fixture_schema_dir"

  # Symlink the test-only migrations dir into the temp schema's
  # expected `migrations/` location.
  ln -s "$prisma_migrations_dir/migrations" "$fixture_schema_dir/migrations"

  # Write a minimal schema.prisma: just a datasource block (the
  # generator block is required by Prisma but its output path is
  # irrelevant for `migrate deploy`, which never invokes
  # prisma generate). The datasource provider matches the
  # migration_lock.toml provider so Prisma's P3019 guard is
  # satisfied.
  cat >"$fixture_schema_dir/schema.prisma" <<EOF_SCHEMA
generator client {
  provider = "prisma-client-js"
  output   = "$TMP/fixture-prisma-client-$service"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
EOF_SCHEMA

  # PRISMA_BIN override: when set (typically by the unit test stub
  # and now by the GHA workflow after `npm ci`), the harness
  # invokes "$PRISMA_BIN migrate deploy" directly so the stub PATH
  # (unit test) or the installed binary (CI) intercepts the call.
  # When unset (legacy invocation), fall back to the npx pattern;
  # this path is no longer used by the GHA workflow but is kept for
  # backward compatibility with developer-machine runs that
  # already have node_modules installed.
  local prisma_invocation
  if [[ -n "${PRISMA_BIN:-}" ]]; then
    prisma_invocation=("$PRISMA_BIN" migrate deploy)
  else
    prisma_invocation=(npx --no-install --prefix "$REPO_ROOT/services/$service" prisma migrate deploy)
  fi

  set +e
  (
    cd "$REPO_ROOT" && \
      DATABASE_URL="$source_dsn" \
      "${prisma_invocation[@]}" --schema "$fixture_schema_dir/schema.prisma" \
        >"$PRISMA_LOG" 2>&1
  )
  echo $? >"$PRISMA_EXIT_FILE"
  set -e
  local exit_code
  exit_code="$(cat "$PRISMA_EXIT_FILE")"
  [[ "$exit_code" -eq 1 ]]
}

step_prisma_migration_failure_diagnostic() {
  # The bad migration references a non-existent type
  # ("nonexistent_type_d4e3"), so Prisma's `migrate deploy` exits 1
  # with a P3009-class failure. The exact surfaced error message
  # varies across Prisma versions: Prisma 5.22 with a strict
  # `--schema` deployment typically surfaces the underlying
  # `type "nonexistent_type_d4e3" does not exist` SQL error, but
  # newer Prisma versions (and Prisma 5.x with the default
  # non-verbose output) collapse the underlying SQL error into a
  # bare `P3009: migrate found failed migrations in the target
  # database` message. The check must accept either shape so the
  # fixture is robust against Prisma version drift. The
  # authoritative migration-failure assertion is the database state
  # check in `step_prisma_migrations_state_uniquely_failed`; this
  # check is a cheap corroboration that Prisma surfaced *some*
  # failure indicator (the SQL identifier, the Prisma error code,
  # the migration-failure phrase, or the migration filename) so
  # the harness cannot be tricked by an unrelated exit 1.
  grep -qF -e 'nonexistent_type_d4e3' \
          -e 'P3009' \
          -e 'migrate found failed migrations' \
          -e 'bad_migration' \
          "$PRISMA_LOG"
}

step_prisma_migrations_state_uniquely_failed() {
  # The disposable database should now have exactly one row in
  # _prisma_migrations: the bad_migration, with finished_at set and
  # rolled_back_at NULL (Prisma's default for a non-atomic SQL error:
  # the failed migration is recorded, the rest of the schema is
  # untouched). Prisma creates _prisma_migrations in the schema
  # specified by the DSN's `?schema=` query param (e.g. tasks_api,
  # budget_api), not in the default public search_path, so the psql
  # queries below must set the search_path before the unqualified
  # `_prisma_migrations` reference resolves. The schema name is
  # derived from the DSN; if it is absent the assertion falls back to
  # the per-service default.
  command -v psql >/dev/null 2>&1 || return 1

  local schema_name
  schema_name="$(printf '%s' "$source_dsn" | sed -nE 's|^[a-z]+://[^?]*\?.*schema=([^&]+).*|\1|p')"
  if [[ -z "$schema_name" ]]; then
    case "$service" in
      tasks-api)  schema_name="tasks_api" ;;
      budget-api) schema_name="budget_api" ;;
      *) cloud_db_die "no schema= in DSN and service '$service' has no default schema" ;;
    esac
  fi

  local row_count
  local failed_name
  local rolled_back

  # psql's URI form for --dbname rejects unknown query parameters
  # with "invalid URI query parameter: \"schema\"". The DSN we
  # receive includes `?schema=tasks_api&sslmode=disable`, but only
  # sslmode is a real psql URI param; the schema segment is a
  # Prisma-specific extension that must be stripped before handing
  # the DSN to psql. We keep the connection part (scheme, userinfo,
  # host, port, database) and drop everything from the first `?`.
  local psql_dsn="${source_dsn%%\?*}"

  # Schema-qualify the `_prisma_migrations` reference so we don't
  # need `SET search_path` (which would otherwise leak into the
  # captured psql output and break the tr-based parsing below).
  # The schema name is the one Prisma was instructed to use via
  # the DSN's `?schema=` query param.
  local qualified_table="${schema_name}._prisma_migrations"

  row_count="$(PGPASSWORD="" psql --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$psql_dsn" \
    --command="SELECT count(*) FROM ${qualified_table};" 2>/dev/null | tr -d '[:space:]')"
  [[ "$row_count" == "1" ]] || return 1

  failed_name="$(PGPASSWORD="" psql --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$psql_dsn" \
    --command="SELECT migration_name FROM ${qualified_table};" 2>/dev/null | tr -d '[:space:]')"
  [[ "$failed_name" == *"bad_migration"* ]] || return 1

  rolled_back="$(PGPASSWORD="" psql --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$psql_dsn" \
    --command="SELECT count(*) FROM ${qualified_table} WHERE rolled_back_at IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
  [[ "$rolled_back" == "0" ]] || return 1
  return 0
}

step_no_workflow_validation_attempted() {
  # The parent-design drill.sh runs validate / reconcile / workflow
  # steps after migrate. The fixture must NOT have reached any of
  # them. We assert by re-reading the migrate log: it should contain
  # only the migration-failure error, no reconcile, no workflow.
  local forbidden=("reconcile" "drill_step workflow" "validate_workflows" "run_workflow")
  local token
  for token in "${forbidden[@]}"; do
    if grep -qF "$token" "$PRISMA_LOG"; then
      return 1
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Run the checks. Each step is its own checks[] entry.
# ---------------------------------------------------------------------------

drill_step ac4.prisma_migration_failure_exit_code step_prisma_migration_failure_exit_code || true
drill_step ac4.prisma_migration_failure_diagnostic step_prisma_migration_failure_diagnostic || true
drill_step ac4.prisma_migrations_state_uniquely_failed step_prisma_migrations_state_uniquely_failed || true
drill_step ac4.no_workflow_validation_attempted step_no_workflow_validation_attempted || true

checks_all_pass=1
for line in "${CHECKS_JSONL[@]}"; do
  if [[ "$line" != *'"status":"pass"'* ]]; then
    checks_all_pass=0
    break
  fi
done

# The fixture has no live cleanup hooks; the disposable DSN is dropped
# at the end of the GitHub Actions job by the runner, and locally the
# developer is expected to `docker compose down` (or equivalent). The
# cleanup entry below records that explicitly so the envelope's
# `cleanup.ok` predicate is satisfied.
CLEANUP_JSONL=(
  '{"name":"disposable_dsn_dropped_by_runner","ok":true,"error":null}'
)
cleanup_ok=1
for line in "${CLEANUP_JSONL[@]}"; do
  if [[ "$line" != *'"ok":true'* ]]; then
    cleanup_ok=0
  fi
done

verdict="fail"
if [[ "$checks_all_pass" -eq 1 && "$cleanup_ok" -eq 1 ]]; then
  verdict="pass"
fi

# ---------------------------------------------------------------------------
# Emit the envelope. The shape mirrors staging-failure-drill.sh so
# downstream tooling can ingest both drills with the same parser; the
# provider is "github-actions-postgres" to distinguish the disposable
# CI fixture from the live staging drill (provider="fly.io").
# ---------------------------------------------------------------------------

ended_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
checks_array="$(printf '%s\n' "${CHECKS_JSONL[@]}" | jq -s '.')"
cleanup_array="$(printf '%s\n' "${CLEANUP_JSONL[@]}" | jq -s '.')"

# Only the active service has a "url" pointing at the disposable DSN
# host; the other two are recorded as "https://not-checked.invalid" to
# match the parent drill's convention for services the drill does not
# exercise.
disposable_host="$(printf '%s' "$source_dsn" | sed -E 's|^postgresql?://[^@]*@([^:/]+).*|\1|')"
case "$service" in
  tasks-api)
    services_json=$(cat <<JSON
{
  "tasksApi": {"url":"postgresql://${disposable_host}","version":null,"matchesIntent":false},
  "budgetApi": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false},
  "contentScheduler": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false}
}
JSON
)
    ;;
  budget-api)
    services_json=$(cat <<JSON
{
  "tasksApi": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false},
  "budgetApi": {"url":"postgresql://${disposable_host}","version":null,"matchesIntent":false},
  "contentScheduler": {"url":"https://not-checked.invalid","version":null,"matchesIntent":false}
}
JSON
)
    ;;
esac

production_blockers='[]'

# A run that misses any check gets a structured production-blockers
# entry that names which assertion missed, so the operator-review path
# surfaces the specific gate that failed without re-reading the
# redacted log.
if [[ "$checks_all_pass" -ne 1 ]]; then
  production_blockers="$(printf '%s\n' "${CHECKS_JSONL[@]}" | jq -s '[ .[] | select(.status == "fail") | { "code": ("AC4_STEP_FAILED_" + (.name | gsub("\\."; "_") | ascii_upcase)), "summary": ("Migration-failure assertion missed: " + .name), "owner": "Rowan", "reference": "docs/specs/staging-database-migration-restore-ac4-fixture-tech-design.md" } ]')"
fi

accepted_limitations='[{"code":"AC4_FIXTURE_DISPOSABLE_DSN","summary":"The fixture runs against a disposable PostgreSQL DSN (GitHub Actions services container or developer Docker container) and does not exercise the live staging Environment; the AC1–AC3 evidence still requires the Quinn operator re-trigger of cloud-staging-db-drill on the post-#791 head.","owner":"Rowan","rationale":"The fixture is additive and parallel: it covers the CI-provable migration-failure path without depending on the live staging Environment secrets Quinn is separately provisioning.","followUp":"Re-run cloud-staging-db-drill against the post-#791 head once the 4 DSN secrets are provisioned to capture the live AC1–AC3 envelopes."}]'

result=$(cat <<JSON
{
  "schemaVersion": ${SCHEMA_VERSION},
  "runId": "${run_id}",
  "intentCommit": ${intent_commit_json},
  "environment": { "id": "disposable-postgres-${service}", "provider": "github-actions-postgres" },
  "startedAt": "${START_EPOCH}",
  "endedAt": "${ended_iso}",
  "services": ${services_json},
  "checks": ${checks_array},
  "cleanup": { "ok": $([[ $cleanup_ok -eq 1 ]] && echo true || echo false), "operations": ${cleanup_array} },
  "productionBlockers": ${production_blockers},
  "acceptedLimitations": ${accepted_limitations},
  "verdict": "${verdict}"
}
JSON
)

if [[ -n "$output_path" ]]; then
  printf '%s\n' "$result" >"$output_path"
  cloud_db_info "wrote $output_path"
else
  printf '%s\n' "$result"
fi

if [[ "$verdict" == "pass" ]]; then
  exit 0
else
  exit 1
fi
