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
#   4. run prisma migrate deploy for tasks-api + content-scheduler-api
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
  --source-tasks-dsn-file <path> --source-content-scheduler-dsn-file <path> \
  --dest-tasks-dsn-file <path>   --dest-content-scheduler-dsn-file <path> \
  --confirm <run-id> \
  [--archive-dir <path>] [--recovery] [--interruption <dump|restore|none>] \
  [--cleanup-destination]

Required:
  --source-tasks-dsn-file <path>     Source tasks_api DSN file.
  --source-content-scheduler-dsn-file <path>    Source content_scheduler DSN file.
  --dest-tasks-dsn-file <path>       Destination tasks_api DSN file.
  --dest-content-scheduler-dsn-file <path>      Destination content_scheduler DSN file.
  --confirm <run-id>                 Must match CLOUD_DB_RUN_ID.

Optional:
  --archive-dir <path>               Where to write archives (default:
                                     the environment's artifact directory,
                                     ./artifacts/cloud-staging or
                                     ./artifacts/cloud-production).
  --environment <staging|production> Environment label. Defaults to the
                                     ENVIRONMENT environment variable, then
                                     "staging". A production run also
                                     requires CLOUD_DB_PRODUCTION_ACK=1.
  --expected-host <host>             Declares an endpoint this run may
                                     touch. Repeatable. A production run
                                     MUST declare every endpoint it
                                     touches.
  --recovery                         Also restore into a recovery DB and
                                     re-reconcile. The recovery target
                                     must be its own endpoint: the drill
                                     refuses a recovery DSN that shares a
                                     host with the source or the
                                     destination.
  --recovery-tasks-dsn-file <path>    Recovery tasks_api DSN file.
                                     Required with --recovery.
  --recovery-content-scheduler-dsn-file <path>
                                     Recovery content_scheduler DSN file.
                                     Required with --recovery.
  --interruption <kind>              Run a single interruption drill:
                                     "dump" (interrupt pg_dump),
                                     "restore" (interrupt pg_restore),
                                     or "none" (default: none).
  --cleanup-destination              Operator-only. Before restore,
                                     drop and recreate the
                                     tasks_api and content_scheduler schemas
                                     in the destination database so
                                     the restore target is empty.
                                     Requires CLEANUP_DESTINATION=1 in
                                     the environment (two-key auth) and
                                     is wired to a workflow_dispatch
                                     input on the staging workflow.
  --output <path>                    Final drill-result envelope.
USAGE
}

SRC_TASKS_FILE="" SRC_CONTENT_SCHEDULER_FILE=""
DEST_TASKS_FILE="" DEST_CONTENT_SCHEDULER_FILE=""
RECOVERY_TASKS_FILE="" RECOVERY_CONTENT_SCHEDULER_FILE=""
ARCHIVE_DIR=""
RECOVERY=0
INTERRUPTION="none"
CLEANUP_DESTINATION_FLAG=0
CONFIRM=""
ENVIRONMENT="${ENVIRONMENT:-staging}"

while (( $# > 0 )); do
  case "$1" in
    --source-tasks-dsn-file)  SRC_TASKS_FILE="$2";  shift 2;;
    --source-content-scheduler-dsn-file) SRC_CONTENT_SCHEDULER_FILE="$2"; shift 2;;
    --dest-tasks-dsn-file)    DEST_TASKS_FILE="$2";  shift 2;;
    --dest-content-scheduler-dsn-file)   DEST_CONTENT_SCHEDULER_FILE="$2"; shift 2;;
    --archive-dir)            ARCHIVE_DIR="$2";      shift 2;;
    --environment)            ENVIRONMENT="$2";      shift 2;;
    --expected-host)          cloud_db_add_expected_host "$2"; shift 2;;
    --recovery)               RECOVERY=1;            shift;;
    --recovery-tasks-dsn-file)         RECOVERY_TASKS_FILE="$2"; shift 2;;
    --recovery-content-scheduler-dsn-file) RECOVERY_CONTENT_SCHEDULER_FILE="$2"; shift 2;;
    --interruption)           INTERRUPTION="$2";     shift 2;;
    --cleanup-destination)    CLEANUP_DESTINATION_FLAG=1; shift;;
    --confirm)                CONFIRM="$2";          shift 2;;
    --output)                 OUTPUT_PATH="$2";      shift 2;;
    --help|-h)                usage; exit 0;;
    *)                        cloud_db_die "unknown argument: $1";;
  esac
done

cloud_db_set_environment "$ENVIRONMENT"
cloud_db_load_expected_targets_from_env
cloud_db_assert_production_ack

