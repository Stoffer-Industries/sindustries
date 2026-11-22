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
# PER-SCHEMA RESTORE (the production topology). The archive carries BOTH
# tasks_api and content_scheduler, and the production profile gives each
# schema its OWN service role (`databaseServiceRoles` in
# infra/cloud/platform/platform-environments.mjs). Restoring the
# combined archive through a single destination DSN therefore hands
# BOTH schemas to whichever role that DSN connects as: content_scheduler
# comes back owned by the tasks role, the content-scheduler role holds
# USAGE=false/CREATE=false on its OWN schema, and the tasks role holds
# cross-schema access that the platform's own
# `neon.service-role-scope` production gate forbids.
#
# So the restore is per-schema: each schema is created by its own role
# and restored through its own role's DSN. `pg_restore --schema=<name>`
# does NOT create the schema (it only restores objects INSIDE it), so
# each role creates its own schema first and then restores its own
# objects. No privileged role is needed, and no post-restore remediation
# with SET ROLE is needed.
#
# The end state is ASSERTED, not assumed: after the restore the script
# proves that each schema is owned by the role that restored it, that
# each role can use its own schema, and -- when the two roles differ --
# that neither role can reach across into the other's schema. A restore
# that produced the wrong end state fails here, loudly, instead of
# failing later at the migration step with "permission denied for
# schema content_scheduler".
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
  --destination-content-scheduler-dsn-file <path> \
  --archive <path> \
  --archive-sha256 <digest>
  [--intentional-failure-after <seconds>]

Required:
  --source-dsn-file <path>       Mode-0600 source DSN file (used only for
                                 inequality check; no source data is read).
  --destination-dsn-file <path>  Mode-0600 destination DSN file for the
                                 tasks_api schema. Must end in a fresh,
                                 empty database. The role it connects as
                                 becomes the owner of tasks_api.
  --destination-content-scheduler-dsn-file <path>
                                 Mode-0600 destination DSN file for the
                                 content_scheduler schema. The role it
                                 connects as becomes the owner of
                                 content_scheduler. Required: the
                                 production profile confines each schema
                                 to its own service role, and a restore
                                 that cannot honour that would silently
                                 hand both schemas to one role.
  --archive <path>               Path to the .dump archive.
  --archive-sha256 <digest>      Expected sha256 digest (64 hex chars).

Optional:
  --result-dir <path>            Directory for redacted restore results/logs.
                                 Defaults to the environment's artifact
                                 directory (./artifacts/cloud-staging,
                                 ./artifacts/cloud-production). The
                                 workflow passes its upload directory here so
                                 restore-result.json and the pg_restore log are
                                 captured as run artifacts.
  --environment <staging|production>
                                 Environment label. Defaults to the
                                 ENVIRONMENT environment variable, then
                                 "staging".
  --expected-host <host>         Declares an endpoint this run may touch.
                                 Repeatable. A production run MUST declare
                                 every endpoint it touches.
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
DEST_CONTENT_SCHEDULER_DSN_FILE=""
ARCHIVE_PATH=""
EXPECTED_SHA=""
INTENTIONAL_FAILURE_AFTER=""
RESULT_DIR=""
ENVIRONMENT="${ENVIRONMENT:-staging}"

while (( $# > 0 )); do
  case "$1" in
    --source-dsn-file)            SOURCE_DSN_FILE="$2"; shift 2;;
    --destination-dsn-file)       DEST_DSN_FILE="$2"; shift 2;;
    --destination-content-scheduler-dsn-file)
                                  DEST_CONTENT_SCHEDULER_DSN_FILE="$2"; shift 2;;
    --archive)                    ARCHIVE_PATH="$2"; shift 2;;
    --archive-sha256)             EXPECTED_SHA="$2"; shift 2;;
    --result-dir)                 RESULT_DIR="$2"; shift 2;;
    --environment)                ENVIRONMENT="$2"; shift 2;;
    --expected-host)              cloud_db_add_expected_host "$2"; shift 2;;
    --intentional-failure-after)  INTENTIONAL_FAILURE_AFTER="$2"; shift 2;;
    --help|-h)                    usage; exit 0;;
    *)                            cloud_db_die "unknown argument: $1";;
  esac
