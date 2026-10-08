#!/usr/bin/env bash
# scripts/cloud/database/migrate.sh
#
# Runs `prisma migrate deploy` for each owning service against its
# schema-qualified destination DSN. Each service's migration command is
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
  --budget-dsn-file <path>

Required:
  --tasks-dsn-file <path>   Mode-0600 DSN for the tasks_api schema
                            (must include ?schema=tasks_api).
  --budget-dsn-file <path>  Mode-0600 DSN for the budget_api schema
                            (must include ?schema=budget_api).

The destination DSNs are expected to be the same database, just with
different ?schema=... query parameters. The script will not move
budget tables into tasks_api ownership and will not let either service
query the other's schema.
USAGE
}

TASKS_DSN_FILE=""
BUDGET_DSN_FILE=""

while (( $# > 0 )); do
  case "$1" in
    --tasks-dsn-file)  TASKS_DSN_FILE="$2"; shift 2;;
    --budget-dsn-file) BUDGET_DSN_FILE="$2"; shift 2;;
    --help|-h)         usage; exit 0;;
    *)                 cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$TASKS_DSN_FILE" || -z "$BUDGET_DSN_FILE" ]]; then
  cloud_db_die "both --tasks-dsn-file and --budget-dsn-file are required"
fi

cloud_db_assert_environment "staging"

cloud_db_load_secret TASKS_DSN "$TASKS_DSN_FILE"
cloud_db_load_secret BUDGET_DSN "$BUDGET_DSN_FILE"
cloud_db_assert_no_production_dsn "tasks" "$TASKS_DSN"
cloud_db_assert_no_production_dsn "budget" "$BUDGET_DSN"

# Required schema qualification so Prisma writes into the right schema.
case "$TASKS_DSN" in
  *"?schema=tasks_api"*|*"?schema=tasks_api&"*|*"?schema=tasks_api#"*) ;;
  *) cloud_db_die "tasks DSN must include ?schema=tasks_api" ;;
esac
case "$BUDGET_DSN" in
  *"?schema=budget_api"*|*"?schema=budget_api&"*|*"?schema=budget_api#"*) ;;
  *) cloud_db_die "budget DSN must include ?schema=budget_api" ;;
esac

# ---------------------------------------------------------------------------
# Resolve per-service Prisma schema directory
# ---------------------------------------------------------------------------

REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$REPO_ROOT_DEFAULT}"

TASKS_PRISMA_DIR="${REPO_ROOT}/services/tasks-api/prisma"
BUDGET_PRISMA_DIR="${REPO_ROOT}/services/budget-api/prisma"

[[ -f "$TASKS_PRISMA_DIR/schema.prisma" ]]  || cloud_db_die "missing tasks-api prisma schema"
[[ -f "$BUDGET_PRISMA_DIR/schema.prisma" ]] || cloud_db_die "missing budget-api prisma schema"

RESULT_DIR="./artifacts/cloud-staging"
mkdir -p "$RESULT_DIR"

# ---------------------------------------------------------------------------
# Helper: preflight _prisma_migrations state for a service
# ---------------------------------------------------------------------------

prisma_migration_state() {
  local service_name="$1"
  local dsn="$2"

  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$dsn" \
    --command="
      SELECT json_build_object(
        'service', '$service_name',
        'total',          (SELECT count(*) FROM _prisma_migrations),
        'finished',       (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        'rolled_back',    (SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL),
        'failed',         (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'pending',        (SELECT count(*) FROM _prisma_migrations WHERE started_at IS NULL)
      );"
}

# ---------------------------------------------------------------------------
# Run prisma migrate deploy per service
# ---------------------------------------------------------------------------

declare -A SERVICE_RESULTS
ALL_OK=1

run_service_migration() {
  local service_name="$1"
  local prisma_dir="$2"
  local dsn="$3"
  local log_path="${RESULT_DIR}/migrate-${CLOUD_DB_RUN_ID}-${service_name}.log"
  local state

  cloud_db_info "running prisma migrate deploy service=${service_name}"

  state="$(prisma_migration_state "$service_name" "$dsn")"

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
      DATABASE_URL="$dsn" \
      npx --no-install prisma migrate deploy \
        >"$log_path" 2>&1 ) \
    || cloud_db_die "prisma migrate deploy failed for ${service_name}; see ${log_path}"

  local post_state
  post_state="$(prisma_migration_state "$service_name" "$dsn")"

  SERVICE_RESULTS["$service_name"]="$post_state"
  cloud_db_info "service=${service_name} migrations ok state=${post_state}"
}

run_service_migration "tasks-api"  "$TASKS_PRISMA_DIR"  "$TASKS_DSN"
run_service_migration "budget-api" "$BUDGET_PRISMA_DIR" "$BUDGET_DSN"

# ---------------------------------------------------------------------------
# Emit result envelope
# ---------------------------------------------------------------------------

RESULT_PATH="${RESULT_DIR}/migrate-${CLOUD_DB_RUN_ID}.json"

python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$TASKS_DSN_FILE" "$BUDGET_DSN_FILE" \
        "${SERVICE_RESULTS[tasks-api]}" "${SERVICE_RESULTS[budget-api]}" <<'PY'
import json, sys

out_path, run_id, tasks_dsn_file, budget_dsn_file, tasks_state, budget_state = sys.argv[1:]

envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-migrate",
  "runId": run_id,
  "tasks": {
    "dsnFile": tasks_dsn_file,
    "state": json.loads(tasks_state),
  },
  "budget": {
    "dsnFile": budget_dsn_file,
    "state": json.loads(budget_state),
  },
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "migrations complete for both services"
printf '%s\n' "$RESULT_PATH"
