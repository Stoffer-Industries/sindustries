#!/usr/bin/env bash
# shellcheck shell=bash
# per-schema-restore.test.sh — regression guard for task 020f423e.
#
# THE DEFECT. The production cutover restores the tasks_api and
# content_scheduler schemas from ONE archive. The production profile
# gives each schema its OWN service role
# (`databaseServiceRoles` in infra/cloud/platform/platform-environments.mjs).
# The restore connected with a single destination DSN, so BOTH schemas
# came back owned by whichever role that DSN connects as. Measured
# against a replica of the production topology:
#
#     owner of content_scheduler = <tasks role>    <- should be the cs role
#     cs_role  USAGE on content_scheduler = false  <- its own schema
#     cs_role  CREATE on content_scheduler = false <- its own schema
#     tasks_role USAGE on content_scheduler = true  <- cross-schema drift
#
# The restore SUCCEEDED. The drill moved on. The production failure
# surfaced one step later, at `prisma migrate deploy` for the
# content-scheduler, as `permission denied for schema
# content_scheduler` — after the live schema had already been dropped
# and recreated with the wrong owner.
#
# THE FIX. The restore is per-schema: each role creates its own schema
# and restores its own objects through its own DSN, and the resulting
# ownership/privilege end state is ASSERTED rather than assumed. This
# test pins the behaviour, including the two ways a wrong end state
# must still fail loudly:
#
#   1. each schema is created by the role that owns it
#   2. each schema is restored through its own role's DSN
#   3. a schema owned by the wrong role fails the restore
#   4. a role holding cross-schema access fails the restore
#   5. the content-scheduler destination DSN is REQUIRED, not optional
#   6. drill.sh passes it to restore.sh at both call sites
#
# Behavioural rather than a grep over source: a stub psql/pg_restore on
# PATH answers the catalogue queries, and the real scripts run their
# real gates against them. No PostgreSQL needed.
# Runs in CI via `npm run test:cloud-db`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

RESTORE_SH="$REPO_ROOT/scripts/cloud/database/restore.sh"
DRILL_SH="$REPO_ROOT/scripts/cloud/database/drill.sh"

for f in "$RESTORE_SH" "$DRILL_SH"; do
  [[ -f "$f" ]] || { echo "FAIL: $f not found"; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "  ok $1"; }
fail() { echo "  FAIL $1"; failures=$((failures + 1)); }

# ---------------------------------------------------------------------------
# Stub toolchain.
#
# The stub tracks who created each schema (the connecting role becomes
# the owner) and answers pg_get_userbyid / has_schema_privilege from
# that state, so the assertions below exercise the same ownership
# semantics a real server has. Overrides let a test simulate the two
# broken end states the restore must refuse.
# ---------------------------------------------------------------------------

BIN="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$BIN" "$STATE"

cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "psql (PostgreSQL) 18.2"; exit 0; fi
cmd=""
dbname=""
probe_role=""
for arg in "$@"; do
  case "$arg" in
    --command=*) cmd="${arg#--command=}" ;;
    --dbname=*)  dbname="${arg#--dbname=}" ;;
    --variable=probe_role=*) probe_role="${arg#--variable=probe_role=}" ;;
  esac
done
echo "SQL: $cmd" >> "$PSQL_SQL_LOG"
flat="$(printf '%s' "$cmd" | tr -s '[:space:]' ' ')"

conn_role="$(printf '%s' "$dbname" | sed -E 's#^[a-z0-9+.-]+://([^:@/]*)(:[^@]*)?@.*#\1#')"

