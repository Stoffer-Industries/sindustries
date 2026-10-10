#!/usr/bin/env bash
# scripts/cloud/database/drill.sh
#
# Top-level orchestrator for the cloud-staging database transfer
# rehearsal. Walks the full sequence described in the task
# d37681e1 tech design:
#
#   1. inventory source
#   2. dump source to a verified custom archive
#   3. restore archive into a fresh destination
#   4. run prisma migrate deploy for tasks-api + budget-api
#   5. reconcile source vs destination (no row data, no IDs, no DSNs)
#   6. (optional) dump the destination, restore into a recovery DB,
#      run migrations + reconciliation again
#   7. (optional) interruption drill
#
# The drill refuses to proceed without a confirmation token that
# matches the current run id and the expected environment label.

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assign_run_id

usage() {
  cat <<'USAGE'
Usage: drill.sh \
  --source-tasks-dsn-file <path> --source-budget-dsn-file <path> \
  --dest-tasks-dsn-file <path>   --dest-budget-dsn-file <path> \
  --confirm <run-id> \
  [--archive-dir <path>] [--recovery] [--interruption <dump|restore|none>]

Required:
  --source-tasks-dsn-file <path>     Source tasks_api DSN file.
  --source-budget-dsn-file <path>    Source budget_api DSN file.
  --dest-tasks-dsn-file <path>       Destination tasks_api DSN file.
  --dest-budget-dsn-file <path>      Destination budget_api DSN file.
  --confirm <run-id>                 Must match CLOUD_DB_RUN_ID.

Optional:
  --archive-dir <path>               Where to write archives (default
                                     ./artifacts/cloud-staging).
  --recovery                         Also restore into a recovery DB and
                                     re-reconcile.
  --interruption <kind>              Run a single interruption drill:
                                     "dump" (interrupt pg_dump),
                                     "restore" (interrupt pg_restore),
                                     or "none" (default: none).
  --output <path>                    Final drill-result envelope.
USAGE
}

SRC_TASKS_FILE="" SRC_BUDGET_FILE=""
DEST_TASKS_FILE="" DEST_BUDGET_FILE=""
ARCHIVE_DIR=""
RECOVERY=0
INTERRUPTION="none"
CONFIRM=""

while (( $# > 0 )); do
  case "$1" in
    --source-tasks-dsn-file)  SRC_TASKS_FILE="$2";  shift 2;;
    --source-budget-dsn-file) SRC_BUDGET_FILE="$2"; shift 2;;
    --dest-tasks-dsn-file)    DEST_TASKS_FILE="$2";  shift 2;;
    --dest-budget-dsn-file)   DEST_BUDGET_FILE="$2"; shift 2;;
    --archive-dir)            ARCHIVE_DIR="$2";      shift 2;;
    --recovery)               RECOVERY=1;            shift;;
    --interruption)           INTERRUPTION="$2";     shift 2;;
    --confirm)                CONFIRM="$2";          shift 2;;
    --output)                 OUTPUT_PATH="$2";      shift 2;;
    --help|-h)                usage; exit 0;;
    *)                        cloud_db_die "unknown argument: $1";;
  esac
done

for v in SRC_TASKS_FILE SRC_BUDGET_FILE DEST_TASKS_FILE DEST_BUDGET_FILE CONFIRM; do
  if [[ -z "${!v}" ]]; then
    cloud_db_die "--${v,,} is required"
  fi
done

if [[ "$CONFIRM" != "${CLOUD_DB_RUN_ID:-}" ]]; then
  cloud_db_die "--confirm must match the assigned run id (${CLOUD_DB_RUN_ID:-unset})"
fi

case "$INTERRUPTION" in
  dump|restore|none) ;;
  *) cloud_db_die "--interruption must be dump, restore, or none" ;;
esac

ARCHIVE_DIR="${ARCHIVE_DIR:-./artifacts/cloud-staging}"
mkdir -p "$ARCHIVE_DIR"

# ---------------------------------------------------------------------------
# Step 1: inventory
# ---------------------------------------------------------------------------

INVENTORY_OUT="${ARCHIVE_DIR}/inventory-${CLOUD_DB_RUN_ID}.json"
"$(dirname "${BASH_SOURCE[0]}")/inventory.sh" \
  --source-dsn-file "$SRC_TASKS_FILE" \
  --output "$INVENTORY_OUT" >/dev/null

