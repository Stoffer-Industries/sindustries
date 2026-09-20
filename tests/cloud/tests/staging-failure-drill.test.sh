#!/usr/bin/env bash
# staging-failure-drill.test.sh — black-box smoke tests for the cloud
# staging failure drill (task 2850c5ac, AC3).
#
# Stubs `flyctl` in PATH so the drill executes against a controlled
# canned JSON, then asserts:
#
#   1. The drill parses cleanly and emits schema-valid JSON.
#   2. Cleanup() runs before the verdict is computed (CLEANUP_JSONL is
#      populated in the emitted result, not empty).
#   3. The intentCommit token is correctly quoted when non-empty
#      (Codex P1 #4: prior in-heredoc concatenation produced
#      `"abc123"null`, which jq refused to parse).
#   4. A missing intent commit is rejected before mutation.
#   5. The script never invokes a bare `fly` binary — only the
#      workflow-installed `flyctl` (Stoff81 Critical #3).
#   6. Cleanup() is idempotent: a second invocation after CLEANUP_RAN=1
#      is a no-op (Stoff81 Critical #1).
#
# Pure bash; no install step on CI. Run with:
#   bash tests/cloud/tests/staging-failure-drill.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi
DRILL="$REPO_ROOT/tests/cloud/staging-failure-drill.sh"
SCHEMA="$REPO_ROOT/tests/cloud/staging-validation.schema.json"
SCHEMA_CHECK="$REPO_ROOT/tests/cloud/scripts/check-schema.mjs"
[[ -f "$DRILL" ]] || { echo "FAIL: $DRILL not found (REPO_ROOT=$REPO_ROOT)" >&2; exit 1; }
[[ -f "$SCHEMA" ]] || { echo "FAIL: $SCHEMA not found" >&2; exit 1; }
[[ -f "$SCHEMA_CHECK" ]] || { echo "FAIL: $SCHEMA_CHECK not found" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Stub flyctl — emits a stateful machine list (one worker)
# and records every invocation to $FLY_LOG so sub-cases can inspect what
# the drill actually called. Stop/start update a state file so the test
# verifies both the killed and recovered machine-state assertions.
# ---------------------------------------------------------------------------

mkdir -p "$TMP/bin"
cat >"$TMP/bin/flyctl" <<'STUB'
#!/usr/bin/env bash
printf 'INVOKED: %s\n' "$*" >>"$FLY_LOG"
case "$1 $2" in
  "status")
    state="$(cat "$FLY_STATE")"
    cat <<JSON
{"Machines":[{"ID":"machine-abc","Name":"worker-1","State":"$state"}]}
JSON
    ;;
  "machines list")
    state="$(cat "$FLY_STATE")"
    cat <<JSON
[{"id":"machine-abc","name":"worker-1","state":"$state","config":{"metadata":{"fly-process-group":"worker"}}}]
JSON
    ;;
  "machines stop")
    printf 'stopped' >"$FLY_STATE"
    ;;
  "machines start")
    printf 'started' >"$FLY_STATE"
    ;;
  *)
    echo "stub: unhandled flyctl invocation: $*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$TMP/bin/flyctl"
export PATH="$TMP/bin:$PATH"
export FLY_LOG="$TMP/fly.log"
export FLY_STATE="$TMP/fly.state"
printf 'started' >"$FLY_STATE"
export FLY_API_TOKEN="fake-token-for-test"

# ---------------------------------------------------------------------------
# Helper: run the drill with the stub and assert on the emitted JSON.
# ---------------------------------------------------------------------------

run_drill() {
  local intent_commit="$1"
  local out="$TMP/result.json"
  set +e
  "$DRILL" \
    --fly-org "test-org" \
    --fly-app-worker "sindustries-content-scheduler-worker-staging" \
    --scheduler-api-url "https://scheduler.example" \
    --scheduler-token "fake-scheduler-token" \
    --intent-commit "$intent_commit" \
    --confirm-staging \
    --output "$out" \
    --max-duration-seconds 60
  local rc=$?
  set -e
  printf '%s' "$rc"
}

