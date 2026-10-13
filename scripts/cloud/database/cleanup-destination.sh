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

# If both schemas are already empty, the cleanup is a no-op. Still
# record the envelope so the audit trail is complete and the
# operator sees the explicit "already clean" verdict.
if [[ "$pre_tasks_count" == "0" && "$pre_budget_count" == "0" ]]; then
  cloud_db_info "cleanup: both destination schemas already empty; nothing to drop"
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
    "tasks_api":  {"tableCount": int(pre_tasks)},
    "budget_api": {"tableCount": int(pre_budget)},
  },
  "dropped": {
    "tasks_api":  [],
    "budget_api": [],
  },
  "recreated": ["tasks_api", "budget_api"],
  "verdict": "ALREADY_EMPTY",
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY
  printf '%s\n' "$emitted_path"
  exit 0
fi

# ---------------------------------------------------------------------------
# Drop and recreate the two service schemas. We use DROP SCHEMA
# ... CASCADE so the cleanup is atomic per-schema; CREATE SCHEMA
# recreates the empty targets. We do NOT touch the `public` schema
# or any role grants — the staging database has no cross-schema
# dependencies and pg_dump --schema=... --schema=... reproduces the
# two target schemas on restore, so dropping them here is the
# minimum surface needed to make restore.sh's non-empty check pass.
# ---------------------------------------------------------------------------

cloud_db_info "cleanup: dropping tasks_api (pre-count=${pre_tasks_count}) and budget_api (pre-count=${pre_budget_count})"

drop_start_epoch="$(date +%s)"

PGPASSWORD="" psql \
  --no-psqlrc --variable=ON_ERROR_STOP=1 \
  --dbname="$DEST_TASKS_DSN" \
  --command="DROP SCHEMA IF EXISTS tasks_api CASCADE; CREATE SCHEMA tasks_api;" \
  >/dev/null

PGPASSWORD="" psql \
  --no-psqlrc --variable=ON_ERROR_STOP=1 \
  --dbname="$DEST_BUDGET_DSN" \
  --command="DROP SCHEMA IF EXISTS budget_api CASCADE; CREATE SCHEMA budget_api;" \
  >/dev/null

drop_end_epoch="$(date +%s)"

# Post-cleanup assertion: both schemas now exist and are empty.
post_tasks_count="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_TASKS_DSN" \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'tasks_api';" \
    2>/dev/null | tr -d '[:space:]'
)"
post_budget_count="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_BUDGET_DSN" \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'budget_api';" \
    2>/dev/null | tr -d '[:space:]'
)"

if [[ "$post_tasks_count" != "0" || "$post_budget_count" != "0" ]]; then
  cloud_db_die \
    "post-cleanup assertion failed: tasks_api has ${post_tasks_count} tables, budget_api has ${post_budget_count}; refusing to proceed"
fi

# ---------------------------------------------------------------------------
# Emit the cleanup envelope
# ---------------------------------------------------------------------------

emitted_path="./artifacts/cloud-staging/cleanup-${CLOUD_DB_RUN_ID}.json"
mkdir -p "$(dirname "$emitted_path")"

python3 - "$emitted_path" "$CLOUD_DB_RUN_ID" \
        "$pre_tasks_count" "$pre_budget_count" \
        "$post_tasks_count" "$post_budget_count" \
        "$drop_start_epoch" "$drop_end_epoch" <<'PY'
import json, sys
out_path, run_id, pre_t, pre_b, post_t, post_b, start, end = sys.argv[1:]
envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-cleanup-destination",
  "runId": run_id,
  "preCleanup": {
    "tasks_api":  {"tableCount": int(pre_t)},
    "budget_api": {"tableCount": int(pre_b)},
  },
  "dropped": {
    "tasks_api":  ["CASCADE"],
    "budget_api": ["CASCADE"],
  },
  "recreated": ["tasks_api", "budget_api"],
  "postCleanup": {
    "tasks_api":  {"tableCount": int(post_t)},
    "budget_api": {"tableCount": int(post_b)},
  },
  "startEpoch": int(start),
  "endEpoch":   int(end),
  "durationSeconds": int(end) - int(start),
  "verdict": "CLEANED",
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "cleanup: dropped tasks_api (${pre_tasks_count} tables) + budget_api (${pre_budget_count} tables); both recreated empty"
printf '%s\n' "$emitted_path"