case "$flat" in
  *"CREATE SCHEMA tasks_api"*)
      printf '%s' "$conn_role" > "$PSQL_STUB_STATE_DIR/owner_tasks_api"
      echo "CREATE SCHEMA AS ${conn_role} tasks_api" >> "$PSQL_SQL_LOG"
      printf '%s\n' "CREATE SCHEMA" ;;
  *"CREATE SCHEMA content_scheduler"*)
      printf '%s' "$conn_role" > "$PSQL_STUB_STATE_DIR/owner_content_scheduler"
      echo "CREATE SCHEMA AS ${conn_role} content_scheduler" >> "$PSQL_SQL_LOG"
      printf '%s\n' "CREATE SCHEMA" ;;
  *"pg_get_userbyid"*)
      _schema="tasks_api"
      case "$flat" in *"nspname = 'content_scheduler'"*) _schema="content_scheduler";; esac
      case "$_schema" in
        tasks_api) _override="${PSQL_SCHEMA_OWNER_TASKS:-}" ;;
        *)        _override="${PSQL_SCHEMA_OWNER_CONTENT_SCHEDULER:-}" ;;
      esac
      if [[ -n "$_override" ]]; then
        printf '%s\n' "$_override"
      else
        printf '%s\n' "$(cat "$PSQL_STUB_STATE_DIR/owner_${_schema}" 2>/dev/null || printf '%s' "$conn_role")"
      fi ;;
  *"has_schema_privilege"*)
      # `current_user` is the role the connection runs as, so the
      # privilege answer is about that role -- which is the role the
      # schema's owner is compared against.
      _schema="tasks_api"
      case "$flat" in
        *"'content_scheduler'"*) _schema="content_scheduler" ;;
      esac
      # An UNRECORDED owner means the schema has not been created by this
      # run yet. Falling back to the connecting role here made a
      # pre-flight privilege question answer "yes" for a schema nobody
      # owns -- the stub asserting something the server would not say.
      # Before the restore creates its schemas there is no owner, so the
      # answer is the cross-access override, which defaults to "no".
      _owner_file="$PSQL_STUB_STATE_DIR/owner_${_schema}"
      if [[ -f "$_owner_file" ]]; then
        _owner="$(cat "$_owner_file")"
      else
        _owner=""
      fi
      if [[ -n "$_owner" && "$_owner" == "$conn_role" ]]; then
        printf '%s\n' "t"
      else
        case "$_schema" in
          tasks_api) _cross="${PSQL_PRIVILEGE_CONTENT_SCHEDULER_ROLE_ON_TASKS:-f}" ;;
          *)        _cross="${PSQL_PRIVILEGE_TASKS_ROLE_ON_CONTENT_SCHEDULER:-f}" ;;
        esac
        printf '%s\n' "$_cross"
      fi ;;
  *"current_user"*)
      printf '%s\n' "$conn_role" ;;
  *"pg_namespace"*"nspname = 'tasks_api'"*)
      printf '%s\n' "${PSQL_NSP_TASKS_COUNT:-1}" ;;
  *"pg_namespace"*"nspname = 'content_scheduler'"*)
      printf '%s\n' "${PSQL_NSP_CONTENT_SCHEDULER_COUNT:-1}" ;;
  *"information_schema.tables"*)
      printf '%s\n' "0" ;;
  *"information_schema.schemata"*)
      printf '%s\n' "" ;;
  *)
      printf '\n' ;;
esac
STUB

cat > "$BIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "pg_restore (PostgreSQL) 18.2"; exit 0; fi
schema=""
dbname=""
for arg in "$@"; do
  case "$arg" in
    --schema=*) schema="${arg#--schema=}" ;;
    --dbname=*) dbname="${arg#--dbname=}" ;;
  esac
done
echo "PG_RESTORE RAN schema=${schema} dbname=${dbname}" >> "$PG_RESTORE_LOG"
exit 0
STUB

cat > "$BIN/pg_dump" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "pg_dump (PostgreSQL) 18.2"; exit 0; fi
exit 0
STUB

cat > "$BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
exec shasum -a 256 "$@"
STUB

cat > "$BIN/openssl" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "rand" ]]; then printf 'abc123\n'; exit 0; fi
exec /usr/bin/openssl "$@"
STUB

chmod +x "$BIN"/psql "$BIN"/pg_restore "$BIN"/pg_dump "$BIN"/sha256sum "$BIN"/openssl

if ! command -v node >/dev/null 2>&1; then
  cat > "$BIN/node" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$BIN/node"
fi

# ---------------------------------------------------------------------------
# Fixtures. The two destination DSNs use DIFFERENT roles, which is the
# production topology: one service role per schema.
# ---------------------------------------------------------------------------

mkdir -p "$WORK/secrets" "$WORK/artifacts"
printf 'postgres://readonly:***@source-host.internal:5432/sindustries_staging_source?sslmode=require\n' \
  > "$WORK/secrets/source.dsn"
printf 'postgres://tasks_role:***@dest-tasks.internal:5432/sindustries_staging_dest_tasks?sslmode=require\n' \
  > "$WORK/secrets/dest_tasks.dsn"
printf 'postgres://cs_role:***@dest-content-scheduler.internal:5432/sindustries_staging_dest_cs?sslmode=require\n' \
  > "$WORK/secrets/dest_content_scheduler.dsn"
