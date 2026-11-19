#!/usr/bin/env bash
# scripts/cloud/cutover/tests/cutover-harness.test.sh
#
# Script-level tests for the production cutover harness (task 020f423e).
#
# The unit tests in infra/cloud/cutover/tests/cutover-core.test.mjs
# cover the manifest validator and the route adapter. THIS file covers
# the harness around them: that each script refuses the wrong thing.
#
# A cutover harness is worth nothing if its scripts are permissive, so
# every assertion here is a refusal:
#   - the rehearsal refuses a production manifest
#   - the rollback refuses a stale data plane
#   - the executor refuses to run without the typed production
#     acknowledgement
#   - the preflight reports every outstanding gate rather than passing
#   - the route adapter refuses a stale version through the CLI
#   - the redactor masks a DSN before it reaches an artifact
#
# The suite needs no network and no credentials: the probe and Tasks API
# timeouts are shortened so the gates fail fast and are reported as
# failures rather than hanging.
#
# Run:
#   bash scripts/cloud/cutover/tests/cutover-harness.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
fi

CUTOVER_DIR="$REPO_ROOT/scripts/cloud/cutover"
ADAPTER="$REPO_ROOT/infra/cloud/cutover/traffic-route.mjs"
EXAMPLE="$REPO_ROOT/infra/cloud/cutover/production-manifest.example.json"

# A short probe timeout and a short Tasks API timeout: the gates under
# test must FAIL fast, not hang.
export CUTOVER_PROBE_TIMEOUT_MS="${CUTOVER_PROBE_TIMEOUT_MS:-1500}"
export CUTOVER_TASKS_API_TIMEOUT="${CUTOVER_TASKS_API_TIMEOUT:-2}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

failures=0
checks=0

check() {
  # check <name> <condition-result> <detail>
  local name="$1" ok="$2" detail="${3:-}"
  checks=$((checks + 1))
  if [[ "$ok" == "0" ]]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s%s\n' "$name" "${detail:+ — $detail}"
    failures=$((failures + 1))
  fi
}