# Every sub-script receives the same environment label and the same
# declared endpoint allowlist, so no step can drift to a different
# environment or endpoint than the one the operator authorised.
EXPECTED_HOST_FLAGS=()
for host in "${CLOUD_DB_TARGET_HOSTS[@]}"; do
  EXPECTED_HOST_FLAGS+=(--expected-host "$host")
done

for v in SRC_TASKS_FILE SRC_CONTENT_SCHEDULER_FILE DEST_TASKS_FILE DEST_CONTENT_SCHEDULER_FILE CONFIRM; do
  if [[ -z "${!v}" ]]; then
    cloud_db_die "--${v,,} is required"
  fi
done

# Two-key auth for the destructive operator action: the CLI flag
# confirms intent at the call site, and CLEANUP_DESTINATION=1 in the
# environment is the second factor that the operator (or the
# workflow_dispatch input that maps to it) must explicitly set.
# Refuse if either is missing.
if [[ "$CLEANUP_DESTINATION_FLAG" -eq 1 && "${CLEANUP_DESTINATION:-0}" != "1" ]]; then
  cloud_db_die "--cleanup-destination requires CLEANUP_DESTINATION=1 in the environment"
fi

if [[ "$CONFIRM" != "${CLOUD_DB_RUN_ID:-}" ]]; then
  cloud_db_die "--confirm must match the assigned run id (${CLOUD_DB_RUN_ID:-unset})"
fi

case "$INTERRUPTION" in
  dump|restore|none) ;;
  *) cloud_db_die "--interruption must be dump, restore, or none" ;;
esac

ARCHIVE_DIR="${ARCHIVE_DIR:-$CLOUD_DB_ARTIFACT_DIR}"
mkdir -p "$ARCHIVE_DIR"

# ---------------------------------------------------------------------------
# Step 1: inventory
# ---------------------------------------------------------------------------

INVENTORY_OUT="${ARCHIVE_DIR}/inventory-${CLOUD_DB_RUN_ID}.json"
"$(dirname "${BASH_SOURCE[0]}")/inventory.sh" \
  --source-dsn-file "$SRC_TASKS_FILE" \
  --output "$INVENTORY_OUT" \
  --environment "$ENVIRONMENT" \
  "${EXPECTED_HOST_FLAGS[@]}" >/dev/null

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
    --environment "$ENVIRONMENT" \
    "${EXPECTED_HOST_FLAGS[@]}" \
    "${DUMP_KEEP_PARTIAL_FLAG[@]}"
)"

DUMP_ARCHIVE_PATH="${ARCHIVE_DIR}/$(basename "$DUMP_RESULT" .dump-result.json).dump"
DUMP_SHA="$(cat "${DUMP_ARCHIVE_PATH}.sha256")"
cloud_db_info "step 2 dump complete archive=${DUMP_ARCHIVE_PATH} digest=${DUMP_SHA}"

if [[ "$INTERRUPTION" == "dump" ]]; then
  cloud_db_die "interruption=dump drill complete; .partial intentionally left in place"
fi

# ---------------------------------------------------------------------------
# Step 2.5: optional destination cleanup (operator only). The
# cleanup-destination.sh script drops the tasks_api and content_scheduler
# schemas and leaves them absent; pg_restore recreates them as part
# of its own DDL during the restore step. The two-key auth (CLI
# flag + env var) is enforced in cleanup-destination.sh itself;
# the drill orchestrator just decides whether to invoke it.
# ---------------------------------------------------------------------------

CLEANUP_OUT=""
if [[ "$CLEANUP_DESTINATION_FLAG" -eq 1 ]]; then
  CLEANUP_OUT="$(
    "$(dirname "${BASH_SOURCE[0]}")/cleanup-destination.sh" \
      --source-tasks-dsn-file "$SRC_TASKS_FILE" \
      --dest-tasks-dsn-file   "$DEST_TASKS_FILE" \
      --dest-content-scheduler-dsn-file  "$DEST_CONTENT_SCHEDULER_FILE" \
      --confirm "$CONFIRM" \
      --confirm-cleanup-destination \
      --environment "$ENVIRONMENT" \
      "${EXPECTED_HOST_FLAGS[@]}"
  )"
  cloud_db_info "step 2.5 destination cleanup complete envelope=${CLEANUP_OUT}"
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
    --destination-content-scheduler-dsn-file "$DEST_CONTENT_SCHEDULER_FILE" \
    --archive "$DUMP_ARCHIVE_PATH" \
    --archive-sha256 "$DUMP_SHA" \
    --result-dir "$ARCHIVE_DIR" \
    --environment "$ENVIRONMENT" \
    "${EXPECTED_HOST_FLAGS[@]}" \
    "${RESTORE_INTENTIONAL_FAILURE_FLAG[@]}"
)"