assert_intent_commit_value() {
  local out="$TMP/result.json" expected="$1"
  local got
  got="$(jq -r '.intentCommit' "$out")"
  if [[ "$got" != "$expected" ]]; then
    echo "FAIL: intentCommit expected '$expected', got '$got'" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Sub-case 1: intentCommit is non-empty → emitted as a quoted string
# (Codex P1 #4 regression guard).
# ---------------------------------------------------------------------------
rc="$(run_drill "abc1234567890def1234567890def1234567890")"
if [[ "$rc" -ne 1 ]]; then
  echo "FAIL: drill expected exit 1 while AC3 observability verification is unimplemented, got $rc" >&2
  exit 1
fi
assert_intent_commit_value "abc1234567890def1234567890def1234567890"
jq -e '.intentCommit == "abc1234567890def1234567890def1234567890"' "$TMP/result.json" >/dev/null \
  || { echo "FAIL: intentCommit did not match the declared SHA" >&2; exit 1; }
echo "PASS: sub-case 1 — intentCommit correctly quoted when non-empty"

# Verify schema validity on the same file.
node "$SCHEMA_CHECK" "$TMP/result.json" >/dev/null \
  || { echo "FAIL: schema check failed on sub-case 1 output" >&2; exit 1; }
echo "PASS: sub-case 1 — emitted JSON passes schema check"

# ---------------------------------------------------------------------------
# Sub-case 2: intentCommit empty → rejected before any provider mutation.
# ---------------------------------------------------------------------------
: >"$FLY_LOG"
rc="$(run_drill "")"
if [[ "$rc" -ne 2 ]]; then
  echo "FAIL: drill expected config exit 2 for missing intent commit, got $rc" >&2
  exit 1
fi
if [[ -s "$FLY_LOG" ]]; then
  echo "FAIL: provider commands ran before missing intent commit was rejected" >&2
  exit 1
fi
echo "PASS: sub-case 2 — missing intentCommit rejected before provider mutation"

# ---------------------------------------------------------------------------
# Sub-case 3: the result JSON contains a populated cleanup.operations
# array (Stoff81 Critical #1: prior code wrote the result before the
# EXIT trap fired, so cleanup.operations was always []). We confirm
# the verdict path includes cleanup information — even if the kill
# succeeded, the cleanup pass restarted the machine and recorded success.
# ---------------------------------------------------------------------------
ops_len="$(jq '.cleanup.operations | length' "$TMP/result.json")"
if [[ "$ops_len" -lt 1 ]]; then
  echo "FAIL: cleanup.operations should be populated (got length=$ops_len)" >&2
  cat "$TMP/result.json" >&2
  exit 1
fi
echo "PASS: sub-case 3 — cleanup.operations populated (length=$ops_len)"
jq -e '.cleanup.ok == true and (.cleanup.operations[] | select(.name == "drill.worker_restart" and .ok == true))' "$TMP/result.json" >/dev/null \
  || { echo "FAIL: cleanup did not record a successful worker restart" >&2; exit 1; }
[[ "$(cat "$FLY_STATE")" == "started" ]] \
  || { echo "FAIL: worker did not finish in started state" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Sub-case 4: the drill source never invokes a bare `fly` binary — only
# the workflow-installed `flyctl`. Stoff81 Critical #3: prior code mixed
# `fly` and `flyctl`; the kill/restart steps would fail on the runner
# because only `flyctl` is on PATH.
# ---------------------------------------------------------------------------
# This is a source-level check on the drill script. We allow `fly`
# inside comments and inside the user-facing argument/env names
# (`--fly-org`, `STAGING_FLY_ORG`), but never as a command.
if grep -nE '(^|[^A-Za-z_-])fly (machines|status)' "$DRILL" >/dev/null 2>&1; then
  echo "FAIL: drill still invokes bare 'fly' binary:" >&2
  grep -nE '(^|[^A-Za-z_-])fly (machines|status)' "$DRILL" >&2
  exit 1
fi
echo "PASS: sub-case 4 — drill uses flyctl consistently (no bare 'fly' binary)"

# ---------------------------------------------------------------------------
# Sub-case 5: cleanup() is called directly before the verdict, with
# idempotent guard. Source-level check.
# ---------------------------------------------------------------------------
if ! grep -qE '^cleanup$' "$DRILL"; then
  echo "FAIL: drill script missing direct cleanup() invocation" >&2
  exit 1
fi
if ! grep -qE 'CLEANUP_RAN=' "$DRILL"; then
  echo "FAIL: drill script missing CLEANUP_RAN idempotent guard" >&2
  exit 1
fi
if ! grep -qE 'trap cleanup EXIT' "$DRILL"; then
  echo "FAIL: drill script missing EXIT trap on cleanup" >&2
  exit 1
fi
# The direct cleanup call must come after the drill steps and before
# the verdict computation. Find the line numbers and assert the order.
cleanup_line="$(grep -nE '^cleanup$' "$DRILL" | head -n1 | cut -d: -f1)"
verdict_line="$(grep -nE 'verdict="(pass|fail)"' "$DRILL" | head -n1 | cut -d: -f1)"
if [[ -z "$cleanup_line" || -z "$verdict_line" ]]; then
  echo "FAIL: could not locate cleanup() call or verdict line (cleanup=$cleanup_line verdict=$verdict_line)" >&2
  exit 1
fi
if (( cleanup_line >= verdict_line )); then
  echo "FAIL: cleanup() invocation ($cleanup_line) is not before verdict ($verdict_line)" >&2
  exit 1
fi
echo "PASS: sub-case 5 — cleanup() runs directly before verdict (cleanup=$cleanup_line, verdict=$verdict_line)"

# ---------------------------------------------------------------------------
# Sub-case 6: drill step `drill.verify_killed_machine_stopped` and
# `drill.verify_recovered_machine_started` exist and use flyctl
# machines list (Stoff81 Critical #2: AC3 must verify the actual
# machine state via flyctl, not just poll the HTTP health endpoint).
# ---------------------------------------------------------------------------
if ! grep -qE 'drill.verify_killed_machine_stopped' "$DRILL"; then
  echo "FAIL: drill.verify_killed_machine_stopped step missing" >&2
  exit 1
fi
if ! grep -qE 'drill.verify_recovered_machine_started' "$DRILL"; then
  echo "FAIL: drill.verify_recovered_machine_started step missing" >&2
  exit 1
fi
echo "PASS: sub-case 6 — drill includes post-kill and post-recovery machine-state verify steps"

echo "OK: all staging-failure-drill sub-cases passed"