done

if [[ -z "$SOURCE_DSN_FILE" || -z "$DEST_DSN_FILE" || \
      -z "$DEST_CONTENT_SCHEDULER_DSN_FILE" || \
      -z "$ARCHIVE_PATH" || -z "$EXPECTED_SHA" ]]; then
  cloud_db_die "all of --source-dsn-file, --destination-dsn-file, --destination-content-scheduler-dsn-file, --archive, --archive-sha256 are required"
fi

if [[ -n "$INTENTIONAL_FAILURE_AFTER" ]]; then
  if ! [[ "$INTENTIONAL_FAILURE_AFTER" =~ ^[0-9]+$ ]] || (( INTENTIONAL_FAILURE_AFTER < 1 )); then
    cloud_db_die "--intentional-failure-after must be a positive integer"
  fi
fi

cloud_db_set_environment "$ENVIRONMENT"
cloud_db_load_expected_targets_from_env
cloud_db_assert_production_ack
cloud_db_assign_run_id

# ---------------------------------------------------------------------------
# Load + verify DSNs + archive
# ---------------------------------------------------------------------------

cloud_db_load_secret SOURCE_DSN "$SOURCE_DSN_FILE"
cloud_db_load_secret DEST_DSN "$DEST_DSN_FILE"
cloud_db_load_secret DEST_CONTENT_SCHEDULER_DSN "$DEST_CONTENT_SCHEDULER_DSN_FILE"
cloud_db_assert_target_dsn "source" "$SOURCE_DSN"
cloud_db_assert_target_dsn "destination (tasks_api)" "$DEST_DSN"
cloud_db_assert_target_dsn "destination (content_scheduler)" "$DEST_CONTENT_SCHEDULER_DSN"
cloud_db_assert_inequality "source" "$SOURCE_DSN" "destination (tasks_api)" "$DEST_DSN"
cloud_db_assert_inequality "source" "$SOURCE_DSN" "destination (content_scheduler)" "$DEST_CONTENT_SCHEDULER_DSN"

# ---------------------------------------------------------------------------
# Catalogue helpers
# ---------------------------------------------------------------------------
#
# These read the destination's own catalogue over the connection that
# will own the schema. They are defined here, before the first use,
# because the role check below runs BEFORE the destination is written to.

schema_owner() {
  local dsn="$1" schema="$2" owner out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '${schema}'), 'ABSENT');" \
      2>&1
  )" || cloud_db_die "could not read the owner of schema '${schema}': ${out}"
  owner="$(printf '%s' "$out" | awk '{print $1}')"
  printf '%s' "$owner"
}

# The role the server says this connection is running as. Taken from the
# server rather than parsed out of the DSN: the DSN's userinfo is a
# claim, `current_user` is the fact, and the assertion compares against
# the fact.
connection_role() {
  local dsn="$1" role out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT current_user;" \
      2>&1
  )" || cloud_db_die "could not read the current role of the destination connection: ${out}"
  role="$(printf '%s' "$out" | awk '{print $1}')"
  printf '%s' "$role"
}

# Whether the role THIS CONNECTION runs as holds a privilege on a schema.
# `current_user` rather than an interpolated role name: psql does not
# substitute variables into a `--command` string (it only does so for
# `-f` files and standard input), so a `:'role'` placeholder reaches
# the server verbatim and the query fails.
schema_privilege() {
  local dsn="$1" schema="$2" priv="$3" result out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT has_schema_privilege(current_user, '${schema}', '${priv}');" \
      2>&1
  )" || cloud_db_die "could not read the ${priv} privilege of the connecting role on schema '${schema}': ${out}"
  result="$(printf '%s' "$out" | awk '{print $1}')"
  printf '%s' "${result:-f}"
}

