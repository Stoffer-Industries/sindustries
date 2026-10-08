#!/usr/bin/env bash
# scripts/cloud/database/restore.sh
#
# Restores a verified archive into a fresh cloud staging destination.
# Refuses to:
#   - operate against any target not in the allowed environment list
#   - operate against any database name without the staging prefix
#   - operate against any DSN that resolves to the source host
#   - resume or retry against a non-empty destination
#   - silently accept a partial restore
#
# A failed attempt is quarantined by tagging the destination database
# with a `<run-id>-failed` marker (logical only — the database is left
# in place for the operator to drop, never overwritten by a retry).

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assert_required_commands

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: restore.sh \
  --source-dsn-file <path> \
  --destination-dsn-file <path> \
  --archive <path> \
  --archive-sha256 <digest>
  [--intentional-failure-after <seconds>]

Required:
  --source-dsn-file <path>       Mode-0600 source DSN file (used only for
                                 inequality check; no source data is read).
  --destination-dsn-file <path>  Mode-0600 destination DSN file. Must end
                                 in a fresh, empty database.
  --archive <path>               Path to the .dump archive.
  --archive-sha256 <digest>      Expected sha256 digest (64 hex chars).

Optional:
  --intentional-failure-after <seconds>
                                 Drill-only flag. When set, restore.sh
                                 starts pg_restore, waits the given
                                 number of seconds, then SIGTERMs
                                 pg_restore and exits non-zero with
                                 a clear 'intentional failure' message.
                                 Demonstrates the AC4 failure-and-retry
                                 surface; never used in production runs.
USAGE
}

SOURCE_DSN_FILE=""
DEST_DSN_FILE=""
ARCHIVE_PATH=""
EXPECTED_SHA=""
INTENTIONAL_FAILURE_AFTER=""

while (( $# > 0 )); do
  case "$1" in
    --source-dsn-file)            SOURCE_DSN_FILE="$2"; shift 2;;
    --destination-dsn-file)       DEST_DSN_FILE="$2"; shift 2;;
    --archive)                    ARCHIVE_PATH="$2"; shift 2;;
    --archive-sha256)             EXPECTED_SHA="$2"; shift 2;;
    --intentional-failure-after)  INTENTIONAL_FAILURE_AFTER="$2"; shift 2;;
    --help|-h)                    usage; exit 0;;
    *)                            cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$SOURCE_DSN_FILE" || -z "$DEST_DSN_FILE" || \
      -z "$ARCHIVE_PATH" || -z "$EXPECTED_SHA" ]]; then
  cloud_db_die "all four --source-dsn-file, --destination-dsn-file, --archive, --archive-sha256 are required"
fi

if [[ -n "$INTENTIONAL_FAILURE_AFTER" ]]; then
  if ! [[ "$INTENTIONAL_FAILURE_AFTER" =~ ^[0-9]+$ ]] || (( INTENTIONAL_FAILURE_AFTER < 1 )); then
    cloud_db_die "--intentional-failure-after must be a positive integer"
  fi
fi

cloud_db_assert_environment "staging"
cloud_db_assign_run_id

# ---------------------------------------------------------------------------
# Load + verify DSNs + archive
# ---------------------------------------------------------------------------

cloud_db_load_secret SOURCE_DSN "$SOURCE_DSN_FILE"
cloud_db_load_secret DEST_DSN "$DEST_DSN_FILE"
cloud_db_assert_no_production_dsn "source" "$SOURCE_DSN"
cloud_db_assert_no_production_dsn "destination" "$DEST_DSN"
cloud_db_assert_inequality "source" "$SOURCE_DSN" "destination" "$DEST_DSN"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  cloud_db_die "archive '$ARCHIVE_PATH' not found"
fi

# Verify sha256 BEFORE touching the destination.
ACTUAL_SHA="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  cloud_db_die "archive sha256 mismatch; expected=$EXPECTED_SHA actual=$ACTUAL_SHA"
fi

