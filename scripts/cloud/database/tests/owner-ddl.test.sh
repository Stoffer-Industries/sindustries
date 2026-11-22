#!/usr/bin/env bash
# shellcheck shell=bash
# owner-ddl.test.sh — regression guard for task f2c23e26.
#
# THE DEFECT. The production schemas are owned by the database owner role
# (`neondb_owner`), NOT by the service roles. That makes the two
# destructive DDL statements in the cutover harness owner-only:
#
#   * `DROP SCHEMA IF EXISTS tasks_api CASCADE` — run as a service role it
#     fails closed with "must be owner of schema", before anything is
#     dropped, so the window cannot run.
#   * `CREATE SCHEMA tasks_api` — run as a service role it succeeds, but
#     it makes the SERVICE role the schema's owner. That silently changes
#     the production topology: the accepted shared-access decision
#     (Quinn, 2026-11-23 07:25 NZDT) accepted shared ACCESS between the
#     two service roles; it did not authorise changing who owns the
#     schemas.
#
# THE FIX. The destructive DDL runs on an optional schema-OWNER
# connection, while the service roles keep their own DML-scoped
# connections for the data load. The owner-created schema has no ACL of
# its own — `DROP SCHEMA ... CASCADE` took the previous grants with it —
# so the owner grants the service role USAGE, CREATE on its own schema.
# Without an owner DSN the scripts behave exactly as before, which is
# what the staging topology needs (one role, owning both schemas).
#
# This test pins:
#
#   1. the cleanup DROPs the schemas through the OWNER connection when one
#      is supplied, and NOT through the service-role connections
#   2. the cleanup still DROPs through the service-role connections when
#      no owner connection is supplied (staging shape, unchanged)
#   3. the restore CREATEs the schema through the OWNER connection, and
#      GRANTS USAGE, CREATE on it to the service role
#   4. the restore's post-restore ownership assertion expects the OWNER
#      role, not the service role, when an owner connection was supplied
#   5. the restore still CREATEs the schema through the service-role
#      connection when no owner connection is supplied (unchanged)
#   6. a restore whose service role was NOT granted CREATE on its own
#      schema refuses, rather than loading data it cannot write
#
# Behavioural rather than a grep over source: a stub psql on PATH answers
# the catalogue queries from state files and records WHICH connection ran
# each statement, and the real scripts run their real gates against it.
# No PostgreSQL needed.
# Runs in CI via `npm run test:cloud-db`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

CLEANUP_SH="$REPO_ROOT/scripts/cloud/database/cleanup-destination.sh"
RESTORE_SH="$REPO_ROOT/scripts/cloud/database/restore.sh"

for f in "$CLEANUP_SH" "$RESTORE_SH"; do
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
# State files:
#
#   present   — one schema name per line; a schema listed here exists
#   owners    — `<schema>|<owner role>` per line
#   grants    — `<role>|<schema>` per line; a grant of USAGE, CREATE
#   sql.log   — `<connection role>|<statement>` per line, so a test can
#               assert WHICH connection ran the destructive statement
#
# The stub answers the privilege question the way PostgreSQL would:
# a role that OWNS the schema has every privilege on it, a role that was
# GRANTED USAGE, CREATE on it has those two, and anything else has
# neither. The `grants` file is written by the stub when it sees the
# harness's own GRANT statement, so the restore's grant is what makes
# the data load possible — a restore that forgot the grant fails here
# exactly as it would in production.
# ---------------------------------------------------------------------------

BIN="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$BIN" "$STATE"

cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "psql (PostgreSQL) 18.2"; exit 0; fi
cmd=""
dbname=""
for arg in "$@"; do
  case "$arg" in
    --command=*) cmd="${arg#--command=}" ;;
    --dbname=*)  dbname="${arg#--dbname=}" ;;
  esac
done
echo "SQL: $cmd" >> "$PSQL_SQL_LOG"
flat="$(printf '%s' "$cmd" | tr -s '[:space:]' ' ')"

conn_role="$(printf '%s' "$dbname" | sed -E 's#^[a-z0-9+.-]+://([^:@/]*)(:[^@]*)?@.*#\1#')"
echo "$conn_role|$flat" >> "$PSQL_CONNECTION_LOG"

present_file="$PSQL_STUB_STATE_DIR/present"
owners_file="$PSQL_STUB_STATE_DIR/owners"
grants_file="$PSQL_STUB_STATE_DIR/grants"

schema_present() {
  [[ -f "$present_file" ]] || return 1
  grep -qx "$1" "$present_file"
}

