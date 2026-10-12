#!/usr/bin/env bash
# staging-db-migration-failure-drill.test.sh
#
# Unit tests for tests/cloud/staging-db-migration-failure-drill.sh
# (AC4 CI migration-failure fixture, task d37681e1).
#
# Stubs `prisma` and `psql` in PATH so the harness runs against
# controlled canned responses, then asserts:
#
#   1. The harness refuses a non-disposable DSN unless
#      STAGING_DB_FAILURE_FIXTURE=1 is set.
#   2. The harness refuses a DSN that matches the production deny-list
#      substring even with the override set.
#   3. The harness refuses a --prisma-migrations-dir that resolves
#      under services/<svc>/prisma/migrations/.
#   4. The harness requires --confirm-staging.
#   5. The happy path: prisma exits 1 with a "bad_migration" error,
#      _prisma_migrations has exactly one row named *_bad_migration*
#      with rolled_back_at NULL — the harness emits verdict=pass,
#      exit 0, and all four checks recorded.
#   6. The happy path records no workflow-validation step in the
#      emitted envelope (no reconcile / drill_step workflow / etc.).
#
# Pure bash; no install step on CI. Run with:
#   bash tests/cloud/tests/staging-db-migration-failure-drill.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
DRILL="$REPO_ROOT/tests/cloud/staging-db-migration-failure-drill.sh"
[[ -f "$DRILL" ]] || { echo "FAIL: $DRILL not found (REPO_ROOT=$REPO_ROOT)" >&2; exit 1; }

FIXTURE_MIG_DIR_TASKS="$REPO_ROOT/services/tasks-api/prisma/test-migrations-fixture"
FIXTURE_MIG_DIR_BUDGET="$REPO_ROOT/services/budget-api/prisma/test-migrations-fixture"
PROD_MIG_DIR_TASKS="$REPO_ROOT/services/tasks-api/prisma/migrations"
PROD_MIG_DIR_BUDGET="$REPO_ROOT/services/budget-api/prisma/migrations"
for d in "$FIXTURE_MIG_DIR_TASKS" "$FIXTURE_MIG_DIR_BUDGET" "$PROD_MIG_DIR_TASKS" "$PROD_MIG_DIR_BUDGET"; do
  [[ -d "$d" ]] || { echo "FAIL: $d not found" >&2; exit 1; }
done

PASS=0
FAIL=0
TESTS_RUN=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); TESTS_RUN=$((TESTS_RUN + 1)); printf "  ok %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); TESTS_RUN=$((TESTS_RUN + 1)); printf "  not ok %s\n" "$1"; if [[ -n "${2:-}" ]]; then printf "      %s\n" "$2"; fi; }

# ---------------------------------------------------------------------------
# Build a fake prisma that exits 1 with a "bad_migration" error and
# creates a fake _prisma_migrations row by writing to a marker file
# (the harness's stub-psql path reads _prisma_migrations indirectly).
# Build a fake psql that reports exactly one row named
# "20260101000000_bad_migration" with rolled_back_at NULL.
# ---------------------------------------------------------------------------

setup_stubs() {
  local bin="$TMP/bin-$RANDOM"
  mkdir -p "$bin"

  cat >"$bin/prisma" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  migrate)
    if [[ "$2" == "deploy" ]]; then
      # Record the invocation so the test can later assert no
      # `migrate resolve` was attempted.
      printf 'INVOKED: prisma %s\n' "$*" >>"$PRISMA_LOG"
      printf 'Error: P3009\nmigrate found failed migrations in the target database\n\nThe 20260101000000_bad_migration migration failed: type "nonexistent_type_d4e3" does not exist\n' >&2
      exit 1
    fi
    if [[ "$2" == "resolve" ]]; then
      printf 'INVOKED: prisma %s\n' "$*" >>"$PRISMA_LOG"
      echo "stub: prisma migrate resolve must not be invoked by the harness" >&2
      exit 99
    fi
    ;;
esac
STUB
  chmod +x "$bin/prisma"

  cat >"$bin/psql" <<'STUB'
#!/usr/bin/env bash
# Stub psql that answers the three queries the harness makes against
# _prisma_migrations. The query is the third positional argument
# (psql -c '...'); the harness never passes --command=foo so we match
# by trailing query content.
query="${@: -1}"
case "$query" in
  *"SELECT count(*) FROM _prisma_migrations;")
    printf '1\n'
    ;;
  *"SELECT migration_name FROM _prisma_migrations;")
    printf '20260101000000_bad_migration\n'
    ;;
  *"SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL;")
    printf '0\n'
    ;;
  *)
    echo "stub-psql: unhandled query: $query" >&2
    exit 2
    ;;
