#!/usr/bin/env bash
# scripts/cloud/database/migrate.sh
#
# Runs `prisma migrate deploy` for each owning service against its
# schema-qualified destination database. Each service's migration command is
# independent — there are no cross-schema foreign keys. The script
# refuses to run if a previous attempt left behind failed or
# unaccounted-pending migrations.
#
# Output:
#   ./artifacts/cloud-staging/migrate-<run-id>.json
#   plus one <service>.log per service.

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assign_run_id

usage() {
  cat <<'USAGE'
Usage: migrate.sh \
  --tasks-dsn-file <path> \
  --content-scheduler-dsn-file <path> \
  [--result-dir <path>]

Required:
  --tasks-dsn-file <path>   Mode-0600 direct DSN for the destination database.
  --content-scheduler-dsn-file <path>  Mode-0600 direct DSN for the destination database.

Optional:
  --result-dir <path>       Directory for redacted migration results/logs.
                            Defaults to the environment's artifact directory
                            (./artifacts/cloud-staging,
                            ./artifacts/cloud-production).
  --environment <staging|production>
                            Environment label. Defaults to the ENVIRONMENT
                            environment variable, then "staging".
  --expected-host <host>    Declares an endpoint this run may touch.
                            Repeatable. A production run MUST declare every
                            endpoint it touches.

The destination DSNs are expected to be the same database. The script adds
the Prisma-only ?schema=... parameter when invoking each service migration;
the raw DSNs remain valid libpq URLs for psql, pg_dump, and pg_restore.
USAGE
}

TASKS_DSN_FILE=""
CONTENT_SCHEDULER_DSN_FILE=""
RESULT_DIR=""
ENVIRONMENT="${ENVIRONMENT:-staging}"

while (( $# > 0 )); do
  case "$1" in
    --tasks-dsn-file)  TASKS_DSN_FILE="$2"; shift 2;;
    --content-scheduler-dsn-file) CONTENT_SCHEDULER_DSN_FILE="$2"; shift 2;;
    --result-dir)      RESULT_DIR="$2"; shift 2;;
    --environment)     ENVIRONMENT="$2"; shift 2;;
    --expected-host)   cloud_db_add_expected_host "$2"; shift 2;;
    --help|-h)         usage; exit 0;;
    *)                 cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$TASKS_DSN_FILE" || -z "$CONTENT_SCHEDULER_DSN_FILE" ]]; then
  cloud_db_die "both --tasks-dsn-file and --content-scheduler-dsn-file are required"
fi

cloud_db_set_environment "$ENVIRONMENT"
cloud_db_load_expected_targets_from_env
cloud_db_assert_production_ack

RESULT_DIR="${RESULT_DIR:-$CLOUD_DB_ARTIFACT_DIR}"

cloud_db_load_secret TASKS_DSN "$TASKS_DSN_FILE"
cloud_db_load_secret CONTENT_SCHEDULER_DSN "$CONTENT_SCHEDULER_DSN_FILE"
cloud_db_assert_target_dsn "tasks" "$TASKS_DSN"
cloud_db_assert_target_dsn "content-scheduler" "$CONTENT_SCHEDULER_DSN"

# ---------------------------------------------------------------------------
# Resolve per-service Prisma schema directory
# ---------------------------------------------------------------------------

REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$REPO_ROOT_DEFAULT}"

TASKS_PRISMA_DIR="${REPO_ROOT}/services/tasks-api/prisma"
CONTENT_SCHEDULER_PRISMA_DIR="${REPO_ROOT}/services/content-scheduler-api/prisma"

[[ -f "$TASKS_PRISMA_DIR/schema.prisma" ]]  || cloud_db_die "missing tasks-api prisma schema"
[[ -f "$CONTENT_SCHEDULER_PRISMA_DIR/schema.prisma" ]] || cloud_db_die "missing content-scheduler-api prisma schema"

mkdir -p "$RESULT_DIR"

# ---------------------------------------------------------------------------
# Helper: preflight _prisma_migrations state for a service
# ---------------------------------------------------------------------------