schema_visible() {
  local dsn="$1" schema="$2" count out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="SELECT count(*) FROM pg_namespace WHERE nspname = '${schema}';" \
      2>&1
  )" || cloud_db_die "could not check whether schema '${schema}' is visible: ${out}"
  count="$(printf '%s' "$out" | tr -d '[:space:]')"
  [[ "${count:-0}" != "0" ]]
}

# The role each destination connection runs as. Read from the SERVER
# (`current_user`), not parsed out of the DSN: the DSN's userinfo is a
# claim, `current_user` is the fact, and the ownership assertion below
# compares against the fact.
#
# Both are read BEFORE anything is written, because a wrong role
# arrangement must fail before the destination is touched, not after.
tasks_role="$(connection_role "$DEST_DSN")"
content_scheduler_role="$(connection_role "$DEST_CONTENT_SCHEDULER_DSN")"

# The production topology gives each schema its OWN service role
# (`databaseServiceRoles` in
# infra/cloud/platform/platform-environments.mjs). Two destination DSNs
# that connect as the SAME role is the exact shape of the defect this
# restore was rewritten to fix -- one role owning both schemas -- and it
# would pass every ownership assertion, because each schema's owner
# would equal the role that connected. So in a production run the two
# roles must differ, and the check is explicit about which production
# requirement it enforces.
#
# Staging is genuinely single-role (the staging profile defines no
# per-schema service roles), so there the same role is allowed -- and
# recorded in the envelope rather than left implicit.
if [[ "$CLOUD_DB_ENVIRONMENT" == "production" && "$tasks_role" == "$content_scheduler_role" ]]; then
  cloud_db_die \
    "both destination connections run as role '${tasks_role}', but the production topology gives tasks_api and content_scheduler their own service roles (sindustries_tasks_api / sindustries_content_scheduler). One role owning both schemas is the defect this restore exists to prevent; refusing to restore."
fi
if [[ "$tasks_role" == "$content_scheduler_role" ]]; then
  cloud_db_info \
    "both destination connections run as role '${tasks_role}'; this environment uses one role for both schemas, so the cross-schema isolation assertion does not apply"
fi

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  cloud_db_die "archive '$ARCHIVE_PATH' not found"
fi

# Verify sha256 BEFORE touching the destination.
ACTUAL_SHA="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  cloud_db_die "archive sha256 mismatch; expected=$EXPECTED_SHA actual=$ACTUAL_SHA"
fi

# Reject any destination database that already has objects. A fresh,
# empty destination is the only safe target. BOTH destination DSNs are
# checked: the two schemas can live in one database (the production
# topology) or in two, and the destination is only fresh if every
# database the restore will write to is empty.
for dest_label in tasks_api content_scheduler; do
  if [[ "$dest_label" == "tasks_api" ]]; then
    dest_dsn="$DEST_DSN"
  else
    dest_dsn="$DEST_CONTENT_SCHEDULER_DSN"
  fi

  existing_objects="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dest_dsn" \
      --command="SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('tasks_api','content_scheduler','public');"
  )"
  if [[ "${existing_objects// /}" != "0" ]]; then
    cloud_db_die \
      "destination is not empty (${dest_label}: existing object count: ${existing_objects}); refusing to overwrite"
  fi
done