chmod 0600 "$WORK/secrets"/*.dsn

archive="$WORK/fake.dump"
printf 'not a real dump\n' > "$archive"
sha="$(PATH="$BIN:$PATH" sha256sum "$archive" | awk '{print $1}')"

RUN_ID="20260101T000000Z-pertest"

run_restore() {
  # $1 = extra env assignments (may be empty)
  mkdir -p "$WORK/artifacts"
  : > "$WORK/sql.log"
  : > "$WORK/restore.log"
  ( cd "$WORK/artifacts" && \
    env \
      PATH="$BIN:$PATH" \
      PSQL_SQL_LOG="$WORK/sql.log" \
      PG_RESTORE_LOG="$WORK/restore.log" \
      PSQL_STUB_STATE_DIR="$STATE" \
      CLOUD_DB_RUN_ID="$RUN_ID" \
      ENVIRONMENT=staging \
      ${1:+$1} \
      bash "$RESTORE_SH" \
        --source-dsn-file "$WORK/secrets/source.dsn" \
        --destination-dsn-file "$WORK/secrets/dest_tasks.dsn" \
        --destination-content-scheduler-dsn-file "$WORK/secrets/dest_content_scheduler.dsn" \
        --archive "$archive" \
        --archive-sha256 "$sha" \
        --result-dir "$WORK/artifacts" 2>&1
  )
}

# ---------------------------------------------------------------------------
# Case 1 — each schema is created by, and restored through, its own role.
# ---------------------------------------------------------------------------

set +e
out="$(run_restore)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "restore succeeds when each schema is restored through its own role"
else
  fail "restore failed on the happy path (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "CREATE SCHEMA AS tasks_role tasks_api" "$WORK/sql.log"; then
  pass "tasks_api is created by the tasks role"
else
  fail "tasks_api was not created by the tasks role"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "CREATE SCHEMA AS cs_role content_scheduler" "$WORK/sql.log"; then
  pass "content_scheduler is created by the content-scheduler role"
else
  fail "content_scheduler was not created by the content-scheduler role"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "PG_RESTORE RAN schema=tasks_api" "$WORK/restore.log" \
   && grep -q "PG_RESTORE RAN schema=content_scheduler" "$WORK/restore.log"; then
  pass "pg_restore runs once per schema, not once for the combined archive"
else
  fail "pg_restore did not run once per schema"
  printf '%s\n' "$WORK/restore.log" | sed 's/^/      /'
fi

if grep -q "PG_RESTORE RAN schema=tasks_api .*dest-tasks.internal" "$WORK/restore.log"; then
  pass "the tasks_api restore uses the tasks destination DSN"
else
  fail "the tasks_api restore did not use the tasks destination DSN"
  printf '%s\n' "$WORK/restore.log" | sed 's/^/      /'
fi

if grep -q "PG_RESTORE RAN schema=content_scheduler .*dest-content-scheduler.internal" "$WORK/restore.log"; then
  pass "the content_scheduler restore uses the content-scheduler destination DSN"
else
  fail "the content_scheduler restore did not use the content-scheduler destination DSN"
  printf '%s\n' "$WORK/restore.log" | sed 's/^/      /'
fi

if [[ -f "$WORK/artifacts/restore-${RUN_ID}.json" ]] \
   && python3 -c "
import json,sys
d=json.load(open('$WORK/artifacts/restore-${RUN_ID}.json'))
sys.exit(0 if d.get('perSchemaRestore') is True \
  and d.get('schemaOwners',{}).get('tasks_api')=='tasks_role' \
  and d.get('schemaOwners',{}).get('content_scheduler')=='cs_role' else 1)" 2>/dev/null; then
  pass "the restore envelope records the per-schema owners"
else
  fail "the restore envelope does not record the per-schema owners"
fi

# ---------------------------------------------------------------------------
# Case 2 — a schema owned by the WRONG role must fail the restore.
# This is the defect itself: the old restore produced this end state
# and reported success.
# ---------------------------------------------------------------------------

set +e
out="$(run_restore "PSQL_SCHEMA_OWNER_CONTENT_SCHEDULER=tasks_role")"
rc=$?
set -e

if [[ $rc -ne 0 ]] && grep -q "ownership assertion failed" <<<"$out"; then
  pass "restore refuses a schema owned by the wrong role"
else
  fail "restore accepted a schema owned by the wrong role"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 3 — a role holding cross-schema access must fail the restore.
# ---------------------------------------------------------------------------

set +e
out="$(run_restore "PSQL_PRIVILEGE_TASKS_ROLE_ON_CONTENT_SCHEDULER=t")"
rc=$?
set -e

if [[ $rc -ne 0 ]] && grep -q "isolation assertion failed" <<<"$out"; then
  pass "restore refuses a role that holds cross-schema access"
else
  fail "restore accepted cross-schema access"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 4 — the content-scheduler destination DSN is required. Without it
# the restore would fall back to the single-DSN behaviour that produced
# the defect.
# ---------------------------------------------------------------------------

set +e
out="$(
  cd "$WORK/artifacts" && \
  PATH="$BIN:$PATH" \
  PSQL_SQL_LOG="$WORK/sql.log" \
  PG_RESTORE_LOG="$WORK/restore.log" \
  PSQL_STUB_STATE_DIR="$STATE" \
  CLOUD_DB_RUN_ID="$RUN_ID" \
  ENVIRONMENT=staging \
  bash "$RESTORE_SH" \
    --source-dsn-file "$WORK/secrets/source.dsn" \
    --destination-dsn-file "$WORK/secrets/dest_tasks.dsn" \
    --archive "$archive" \
    --archive-sha256 "$sha" \
    --result-dir "$WORK/artifacts" 2>&1
)"
rc=$?
set -e

if [[ $rc -ne 0 ]] && grep -q "destination-content-scheduler-dsn-file" <<<"$out"; then
  pass "restore refuses to run without the content-scheduler destination DSN"
else
  fail "restore accepted a missing content-scheduler destination DSN"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 5 — drill.sh hands the content-scheduler destination DSN to
# restore.sh at BOTH call sites (the normal restore and the recovery
# restore). A restore that still received only one DSN would reproduce
# the defect on the recovery path.
# ---------------------------------------------------------------------------

if grep -c -- "--destination-content-scheduler-dsn-file" "$DRILL_SH" | grep -qx "2"; then
  pass "drill.sh passes the content-scheduler destination DSN at both restore call sites"
else
  fail "drill.sh does not pass the content-scheduler destination DSN at both restore call sites"
fi

# ---------------------------------------------------------------------------
# Case 6 — a PRODUCTION run whose two destination connections use the SAME
# role must be refused before anything is written.
#
# This is the shape of the defect: one role owning both schemas. It
# would pass every ownership assertion, because each schema's owner
# would equal the role that connected -- the assertions compare the
# owner against the connecting role, so a single role trivially matches
# both. The production topology defines two DISTINCT service roles, so
# the same-role arrangement is refused outright there.
# ---------------------------------------------------------------------------

mkdir -p "$WORK/prod-secrets"
printf 'postgres://readonly:***@prod-source.internal:5432/neondb_src?sslmode=require\n' \
  > "$WORK/prod-secrets/source.dsn"
printf 'postgres://sindustries_tasks_api:***@prod-tasks.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/prod-secrets/tasks.dsn"
printf 'postgres://sindustries_tasks_api:***@prod-cs.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/prod-secrets/cs.dsn"
chmod 0600 "$WORK/prod-secrets"/*.dsn

set +e
: > "$WORK/restore.log"
: > "$WORK/sql.log"
out="$(
  cd "$WORK/artifacts" && \
  env \
    PATH="$BIN:$PATH" \
    PSQL_SQL_LOG="$WORK/sql.log" \
    PG_RESTORE_LOG="$WORK/restore.log" \
    PSQL_STUB_STATE_DIR="$STATE" \
    CLOUD_DB_RUN_ID="$RUN_ID" \
    ENVIRONMENT=production \
    CLOUD_DB_PRODUCTION_ACK=1 \
    bash "$RESTORE_SH" \
      --source-dsn-file "$WORK/prod-secrets/source.dsn" \
      --destination-dsn-file "$WORK/prod-secrets/tasks.dsn" \
      --destination-content-scheduler-dsn-file "$WORK/prod-secrets/cs.dsn" \
      --expected-host prod-source.internal:5432 \
      --expected-host prod-tasks.internal:5432 \
      --expected-host prod-cs.internal:5432 \
      --archive "$archive" \
      --archive-sha256 "$sha" \
      --result-dir "$WORK/artifacts" 2>&1
)"
rc=$?
set -e

if [[ $rc -ne 0 ]] && grep -qi "one role owning both schemas" <<<"$out"; then
  pass "a production restore with one role for both schemas is refused"
else
  fail "a production restore with one role for both schemas was NOT refused"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "PG_RESTORE RAN" "$WORK/restore.log"; then
  fail "the same-role production restore reached pg_restore"
else
  pass "the same-role production restore fails before touching the destination"
fi

if (( failures > 0 )); then
  echo "FAIL: ${failures} per-schema-restore check(s) failed"
  exit 1
fi

echo "ALL per-schema-restore checks passed"
