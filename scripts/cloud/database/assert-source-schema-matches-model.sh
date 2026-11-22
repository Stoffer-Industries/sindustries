#!/usr/bin/env bash
# scripts/cloud/database/assert-source-schema-matches-model.sh
#
# Fails closed when the SOURCE schema's table inventory does not match the
# Prisma model the repository declares for the service that owns it.
#
# Why this exists (task f2c23e26, production data migration with verified
# backup and restore):
#
#   The restore copies the source schema wholesale -- every table, every
#   row, including tables that the repository's schema.prisma does not
#   model. The drill's cleanup step drops the live destination schemas
#   first (cleanup_destination=true), so anything the source carries that
#   the repository does not model lands in production as permanent drift,
#   and it lands AFTER the destination has already been destroyed.
#
#   Measured on the live prodlike source (read-only, 2026-11-23):
#
#     tasks_api.ContentSchedulerItem       29 rows  -- not modelled
#     tasks_api.Task_blocked_ready_backup  48 rows  -- not modelled
#
#   The first is a content-scheduler table orphaned in the tasks_api schema
#   by the schema split; the second is the backup table left behind by the
#   rolled-back `add_blocked_ready_columns` migration. Neither appears in
#   services/tasks-api/prisma/schema.prisma, so neither would ever be
#   migrated, reconciled or pruned by a later `prisma migrate` run, and 29
#   content-scheduler rows would be duplicated into production inside a
#   table the application does not read.
#
#   The check is read-only and runs BEFORE the destructive cleanup step,
#   so a source that does not match the model refuses while the live
#   destination is still intact.
#
#   It also refuses the opposite direction: a table the repository models
#   but the source lacks would be restored as a schema that no longer
#   matches the service it belongs to.
#
# Output:
#   ./artifacts/cloud-staging/assert-source-schema-model-match-<run-id>.json
#   (or ./artifacts/cloud-production/... in a production run)
#
#   The envelope carries table NAMES and row COUNTS only -- no row data,
#   no DSN values, no credentials.

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assert_required_commands

usage() {
  cat <<'USAGE'
Usage: assert-source-schema-matches-model.sh \
  --source-tasks-dsn-file <path> \
  --source-content-scheduler-dsn-file <path> \
  [--result-dir <path>]

Required:
  --source-tasks-dsn-file <path>          Mode-0600 file containing the
                                           source DSN for the tasks_api schema.
  --source-content-scheduler-dsn-file <path>
                                           Mode-0600 file containing the
                                           source DSN for the content_scheduler
                                           schema.

Optional:
  --result-dir <path>      Directory for the redacted result envelope.
                            Defaults to the environment's artifact directory
                            (./artifacts/cloud-staging,
                            ./artifacts/cloud-production).
  --environment <staging|production>
                            Environment label. Defaults to the ENVIRONMENT
                            environment variable, then "staging".
  --expected-host <host>   Declares an endpoint this run may touch.
                            Repeatable. A production run MUST declare every
                            endpoint it touches.
  --help|-h                Show this help.

The source DSNs must be direct PostgreSQL URLs. Each schema is inspected
over the connection that owns it, so the check reads the same surface the
restore will read.
USAGE
}

SOURCE_TASKS_DSN_FILE=""
SOURCE_CONTENT_SCHEDULER_DSN_FILE=""
RESULT_DIR=""
ENVIRONMENT="${ENVIRONMENT:-staging}"

while (( $# > 0 )); do
  case "$1" in
    --source-tasks-dsn-file)            SOURCE_TASKS_DSN_FILE="$2"; shift 2;;
    --source-content-scheduler-dsn-file) SOURCE_CONTENT_SCHEDULER_DSN_FILE="$2"; shift 2;;
    --result-dir)                       RESULT_DIR="$2"; shift 2;;
    --environment)                      ENVIRONMENT="$2"; shift 2;;
    --expected-host)                    cloud_db_add_expected_host "$2"; shift 2;;
    --help|-h)                          usage; exit 0;;
    *)                                  cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$SOURCE_TASKS_DSN_FILE" || -z "$SOURCE_CONTENT_SCHEDULER_DSN_FILE" ]]; then
  cloud_db_die "both --source-tasks-dsn-file and --source-content-scheduler-dsn-file are required"