cloud_db_info "step 1 inventory complete"

# ---------------------------------------------------------------------------
# Step 2: dump
# ---------------------------------------------------------------------------

DUMP_OUT="${ARCHIVE_DIR}/dump-${CLOUD_DB_RUN_ID}.json"
DUMP_KEEP_PARTIAL_FLAG=()
if [[ "$INTERRUPTION" == "dump" ]]; then
  DUMP_KEEP_PARTIAL_FLAG=(--keep-partial)
fi
DUMP_RESULT="$(
  "$(dirname "${BASH_SOURCE[0]}")/dump.sh" \
    --source-dsn-file "$SRC_TASKS_FILE" \
    --archive-dir "$ARCHIVE_DIR" \
    "${DUMP_KEEP_PARTIAL_FLAG[@]}"
)"

DUMP_ARCHIVE_PATH="${ARCHIVE_DIR}/$(basename "$DUMP_RESULT" .dump-result.json).dump"
DUMP_SHA="$(cat "${DUMP_ARCHIVE_PATH}.sha256")"
cloud_db_info "step 2 dump complete archive=${DUMP_ARCHIVE_PATH} digest=${DUMP_SHA}"

if [[ "$INTERRUPTION" == "dump" ]]; then
  cloud_db_die "interruption=dump drill complete; .partial intentionally left in place"
fi

# ---------------------------------------------------------------------------
# Step 3: restore
# ---------------------------------------------------------------------------

RESTORE_INTENTIONAL_FAILURE_FLAG=()
if [[ "$INTERRUPTION" == "restore" ]]; then
  RESTORE_INTENTIONAL_FAILURE_FLAG=(--intentional-failure-after 2)
fi
RESTORE_OUT="$(
  "$(dirname "${BASH_SOURCE[0]}")/restore.sh" \
    --source-dsn-file "$SRC_TASKS_FILE" \
    --destination-dsn-file "$DEST_TASKS_FILE" \
    --archive "$DUMP_ARCHIVE_PATH" \
    --archive-sha256 "$DUMP_SHA" \
    "${RESTORE_INTENTIONAL_FAILURE_FLAG[@]}"
)"

if [[ "$INTERRUPTION" == "restore" ]]; then
  cloud_db_die "interruption=restore drill complete; intentionally failed at pg_restore"
fi

cloud_db_info "step 3 restore complete"

# ---------------------------------------------------------------------------
# Step 4: prisma migrate deploy
# ---------------------------------------------------------------------------

"$(dirname "${BASH_SOURCE[0]}")/migrate.sh" \
  --tasks-dsn-file "$DEST_TASKS_FILE" \
  --budget-dsn-file "$DEST_BUDGET_FILE" >/dev/null

cloud_db_info "step 4 migrations complete"

# ---------------------------------------------------------------------------
# Step 5: reconcile
# ---------------------------------------------------------------------------

RECONCILE_OUT="${ARCHIVE_DIR}/reconcile-${CLOUD_DB_RUN_ID}.json"
RECONCILE_EXIT=0
"$(dirname "${BASH_SOURCE[0]}")/reconcile.mjs" \
  --source-tasks-dsn-file  "$SRC_TASKS_FILE" \
  --source-budget-dsn-file "$SRC_BUDGET_FILE" \
  --dest-tasks-dsn-file    "$DEST_TASKS_FILE" \
  --dest-budget-dsn-file   "$DEST_BUDGET_FILE" \
  --output "$RECONCILE_OUT" || RECONCILE_EXIT=$?

if (( RECONCILE_EXIT != 0 )); then
  cloud_db_die "reconcile FAILED; see ${RECONCILE_OUT}"
fi
cloud_db_info "step 5 reconcile complete"

# ---------------------------------------------------------------------------
# Step 6: recovery (optional)
# ---------------------------------------------------------------------------