# Table count is not the same as freshness. The archive is a
# custom-format dump (`pg_dump --format=custom`) whose TOC carries
# `tasks_api` and `content_scheduler` as SCHEMA entries, so pg_restore
# issues `CREATE SCHEMA <name>;` for each before any table DDL.
# A destination where either schema EXISTS is therefore
# incompatible with the archive even when it holds zero tables --
# pg_restore dies on `schema "content_scheduler" already exists` and takes
# the whole drill with it.
#
# A prior failed restore lands in exactly that state: restore.sh
# creates the schema, then fails before creating any table. This is
# the guard that should have caught it before pg_restore ran. Fail
# here, with the operator fix named, instead of 200 lines into a log.
existing_schemas=""
for dest_label in tasks_api content_scheduler; do
  if [[ "$dest_label" == "tasks_api" ]]; then
    dest_dsn="$DEST_DSN"
  else
    dest_dsn="$DEST_CONTENT_SCHEDULER_DSN"
  fi
  found_schemas="$(
    PGPASSWORD="" psql \
      --no-psqlrc --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --dbname="$dest_dsn" \
      --command="SELECT string_agg(schema_name, ',' ORDER BY schema_name) FROM information_schema.schemata WHERE schema_name IN ('tasks_api','content_scheduler');" \
      2>/dev/null | tr -d '[:space:]'
  )"
  if [[ -n "${found_schemas:-}" ]]; then
    existing_schemas="${existing_schemas:+${existing_schemas},}${dest_label}:${found_schemas}"
  fi
done
if [[ -n "${existing_schemas:-}" ]]; then
  cloud_db_die \
    "destination already contains schema(s): ${existing_schemas}; pg_restore cannot apply its TOC's SCHEMA entries into a destination that already holds them (custom-format archives issue CREATE SCHEMA before any table DDL). Re-run with --cleanup-destination (or drop the listed schema(s)) before restoring"
fi

RESULT_DIR="${RESULT_DIR:-$CLOUD_DB_ARTIFACT_DIR}"
mkdir -p "$RESULT_DIR"

RESULT_PATH="${RESULT_DIR}/restore-${CLOUD_DB_RUN_ID}.json"

# ---------------------------------------------------------------------------
# Execute pg_restore, per schema
# ---------------------------------------------------------------------------

cloud_db_info "starting pg_restore run=${CLOUD_DB_RUN_ID}"
restore_start_epoch="$(date +%s)"

TASKS_LOG="${RESULT_PATH%.json}.log"
CONTENT_SCHEDULER_LOG="${RESULT_PATH%.json}-content_scheduler.log"

# ---------------------------------------------------------------------------
# Create each schema with its OWN role
# ---------------------------------------------------------------------------
#
# `pg_restore --schema=<name>` restores the objects INSIDE a schema but
# does not create the schema itself -- verified: run against an archive
# whose TOC carries a SCHEMA entry, the schema is absent afterwards and
# the table DDL dies with "schema does not exist". So each role creates
# its own schema first and then restores its own objects.
#
# Creating the schema as the connecting role makes that role the owner,
# which is exactly the production topology: each service role owns its
# own schema, and no role reaches across into the other's.
#
# The role needs CREATE on the destination database to create a schema.
# When it does not have it, that is a provisioning gap rather than a
# code fault, so the message names it instead of leaving a bare
# permission error in the log.
create_schema_as_owner() {
  local dsn="$1" schema="$2" label="$3" out
  out="$(
    PGPASSWORD="" psql \
      --no-psqlrc --variable=ON_ERROR_STOP=1 \
      --dbname="$dsn" \
      --command="CREATE SCHEMA ${schema};" \
      2>&1
  )" || cloud_db_die \
    "could not create schema '${schema}' as its own owner (${label}): ${out}. The service role must hold CREATE on the destination database so it can create and own its own schema."
  cloud_db_info "created schema ${schema} as its own owner (${label})"
}

create_schema_as_owner "$DEST_DSN" tasks_api "tasks_api destination"
create_schema_as_owner "$DEST_CONTENT_SCHEDULER_DSN" content_scheduler "content_scheduler destination"

