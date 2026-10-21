#!/usr/bin/env bash
# shellcheck shell=bash
# schema-presence.test.sh — regression guard for task d37681e1.
#
# The failure this guards (drill run 39583824097):
#
#     pg_restore: error: could not execute query:
#     ERROR:  schema "budget_api" already exists
#     Command was: CREATE SCHEMA budget_api;
#
# Two guards were blind to the same state. cleanup-destination.sh
# decided whether to drop using information_schema.tables counts, and
# restore.sh's "destination is not empty" pre-flight did the same. A
# failed pg_restore creates the schema and then dies before it creates
# any table, so the schema is left PRESENT but EMPTY -- invisible to
# both table-count queries. Cleanup therefore reported "both
# destination schemas already empty; nothing to drop" and skipped the
# DROP, and restore's guard passed the same destination straight
# through to pg_restore, which then collided with its own CREATE
# SCHEMA.
#
# The two holes are complementary and only meet after a failure, so
# fixing either alone leaves the drill able to re-enter this state.
# This test pins BOTH.
#
# It is behavioural rather than a grep over source: a stub psql/pg_restore
# on PATH answers the catalogue queries with canned rows, and the real
# scripts run their real gates against them. No PostgreSQL needed.
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
# Stub toolchain. psql answers catalogue queries from env vars and logs every
# statement it is handed, so a test can assert a DROP was actually issued
# rather than trusting the script's own log line.
# ---------------------------------------------------------------------------

BIN="$WORK/bin"
mkdir -p "$BIN"

cat > "$BIN/psql" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "psql (PostgreSQL) 18.2"; exit 0; fi
cmd=""
for arg in "$@"; do
  case "$arg" in
    --command=*) cmd="${arg#--command=}" ;;
  esac
done
echo "SQL: $cmd" >> "$PSQL_SQL_LOG"
# Normalise whitespace for matching.
flat="$(printf '%s' "$cmd" | tr -s '[:space:]' ' ')"

case "$flat" in
  *"information_schema.schemata"*"schema_name = 'tasks_api'"*)
      printf '%s\n' "${PSQL_TASKS_SCHEMA_EXISTS:-0}" ;;
  *"information_schema.schemata"*"schema_name = 'budget_api'"*)
      printf '%s\n' "${PSQL_BUDGET_SCHEMA_EXISTS:-0}" ;;
  *"information_schema.schemata"*"schema_name IN"*)
      # restore.sh issues this exact query twice: once as the pre-flight
      # guard and once as the post-restore verification. Answer the first
      # with the starting state, the second with the post-restore state.
      _n="$(cat "$PSQL_SCHEMA_IN_COUNT" 2>/dev/null || printf '0')"
      _n=$((_n + 1)); printf '%s' "$_n" > "$PSQL_SCHEMA_IN_COUNT"
      if [[ "$_n" -eq 1 ]]; then
        printf '%s\n' "${PSQL_RESTORE_SCHEMA_LIST:-}"
      else
        printf '%s\n' "${PSQL_RESTORE_SCHEMA_AFTER:-tasks_api,budget_api}"
      fi ;;
  *"information_schema.tables"*"table_schema = 'tasks_api'"*)
      printf '%s\n' "${PSQL_TASKS_TABLE_COUNT:-0}" ;;
  *"information_schema.tables"*"table_schema = 'budget_api'"*)
      printf '%s\n' "${PSQL_BUDGET_TABLE_COUNT:-0}" ;;
  *"information_schema.tables"*"table_schema IN"*)
      printf '%s\n' "${PSQL_RESTORE_TABLE_COUNT:-0}" ;;
  *"DROP SCHEMA"*)
      printf '%s\n' "DROP SCHEMA" ;;
  *)
      printf '\n' ;;
esac
STUB

cat > "$BIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "pg_restore (PostgreSQL) 18.2"; exit 0; fi
echo "PG_RESTORE RAN" >> "$PSQL_SQL_LOG"
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

# node is presence-checked only; shim it only if the host lacks it.
if ! command -v node >/dev/null 2>&1; then
  cat > "$BIN/node" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$BIN/node"
fi

