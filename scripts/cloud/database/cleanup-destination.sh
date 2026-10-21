#!/usr/bin/env bash
# scripts/cloud/database/cleanup-destination.sh
#
# Operator-only destructive action for the cloud-staging database
# drill (task d37681e1). Drops and recreates the two service
# schemas (tasks_api, budget_api) in the destination database so
# restore.sh can write into a fresh, empty target. This exists
# because restore.sh explicitly refuses to overwrite a non-empty
# destination (a safety guard), and a previous failed drill run
# can leave tables behind that the next run cannot clear on its
# own.
#
# SAFETY GUARDS — every one is a hard precondition; this script
# fails closed if any guard fails:
#
#   1. Requires --confirm <run-id> matching the assigned run id
#      (same convention as drill.sh).
#   2. Requires --confirm-cleanup-destination as a separate explicit
#      ack (two-key auth). The plain --confirm token alone is not
#      enough; the operator must type the literal phrase
#      `--confirm-cleanup-destination`.
#   3. Refuses to operate on any DSN that matches the production
#      deny-list substring (prod, production, sindustries-prod),
#      even with the override env var.
#   4. Refuses to operate if the destination DSN is the same host
#      as the source DSN (cannot drop a schema the source needs).
#   5. Refuses to operate on any database name without the staging
#      prefix (sindustries_staging_).
#   6. Refuses to operate if ENVIRONMENT is not "staging".
#
# NEVER call this from a push-triggered or schedule-triggered
# workflow. Only from a workflow_dispatch input where the operator
# has explicitly opted in.

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assert_required_commands
cloud_db_assert_environment "staging"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: cleanup-destination.sh \
  --source-tasks-dsn-file <path> \
  --dest-tasks-dsn-file <path> \
  --dest-budget-dsn-file <path> \
  --confirm <run-id> \
  --confirm-cleanup-destination

Required:
  --source-tasks-dsn-file <path>   Source tasks_api DSN file. Used only
                                    for the source != destination
                                    inequality check; no source data
                                    is read.
  --dest-tasks-dsn-file <path>      Destination tasks_api DSN file.
  --dest-budget-dsn-file <path>     Destination budget_api DSN file.
  --confirm <run-id>                Must match CLOUD_DB_RUN_ID.
  --confirm-cleanup-destination     Explicit two-key ack. Must be
                                    spelled exactly; refuses
                                    otherwise.

Emits a JSON envelope at artifacts/cloud-staging/cleanup-<run-id>.json
documenting the schemas dropped, the timestamp, and the run id.
USAGE
}

SOURCE_TASKS_FILE=""
DEST_TASKS_FILE=""
DEST_BUDGET_FILE=""
CONFIRM=""
CONFIRM_CLEANUP=0

while (( $# > 0 )); do
  case "$1" in
    --source-tasks-dsn-file)   SOURCE_TASKS_FILE="$2";  shift 2;;
    --dest-tasks-dsn-file)     DEST_TASKS_FILE="$2";    shift 2;;
    --dest-budget-dsn-file)    DEST_BUDGET_FILE="$2";   shift 2;;
    --confirm)                 CONFIRM="$2";            shift 2;;
    --confirm-cleanup-destination) CONFIRM_CLEANUP=1;    shift;;
    --help|-h)                 usage; exit 0;;
    *)                         cloud_db_die "unknown argument: $1";;
  esac
done

for v in SOURCE_TASKS_FILE DEST_TASKS_FILE DEST_BUDGET_FILE CONFIRM; do
  if [[ -z "${!v}" ]]; then
    cloud_db_die "--${v,,} is required"
  fi
done

if [[ "$CONFIRM_CLEANUP" -ne 1 ]]; then
  cloud_db_die "--confirm-cleanup-destination is required; this is a destructive operator action"
fi

cloud_db_assign_run_id

if [[ "$CONFIRM" != "${CLOUD_DB_RUN_ID:-}" ]]; then
  cloud_db_die "--confirm must match the assigned run id (${CLOUD_DB_RUN_ID:-unset})"
fi

# ---------------------------------------------------------------------------
# Load + verify DSNs
# ---------------------------------------------------------------------------

cloud_db_load_secret SOURCE_TASKS_DSN "$SOURCE_TASKS_FILE"
cloud_db_load_secret DEST_TASKS_DSN  "$DEST_TASKS_FILE"
cloud_db_load_secret DEST_BUDGET_DSN "$DEST_BUDGET_FILE"

# Refuse production DSNs at either end of the source/dest spectrum.
cloud_db_assert_no_production_dsn "source"      "$SOURCE_TASKS_DSN"
cloud_db_assert_no_production_dsn "destination (tasks_api)"  "$DEST_TASKS_DSN"
cloud_db_assert_no_production_dsn "destination (budget_api)" "$DEST_BUDGET_DSN"