# Use --exit-on-error so a SQL error fails the whole restore; --no-owner
# and --no-acl so the destination is the source of privilege truth. With
# the restore running as the schema's own owner, --no-owner means the
# connecting role owns what it restores, which is the role that is
# supposed to own it.
restore_one_schema() {
  local dsn="$1" schema="$2" label="$3" log_path="$4"
  PGPASSWORD="" pg_restore \
    --exit-on-error \
    --no-owner \
    --no-acl \
    --no-password \
    --schema="$schema" \
    --dbname="$dsn" \
    "$ARCHIVE_PATH" \
    >"$log_path" 2>&1 \
    || cloud_db_die "pg_restore failed for schema '${schema}' (${label}); see ${log_path}"
}

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
    --schema=tasks_api \
    --dbname="$DEST_DSN" \
    "$ARCHIVE_PATH" \
    >"$TASKS_LOG" 2>&1 &
  PGPID=$!
  # Use a function so $PGPID is resolved when the signal fires, not when
  # the trap is installed. PGPID is intentionally global so the function
  # can read it.
  _cloud_db_restore_kill() {
    kill -TERM "$PGPID" 2>/dev/null || true
  }
  trap '_cloud_db_restore_kill' INT TERM
  sleep "$INTENTIONAL_FAILURE_AFTER"
  cloud_db_info "intentional failure drill: sending SIGTERM to pg_restore (pid=$PGPID) after ${INTENTIONAL_FAILURE_AFTER}s"
  kill -TERM "$PGPID" 2>/dev/null || true
  wait "$PGPID" || true
  cloud_db_die "intentional failure drill: pg_restore killed at ${INTENTIONAL_FAILURE_AFTER}s; see ${TASKS_LOG}"
fi

restore_one_schema "$DEST_DSN" tasks_api "tasks_api destination" "$TASKS_LOG"
restore_one_schema "$DEST_CONTENT_SCHEDULER_DSN" content_scheduler "content_scheduler destination" "$CONTENT_SCHEDULER_LOG"

restore_end_epoch="$(date +%s)"

# ---------------------------------------------------------------------------
# Verify restore produced both schemas
# ---------------------------------------------------------------------------

restored_tasks_schema="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_DSN" \
    --command="SELECT count(*) FROM pg_namespace WHERE nspname = 'tasks_api';" \
    2>/dev/null | tr -d '[:space:]'
)"
restored_content_scheduler_schema="$(
  PGPASSWORD="" psql \
    --no-psqlrc --tuples-only --no-align \
    --variable=ON_ERROR_STOP=1 \
    --dbname="$DEST_CONTENT_SCHEDULER_DSN" \
    --command="SELECT count(*) FROM pg_namespace WHERE nspname = 'content_scheduler';" \
    2>/dev/null | tr -d '[:space:]'
)"

if [[ "${restored_tasks_schema:-0}" != "1" ]]; then
  cloud_db_die \
    "post-restore schema check failed; expected schema tasks_api in the tasks_api destination, found ${restored_tasks_schema:-0}"
fi
if [[ "${restored_content_scheduler_schema:-0}" != "1" ]]; then
  cloud_db_die \
    "post-restore schema check failed; expected schema content_scheduler in the content_scheduler destination, found ${restored_content_scheduler_schema:-0}"
fi

restored_schemas="tasks_api,content_scheduler"

# ---------------------------------------------------------------------------
# Assert the ownership end state
# ---------------------------------------------------------------------------
#
# The defect this whole change exists for was SILENT: the restore
# succeeded, the drill moved on, and the schema was owned by the wrong
# role until the migration step failed with "permission denied for
# schema content_scheduler". So the end state is asserted here, at the
# one place that can see it, and the restore fails loudly instead of
# leaving a broken database behind for the next step to trip over.
#
# Each schema must be owned by the role that restored it; each role
# must be able to use its own schema; and when the two roles differ,
# neither may reach across into the other's schema.
tasks_owner="$(schema_owner "$DEST_DSN" tasks_api)"
content_scheduler_owner="$(schema_owner "$DEST_CONTENT_SCHEDULER_DSN" content_scheduler)"

if [[ "$tasks_owner" != "$tasks_role" ]]; then
  cloud_db_die \
    "post-restore ownership assertion failed: schema tasks_api is owned by '${tasks_owner:-<unknown>}' but the role that restored it is '${tasks_role}'. A schema restored through the wrong role is the defect that breaks the production migrations; refusing to continue."