fi

cloud_db_set_environment "$ENVIRONMENT"
cloud_db_load_expected_targets_from_env
cloud_db_assert_production_ack
cloud_db_assign_run_id

RESULT_DIR="${RESULT_DIR:-$CLOUD_DB_ARTIFACT_DIR}"
mkdir -p "$RESULT_DIR"

# ---------------------------------------------------------------------------
# Load + verify the source DSNs
# ---------------------------------------------------------------------------

cloud_db_load_secret SOURCE_TASKS_DSN "$SOURCE_TASKS_DSN_FILE"
cloud_db_load_secret SOURCE_CONTENT_SCHEDULER_DSN "$SOURCE_CONTENT_SCHEDULER_DSN_FILE"
cloud_db_assert_target_dsn "source (tasks_api)" "$SOURCE_TASKS_DSN"
cloud_db_assert_target_dsn "source (content_scheduler)" "$SOURCE_CONTENT_SCHEDULER_DSN"

# ---------------------------------------------------------------------------
# Resolve the repository's model list per schema
# ---------------------------------------------------------------------------
#
# The model list is read from the service's own prisma schema, so the
# check cannot drift from the code the applications actually run. A model
# maps to the table of the same name unless it declares @@map("...").

REPO_ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$REPO_ROOT_DEFAULT}"

TASKS_PRISMA_SCHEMA="${REPO_ROOT}/services/tasks-api/prisma/schema.prisma"
CONTENT_SCHEDULER_PRISMA_SCHEMA="${REPO_ROOT}/services/content-scheduler-api/prisma/schema.prisma"

[[ -f "$TASKS_PRISMA_SCHEMA" ]] || cloud_db_die "missing tasks-api prisma schema"
[[ -f "$CONTENT_SCHEDULER_PRISMA_SCHEMA" ]] || cloud_db_die "missing content-scheduler-api prisma schema"

# ---------------------------------------------------------------------------
# Read the source inventory for one schema
# ---------------------------------------------------------------------------
#
# The table list and the row counts come from one query so the verdict can
# name how much data an unexpected table would carry. Row counts are the
# planner's estimate (reltuples), the same measure inventory.sh records:
# exact counts would scan every row of a live source.

source_table_inventory() {
  local dsn="$1"
  local schema_name="$2"

  psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$dsn" \
    --command="
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.table_name), '[]'::json)
      FROM (
        SELECT
          t.table_name,
          c.reltuples::bigint AS estimated_rows
        FROM information_schema.tables t
        JOIN pg_class c ON c.relname = t.table_name
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.table_schema = '${schema_name}'
          AND n.nspname = '${schema_name}'
          AND t.table_type = 'BASE TABLE'
          AND t.table_name <> '_prisma_migrations'
      ) t;" \
    || cloud_db_die "could not read the source table inventory for schema '${schema_name}'"
}

# ---------------------------------------------------------------------------
# Compare source inventory against the repository's models
# ---------------------------------------------------------------------------
#
# model_tables <schema.prisma path> -- prints one table name per line.
#
# The parser reads `model <Name> {` blocks and honours a block-level
# @@map("...") rename. A schema the parser cannot read yields an empty
# list, and an empty list fails the comparison for every table in the
# source -- the check fails closed rather than silently passing.

model_tables() {
  local prisma_schema="$1"

  python3 - "$prisma_schema" <<'PY'
import re, sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()

# A model block runs from `model X {` to the matching closing brace.
# The block is scanned for a block-level @@map("...") rename; a field-level
# @map("...") renames a COLUMN and is deliberately not matched here.
tables = []
for match in re.finditer(r"^model\s+(\w+)\s*\{", text, re.MULTILINE):
    name = match.group(1)
    start = match.end()
    depth = 1
    index = start
    while index < len(text) and depth > 0:
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    block = text[start:index]
    renamed = re.search(r'@@map\(\s*"([^"]+)"\s*\)', block)
    tables.append(renamed.group(1) if renamed else name)

for table in tables:
    print(table)
PY
}