# Refuse same-host source/destination (would drop schemas the source
# still needs).
cloud_db_assert_inequality "source" "$SOURCE_TASKS_DSN" "destination (tasks_api)"  "$DEST_TASKS_DSN"
cloud_db_assert_inequality "source" "$SOURCE_TASKS_DSN" "destination (budget_api)" "$DEST_BUDGET_DSN"

# Refuse any non-staging database name. The DSN includes the
# database name as the path component; strip the userinfo and
# query string before passing the name to the assertion.
_dsn_dbname() {
  printf '%s' "$1" | sed -E 's#^[a-z0-9]+://[^@]+@[^/]+/##; s#\?.*$##'
}
cloud_db_assert_database_name "$(_dsn_dbname "$DEST_TASKS_DSN")"
cloud_db_assert_database_name "$(_dsn_dbname "$DEST_BUDGET_DSN")"

# ---------------------------------------------------------------------------
# Pre-cleanup snapshot: count the pre-existing objects in each
# destination schema so the envelope records what was actually
# dropped. The counts are recorded as a single integer per schema;
# no row data, no IDs, no DSNs leak.
# ---------------------------------------------------------------------------

pre_tasks_count="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_TASKS_DSN" \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'tasks_api';" \
    2>/dev/null | tr -d '[:space:]'
)"
pre_tasks_count="${pre_tasks_count:-0}"

pre_budget_count="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_BUDGET_DSN" \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'budget_api';" \
    2>/dev/null | tr -d '[:space:]'
)"
pre_budget_count="${pre_budget_count:-0}"

# Table counts alone cannot decide whether the destination is fresh.
# A failed pg_restore creates the schema and then dies before it
# creates any table, leaving the schema present but EMPTY -- invisible
# to information_schema.tables, and fatal to the next restore, because
# the plain-format dump leads with `CREATE SCHEMA budget_api;`. That is
# exactly how drill run 39583824097 died on
# `schema "budget_api" already exists` immediately after cleanup
# reported "both destination schemas already empty; nothing to drop".
#
# So probe information_schema.schemata for schema EXISTENCE. Only a
# genuinely absent schema is a no-op; present-but-empty still gets
# dropped. Cleanup must leave the destination ABSENT, not
# recreated-empty -- restore.sh's schema-presence guard (added in
# commit 4d7d4cc0) refuses a destination that already holds either
# schema, and a `DROP … ; CREATE …;` sequence here would leave it
# present-but-empty and trip that guard the moment the next restore
# step runs. Schemas are recreated by pg_restore as part of its own
# DDL, so cleanup's job is done at "DROP".
_schema_exists() {
  local dsn="$1" schema="$2" found
  found="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${schema}';" \
    2>/dev/null | tr -d '[:space:]'
  )"
  [[ "${found:-0}" != "0" ]]
}

pre_tasks_schema_present=false
pre_budget_schema_present=false
if _schema_exists "$DEST_TASKS_DSN" tasks_api; then pre_tasks_schema_present=true; fi
if _schema_exists "$DEST_BUDGET_DSN" budget_api; then pre_budget_schema_present=true; fi

if [[ "$pre_tasks_schema_present" == "false" && "$pre_budget_schema_present" == "false" ]]; then
  cloud_db_info "cleanup: neither destination schema exists; nothing to drop"
  emitted_path="./artifacts/cloud-staging/cleanup-${CLOUD_DB_RUN_ID}.json"
  mkdir -p "$(dirname "$emitted_path")"
  python3 - "$emitted_path" "$CLOUD_DB_RUN_ID" "$pre_tasks_count" "$pre_budget_count" <<'PY'
import json, sys
out_path, run_id, pre_tasks, pre_budget = sys.argv[1:]
envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-cleanup-destination",
  "runId": run_id,
  "preCleanup": {
    "tasks_api":  {"tableCount": int(pre_tasks), "schemaPresent": False},
    "budget_api": {"tableCount": int(pre_budget), "schemaPresent": False},
  },
  "dropped": {
    "tasks_api":  [],
    "budget_api": [],
  },
  "recreated": [],
  "postCleanup": {
    "tasks_api":  {"schemaPresent": False},
    "budget_api": {"schemaPresent": False},
  },
  "verdict": "SCHEMAS_ABSENT",
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY
  printf '%s\n' "$emitted_path"
  exit 0
fi

