#!/usr/bin/env bash
# scripts/cloud/database/dump.sh
#
# Creates a consistent custom-format PostgreSQL archive containing
# tasks_api and budget_api schemas from a read-only source. The archive
# is written atomically (`.partial` -> verified -> `<run-id>.dump`) and
# refused if it cannot be parsed back with `pg_restore --list`.
#
# Output:
#   ${CLOUD_DB_ARCHIVE_DIR:-./artifacts/cloud-staging}/<run-id>.dump
#   ${CLOUD_DB_ARCHIVE_DIR:-./artifacts/cloud-staging}/<run-id>.dump.sha256

set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cloud_db_assert_required_commands

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: dump.sh --source-dsn-file <path> [--archive-dir <path>]

Required:
  --source-dsn-file <path>   Mode-0600 file containing the source DSN.

Optional:
  --archive-dir <path>       Where to write the .dump and .sha256 files.
                             Defaults to ./artifacts/cloud-staging.
  --environment <staging>    Environment label. Defaults to "staging".
  --keep-partial             Do not delete the .partial file on failure
                             (used by the interruption drill).
  --help                     Show this help.
USAGE
}

SOURCE_DSN_FILE=""
ARCHIVE_DIR=""
ENVIRONMENT="staging"
KEEP_PARTIAL=0

while (( $# > 0 )); do
  case "$1" in
    --source-dsn-file) SOURCE_DSN_FILE="$2"; shift 2;;
    --archive-dir)     ARCHIVE_DIR="$2"; shift 2;;
    --environment)     ENVIRONMENT="$2"; shift 2;;
    --keep-partial)    KEEP_PARTIAL=1; shift;;
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
cloud_db_assert_no_production_dsn "source" "$SOURCE_DSN"

ARCHIVE_DIR="${ARCHIVE_DIR:-./artifacts/cloud-staging}"
mkdir -p "$ARCHIVE_DIR"

PARTIAL_PATH="${ARCHIVE_DIR}/${CLOUD_DB_RUN_ID}.dump.partial"
FINAL_PATH="${ARCHIVE_DIR}/${CLOUD_DB_RUN_ID}.dump"
SHA_PATH="${FINAL_PATH}.sha256"

# Refuse if a previous run's partial is still present.
if [[ -e "$PARTIAL_PATH" ]]; then
  cloud_db_die "stale partial archive exists at ${PARTIAL_PATH}; refusing to overwrite"
fi

cleanup_on_failure() {
  local rc=$?
  if (( rc != 0 )) && (( ! KEEP_PARTIAL )) && [[ -e "$PARTIAL_PATH" ]]; then
    rm -f "$PARTIAL_PATH"
    cloud_db_warn "removed partial archive after failure"
  fi
  return $rc
}
trap 'cleanup_on_failure' EXIT

# ---------------------------------------------------------------------------
# Execute pg_dump
# ---------------------------------------------------------------------------

cloud_db_info "starting pg_dump run=${CLOUD_DB_RUN_ID}"
pg_dump_start_epoch="$(date +%s)"

PGPASSWORD="" pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=tasks_api \
  --schema=budget_api \
  --no-password \
  --verbose \
  --file="$PARTIAL_PATH" \
  "$SOURCE_DSN" \
  >"${ARCHIVE_DIR}/${CLOUD_DB_RUN_ID}.dump.log" 2>&1 \
  || cloud_db_die "pg_dump failed; see ${ARCHIVE_DIR}/${CLOUD_DB_RUN_ID}.dump.log"

pg_dump_end_epoch="$(date +%s)"

# ---------------------------------------------------------------------------
# Verify + atomic rename
# ---------------------------------------------------------------------------

cloud_db_info "verifying archive listing"
pg_restore --list "$PARTIAL_PATH" >/dev/null \
  || cloud_db_die "pg_restore --list failed on partial archive"

cloud_db_info "calculating sha256"
( cd "$(dirname "$PARTIAL_PATH")" && sha256sum "$(basename "$PARTIAL_PATH")" ) > "$SHA_PATH"

mv "$PARTIAL_PATH" "$FINAL_PATH"
cloud_db_info "renamed partial -> final"

# Update the .sha256 file to point at the final filename.
( cd "$(dirname "$FINAL_PATH")" && sha256sum "$(basename "$FINAL_PATH")" ) > "$SHA_PATH"

# ---------------------------------------------------------------------------
# Emit result envelope
# ---------------------------------------------------------------------------

RESULT_PATH="${ARCHIVE_DIR}/${CLOUD_DB_RUN_ID}.dump-result.json"

python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$FINAL_PATH" \
        "$SHA_PATH" "$pg_dump_start_epoch" "$pg_dump_end_epoch" \
        "$(stat -c %s "$FINAL_PATH" 2>/dev/null || stat -f %z "$FINAL_PATH")" <<'PY'
import hashlib, json, os, sys

out_path, run_id, archive_path, sha_path, start_epoch, end_epoch, size_bytes = sys.argv[1:]

with open(archive_path, "rb") as fh:
  digest = hashlib.sha256(fh.read()).hexdigest()

envelope = {
  "schemaVersion": 1,
  "kind": "cloud-staging-dump",
  "runId": run_id,
  "archivePath": os.path.basename(archive_path),
  "sha256": digest,
  "sizeBytes": int(size_bytes),
  "startEpoch": int(start_epoch),
  "endEpoch": int(end_epoch),
  "durationSeconds": int(end_epoch) - int(start_epoch),
  "verifiedByPgRestoreList": True,
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

# Re-write the canonical .sha256 file to use only the digest (no filename
# prefix), so the downstream restore.sh can verify without trusting path.
sha256sum "$FINAL_PATH" | awk '{print $1}' > "$SHA_PATH"

cloud_db_info "dump complete: archive=${FINAL_PATH} digest=$(cat "$SHA_PATH")"
printf '%s\n' "$RESULT_PATH"