TASKS_SOURCE_TABLES="$(source_table_inventory "$SOURCE_TASKS_DSN" "tasks_api")"
CONTENT_SCHEDULER_SOURCE_TABLES="$(source_table_inventory "$SOURCE_CONTENT_SCHEDULER_DSN" "content_scheduler")"

TASKS_MODEL_TABLES="$(model_tables "$TASKS_PRISMA_SCHEMA")"
CONTENT_SCHEDULER_MODEL_TABLES="$(model_tables "$CONTENT_SCHEDULER_PRISMA_SCHEMA")"

if [[ -z "$TASKS_MODEL_TABLES" ]]; then
  cloud_db_die "could not read the tasks-api model list from ${TASKS_PRISMA_SCHEMA}; refusing"
fi
if [[ -z "$CONTENT_SCHEDULER_MODEL_TABLES" ]]; then
  cloud_db_die "could not read the content-scheduler-api model list from ${CONTENT_SCHEDULER_PRISMA_SCHEMA}; refusing"
fi

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

RESULT_PATH="${RESULT_DIR}/assert-source-schema-model-match-${CLOUD_DB_RUN_ID}.json"

verdict="$(python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$CLOUD_DB_KIND_PREFIX" "$CLOUD_DB_ENVIRONMENT" \
  "$TASKS_SOURCE_TABLES" "$TASKS_MODEL_TABLES" \
  "$CONTENT_SCHEDULER_SOURCE_TABLES" "$CONTENT_SCHEDULER_MODEL_TABLES" <<'PY'
import json, sys

out_path, run_id, kind_prefix, environment = sys.argv[1:5]
tasks_source_json, tasks_models, cs_source_json, cs_models = sys.argv[5:9]

tasks_source = json.loads(tasks_source_json)
cs_source = json.loads(cs_source_json)


def compare(source_rows, model_lines, schema_name):
    source = {row["table_name"]: int(row.get("estimated_rows") or 0) for row in source_rows}
    models = {line.strip() for line in model_lines.splitlines() if line.strip()}
    unexpected = sorted(set(source) - models)
    missing = sorted(models - set(source))
    return {
        "schema": schema_name,
        "modelTables": sorted(models),
        "sourceTables": sorted(source),
        "unexpected": [
            {"table": table, "estimatedRows": source[table]} for table in unexpected
        ],
        "missing": missing,
        "ok": not unexpected and not missing,
    }


tasks = compare(tasks_source, tasks_models, "tasks_api")
content_scheduler = compare(cs_source, cs_models, "content_scheduler")

envelope = {
    "schemaVersion": 1,
    "kind": f"{kind_prefix}-source-schema-model-match",
    "environment": environment,
    "runId": run_id,
    "services": {"tasks-api": tasks, "content-scheduler-api": content_scheduler},
    "ok": tasks["ok"] and content_scheduler["ok"],
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(envelope, fh, indent=2, sort_keys=True)
    fh.write("\n")

lines = []
for service, verdict in (("tasks-api", tasks), ("content-scheduler-api", content_scheduler)):
    for entry in verdict["unexpected"]:
        lines.append(
            f"  {verdict['schema']}.{entry['table']}: {entry['estimatedRows']} estimated rows, "
            f"not modelled by {service}"
        )
    for table in verdict["missing"]:
        lines.append(
            f"  {verdict['schema']}.{table}: modelled by {service} but absent from the source"
        )

if not envelope["ok"]:
    print("SOURCE SCHEMA DOES NOT MATCH THE REPOSITORY MODEL", file=sys.stderr)
    for line in lines:
        print(line, file=sys.stderr)
    print(
        "Refusing before the destination cleanup: the restore copies the source schema "
        "wholesale, so these objects would land in the destination as drift the repository "
        "never migrates, reconciles or prunes.",
        file=sys.stderr,
    )
    print(f"Evidence: {out_path}", file=sys.stderr)

print(json.dumps({"ok": envelope["ok"], "unexpected": len(lines)}))
PY
)"

if [[ "$verdict" != '{"ok": true, "unexpected": 0}' ]]; then
  cloud_db_die "source schema does not match the repository model; refusing before the destination cleanup"
fi

cloud_db_info "source schema matches the repository model for both services"
printf '%s\n' "$RESULT_PATH"