# Reject any destination database that already has objects. A fresh,
# empty destination is the only safe target.
existing_objects="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_DSN" \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('tasks_api','budget_api','public');"
)"
if [[ "${existing_objects// /}" != "0" ]]; then
  cloud_db_die \
    "destination is not empty (existing object count: ${existing_objects}); refusing to overwrite"
fi

RESULT_PATH="./artifacts/cloud-staging/restore-${CLOUD_DB_RUN_ID}.json"
mkdir -p "$(dirname "$RESULT_PATH")"

# ---------------------------------------------------------------------------
# Execute pg_restore
# ---------------------------------------------------------------------------

cloud_db_info "starting pg_restore run=${CLOUD_DB_RUN_ID}"
restore_start_epoch="$(date +%s)"

# Use --exit-on-error so a SQL error fails the whole restore; --no-owner
# and --no-acl so the destination is the source of privilege truth.
if [[ -n "$INTENTIONAL_FAILURE_AFTER" ]]; then
  # Drill-only failure injection. Start pg_restore, wait the given
  # number of seconds, then SIGTERM it. The destination is left in
  # a partial state; the operator-driven quarantine + re-restore
  # procedure is documented in the runbook.
  PGPASSWORD="" pg_restore \
    --exit-on-error \
    --no-owner \
    --no-acl \
    --no-password \
    --dbname="$DEST_DSN" \
    "$ARCHIVE_PATH" \
    >"${RESULT_PATH%.json}.log" 2>&1 &
  PGPID=$!
  trap "kill -TERM '$PGPID' 2>/dev/null || true" INT TERM
  sleep "$INTENTIONAL_FAILURE_AFTER"
  cloud_db_info "intentional failure drill: sending SIGTERM to pg_restore (pid=$PGPID) after ${INTENTIONAL_FAILURE_AFTER}s"
  kill -TERM "$PGPID" 2>/dev/null || true
  wait "$PGPID" || true
  cloud_db_die "intentional failure drill: pg_restore killed at ${INTENTIONAL_FAILURE_AFTER}s; see ${RESULT_PATH%.json}.log"
fi

PGPASSWORD="" pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --no-password \
  --dbname="$DEST_DSN" \
  "$ARCHIVE_PATH" \
  >"${RESULT_PATH%.json}.log" 2>&1 \
  || cloud_db_die "pg_restore failed; see ${RESULT_PATH%.json}.log"

restore_end_epoch="$(date +%s)"

# ---------------------------------------------------------------------------
# Verify restore produced both schemas
# ---------------------------------------------------------------------------

restored_schemas="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_DSN" \
    --command="SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('tasks_api','budget_api');"
)"

if [[ -z "$restored_schemas" || "$restored_schemas" != *"tasks_api"* || "$restored_schemas" != *"budget_api"* ]]; then
  cloud_db_die \
    "post-restore schema check failed; expected both tasks_api and budget_api, got '$restored_schemas'"
fi

# ---------------------------------------------------------------------------
# Emit result envelope
# ---------------------------------------------------------------------------

python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$EXPECTED_SHA" \
        "$restore_start_epoch" "$restore_end_epoch" "$restored_schemas" \
        "$(stat -c %s "$ARCHIVE_PATH" 2>/dev/null || stat -f %z "$ARCHIVE_PATH")" <<'PY'
import json, sys

out_path, run_id, expected_sha, start_epoch, end_epoch, schemas, size_bytes = sys.argv[1:]

envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-restore",
  "runId": run_id,
  "archiveSha256": expected_sha,
  "archiveSizeBytes": int(size_bytes),
  "startEpoch": int(start_epoch),
  "endEpoch": int(end_epoch),
  "durationSeconds": int(end_epoch) - int(start_epoch),
  "restoredSchemas": [s for s in schemas.split(",") if s],
  "exitOnError": True,
  "noOwner": True,
  "noAcl": True,
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "restore complete: schemas=${restored_schemas} archive_digest=${EXPECTED_SHA}"
printf '%s\n' "$RESULT_PATH"