if [[ "$INTERRUPTION" == "restore" ]]; then
  cloud_db_die "interruption=restore drill complete; intentionally failed at pg_restore"
fi

cloud_db_info "step 3 restore complete"

# ---------------------------------------------------------------------------
# Step 4: prisma migrate deploy
# ---------------------------------------------------------------------------

MIGRATE_OUT="$("$(dirname "${BASH_SOURCE[0]}")/migrate.sh" \
  --tasks-dsn-file "$DEST_TASKS_FILE" \
  --content-scheduler-dsn-file "$DEST_CONTENT_SCHEDULER_FILE" \
  --result-dir "$ARCHIVE_DIR" \
  --environment "$ENVIRONMENT" \
  "${EXPECTED_HOST_FLAGS[@]}")"

cloud_db_info "step 4 migrations complete"

# ---------------------------------------------------------------------------
# Step 5: reconcile
# ---------------------------------------------------------------------------

RECONCILE_OUT="${ARCHIVE_DIR}/reconcile-${CLOUD_DB_RUN_ID}.json"
RECONCILE_EXIT=0
"$(dirname "${BASH_SOURCE[0]}")/reconcile.mjs" \
  --source-tasks-dsn-file  "$SRC_TASKS_FILE" \
  --source-content-scheduler-dsn-file "$SRC_CONTENT_SCHEDULER_FILE" \
  --dest-tasks-dsn-file    "$DEST_TASKS_FILE" \
  --dest-content-scheduler-dsn-file   "$DEST_CONTENT_SCHEDULER_FILE" \
  --environment "$ENVIRONMENT" \
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
  # The recovery target is an EXPLICIT pair of DSN files. It used to be
  # derived from the destination file names (`<dest-stem>-recovery.dsn`),
  # which was a convention the workflows did not actually follow: the
  # production and staging workflows both wrote `tasks-recovery.dsn`
  # while the drill looked for `tasks-dest-tasks-dest-recovery.dsn`, so
  # the recovery path failed on a missing file. An explicit argument
  # cannot drift from the caller's naming.
  if [[ -z "$RECOVERY_TASKS_FILE" || -z "$RECOVERY_CONTENT_SCHEDULER_FILE" ]]; then
    cloud_db_die \
      "recovery requested but --recovery-tasks-dsn-file / --recovery-content-scheduler-dsn-file were not provided"
  fi

  # ISOLATION. The recovery target proves that a verified backup restores
  # into a usable state, so it must be a database of its own:
  #   * NOT the destination — restoring the archive into the destination
  #     and then reconciling the destination against itself produces
  #     evidence that looks green and proves nothing.
  #   * NOT the source — the source stays authoritative until the
  #     observation period ends, and it is the rollback target. A
  #     recovery DSN that pointed at the source would write the archive
  #     back over it.
  # The host is read straight out of the DSN file, so the credential
  # never enters the environment of the drill.
  recovery_tasks_host="$(cloud_db_dsn_host_from_file "$RECOVERY_TASKS_FILE")"
  recovery_content_scheduler_host="$(cloud_db_dsn_host_from_file "$RECOVERY_CONTENT_SCHEDULER_FILE")"
  destination_tasks_host="$(cloud_db_dsn_host_from_file "$DEST_TASKS_FILE")"
  destination_content_scheduler_host="$(cloud_db_dsn_host_from_file "$DEST_CONTENT_SCHEDULER_FILE")"
  source_tasks_host="$(cloud_db_dsn_host_from_file "$SRC_TASKS_FILE")"

  cloud_db_assert_recovery_isolation \
    "$source_tasks_host" \
    "$destination_tasks_host" \
    "$recovery_tasks_host" \
    "tasks_api"
  cloud_db_assert_recovery_isolation \
    "$source_tasks_host" \
    "$destination_content_scheduler_host" \
    "$recovery_content_scheduler_host" \
    "content_scheduler"

  DUMP2_OUT="$(
    "$(dirname "${BASH_SOURCE[0]}")/dump.sh" \
      --source-dsn-file "$DEST_TASKS_FILE" \
      --archive-dir "$ARCHIVE_DIR" \
      --environment "$ENVIRONMENT" \
      "${EXPECTED_HOST_FLAGS[@]}"
  )"
  DUMP2_ARCHIVE_PATH="${ARCHIVE_DIR}/$(basename "$DUMP2_OUT" .dump-result.json).dump"
  DUMP2_SHA="$(cat "${DUMP2_ARCHIVE_PATH}.sha256")"

  "$(dirname "${BASH_SOURCE[0]}")/restore.sh" \
    --source-dsn-file "$DEST_TASKS_FILE" \
    --destination-dsn-file "$RECOVERY_TASKS_FILE" \
    --destination-content-scheduler-dsn-file "$RECOVERY_CONTENT_SCHEDULER_FILE" \
    --archive "$DUMP2_ARCHIVE_PATH" \
    --archive-sha256 "$DUMP2_SHA" \
    --result-dir "$ARCHIVE_DIR" \
    --environment "$ENVIRONMENT" \
    "${EXPECTED_HOST_FLAGS[@]}" >/dev/null

  "$(dirname "${BASH_SOURCE[0]}")/migrate.sh" \
    --tasks-dsn-file "$RECOVERY_TASKS_FILE" \
    --content-scheduler-dsn-file "$RECOVERY_CONTENT_SCHEDULER_FILE" \
    --result-dir "$ARCHIVE_DIR" \
    --environment "$ENVIRONMENT" \
    "${EXPECTED_HOST_FLAGS[@]}" >/dev/null

  RECOVERY_OUT="${ARCHIVE_DIR}/reconcile-recovery-${CLOUD_DB_RUN_ID}.json"
  "$(dirname "${BASH_SOURCE[0]}")/reconcile.mjs" \
    --source-tasks-dsn-file  "$DEST_TASKS_FILE" \
    --source-content-scheduler-dsn-file "$DEST_CONTENT_SCHEDULER_FILE" \
    --dest-tasks-dsn-file    "$RECOVERY_TASKS_FILE" \
    --dest-content-scheduler-dsn-file   "$RECOVERY_CONTENT_SCHEDULER_FILE" \
    --environment "$ENVIRONMENT" \
    --output "$RECOVERY_OUT" || cloud_db_die "recovery reconcile FAILED; see ${RECOVERY_OUT}"

  cloud_db_info "step 6 recovery complete"