esac
STUB
  chmod +x "$bin/psql"

  export PATH="$bin:$PATH"
  export PRISMA_LOG="$TMP/prisma.log"
  printf '' >"$PRISMA_LOG"
}

# Convenience: assert jq is available; the harness uses jq to assemble
# the checks[] / cleanup[] arrays.
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Case 1: harness refuses a non-disposable DSN without the override
# ---------------------------------------------------------------------------

echo "case 1: non-disposable DSN without STAGING_DB_FAILURE_FIXTURE=1"
TMP1="$TMP/case1"
mkdir -p "$TMP1"
setup_stubs
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:s3cret@sindustries-prod-db.example.com:5432/tasks_api?schema=tasks_api' \
    --prisma-migrations-dir "$FIXTURE_MIG_DIR_TASKS" \
    --service tasks-api \
    --output "$TMP1/out.json" \
    --confirm-staging 2>&1)"
rc=$?
set -e
if [[ $rc -eq 1 ]] && [[ "$out" == *"does not look like a disposable DSN"* ]]; then
  pass "refuses non-disposable DSN without override (exit=1)"
else
  fail "refuses non-disposable DSN without override" "exit=$rc output=$out"
fi

# ---------------------------------------------------------------------------
# Case 2: harness refuses a production-DSN-substring DSN even with the
# override set.
# ---------------------------------------------------------------------------

echo "case 2: production-substring DSN with STAGING_DB_FAILURE_FIXTURE=1"
TMP2="$TMP/case2"
mkdir -p "$TMP2"
setup_stubs
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  STAGING_DB_FAILURE_FIXTURE=1 \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:s3cret@sindustries-prod-db.example.com:5432/tasks_api?schema=tasks_api' \
    --prisma-migrations-dir "$FIXTURE_MIG_DIR_TASKS" \
    --service tasks-api \
    --output "$TMP2/out.json" \
    --confirm-staging 2>&1)"
rc=$?
set -e
if [[ $rc -eq 1 ]] && [[ "$out" == *"production deny-list substring"* ]]; then
  pass "refuses production-substring DSN even with override (exit=1)"
else
  fail "refuses production-substring DSN even with override" "exit=$rc output=$out"
fi

# ---------------------------------------------------------------------------
# Case 3: harness refuses a prisma-migrations-dir that resolves under
# the production prisma/migrations/ path.
# ---------------------------------------------------------------------------

echo "case 3: production prisma/migrations/ path"
TMP3="$TMP/case3"
mkdir -p "$TMP3"
setup_stubs
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:***@localhost:5432/postgres?schema=tasks_api&sslmode=disable' \
    --prisma-migrations-dir "$PROD_MIG_DIR_TASKS" \
    --service tasks-api \
    --output "$TMP3/out.json" \
    --confirm-staging 2>&1)"
rc=$?
set -e
if [[ $rc -eq 1 ]] && [[ "$out" == *"refuse to override a real migration tree"* ]]; then
  pass "refuses production prisma/migrations/ path (exit=1)"
else
  fail "refuses production prisma/migrations/ path" "exit=$rc output=$out"
fi

# ---------------------------------------------------------------------------
# Case 4: harness requires --confirm-staging
# ---------------------------------------------------------------------------

echo "case 4: missing --confirm-staging"
TMP4="$TMP/case4"
mkdir -p "$TMP4"
setup_stubs
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:***@localhost:5432/postgres?schema=tasks_api&sslmode=disable' \
    --prisma-migrations-dir "$FIXTURE_MIG_DIR_TASKS" \
    --service tasks-api \
    --output "$TMP4/out.json" 2>&1)"
rc=$?
set -e
if [[ $rc -eq 1 ]] && [[ "$out" == *"--confirm-staging is required"* ]]; then
  pass "refuses missing --confirm-staging (exit=1)"
else
  fail "refuses missing --confirm-staging" "exit=$rc output=$out"
fi

# ---------------------------------------------------------------------------
# Case 5: happy path. The harness's stubbed prisma exits 1 with
# "bad_migration" in stderr, the stubbed psql reports exactly one
# _prisma_migrations row named *_bad_migration* with rolled_back_at
# NULL. The harness should emit verdict=pass, exit 0, and all four
# checks should record status=pass.
# ---------------------------------------------------------------------------

