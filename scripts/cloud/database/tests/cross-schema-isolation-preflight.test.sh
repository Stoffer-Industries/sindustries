#!/usr/bin/env bash
# shellcheck shell=bash
# cross-schema-isolation-preflight.test.sh — regression guard for task f2c23e26.
#
# THE DEFECT. The production topology gives each schema its own service
# role (`databaseServiceRoles` in
# infra/cloud/platform/platform-environments.mjs), and the platform's own
# `neon.service-role-scope` gate requires that each role can write only
# inside its own schema and holds no cross-schema access.
#
# The restore asserted that invariant — but only AFTER pg_restore, so a
# destination whose ROLE MODEL cannot confine one service role to its own
# schema was discovered only once the live schemas had already been
# dropped and recreated. The drill then aborted with the data moved, the
# migrations not applied, and the service role unable to use its own
# schema.
#
# The access is a property of the ROLES, not of the data. A role that is a
# member of a role carrying `pg_read_all_data` or `pg_write_all_data`
# holds USAGE — and read and write — on every schema in the database, and
# NO explicit GRANT can withdraw it. Measured against a reproduction of the
# production role model:
#
#     explicit ACL for content_scheduler : names only its own owner role
#     has_schema_privilege(tasks_role, 'content_scheduler', 'USAGE') = true
#     has_table_privilege(tasks_role, 'content_scheduler.post', 'INSERT') = true
#
# So an explicit-ACL-only view of the same question reads CLEAN while the
# access is real. The predicate used here is `has_schema_privilege`, and
# it is the SAME predicate in both places it is asserted.
#
# THE FIX. The same assertion now runs BEFORE the first destructive
# statement, so a mis-provisioned destination refuses with nothing
# dropped and nothing moved. This test pins:
#
#   1. the cleanup DROPS the schemas when the two roles ARE isolated
#   2. the cleanup REFUSES when one role holds USAGE on the other's
#      schema, and the DROP never runs
#   3. the same refusal in the other direction
#   4. the restore REFUSES before it creates either schema
#   5. a single-role environment is not subject to the assertion
#
# Behavioural rather than a grep over source: a stub psql on PATH answers
# the catalogue queries from a state file, and the real scripts run their
# real gates against it. No PostgreSQL needed.
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
# The stub answers from three state files so a test can model a
# destination whose roles are isolated, or one whose roles carry
# cross-schema access:
#
#   present   — one schema name per line; a schema listed here exists
#   usage     — `<role>|<schema>|<t|f>` per line; whether that role
#               holds USAGE on that schema
#
# A DROP removes the schema from `present`, so the post-cleanup
# assertion ("both schemas must now be ABSENT") is answered faithfully.
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

present_file="$PSQL_STUB_STATE_DIR/present"
usage_file="$PSQL_STUB_STATE_DIR/usage"

schema_present() {
  [[ -f "$present_file" ]] || return 1
  grep -qx "$1" "$present_file"
}

case "$flat" in
  *"DROP SCHEMA"*)
      _dropped="$(printf '%s' "$flat" | sed -E 's/.*DROP SCHEMA IF EXISTS ([a-z_]+) CASCADE.*/\1/')"
      if [[ -f "$present_file" ]]; then
        grep -vx "$_dropped" "$present_file" > "$present_file.tmp" 2>/dev/null || true
        mv "$present_file.tmp" "$present_file"
      fi
      printf 'DROP SCHEMA\n' ;;
  *"SELECT current_user"*)
      printf '%s\n' "$conn_role" ;;
  *"has_schema_privilege(current_user,"*)
      _schema="unknown"
      case "$flat" in
        *"current_user, 'tasks_api'"*)         _schema="tasks_api" ;;
        *"current_user, 'content_scheduler'"*) _schema="content_scheduler" ;;
      esac
      _answer="f"
      if [[ -f "$usage_file" ]]; then
        while IFS='|' read -r _r _s _v; do
          [[ -z "${_r:-}" ]] && continue
          if [[ "$_r" == "$conn_role" && "$_s" == "$_schema" ]]; then _answer="$_v"; fi
        done < "$usage_file"
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
# Fixtures.
#
# The two destination DSNs use DIFFERENT roles, which is the production
# topology: one service role per schema. A second pair shares ONE role,
# which is the staging topology, where the assertion does not apply.
# ---------------------------------------------------------------------------