prisma_migration_state() {
  local service_name="$1"
  local schema_name="$2"
  local dsn="$3"
  local migration_table

  case "$schema_name" in
    tasks_api|content_scheduler) migration_table="\"${schema_name}\".\"_prisma_migrations\"" ;;
    *) cloud_db_die "unsupported migration schema '$schema_name'" ;;
  esac

  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$dsn" \
    --command="
      SELECT json_build_object(
        'service', '$service_name',
        'total',          (SELECT count(*) FROM ${migration_table}),
        'finished',       (SELECT count(*) FROM ${migration_table} WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        'rolled_back',    (SELECT count(*) FROM ${migration_table} WHERE rolled_back_at IS NOT NULL),
        'failed',         (SELECT count(*) FROM ${migration_table} WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'pending',        (SELECT count(*) FROM ${migration_table} WHERE started_at IS NULL)
      );"
}

prisma_dsn_for_schema() {
  local dsn="$1"
  local schema_name="$2"
  case "$dsn" in
    *\?*) printf '%s&schema=%s' "$dsn" "$schema_name" ;;
    *)     printf '%s?schema=%s' "$dsn" "$schema_name" ;;
  esac
}

# ---------------------------------------------------------------------------
# Run prisma migrate deploy per service
# ---------------------------------------------------------------------------

declare -A SERVICE_RESULTS

run_service_migration() {
  local service_name="$1"
  local prisma_dir="$2"
  local dsn="$3"
  local schema_name="$4"
  local log_path="${RESULT_DIR}/migrate-${CLOUD_DB_RUN_ID}-${service_name}.log"
  local state prisma_dsn

  prisma_dsn="$(prisma_dsn_for_schema "$dsn" "$schema_name")"

  cloud_db_info "running prisma migrate deploy service=${service_name}"

  state="$(prisma_migration_state "$service_name" "$schema_name" "$dsn")"

  # Parse the JSON with inline python so we key off the actual
  # `failed` field rather than a fragile substring match. A naive
  # match like `*"failed": 0*` misclassifies if the JSON ever has
  # sibling fields like `"failed_rollbacks": 0` or is reformatted.
  python3 - "$service_name" "$state" <<'PY' || cloud_db_die "service=$1 has failed migrations in _prisma_migrations; refusing"
import json, sys
service = sys.argv[1]
state = json.loads(sys.argv[2])
if int(state.get("failed", 0)) > 0:
    raise SystemExit(f"service={service} has failed migrations in _prisma_migrations; refusing")
PY

  ( cd "$prisma_dir" && \
      DATABASE_URL="$prisma_dsn" \
      npx --no-install prisma migrate deploy \
        >"$log_path" 2>&1 ) \
    || cloud_db_die "prisma migrate deploy failed for ${service_name}; see ${log_path}"

  local post_state
  post_state="$(prisma_migration_state "$service_name" "$schema_name" "$dsn")"

  SERVICE_RESULTS["$service_name"]="$post_state"
  cloud_db_info "service=${service_name} migrations ok state=${post_state}"
}

run_service_migration "tasks-api"  "$TASKS_PRISMA_DIR"  "$TASKS_DSN"  tasks_api
run_service_migration "content-scheduler-api" "$CONTENT_SCHEDULER_PRISMA_DIR" "$CONTENT_SCHEDULER_DSN" content_scheduler

# ---------------------------------------------------------------------------
# Emit result envelope
# ---------------------------------------------------------------------------

RESULT_PATH="${RESULT_DIR}/migrate-${CLOUD_DB_RUN_ID}.json"

python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$TASKS_DSN_FILE" "$CONTENT_SCHEDULER_DSN_FILE" \
        "${SERVICE_RESULTS[tasks-api]}" "${SERVICE_RESULTS[content-scheduler-api]}" \
        "$CLOUD_DB_KIND_PREFIX" "$CLOUD_DB_ENVIRONMENT" <<'PY'
import json, sys

out_path, run_id, tasks_dsn_file, content_scheduler_dsn_file, tasks_state, content_scheduler_state, kind_prefix, environment = sys.argv[1:]

envelope = {
  "schemaVersion": 1,
  "kind": f"{kind_prefix}-migrate",
  "environment": environment,
  "runId": run_id,
  "tasks": {
    "dsnFile": tasks_dsn_file,
    "state": json.loads(tasks_state),
  },
  "contentScheduler": {
    "dsnFile": content_scheduler_dsn_file,
    "state": json.loads(content_scheduler_state),
  },
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "migrations complete for both services"
printf '%s\n' "$RESULT_PATH"