# ---------------------------------------------------------------------------
# Drop the two service schemas. We use DROP SCHEMA ... CASCADE so
# the drop is atomic per-schema. We do NOT recreate them here on
# purpose: restore.sh's schema-presence guard (added in commit
# 4d7d4cc0) refuses a destination that already holds either schema,
# because the plain-format dump leads with `CREATE SCHEMA
# tasks_api;` and `CREATE SCHEMA budget_api;`. The guard is correct
# for the post-failure state (where pg_restore left the schema
# empty-but-present); cleanup must therefore take the destination
# all the way to ABSENT so the next restore sees a fresh slot. The
# two schemas are recreated by pg_restore's own DDL during the
# restore step; cleanup is the precondition, not the substitute.
#
# We do NOT touch the `public` schema or any role grants -- the
# staging database has no cross-schema dependencies and pg_dump
# --schema=... --schema=... reproduces the two target schemas on
# restore, so dropping them here is the minimum surface needed to
# make restore.sh's pre-flight pass.
# ---------------------------------------------------------------------------

cloud_db_info "cleanup: dropping tasks_api (schema present=${pre_tasks_schema_present}, pre-count=${pre_tasks_count}) and budget_api (schema present=${pre_budget_schema_present}, pre-count=${pre_budget_count})"

drop_start_epoch="$(date +%s)"

PGPASSWORD="" psql \
  --no-psqlrc --variable=ON_ERROR_STOP=1 \
  --dbname="$DEST_TASKS_DSN" \
  --command="DROP SCHEMA IF EXISTS tasks_api CASCADE;" \
  >/dev/null

PGPASSWORD="" psql \
  --no-psqlrc --variable=ON_ERROR_STOP=1 \
  --dbname="$DEST_BUDGET_DSN" \
  --command="DROP SCHEMA IF EXISTS budget_api CASCADE;" \
  >/dev/null

drop_end_epoch="$(date +%s)"

# Post-cleanup assertion: both schemas must now be ABSENT. The
# previous version of this script dropped and recreated them empty,
# leaving them present-but-empty -- which is exactly the state
# restore.sh's schema-presence guard now refuses (drill run
# 39594803615 died on this combination). An absent schema is
# satisfied by a zero-table count too, so this is the only
# assertion that distinguishes "fresh" from "present but empty".
post_tasks_present=true
post_budget_present=true
if ! _schema_exists "$DEST_TASKS_DSN" tasks_api; then post_tasks_present=false; fi
if ! _schema_exists "$DEST_BUDGET_DSN" budget_api; then post_budget_present=false; fi

if [[ "$post_tasks_present" != "false" || "$post_budget_present" != "false" ]]; then
  cloud_db_die \
    "post-cleanup assertion failed: tasks_api present=${post_tasks_present}, budget_api present=${post_budget_present}; both must be ABSENT before restore runs. Refusing to proceed -- the previous behavior of leaving present-but-empty would trip restore.sh's schema-presence guard."
fi

# ---------------------------------------------------------------------------
# Emit the cleanup envelope. Verdict is SCHEMAS_ABSENT (same
# verdict the no-op early-return emits) so a downstream consumer
# cannot tell apart "schemas were absent" from "cleanup just dropped
# them". The `recreated` field records the empty list -- the
# schemas are recreated by pg_restore, not by cleanup.
# ---------------------------------------------------------------------------

emitted_path="./artifacts/cloud-staging/cleanup-${CLOUD_DB_RUN_ID}.json"
mkdir -p "$(dirname "$emitted_path")"

python3 - "$emitted_path" "$CLOUD_DB_RUN_ID" \
        "$pre_tasks_count" "$pre_budget_count" \
        "$pre_tasks_schema_present" "$pre_budget_schema_present" \
        "$drop_start_epoch" "$drop_end_epoch" <<'PY'
import json, sys
out_path, run_id, pre_t, pre_b, pre_t_present, pre_b_present, start, end = sys.argv[1:]
envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-cleanup-destination",
  "runId": run_id,
  "preCleanup": {
    "tasks_api":  {"tableCount": int(pre_t), "schemaPresent": pre_t_present == "true"},
    "budget_api": {"tableCount": int(pre_b), "schemaPresent": pre_b_present == "true"},
  },
  "dropped": {
    "tasks_api":  ["CASCADE"],
    "budget_api": ["CASCADE"],
  },
  "recreated": [],
  "postCleanup": {
    "tasks_api":  {"schemaPresent": False},
    "budget_api": {"schemaPresent": False},
  },
  "startEpoch": int(start),
  "endEpoch":   int(end),
  "durationSeconds": int(end) - int(start),
  "verdict": "SCHEMAS_ABSENT",
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "cleanup: dropped tasks_api (${pre_tasks_count} tables) + budget_api (${pre_budget_count} tables); schemas now absent"
printf '%s\n' "$emitted_path"