# expect_fail <name> <command...> — the command must exit non-zero.
expect_fail() {
  local name="$1"
  shift
  checks=$((checks + 1))
  local output
  if output="$("$@" 2>&1)"; then
    printf 'FAIL %s — the command was expected to fail but succeeded\n' "$name"
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

# expect_pass <name> <command...>
expect_pass() {
  local name="$1"
  shift
  checks=$((checks + 1))
  local output
  if output="$("$@" 2>&1)"; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s — %s\n' "$name" "$(printf '%s' "$output" | tail -n 3)"
    failures=$((failures + 1))
  fi
}

echo "== the harness refuses the wrong thing =="

# ---------------------------------------------------------------------------
# The rehearsal refuses a production manifest
# ---------------------------------------------------------------------------
expect_fail "the rehearsal refuses a production manifest" \
  bash "$CUTOVER_DIR/rehearse.sh" --manifest "$EXAMPLE"

# ---------------------------------------------------------------------------
# The preflight refuses a manifest that fails validation
# ---------------------------------------------------------------------------
BAD_MANIFEST="$WORK_DIR/bad-manifest.json"
node -e "
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  delete manifest.run.observationMinutes;
  fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
" "$EXAMPLE" "$BAD_MANIFEST"

expect_fail "the preflight refuses a manifest with an unset observation duration" \
  bash "$CUTOVER_DIR/preflight.sh" --manifest "$BAD_MANIFEST" --plan

expect_fail "the executor refuses to start without a preflight" \
  bash "$CUTOVER_DIR/execute.sh" --manifest "$BAD_MANIFEST"

# ---------------------------------------------------------------------------
# The executor refuses to run without the typed production acknowledgement
# ---------------------------------------------------------------------------
# The acknowledgement must arrive in the ENVIRONMENT. A mistyped
# command alone can never start a production run.
unset SINDUSTRIES_CUTOVER_PRODUCTION_ACK || true
expect_fail "the executor refuses without the production acknowledgement" \
  env -u SINDUSTRIES_CUTOVER_PRODUCTION_ACK \
  bash "$CUTOVER_DIR/execute.sh" --manifest "$EXAMPLE" --phase baseline

# ---------------------------------------------------------------------------
# The route adapter refuses a stale version through the CLI
# ---------------------------------------------------------------------------
STATE_FILE="$WORK_DIR/route.json"
expect_fail "the route adapter refuses a stale expected version" \
  node "$ADAPTER" set \
    --manifest "$EXAMPLE" \
    --binding production \
    --expected-version 99 \
    --run-id run-test \
    --confirm run-test \
    --state-file "$STATE_FILE"

expect_fail "the route adapter refuses a confirmation that does not match the run id" \
  node "$ADAPTER" set \
    --manifest "$EXAMPLE" \
    --binding production \
    --expected-version 0 \
    --run-id run-test \
    --confirm run-other \
    --state-file "$STATE_FILE"

expect_pass "the route adapter applies a binding with a matching confirmation" \
  node "$ADAPTER" set \
    --manifest "$EXAMPLE" \
    --binding production \
    --expected-version 0 \
    --run-id run-test \
    --confirm run-test \
    --state-file "$STATE_FILE"

expect_fail "the route adapter refuses a second apply with the same stale version" \
  node "$ADAPTER" set \
    --manifest "$EXAMPLE" \
    --binding prodlike \
    --expected-version 0 \
    --run-id run-test \
    --confirm run-test \
    --state-file "$STATE_FILE"

# ---------------------------------------------------------------------------
# The read-back names the surfaces that still target prodlike
# ---------------------------------------------------------------------------
readback="$(node "$ADAPTER" readback --manifest "$EXAMPLE" --state-file "$STATE_FILE")"
if printf '%s' "$readback" | grep -q '"clean": true'; then
  check "the read-back is clean once every in-scope surface is on production" 0
else
  check "the read-back is clean once every in-scope surface is on production" 1 \
    "$(printf '%s' "$readback" | tr -d '\n ' | head -c 200)"
fi

if printf '%s' "$readback" | grep -q 'documented rollback surface'; then
  check "the read-back names the documented rollback surface" 0
else
  check "the read-back names the documented rollback surface" 1
fi

# ---------------------------------------------------------------------------
# The rollback refuses a stale data plane
# ---------------------------------------------------------------------------
#
# A runtime rollback that points the local services at a stale database
# is not a rollback, it is a divergence. The refusal is the point.
STALE_MANIFEST="$WORK_DIR/stale-plane-manifest.json"
node -e "
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  manifest.origins.prodlike.dataPlane = 'local-postgres';
  fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
" "$EXAMPLE" "$STALE_MANIFEST"

export SINDUSTRIES_CUTOVER_PRODUCTION_ACK="CUTOVER PRODUCTION"
expect_fail "the rollback refuses a prodlike runtime that is not on the canonical data plane" \
  bash "$CUTOVER_DIR/rollback.sh" --manifest "$STALE_MANIFEST" --reason "harness test"

# ---------------------------------------------------------------------------
# The redactor masks a DSN before it reaches an artifact
# ---------------------------------------------------------------------------
REDACTOR="$REPO_ROOT/infra/cloud/platform/redact-output.mjs"
redacted="$(printf '%s' 'DATABASE_URL=postgres://user:hunter2@localhost:7432/sindustries_prodlike' | node "$REDACTOR")"
if printf '%s' "$redacted" | grep -q 'hunter2'; then
  check "the redactor masks a credential before it reaches an artifact" 1 \
    "the redactor left the password in the clear"
else
  check "the redactor masks a credential before it reaches an artifact" 0
fi

# ---------------------------------------------------------------------------
# The preflight plan reports every outstanding gate
# ---------------------------------------------------------------------------
plan_output="$(bash "$CUTOVER_DIR/preflight.sh" --manifest "$EXAMPLE" --plan 2>&1)"
if printf '%s' "$plan_output" | grep -q '"kind": "preflight-result"'; then
  check "the preflight plan produces a result document" 0
else
  check "the preflight plan produces a result document" 1
fi

if printf '%s' "$plan_output" | grep -q '"failureCount"'; then
  check "the preflight plan counts the outstanding gates" 0
else
  check "the preflight plan counts the outstanding gates" 1
fi

echo
echo "$checks checks, $failures failure(s)"
[[ "$failures" -eq 0 ]]