# ---------------------------------------------------------------------------
# Fixtures: three DSN files that satisfy every guard (staging env, no
# production substring, staging db-name prefix, source host distinct from
# both destinations).
# ---------------------------------------------------------------------------

mkdir -p "$WORK/secrets" "$WORK/artifacts"
printf 'postgres://u:p@source-host.internal:5432/sindustries_staging_source?sslmode=require\n' \
  > "$WORK/secrets/source.dsn"
printf 'postgres://u:p@dest-tasks.internal:5432/sindustries_staging_dest_tasks?sslmode=require\n' \
  > "$WORK/secrets/dest_tasks.dsn"
printf 'postgres://u:p@dest-budget.internal:5432/sindustries_staging_dest_budget?sslmode=require\n' \
  > "$WORK/secrets/dest_budget.dsn"
chmod 0600 "$WORK/secrets"/*.dsn

RUN_ID="20260101T000000Z-test00"

run_cleanup() {
  ( cd "$WORK/artifacts" && \
    PATH="$BIN:$PATH" \
    PSQL_SQL_LOG="$WORK/sql.log" PSQL_SCHEMA_IN_COUNT="$WORK/count" \
    CLOUD_DB_RUN_ID="$RUN_ID" \
    ENVIRONMENT=staging \
    bash "$CLEANUP_SH" \
      --source-tasks-dsn-file "$WORK/secrets/source.dsn" \
      --dest-tasks-dsn-file "$WORK/secrets/dest_tasks.dsn" \
      --dest-budget-dsn-file "$WORK/secrets/dest_budget.dsn" \
      --confirm "$RUN_ID" \
      --confirm-cleanup-destination ) 2>&1
}

# ---------------------------------------------------------------------------
# Case 1 — THE REGRESSION. Schema present but EMPTY on both destinations.
# Before the fix: ALREADY_EMPTY verdict, no DROP issued, next restore dies
# on CREATE SCHEMA. After: the schemas are dropped and recreated.
# ---------------------------------------------------------------------------

rm -f "$WORK/count"
: > "$WORK/sql.log"
out="$(PSQL_TASKS_TABLE_COUNT=0 PSQL_BUDGET_TABLE_COUNT=0 \
       PSQL_TASKS_SCHEMA_EXISTS=1 PSQL_BUDGET_SCHEMA_EXISTS=1 \
       run_cleanup || true)"

if grep -q "DROP SCHEMA" "$WORK/sql.log"; then
  pass "cleanup drops a schema that is present but empty (table counts 0)"
else
  fail "cleanup skipped the DROP for a present-but-empty schema -- regression"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

envelope="$(find "$WORK/artifacts" -name "cleanup-${RUN_ID}.json" -type f 2>/dev/null | head -1)"
if [[ -n "$envelope" ]] && grep -q '"verdict": "SCHEMAS_ABSENT"' "$envelope"; then
  fail "cleanup reported SCHEMAS_ABSENT while both schemas existed"
else
  pass "cleanup does not report SCHEMAS_ABSENT when schemas exist"
fi

# ---------------------------------------------------------------------------
# Case 2 — Genuinely fresh destination. Neither schema exists. Cleanup stays
# a no-op and says so. Guards the fix against over-correcting into an
# unconditional drop.
# ---------------------------------------------------------------------------

rm -f "$WORK/count"
: > "$WORK/sql.log"
rm -f "$WORK/artifacts/cleanup-${RUN_ID}.json"
out="$(PSQL_TASKS_TABLE_COUNT=0 PSQL_BUDGET_TABLE_COUNT=0 \
       PSQL_TASKS_SCHEMA_EXISTS=0 PSQL_BUDGET_SCHEMA_EXISTS=0 \
       run_cleanup || true)"

if grep -q "DROP SCHEMA" "$WORK/sql.log"; then
  fail "cleanup issued a DROP on a destination where neither schema exists"
else
  pass "cleanup stays a no-op when neither destination schema exists"
fi

envelope="$(find "$WORK/artifacts" -name "cleanup-${RUN_ID}.json" -type f 2>/dev/null | head -1)"
if [[ -n "$envelope" ]] && grep -q '"verdict": "SCHEMAS_ABSENT"' "$envelope"; then
  pass "cleanup records the SCHEMAS_ABSENT verdict on a fresh destination"
else
  fail "cleanup did not record SCHEMAS_ABSENT on a fresh destination"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 3 — One schema present, one absent. The asymmetric state: must drop.
# ---------------------------------------------------------------------------

rm -f "$WORK/count"
: > "$WORK/sql.log"
rm -f "$WORK/artifacts/cleanup-${RUN_ID}.json"
out="$(PSQL_TASKS_TABLE_COUNT=0 PSQL_BUDGET_TABLE_COUNT=0 \
       PSQL_TASKS_SCHEMA_EXISTS=1 PSQL_BUDGET_SCHEMA_EXISTS=0 \
       run_cleanup || true)"

if grep -q "DROP SCHEMA" "$WORK/sql.log"; then
  pass "cleanup drops when exactly one destination schema exists"
else
  fail "cleanup skipped the DROP when exactly one schema existed -- regression"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Case 4 — restore.sh refuses a destination holding a present-but-empty
# schema, BEFORE pg_restore runs. Before the fix the table-count guard
# passed it through and pg_restore died on CREATE SCHEMA.
# ---------------------------------------------------------------------------

archive="$WORK/fake.dump"
printf 'not a real dump\n' > "$archive"
sha="$(PATH="$BIN:$PATH" sha256sum "$archive" | awk '{print $1}')"

rm -f "$WORK/count"
: > "$WORK/sql.log"
set +e
restore_out="$(
  cd "$WORK/artifacts" && \
  PATH="$BIN:$PATH" \
  PSQL_SQL_LOG="$WORK/sql.log" PSQL_SCHEMA_IN_COUNT="$WORK/count" \
  CLOUD_DB_RUN_ID="$RUN_ID" \
  ENVIRONMENT=staging \
  PSQL_RESTORE_TABLE_COUNT=0 \
  PSQL_RESTORE_SCHEMA_LIST=budget_api \
  bash "$RESTORE_SH" \
    --source-dsn-file "$WORK/secrets/source.dsn" \
    --destination-dsn-file "$WORK/secrets/dest_tasks.dsn" \
    --archive "$archive" \
    --archive-sha256 "$sha" \
    --result-dir "$WORK/artifacts" 2>&1
)"
restore_rc=$?
set -e

if [[ $restore_rc -ne 0 ]] && grep -q "already contains schema" <<<"$restore_out"; then
  pass "restore refuses a destination whose schema already exists"
else
  fail "restore did not refuse a destination whose schema already exists"
  printf '%s\n' "$restore_out" | sed 's/^/      /'
fi

if grep -q "PG_RESTORE RAN" "$WORK/sql.log"; then
  fail "restore reached pg_restore despite the pre-existing schema"
else
  pass "restore fails before pg_restore rather than inside it"
fi

# ---------------------------------------------------------------------------
# Case 5 — restore.sh still proceeds on a genuinely fresh destination. Guards
# the fix against over-correction.
# ---------------------------------------------------------------------------

rm -f "$WORK/count"
: > "$WORK/sql.log"
set +e
restore_ok="$(
  cd "$WORK/artifacts" && \
  PATH="$BIN:$PATH" \
  PSQL_SQL_LOG="$WORK/sql.log" PSQL_SCHEMA_IN_COUNT="$WORK/count" \
  CLOUD_DB_RUN_ID="$RUN_ID" \
  ENVIRONMENT=staging \
  bash "$RESTORE_SH" \
    --source-dsn-file "$WORK/secrets/source.dsn" \
    --destination-dsn-file "$WORK/secrets/dest_tasks.dsn" \
    --archive "$archive" \
    --archive-sha256 "$sha" \
    --result-dir "$WORK/artifacts" 2>&1
)"
restore_ok_rc=$?
set -e

if [[ $restore_ok_rc -eq 0 ]] && grep -q "PG_RESTORE RAN" "$WORK/sql.log"; then
  pass "restore proceeds on a fresh destination"
else
  fail "restore refused a genuinely fresh destination"
  printf '%s\n' "$restore_ok" | sed 's/^/      /'
fi

if (( failures > 0 )); then
  echo "FAIL: ${failures} schema-presence check(s) failed"
  exit 1
fi

echo "ALL schema-presence checks passed"