echo "case 5: happy path verdict=pass"
TMP5="$TMP/case5"
mkdir -p "$TMP5"
setup_stubs
PRISMA_BIN_FOR_TEST="$(dirname "$(command -v prisma)")/prisma"
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  PRISMA_BIN="$PRISMA_BIN_FOR_TEST" \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:***@localhost:5432/postgres?schema=tasks_api&sslmode=disable' \
    --prisma-migrations-dir "$FIXTURE_MIG_DIR_TASKS" \
    --service tasks-api \
    --output "$TMP5/out.json" \
    --run-id "test-run-5" \
    --intent-commit "deadbeefdeadbeef" \
    --confirm-staging 2>&1)"
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  fail "happy path exits 0" "exit=$rc output=$out"
elif [[ ! -s "$TMP5/out.json" ]]; then
  fail "happy path writes JSON output" "empty output file; harness stderr: $out"
else
  verdict="$(jq -r .verdict <"$TMP5/out.json")"
  if [[ "$verdict" == "pass" ]]; then
    pass "happy path verdict=pass"
  else
    fail "happy path verdict=pass" "verdict=$verdict envelope=$(cat "$TMP5/out.json")"
  fi

  pass_count="$(jq '[ .checks[] | select(.status == "pass") ] | length' <"$TMP5/out.json")"
  if [[ "$pass_count" == "4" ]]; then
    pass "happy path records 4/4 pass checks"
  else
    fail "happy path records 4/4 pass checks" "pass_count=$pass_count"
  fi

  provider="$(jq -r .environment.provider <"$TMP5/out.json")"
  if [[ "$provider" == "github-actions-postgres" ]]; then
    pass "happy path emits provider=github-actions-postgres"
  else
    fail "happy path emits provider=github-actions-postgres" "provider=$provider"
  fi

  intent="$(jq -r .intentCommit <"$TMP5/out.json")"
  if [[ "$intent" == "deadbeefdeadbeef" ]]; then
    pass "happy path records intentCommit"
  else
    fail "happy path records intentCommit" "intent=$intent"
  fi
fi

# ---------------------------------------------------------------------------
# Case 6: happy path does not record a workflow-validation check
# (asserted by the absence of reconcile / drill_step workflow tokens
# in the stubbed prisma's recorded log).
# ---------------------------------------------------------------------------

echo "case 6: no workflow-validation step recorded"
if [[ -s "$PRISMA_LOG" ]]; then
  if grep -qE 'reconcile|drill_step workflow|validate_workflows|run_workflow|prisma migrate resolve' "$PRISMA_LOG"; then
    fail "no workflow-validation step recorded" "stub prisma log=$PRISMA_LOG"
  else
    pass "no workflow-validation step recorded (log only shows migrate deploy)"
  fi
else
  fail "no workflow-validation step recorded" "PRISMA_LOG missing or empty"
fi

# ---------------------------------------------------------------------------
# Case 7: budget-api service path. Same harness with --service
# budget-api should also produce verdict=pass; the services.budgetApi
# URL in the envelope should reflect the disposable host.
# ---------------------------------------------------------------------------

echo "case 7: budget-api service path"
TMP7="$TMP/case7"
mkdir -p "$TMP7"
setup_stubs
PRISMA_BIN_FOR_TEST="$(dirname "$(command -v prisma)")/prisma"
set +e
out="$(cd "$REPO_ROOT" && \
  PATH="$PATH" \
  PRISMA_BIN="$PRISMA_BIN_FOR_TEST" \
  bash "$DRILL" \
    --source-dsn 'postgresql://app:***@localhost:5432/postgres?schema=budget_api&sslmode=disable' \
    --prisma-migrations-dir "$FIXTURE_MIG_DIR_BUDGET" \
    --service budget-api \
    --output "$TMP7/out.json" \
    --run-id "test-run-7" \
    --confirm-staging 2>&1)"
rc=$?
set -e
if [[ $rc -eq 0 ]] && [[ -s "$TMP7/out.json" ]]; then
  verdict="$(jq -r .verdict <"$TMP7/out.json")"
  service_id="$(jq -r .environment.id <"$TMP7/out.json")"
  if [[ "$verdict" == "pass" && "$service_id" == "disposable-postgres-budget-api" ]]; then
    pass "budget-api service path verdict=pass (environment.id=disposable-postgres-budget-api)"
  else
    fail "budget-api service path verdict=pass" "verdict=$verdict service_id=$service_id"
  fi
else
  fail "budget-api service path runs cleanly" "exit=$rc output=$out"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n%d tests, %d passed, %d failed\n' "$TESTS_RUN" "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