fi
if [[ "$content_scheduler_owner" != "$content_scheduler_role" ]]; then
  cloud_db_die \
    "post-restore ownership assertion failed: schema content_scheduler is owned by '${content_scheduler_owner:-<unknown>}' but the role that restored it is '${content_scheduler_role}'. A schema restored through the wrong role is the defect that breaks the production migrations; refusing to continue."
fi

if [[ "$(schema_privilege "$DEST_DSN" tasks_api USAGE)" != "t" ]]; then
  cloud_db_die \
    "post-restore privilege assertion failed: role '${tasks_role}' cannot USE its own schema tasks_api; refusing to continue"
fi
if [[ "$(schema_privilege "$DEST_CONTENT_SCHEDULER_DSN" content_scheduler USAGE)" != "t" ]]; then
  cloud_db_die \
    "post-restore privilege assertion failed: role '${content_scheduler_role}' cannot USE its own schema content_scheduler; refusing to continue"
fi

# Cross-schema isolation. It is only meaningful when the two roles
# differ, and only checkable when both schemas live in the same
# database -- which is the production topology, and the one the
# platform's own `neon.service-role-scope` gate enforces.
if [[ "$tasks_role" != "$content_scheduler_role" ]]; then
  if schema_visible "$DEST_DSN" content_scheduler; then
    if [[ "$(schema_privilege "$DEST_DSN" content_scheduler USAGE)" != "f" ]]; then
      cloud_db_die \
        "post-restore isolation assertion failed: role '${tasks_role}' holds USAGE on schema content_scheduler, which belongs to '${content_scheduler_role}'. The production topology confines each service role to its own schema; refusing to continue."
    fi
  fi
  if schema_visible "$DEST_CONTENT_SCHEDULER_DSN" tasks_api; then
    if [[ "$(schema_privilege "$DEST_CONTENT_SCHEDULER_DSN" tasks_api USAGE)" != "f" ]]; then
      cloud_db_die \
        "post-restore isolation assertion failed: role '${content_scheduler_role}' holds USAGE on schema tasks_api, which belongs to '${tasks_role}'. The production topology confines each service role to its own schema; refusing to continue."
    fi
  fi
fi

cloud_db_info "post-restore ownership assertion passed: tasks_api owned by ${tasks_role}, content_scheduler owned by ${content_scheduler_role}"

# ---------------------------------------------------------------------------
# Emit result envelope
# ---------------------------------------------------------------------------

python3 - "$RESULT_PATH" "$CLOUD_DB_RUN_ID" "$EXPECTED_SHA" \
        "$restore_start_epoch" "$restore_end_epoch" "$restored_schemas" \
        "$tasks_role" "$content_scheduler_role" \
        "$(stat -c %s "$ARCHIVE_PATH" 2>/dev/null || stat -f %z "$ARCHIVE_PATH")" \
        "$CLOUD_DB_KIND_PREFIX" "$CLOUD_DB_ENVIRONMENT" <<'PY'
import json, sys

out_path, run_id, expected_sha, start_epoch, end_epoch, schemas, tasks_role, content_scheduler_role, size_bytes, kind_prefix, environment = sys.argv[1:]

envelope = {
  "schemaVersion": 1,
  "kind": f"{kind_prefix}-restore",
  "environment": environment,
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
  "perSchemaRestore": True,
  "singleRoleDestination": tasks_role == content_scheduler_role,
  "schemaOwners": {
    "tasks_api": tasks_role,
    "content_scheduler": content_scheduler_role,
  },
}
with open(out_path, "w", encoding="utf-8") as fh:
  json.dump(envelope, fh, indent=2, sort_keys=True)
  fh.write("\n")
PY

cloud_db_info "restore complete: schemas=${restored_schemas} archive_digest=${EXPECTED_SHA}"
printf '%s\n' "$RESULT_PATH"