schema_owner_of() {
  [[ -f "$owners_file" ]] || return 1
  awk -F'|' -v s="$1" '$1 == s { print $2; found = 1 } END { if (!found) exit 1 }' "$owners_file"
}

has_grant() {
  [[ -f "$grants_file" ]] || return 1
  grep -qx "$1|$2" "$grants_file"
}

case "$flat" in
  *"DROP SCHEMA"*)
      _dropped="$(printf '%s' "$flat" | sed -E 's/.*DROP SCHEMA IF EXISTS ([a-z_]+) CASCADE.*/\1/')"
      if [[ -f "$present_file" ]]; then
        grep -vx "$_dropped" "$present_file" > "$present_file.tmp" 2>/dev/null || true
        mv "$present_file.tmp" "$present_file"
      fi
      if [[ -f "$owners_file" ]]; then
        grep -v "^${_dropped}|" "$owners_file" > "$owners_file.tmp" 2>/dev/null || true
        mv "$owners_file.tmp" "$owners_file"
      fi
      printf 'DROP SCHEMA\n' ;;
  *"CREATE SCHEMA"*)
      _schema="$(printf '%s' "$flat" | sed -E 's/.*CREATE SCHEMA ([a-z_]+).*/\1/')"
      printf '%s\n' "$_schema" >> "$present_file"
      printf '%s|%s\n' "$_schema" "$conn_role" >> "$owners_file"
      printf 'CREATE SCHEMA\n' ;;
  *"GRANT USAGE, CREATE ON SCHEMA"*)
      _schema="$(printf '%s' "$flat" | sed -E 's/.*GRANT USAGE, CREATE ON SCHEMA ([a-z_]+) TO ([a-z_]+).*/\1/')"
      _granted="$(printf '%s' "$flat" | sed -E 's/.*GRANT USAGE, CREATE ON SCHEMA ([a-z_]+) TO ([a-z_]+).*/\2/')"
      printf '%s|%s\n' "$_granted" "$_schema" >> "$grants_file"
      printf 'GRANT\n' ;;
  *"SELECT current_user"*)
      printf '%s\n' "$conn_role" ;;
  *"pg_get_userbyid"*)
      _schema="unknown"
      case "$flat" in
        *"nspname = 'tasks_api'"*)         _schema="tasks_api" ;;
        *"nspname = 'content_scheduler'"*) _schema="content_scheduler" ;;
      esac
      _owner="$(schema_owner_of "$_schema" 2>/dev/null || printf 'ABSENT')"
      printf '%s\n' "$_owner" ;;
  *"has_schema_privilege(current_user,"*)
      _schema="unknown"
      _priv="USAGE"
      case "$flat" in
        *"current_user, 'tasks_api'"*)         _schema="tasks_api" ;;
        *"current_user, 'content_scheduler'"*) _schema="content_scheduler" ;;
      esac
      case "$flat" in
        *"'CREATE'"*) _priv="CREATE" ;;
        *"'USAGE'"*)  _priv="USAGE" ;;
      esac
      _answer="f"
      if [[ "$(schema_owner_of "$_schema" 2>/dev/null || printf 'ABSENT')" == "$conn_role" ]]; then
        # The owner holds every privilege on its own schema.
        _answer="t"
      elif has_grant "$conn_role" "$_schema"; then
        _answer="t"
      fi
      printf '%s\n' "$_answer" ;;
  *"pg_namespace"*)
      _schema="unknown"
      case "$flat" in
        *"nspname = 'tasks_api'"*)         _schema="tasks_api" ;;
        *"nspname = 'content_scheduler'"*) _schema="content_scheduler" ;;
      esac
      if schema_present "$_schema"; then printf '1\n'; else printf '0\n'; fi ;;
  *"information_schema.schemata"*)
      _found=""
      for _s in tasks_api content_scheduler; do
        if schema_present "$_s"; then _found="${_found:+${_found},}${_s}"; fi
      done
      printf '%s\n' "$_found" ;;
  *"information_schema.tables"*)
      printf '0\n' ;;
  *"string_agg"*)
      printf '\n' ;;
  *)
      printf '\n' ;;
esac
exit 0
STUB

cat > "$BIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "pg_restore (PostgreSQL) 18.2"; exit 0; fi
echo "PG_RESTORE RAN" >> "$PG_RESTORE_LOG"
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

chmod +x "$BIN"/psql "$BIN"/pg_restore "$BIN"/sha256sum "$BIN"/openssl