mkdir -p "$WORK/secrets" "$WORK/artifacts"
printf 'postgres://readonly:***@source-host.internal:5432/sindustries_staging_source?sslmode=require\n' \
  > "$WORK/secrets/source.dsn"
printf 'postgres://tasks_role:***@dest-tasks.internal:5432/sindustries_staging_dest_tasks?sslmode=require\n' \
  > "$WORK/secrets/dest_tasks.dsn"
printf 'postgres://cs_role:***@dest-content-scheduler.internal:5432/sindustries_staging_dest_cs?sslmode=require\n' \
  > "$WORK/secrets/dest_content_scheduler.dsn"
printf 'postgres://single_role:***@dest-single.internal:5432/sindustries_staging_dest_single?sslmode=require\n' \
  > "$WORK/secrets/dest_single_tasks.dsn"
printf 'postgres://single_role:***@dest-single.internal:5432/sindustries_staging_dest_single_cs?sslmode=require\n' \
  > "$WORK/secrets/dest_single_content_scheduler.dsn"
chmod 0600 "$WORK/secrets"/*.dsn

archive="$WORK/fake.dump"
printf 'not a real dump\n' > "$archive"
sha="$(PATH="$BIN:$PATH" sha256sum "$archive" | awk '{print $1}')"

RUN_ID="20260101T000000Z-isolationtest"

# write_state <present schemas...> <usage rows...>
write_state() {
  : > "$STATE/present"
  : > "$STATE/usage"
  local s
  for s in "$@"; do
    case "$s" in
      *"|"*) printf '%s\n' "$s" >> "$STATE/usage" ;;
      *)     printf '%s\n' "$s" >> "$STATE/present" ;;
    esac
  done
}

run_cleanup() {
  # $1 = tasks dest DSN file, $2 = content-scheduler dest DSN file
  : > "$WORK/sql.log"
  : > "$WORK/restore.log"
  ( cd "$WORK/artifacts" && \
    env \
      PATH="$BIN:$PATH" \
      PSQL_SQL_LOG="$WORK/sql.log" \
      PG_RESTORE_LOG="$WORK/restore.log" \
      PSQL_STUB_STATE_DIR="$STATE" \
      CLOUD_DB_RUN_ID="$RUN_ID" \
      CLOUD_DB_ARTIFACT_DIR="$WORK/artifacts" \
      ENVIRONMENT=staging \
      bash "$CLEANUP_SH" \
        --source-tasks-dsn-file "$WORK/secrets/source.dsn" \
        --dest-tasks-dsn-file "$1" \
        --dest-content-scheduler-dsn-file "$2" \
        --expected-host source-host.internal:5432 \
        --expected-host dest-tasks.internal:5432 \
        --expected-host dest-content-scheduler.internal:5432 \
        --expected-host dest-single.internal:5432 \
        --confirm "$RUN_ID" \
        --confirm-cleanup-destination 2>&1
  )
}

run_restore() {
  : > "$WORK/sql.log"
  : > "$WORK/restore.log"
  ( cd "$WORK/artifacts" && \
    env \
      PATH="$BIN:$PATH" \
      PSQL_SQL_LOG="$WORK/sql.log" \
      PG_RESTORE_LOG="$WORK/restore.log" \
      PSQL_STUB_STATE_DIR="$STATE" \
      CLOUD_DB_RUN_ID="$RUN_ID" \
      CLOUD_DB_ARTIFACT_DIR="$WORK/artifacts" \
      ENVIRONMENT=staging \
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
# Case 1 — the roles ARE isolated: the cleanup drops the schemas.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_role|tasks_api|t" \
  "cs_role|content_scheduler|t"

set +e
out="$(run_cleanup "$WORK/secrets/dest_tasks.dsn" "$WORK/secrets/dest_content_scheduler.dsn")"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "the cleanup drops the schemas when the two roles are isolated"
else
  fail "the cleanup failed on the isolated happy path (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "DROP SCHEMA IF EXISTS tasks_api CASCADE" "$WORK/sql.log" \
   && grep -q "DROP SCHEMA IF EXISTS content_scheduler CASCADE" "$WORK/sql.log"; then
  pass "the cleanup drops both schemas through their own destination DSN"
else
  fail "the cleanup did not drop both schemas"
  printf '%s\n' "$WORK/sql.log" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 2 — the tasks role holds USAGE on content_scheduler: the cleanup
# must refuse, and the DROP must never run.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_role|tasks_api|t" \
  "cs_role|content_scheduler|t" \
  "tasks_role|content_scheduler|t"

set +e
out="$(run_cleanup "$WORK/secrets/dest_tasks.dsn" "$WORK/secrets/dest_content_scheduler.dsn")"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  pass "the cleanup refuses when a role holds USAGE on the other schema"
else
  fail "the cleanup did not refuse a cross-schema destination (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "cross-schema isolation assertion failed" <<<"$out"; then
  pass "the refusal names the cross-schema isolation assertion"
else
  fail "the refusal did not name the isolation assertion"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "DROP SCHEMA" "$WORK/sql.log"; then
  fail "the cleanup dropped a schema after refusing to run"
  printf '%s\n' "$WORK/sql.log" | sed 's/^/      /'
else
  pass "the refusal happens BEFORE the drop: no schema was dropped"
fi

# ---------------------------------------------------------------------------
# Case 3 — the other direction: the content-scheduler role holds USAGE on
# tasks_api. Same expectation.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_role|tasks_api|t" \
  "cs_role|content_scheduler|t" \
  "cs_role|tasks_api|t"

set +e
out="$(run_cleanup "$WORK/secrets/dest_tasks.dsn" "$WORK/secrets/dest_content_scheduler.dsn")"
rc=$?
set -e

if [[ $rc -ne 0 ]] && ! grep -q "DROP SCHEMA" "$WORK/sql.log"; then
  pass "the cleanup refuses the reverse cross-schema case, before the drop"
else
  fail "the cleanup did not refuse the reverse cross-schema case (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
  printf '%s\n' "$WORK/sql.log" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 4 — the restore refuses BEFORE it creates either schema.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "tasks_role|tasks_api|t" \
  "cs_role|content_scheduler|t" \
  "tasks_role|content_scheduler|t"

set +e
out="$(run_restore)"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  pass "the restore refuses a cross-schema destination"
else
  fail "the restore did not refuse a cross-schema destination (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

if grep -q "CREATE SCHEMA" "$WORK/sql.log"; then
  fail "the restore created a schema before refusing"
  printf '%s\n' "$WORK/sql.log" | sed 's/^/      /'
else
  pass "the restore refuses BEFORE creating either schema"
fi

if grep -q "pre-restore: cross-schema isolation assertion failed" <<<"$out"; then
  pass "the restore's refusal is attributed to the pre-restore phase"
else
  fail "the restore's refusal did not name the pre-restore phase"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 5 — a single-role environment is not subject to the assertion.
# Staging genuinely restores both schemas with one role, so the check
# must not produce a false refusal there.
# ---------------------------------------------------------------------------

write_state \
  tasks_api content_scheduler \
  "single_role|tasks_api|t" \
  "single_role|content_scheduler|t"

set +e
out="$(run_cleanup "$WORK/secrets/dest_single_tasks.dsn" "$WORK/secrets/dest_single_content_scheduler.dsn")"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "a single-role environment is not refused by the isolation assertion"
else
  fail "the isolation assertion refused a single-role environment (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------

echo
if [[ $failures -eq 0 ]]; then
  echo "cross-schema-isolation-preflight: all checks passed"
  exit 0
fi
echo "cross-schema-isolation-preflight: ${failures} failure(s)"
exit 1
