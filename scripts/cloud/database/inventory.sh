#!/usr/bin/env bash
# scripts/cloud/database/inventory.sh
#
# Records the source database state without row contents:
# - server version, schema list, extension list
# - relation sizes, aggregate row counts
# - Prisma migration state
# - source activity baseline (start/end timestamps)
#
# Output: a JSON envelope written to ${CLOUD_DB_INVENTORY_OUTPUT}
#         (default: ./artifacts/cloud-staging/inventory-${CLOUD_DB_RUN_ID}.json)

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assert_required_commands

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: inventory.sh --source-dsn-file <path> [--output <path>]

Required:
  --source-dsn-file <path>   Mode-0600 file containing the source DSN.

Optional:
  --output <path>            Output JSON path. Defaults to
                             ./artifacts/cloud-staging/inventory-${run_id}.json.
  --environment <staging>    Environment label. Defaults to "staging".
  --help                     Show this help.

The source DSN must include ?schema=tasks_api (and may also include
?schema=budget_api). inventory.sh never accepts positional DSNs.
USAGE
}

SOURCE_DSN_FILE=""
OUTPUT_PATH=""
ENVIRONMENT="staging"

while (( $# > 0 )); do
  case "$1" in
    --source-dsn-file) SOURCE_DSN_FILE="$2"; shift 2;;
    --output)          OUTPUT_PATH="$2"; shift 2;;
    --environment)     ENVIRONMENT="$2"; shift 2;;
    --help|-h)         usage; exit 0;;
    *)                 cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$SOURCE_DSN_FILE" ]]; then
  cloud_db_die "--source-dsn-file is required"
fi

cloud_db_assert_environment "$ENVIRONMENT"
cloud_db_assign_run_id

# ---------------------------------------------------------------------------
# Load + verify source DSN
# ---------------------------------------------------------------------------

cloud_db_load_secret SOURCE_DSN "$SOURCE_DSN_FILE"
cloud_db_assert_no_production_dsn "source" "$SOURCE_DSN_FILE"

if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="./artifacts/cloud-staging/inventory-${CLOUD_DB_RUN_ID}.json"
fi
mkdir -p "$(dirname "$OUTPUT_PATH")"

# ---------------------------------------------------------------------------
# Capture server metadata + schemas
# ---------------------------------------------------------------------------

server_version="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="SHOW server_version;"
)"

if [[ -z "$server_version" ]]; then
  cloud_db_die "could not read source server_version"
fi

schemas_json="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="SELECT json_agg(json_build_object('name', schema_name) ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('tasks_api','budget_api','public');"
)"

extensions_json="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="SELECT COALESCE(json_agg(extname ORDER BY extname), '[]'::json) FROM pg_extension;"
)"

# Aggregate row counts per schema table. No row data is selected.
relation_counts_json="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="
      SELECT json_agg(row_to_json(t) ORDER BY t.table_schema, t.table_name)
      FROM (
        SELECT
          table_schema,
          table_name,
          pg_total_relation_size(quote_ident(table_schema) || '.' || quote_ident(table_name)) AS total_bytes,
          c.reltuples::bigint AS estimated_rows
        FROM information_schema.tables t
        JOIN pg_class c ON c.relname = t.table_name
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
        WHERE table_schema IN ('tasks_api','budget_api')
          AND table_type = 'BASE TABLE'
      ) t;"
)"

prisma_state_json="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="
      SELECT json_build_object(
        'tables_present', bool_or(table_name = '_prisma_migrations'),
        'migrations', COALESCE(json_agg(json_build_object(
          'name', migration_name,
          'finished_at', finished_at,
          'rolled_back_at', rolled_back_at
        ) ORDER BY started_at) FILTER (WHERE table_name = '_prisma_migrations'), '[]'::json)
      )
      FROM (SELECT * FROM tasks_api._prisma_migrations) m
      RIGHT JOIN (VALUES (true)) AS one ON true
      LIMIT 1;"
  )"

# Source activity baseline (snapshot time only — counts of live queries).
activity_json="$(
  PGPASSWORD="${SOURCE_DSN_PASSWORD:-}" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$SOURCE_DSN" \
    --command="
      SELECT json_build_object(
        'active_connections', (SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL),
        'started_at', now()::text
      );"
)"

# ---------------------------------------------------------------------------
# Emit envelope
# ---------------------------------------------------------------------------

python3 - "$OUTPUT_PATH" "$CLOUD_DB_RUN_ID" "$server_version" \
        "$schemas_json" "$extensions_json" "$relation_counts_json" \
        "$prisma_state_json" "$activity_json" <<'PY'
import json, sys

out_path, run_id, server_version, schemas, extensions, relations, prisma, activity = sys.argv[1:]

envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-inventory",
  "runId": run_id,
  "serverVersion": server_version.strip(),
  "schemas": json.loads(schemas) if schemas.strip() else [],
  "extensions": json.loads(extensions) if extensions.strip() else [],
  "relationCounts": json.loads(relations) if relations.strip() else [],
  "prismaState": json.loads(prisma) if prisma.strip() else None,
  "activity": json.loads(activity) if activity.strip() else None,
}

with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "wrote inventory envelope to ${OUTPUT_PATH}"
printf '%s\n' "$OUTPUT_PATH"