fi

# ---------------------------------------------------------------------------
# Step 7: emit final drill result envelope
# ---------------------------------------------------------------------------

OUTPUT_PATH="${OUTPUT_PATH:-${ARCHIVE_DIR}/drill-${CLOUD_DB_RUN_ID}.json}"

python3 - "$OUTPUT_PATH" "$CLOUD_DB_RUN_ID" \
        "$INVENTORY_OUT" "$DUMP_OUT" "$CLEANUP_OUT" "$RESTORE_OUT" \
        "$MIGRATE_OUT" "$RECONCILE_OUT" "$RECOVERY_OUT" \
        "$CLOUD_DB_KIND_PREFIX" "$CLOUD_DB_ENVIRONMENT" <<'PY'
import json, os, sys, pathlib

out_path, run_id, inv, dump, cleanup, restore, migrate, reconcile, recovery, kind_prefix, environment = sys.argv[1:]

def safe_load(p):
  if not p: return None
  return json.loads(pathlib.Path(p).read_text())

envelope = {
  "schemaVersion": 1,
  "kind": f"{kind_prefix}-drill",
  "runId": run_id,
  "environment": environment,
  "interruption": os.environ.get("CLOUD_DB_DRILL_INTERRUPTION", "none"),
  "cleanupDestination": os.path.basename(cleanup) if cleanup else None,
  "steps": {
    "inventory":  os.path.basename(inv)      if inv      else None,
    "dump":       os.path.basename(dump)     if dump     else None,
    "restore":    os.path.basename(restore)  if restore  else None,
    "migrate":    os.path.basename(migrate)  if migrate  else None,
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

# ---------------------------------------------------------------------------
# Step 8: evidence manifest
#
# The manifest digests every artefact this run produced and rolls up the
# verdicts, so one file answers "what did this run produce, and did it
# pass". It is written last, after the drill envelope, so the envelope
# is covered by the digest set too.
# ---------------------------------------------------------------------------

MANIFEST_OUT="$(
  "$(dirname "${BASH_SOURCE[0]}")/manifest.sh" \
    --artifact-dir "$ARCHIVE_DIR" \
    --environment "$ENVIRONMENT" \
    --run-id "$CLOUD_DB_RUN_ID"
)"
cloud_db_info "step 8 manifest complete envelope=${MANIFEST_OUT}"

printf '%s\n' "$OUTPUT_PATH"