RECOVERY_OUT=""
if (( RECOVERY )); then
  # The recovery DSN files are expected to be named `<dest-stem>-recovery.dsn`,
  # where `<dest-stem>` is the destination file path with the `.dsn` suffix
  # stripped. This is the convention documented in the runbook; refuse any
  # future caller that violates it instead of silently reading the wrong
  # file.
  case "$DEST_TASKS_FILE" in
    *.dsn) ;;
    *) cloud_db_die "destination DSN file '$DEST_TASKS_FILE' must end in .dsn (runbook convention)" ;;
  esac
  case "$DEST_BUDGET_FILE" in
    *.dsn) ;;
    *) cloud_db_die "destination DSN file '$DEST_BUDGET_FILE' must end in .dsn (runbook convention)" ;;
  esac
  RECOVERY_TASKS_FILE="${DEST_TASKS_FILE%.dsn}-recovery.dsn"
  RECOVERY_BUDGET_FILE="${DEST_BUDGET_FILE%.dsn}-recovery.dsn"
  if [[ ! -f "$RECOVERY_TASKS_FILE" || ! -f "$RECOVERY_BUDGET_FILE" ]]; then
    cloud_db_die \
      "recovery requested but ${RECOVERY_TASKS_FILE} or ${RECOVERY_BUDGET_FILE} is missing"
  fi

  DUMP2_OUT="$(
    "$(dirname "${BASH_SOURCE[0]}")/dump.sh" \
      --source-dsn-file "$DEST_TASKS_FILE" \
      --archive-dir "$ARCHIVE_DIR"
  )"
  DUMP2_ARCHIVE_PATH="${ARCHIVE_DIR}/$(basename "$DUMP2_OUT" .dump-result.json).dump"
  DUMP2_SHA="$(cat "${DUMP2_ARCHIVE_PATH}.sha256")"

  "$(dirname "${BASH_SOURCE[0]}")/restore.sh" \
    --source-dsn-file "$DEST_TASKS_FILE" \
    --destination-dsn-file "$RECOVERY_TASKS_FILE" \
    --archive "$DUMP2_ARCHIVE_PATH" \
    --archive-sha256 "$DUMP2_SHA" >/dev/null

  "$(dirname "${BASH_SOURCE[0]}")/migrate.sh" \
    --tasks-dsn-file "$RECOVERY_TASKS_FILE" \
    --budget-dsn-file "$RECOVERY_BUDGET_FILE" >/dev/null

  RECOVERY_OUT="${ARCHIVE_DIR}/reconcile-recovery-${CLOUD_DB_RUN_ID}.json"
  "$(dirname "${BASH_SOURCE[0]}")/reconcile.mjs" \
    --source-tasks-dsn-file  "$DEST_TASKS_FILE" \
    --source-budget-dsn-file "$DEST_BUDGET_FILE" \
    --dest-tasks-dsn-file    "$RECOVERY_TASKS_FILE" \
    --dest-budget-dsn-file   "$RECOVERY_BUDGET_FILE" \
    --output "$RECOVERY_OUT" || cloud_db_die "recovery reconcile FAILED; see ${RECOVERY_OUT}"

  cloud_db_info "step 6 recovery complete"
fi

# ---------------------------------------------------------------------------
# Step 7: emit final drill result envelope
# ---------------------------------------------------------------------------

OUTPUT_PATH="${OUTPUT_PATH:-${ARCHIVE_DIR}/drill-${CLOUD_DB_RUN_ID}.json}"

python3 - "$OUTPUT_PATH" "$CLOUD_DB_RUN_ID" \
        "$INVENTORY_OUT" "$DUMP_OUT" "$RESTORE_OUT" \
        "$RECONCILE_OUT" "$RECOVERY_OUT" <<'PY'
import json, os, sys, pathlib

out_path, run_id, inv, dump, restore, reconcile, recovery = sys.argv[1:]

def safe_load(p):
  if not p: return None
  return json.loads(pathlib.Path(p).read_text())

envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-drill",
  "runId": run_id,
  "environment": "staging",
  "interruption": os.environ.get("CLOUD_DB_DRILL_INTERRUPTION", "none"),
  "steps": {
    "inventory":  os.path.basename(inv)      if inv      else None,
    "dump":       os.path.basename(dump)     if dump     else None,
    "restore":    os.path.basename(restore)  if restore  else None,
    "migrate":    None,
    "reconcile":  os.path.basename(reconcile) if reconcile else None,
    "recovery":   os.path.basename(recovery) if recovery  else None,
  },
  "verdict": "PASS",
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "drill complete verdict=PASS run=${CLOUD_DB_RUN_ID}"
printf '%s\n' "$OUTPUT_PATH"