# ---------------------------------------------------------------------------
# Fixtures. The production shape: one database (`neondb`), the schema
# owner role, and the two service roles.
# ---------------------------------------------------------------------------

mkdir -p "$WORK/secrets" "$WORK/artifacts"
printf 'postgres://source_reader:***@source-host.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/secrets/source.dsn"
printf 'postgres://neondb_owner:***@neon-main.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/secrets/owner.dsn"
printf 'postgres://sindustries_tasks_api:***@neon-main.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/secrets/dest_tasks.dsn"
printf 'postgres://sindustries_content_scheduler:***@neon-main.internal:5432/neondb?sslmode=require\n' \
  > "$WORK/secrets/dest_content_scheduler.dsn"
chmod 0600 "$WORK/secrets"/*.dsn

archive="$WORK/fake.dump"
printf 'not a real dump\n' > "$archive"
sha="$(PATH="$BIN:$PATH" sha256sum "$archive" | awk '{print $1}')"

RUN_ID="20260101T000000Z-ownerddl"

write_state() {
  : > "$STATE/present"
  : > "$STATE/owners"
  : > "$STATE/grants"
  local s
  for s in "$@"; do
    case "$s" in
      *"|"*) printf '%s\n' "$s" >> "$STATE/owners" ;;
      *)     printf '%s\n' "$s" >> "$STATE/present" ;;
    esac
  done
}

run_cleanup() {
  # $1 = "owner" to use the owner DSN, or "none" to omit it
  : > "$WORK/sql.log"
  : > "$WORK/connection.log"
  local owner_args=()
  if [[ "$1" == "owner" ]]; then
    owner_args=(--dest-owner-dsn-file "$WORK/secrets/owner.dsn")
  fi
  ( cd "$WORK/artifacts" && \
    env \
      PATH="$BIN:$PATH" \
      PSQL_SQL_LOG="$WORK/sql.log" \
      PSQL_CONNECTION_LOG="$WORK/connection.log" \
      PSQL_STUB_STATE_DIR="$STATE" \
      CLOUD_DB_RUN_ID="$RUN_ID" \
      CLOUD_DB_ARTIFACT_DIR="$WORK/artifacts" \
      ENVIRONMENT=production \
      CLOUD_DB_PRODUCTION_ACK=1 \
      bash "$CLEANUP_SH" \
        --source-tasks-dsn-file "$WORK/secrets/source.dsn" \
        --dest-tasks-dsn-file "$WORK/secrets/dest_tasks.dsn" \
        --dest-content-scheduler-dsn-file "$WORK/secrets/dest_content_scheduler.dsn" \
        "${owner_args[@]}" \
        --expected-host source-host.internal:5432 \
        --expected-host neon-main.internal:5432 \
        --confirm "$RUN_ID" \
        --confirm-cleanup-destination 2>&1
  )
}

run_restore() {
  # $1 = "owner" to use the owner DSN, or "none" to omit it
  : > "$WORK/sql.log"
  : > "$WORK/connection.log"
  : > "$WORK/restore.log"
  local owner_args=()
  if [[ "$1" == "owner" ]]; then
    owner_args=(--destination-owner-dsn-file "$WORK/secrets/owner.dsn")
  fi
  ( cd "$WORK/artifacts" && \
    env \
      PATH="$BIN:$PATH" \
      PSQL_SQL_LOG="$WORK/sql.log" \
      PSQL_CONNECTION_LOG="$WORK/connection.log" \
      PSQL_STUB_STATE_DIR="$STATE" \
      PG_RESTORE_LOG="$WORK/restore.log" \
      CLOUD_DB_RUN_ID="$RUN_ID" \
      CLOUD_DB_ARTIFACT_DIR="$WORK/artifacts" \
      ENVIRONMENT=production \
      CLOUD_DB_PRODUCTION_ACK=1 \
      bash "$RESTORE_SH" \
        --source-dsn-file "$WORK/secrets/source.dsn" \
        --destination-dsn-file "$WORK/secrets/dest_tasks.dsn" \
        --destination-content-scheduler-dsn-file "$WORK/secrets/dest_content_scheduler.dsn" \
        "${owner_args[@]}" \
        --expected-host source-host.internal:5432 \
        --expected-host neon-main.internal:5432 \
        --archive "$archive" \
        --archive-sha256 "$sha" \
        --result-dir "$WORK/artifacts" 2>&1
  )
}

# ---------------------------------------------------------------------------
# Case 1 — the cleanup DROPs through the OWNER connection.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_api|neondb_owner" \
  "content_scheduler|neondb_owner"

set +e
out="$(run_cleanup owner)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "the cleanup completes when an owner connection is supplied"
else
  fail "the cleanup failed with an owner connection (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "^neondb_owner|.*DROP SCHEMA IF EXISTS tasks_api CASCADE" "$WORK/connection.log" \
   && grep -q "^neondb_owner|.*DROP SCHEMA IF EXISTS content_scheduler CASCADE" "$WORK/connection.log"; then
  pass "the DROP runs on the schema-OWNER connection"
else
  fail "the DROP did not run on the schema-owner connection"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
fi

if grep -q "^sindustries_tasks_api|.*DROP SCHEMA" "$WORK/connection.log"; then
  fail "the service role still ran the destructive DROP"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
else
  pass "the service roles do NOT run the destructive DROP"
fi

# ---------------------------------------------------------------------------
# Case 2 — without an owner connection the DROP runs on the service-role
# connections, exactly as before (the staging shape).
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_api|sindustries_tasks_api" \
  "content_scheduler|sindustries_content_scheduler"

set +e
out="$(run_cleanup none)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "the cleanup completes without an owner connection"
else
  fail "the cleanup failed without an owner connection (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "^sindustries_tasks_api|.*DROP SCHEMA IF EXISTS tasks_api CASCADE" "$WORK/connection.log"; then
  pass "without an owner connection the DROP runs on the service-role connection (unchanged)"
else
  fail "without an owner connection the DROP did not run on the service-role connection"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 3 — the restore CREATEs the schema through the OWNER connection and
# GRANTS the service role USAGE, CREATE on it.
# ---------------------------------------------------------------------------

write_state

set +e
out="$(run_restore owner)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "the restore completes when an owner connection is supplied"
else
  fail "the restore failed with an owner connection (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "^neondb_owner|.*CREATE SCHEMA tasks_api" "$WORK/connection.log" \
   && grep -q "^neondb_owner|.*CREATE SCHEMA content_scheduler" "$WORK/connection.log"; then
  pass "the schema is CREATED on the schema-OWNER connection"
else
  fail "the schema was not created on the schema-owner connection"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
fi

if grep -q "^neondb_owner|.*GRANT USAGE, CREATE ON SCHEMA tasks_api TO sindustries_tasks_api" "$WORK/connection.log" \
   && grep -q "^neondb_owner|.*GRANT USAGE, CREATE ON SCHEMA content_scheduler TO sindustries_content_scheduler" "$WORK/connection.log"; then
  pass "the owner grants USAGE, CREATE on each schema to its service role"
else
  fail "the owner did not grant USAGE, CREATE to the service roles"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
fi

if grep -q "^sindustries_tasks_api|.*CREATE SCHEMA" "$WORK/connection.log"; then
  fail "the service role still created the schema (which would change its owner)"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
else
  pass "the service role does NOT create the schema"
fi

# The post-restore ownership assertion must expect the OWNER role. The
# stub records the owner of each created schema, so a wrong expectation
# would fail the restore.
if [[ -f "$STATE/owners" ]] && grep -q "^tasks_api|neondb_owner$" "$STATE/owners"; then
  pass "the restored schema is owned by the schema-owner role"
else
  fail "the restored schema is not owned by the schema-owner role"
  printf '%s\n' "$STATE/owners" 2>/dev/null | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 4 — without an owner connection the restore still creates the
# schema through the service-role connection (unchanged).
# ---------------------------------------------------------------------------

write_state

set +e
out="$(run_restore none)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "the restore completes without an owner connection"
else
  fail "the restore failed without an owner connection (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "^sindustries_tasks_api|.*CREATE SCHEMA tasks_api" "$WORK/connection.log"; then
  pass "without an owner connection the schema is created by the service role (unchanged)"
else
  fail "without an owner connection the schema was not created by the service role"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
fi

if grep -q "GRANT USAGE, CREATE ON SCHEMA" "$WORK/connection.log"; then
  fail "a grant was issued although the service role owns its schema"
  printf '%s\n' "$WORK/connection.log" | sed 's/^/      /'
else
  pass "no grant is issued when the service role owns its own schema"
fi

# ---------------------------------------------------------------------------

echo
if [[ $failures -eq 0 ]]; then
  echo "owner-ddl: all checks passed"
  exit 0
fi
echo "owner-ddl: ${failures} failure(s)"
exit 1
