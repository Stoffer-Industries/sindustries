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
# every assertion here is a refusal.
#
# TWO RULES THIS FILE ENFORCES, both learned the hard way:
#
#   1. A REFUSAL IS NOT JUST A NON-ZERO EXIT. A shell script with a
#      syntax error exits non-zero too, so "the script refuses" and
#      "the script never ran" look identical from outside. Every
#      refusal assertion below pins the EXACT exit code and checks
#      that the output NAMES the reason, so a script that crashes for
#      an unrelated reason cannot pass as a refusal.
#
#   2. EVERY SCRIPT MUST PARSE, AND THAT IS CHECKED FIRST. The parse
#      gate runs before any refusal assertion and exits immediately on
#      a parse error. Without it, a single stray quote in preflight.sh
#      made four refusal assertions pass against a script that had
#      never executed a line.
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

# The harness writes its lock, state and evidence into the artifact
# directory. Point it at the temporary directory so a test run leaves
# nothing behind in the repository.
export SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/artifacts"

# Every route change runs against a fixture tree. The adapter's real
# switch rewrites caller files, so a harness test that uses the default
# repository root would mutate the checkout it is supposed to verify.
CALLER_ROOT="$WORK_DIR/caller-root"
export SINDUSTRIES_CUTOVER_CALLER_ROOT="$CALLER_ROOT"
node --input-type=module -e "
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  const [manifestPath, sourceRoot, targetRoot] = process.argv.slice(1);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const surface of manifest.surfaces) {
    for (const caller of surface.callers ?? []) {
      if (caller.owner !== 'managed') continue;
      const target = join(targetRoot, caller.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, caller.id + '=' + caller.prodlikeTarget + '\n', { flag: 'a' });
    }
  }
" "$EXAMPLE" "$REPO_ROOT" "$CALLER_ROOT"

failures=0
checks=0

# ---------------------------------------------------------------------------
# The parse gate — FIRST, and it exits immediately on a parse error
# ---------------------------------------------------------------------------
echo "== every script parses =="

parse_failures=0
for script in "$CUTOVER_DIR"/*.sh "$REPO_ROOT/infra/cloud/bin/traffic-route"; do
  if bash -n "$script" 2>/dev/null; then
    printf 'ok   %s parses\n' "$(basename "$script")"
  else
    printf 'FAIL %s does not parse\n' "$(basename "$script")"
    bash -n "$script" 2>&1 | sed 's/^/       /'
    parse_failures=$((parse_failures + 1))
  fi
done

if [[ "$parse_failures" -gt 0 ]]; then
  echo
  echo "$parse_failures script(s) do not parse — the refusal assertions below would pass against a script that never ran, so they are not run"
  exit 1
fi

echo
echo "== the harness refuses the wrong thing =="

# expect_fail <name> <expected-exit-code> <expected-reason> <command...>
#
# The exit code must match EXACTLY, and the output must NAME the
# reason. A script that died for an unrelated reason has a different
# code, or a different message, or both.
expect_fail() {
  local name="$1" expected_code="$2" expected_reason="$3"
  shift 3
  checks=$((checks + 1))
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [[ "$status" != "$expected_code" ]]; then
    printf 'FAIL %s — expected exit %s, got %s\n' "$name" "$expected_code" "$status"
    printf '%s\n' "$output" | tail -n 3 | sed 's/^/       /'
    failures=$((failures + 1))
    return
  fi
  if [[ -n "$expected_reason" ]] && ! printf '%s' "$output" | grep -qF "$expected_reason"; then
    printf 'FAIL %s — the refusal did not name "%s"\n' "$name" "$expected_reason"
    printf '%s\n' "$output" | tail -n 3 | sed 's/^/       /'
    failures=$((failures + 1))
    return
  fi
  printf 'ok   %s\n' "$name"
}

# expect_pass <name> <command...>
expect_pass() {
  local name="$1"
  shift
  checks=$((checks + 1))
  local output
  set +e
  output="$("$@" 2>&1)"
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s — exit %s\n' "$name" "$status"
    printf '%s\n' "$output" | tail -n 3 | sed 's/^/       /'
    failures=$((failures + 1))
  fi
}

# ---------------------------------------------------------------------------
# The rehearsal refuses a production manifest
# ---------------------------------------------------------------------------
expect_fail "the rehearsal refuses a production manifest" 2 "the rehearsal refuses environment" \
  bash "$CUTOVER_DIR/rehearse.sh" --manifest "$EXAMPLE"

# ---------------------------------------------------------------------------
# The preflight refuses a manifest that fails validation
# ---------------------------------------------------------------------------
#
# The manifest is the CONTRACT, not one of the gates: an invalid
# manifest is refused in plan mode too, so --plan can never print a
# plan for a window that cannot exist.
BAD_MANIFEST="$WORK_DIR/bad-manifest.json"
node -e "
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  delete manifest.run.observationMinutes;
  fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
" "$EXAMPLE" "$BAD_MANIFEST"

expect_fail "the preflight refuses a manifest with an unset observation duration" 2 "the manifest is invalid" \
  bash "$CUTOVER_DIR/preflight.sh" --manifest "$BAD_MANIFEST" --plan

# ---------------------------------------------------------------------------
# The executor refuses to run without the typed production acknowledgement
# ---------------------------------------------------------------------------
# The acknowledgement must arrive in the ENVIRONMENT. A mistyped
# command alone can never start a production run. It is checked BEFORE
# the lock and BEFORE the preflight, so the refusal does not depend on
# anything the preflight might find.
unset SINDUSTRIES_CUTOVER_PRODUCTION_ACK || true
expect_fail "the executor refuses without the production acknowledgement" 2 "SINDUSTRIES_CUTOVER_PRODUCTION_ACK" \
  env -u SINDUSTRIES_CUTOVER_PRODUCTION_ACK \
  bash "$CUTOVER_DIR/execute.sh" --manifest "$EXAMPLE" --phase baseline

# ---------------------------------------------------------------------------
# The executor refuses an invalid manifest
# ---------------------------------------------------------------------------
# The executor reads the manifest's environment before it does anything
# else, so an invalid manifest has to be a NAMED refusal there — not an
# unhandled exception that happens to exit non-zero.
expect_fail "the executor refuses an invalid manifest" 2 "manifest validation failed" \
  bash "$CUTOVER_DIR/execute.sh" --manifest "$BAD_MANIFEST"

# ---------------------------------------------------------------------------
# The executor refuses to start without a preflight
# ---------------------------------------------------------------------------
# A valid manifest, the acknowledgement present, and a preflight that
# cannot pass: the executor must name the preflight as the reason the
# window does not start.
export SINDUSTRIES_CUTOVER_PRODUCTION_ACK="CUTOVER PRODUCTION"
expect_fail "the executor refuses to start without a preflight" 1 "preflight did not pass" \
  bash "$CUTOVER_DIR/execute.sh" --manifest "$EXAMPLE"

# ---------------------------------------------------------------------------
# The route adapter refuses a stale version through the CLI
# ---------------------------------------------------------------------------
STATE_FILE="$WORK_DIR/route.json"
expect_fail "the route adapter refuses a stale expected version" 1 "route version moved underneath" \
  node "$ADAPTER" set \
    --manifest "$EXAMPLE" \
    --binding production \
    --expected-version 99 \
    --run-id run-test \
    --confirm run-test \
    --state-file "$STATE_FILE"

expect_fail "the route adapter refuses a confirmation that does not match the run id" 1 "confirm" \
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

expect_fail "the route adapter refuses a second apply with the same stale version" 1 "route version moved underneath" \
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
  checks=$((checks + 1))
  printf 'ok   the read-back is clean once every in-scope surface is on production\n'
else
  checks=$((checks + 1))
  printf 'FAIL the read-back is clean once every in-scope surface is on production\n'
  failures=$((failures + 1))
fi

if printf '%s' "$readback" | grep -q 'documented rollback surface'; then
  checks=$((checks + 1))
  printf 'ok   the read-back names the documented rollback surface\n'
else
  checks=$((checks + 1))
  printf 'FAIL the read-back names the documented rollback surface\n'
  failures=$((failures + 1))
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

expect_fail "the rollback refuses a prodlike runtime that is not on the canonical data plane" 1 "not on the canonical data plane" \
  bash "$CUTOVER_DIR/rollback.sh" --manifest "$STALE_MANIFEST" --reason "harness test"

# ---------------------------------------------------------------------------
# The redactor masks a DSN before it reaches an artifact
# ---------------------------------------------------------------------------
REDACTOR="$REPO_ROOT/infra/cloud/platform/redact-output.mjs"
redacted="$(printf '%s' 'DATABASE_URL=postgres://user:***@localhost:7432/sindustries_prodlike' | node "$REDACTOR")"
if printf '%s' "$redacted" | grep -q 'hunter2'; then
  checks=$((checks + 1))
  printf 'FAIL the redactor masks a credential before it reaches an artifact\n'
  failures=$((failures + 1))
else
  checks=$((checks + 1))
  printf 'ok   the redactor masks a credential before it reaches an artifact\n'
fi

# ---------------------------------------------------------------------------
# The preflight plan reports every outstanding gate
# ---------------------------------------------------------------------------
#
# Plan mode exits 0 even with outstanding gates — it is a report. But it
# still refuses an INVALID manifest, and the report must be a real
# result document.
plan_output=""
plan_status=0
set +e
plan_output="$(bash "$CUTOVER_DIR/preflight.sh" --manifest "$EXAMPLE" --plan 2>&1)"
plan_status=$?
set -e

checks=$((checks + 1))
if [[ "$plan_status" -ne 0 ]]; then
  printf 'FAIL the preflight plan exits 0 — got %s\n' "$plan_status"
  failures=$((failures + 1))
else
  printf 'ok   the preflight plan exits 0\n'
fi

if printf '%s' "$plan_output" | grep -q '"kind": "preflight-result"'; then
  checks=$((checks + 1))
  printf 'ok   the preflight plan produces a result document\n'
else
  checks=$((checks + 1))
  printf 'FAIL the preflight plan produces a result document\n'
  failures=$((failures + 1))
fi

if printf '%s' "$plan_output" | grep -q '"failureCount"'; then
  checks=$((checks + 1))
  printf 'ok   the preflight plan counts the outstanding gates\n'
else
  checks=$((checks + 1))
  printf 'FAIL the preflight plan counts the outstanding gates\n'
  failures=$((failures + 1))
fi

if printf '%s' "$plan_output" | grep -q 'gate pass: route-inventory'; then
  checks=$((checks + 1))
  printf 'ok   the route inventory allows the documented rollback surface\n'
else
  checks=$((checks + 1))
  printf 'FAIL the route inventory allows the documented rollback surface\n'
  failures=$((failures + 1))
fi

# ---------------------------------------------------------------------------
# Durable state and resume gates fail closed
# ---------------------------------------------------------------------------
expect_fail "an unreadable state file is not treated as a fresh window" 2 "cannot be read as a state document" \
  env SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/unreadable-state" \
  bash -c '
    source "$1"
    mkdir -p "$CUTOVER_ARTIFACT_DIR"
    printf "%s\n" "{not-json" > "$CUTOVER_STATE_FILE"
    cutover_read_state
  ' _ "$CUTOVER_DIR/common.sh"

expect_pass "the state writer records the numeric route version" \
  env SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/numeric-state" CUTOVER_RUN_ID="state-test" \
  bash -c '
    source "$1"
    cutover_write_state baseline manifest-hash 7
    node -e "
      const state = JSON.parse(require(\"node:fs\").readFileSync(process.argv[1], \"utf8\"));
      if (state.routeVersion !== 7) process.exit(1);
    " "$CUTOVER_STATE_FILE"
  ' _ "$CUTOVER_DIR/common.sh"

expect_fail "the state writer refuses a non-numeric route version" 1 "routeVersion must be a non-negative integer" \
  env SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/invalid-route-version" CUTOVER_RUN_ID="state-test" \
  bash -c 'source "$1"; cutover_write_state baseline manifest-hash not-a-version' _ "$CUTOVER_DIR/common.sh"

expect_fail "resume refuses a different manifest hash" 1 "different manifest" \
  bash -c 'source "$1"; cutover_assert_resumable old-hash 7 new-hash 7' _ "$CUTOVER_DIR/common.sh"

expect_fail "resume refuses a different live route version" 1 "route moved underneath the window" \
  bash -c 'source "$1"; cutover_assert_resumable same-hash 7 same-hash 8' _ "$CUTOVER_DIR/common.sh"

# ---------------------------------------------------------------------------
# Phase timing requires both the hold and minimum samples
# ---------------------------------------------------------------------------
CLOCK_FILE="$WORK_DIR/clock"
printf '%s\n' 100 > "$CLOCK_FILE"
expect_pass "a phase cannot finish before its declared hold" \
  env CUTOVER_CLOCK_FILE="$CLOCK_FILE" \
  bash -c '
    source "$1"
    cutover_phase_should_continue 110 2 2
    printf "%s\n" 110 > "$CUTOVER_CLOCK_FILE"
    if cutover_phase_should_continue 110 2 2; then
      exit 1
    fi
  ' _ "$CUTOVER_DIR/common.sh"

# ---------------------------------------------------------------------------
# Rehearsal gates: every observed outcome controls the result
# ---------------------------------------------------------------------------
expect_pass "a local-recovery result carries the shell state into its JSON evidence" \
  bash -c '
    source "$1"
    result="$(cutover_local_recovery_result run-recovery backup-ref PASS 1)"
    node -e "
      const result = JSON.parse(process.argv[1]);
      if (result.runId !== \"run-recovery\") process.exit(1);
      if (result.reference !== \"backup-ref\") process.exit(1);
      if (result.fallbackHealthVerdict !== \"PASS\") process.exit(1);
      if (!result.isolatedRestorePerformed) process.exit(1);
    " "$result"
  ' _ "$CUTOVER_DIR/common.sh"

expect_pass "a rollback result carries the shell state into its JSON evidence" \
  bash -c '
    source "$1"
    result="$(cutover_rollback_result run-rollback "operator reason" runtime "{\"binding\":\"production\"}" "{\"binding\":\"prodlike\"}")"
    node -e "
      const result = JSON.parse(process.argv[1]);
      if (result.runId !== \"run-rollback\") process.exit(1);
      if (result.reason !== \"operator reason\") process.exit(1);
      if (result.before.binding !== \"production\") process.exit(1);
      if (result.after.binding !== \"prodlike\") process.exit(1);
    " "$result"
  ' _ "$CUTOVER_DIR/common.sh"

expect_pass "a rehearsal result passes only when every hard gate passed" \
  bash -c '
    source "$1"
    result="$(cutover_rehearsal_result run-success PASS 1 0 1 0 1 1)"
    node -e "
      const result = JSON.parse(process.argv[1]);
      if (result.verdict !== \"PASS\") process.exit(1);
      if (!result.failureInjected || !result.failureRecovered) process.exit(1);
      if (!result.rollbackExecuted || !result.rollbackIdempotent) process.exit(1);
    " "$result"
  ' _ "$CUTOVER_DIR/common.sh"

STAGING_MANIFEST="$WORK_DIR/staging-manifest.json"
node -e "
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  manifest.environment = 'staging';
  manifest.taskId = '11111111-1111-4111-8111-111111111111';
  for (const surface of manifest.surfaces) {
    const url = new URL(surface.productionBaseUrl);
    surface.productionBaseUrl = 'http://127.0.0.1:9' + (url.pathname === '/' ? '' : url.pathname);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2));
" "$EXAMPLE" "$STAGING_MANIFEST"

expect_fail "the rehearsal refuses when failure injection is unavailable" 2 "failure injection tool is not available" \
  env CUTOVER_ENVIRONMENT=staging CUTOVER_FAILURE_INJECT_TOOL="$WORK_DIR/missing-injector" \
  bash "$CUTOVER_DIR/rehearse.sh" --manifest "$STAGING_MANIFEST" --run-id rehearsal-no-injector

node "$ADAPTER" set \
  --manifest "$EXAMPLE" \
  --binding prodlike \
  --expected-version 1 \
  --run-id reset-fixture \
  --confirm reset-fixture \
  --state-file "$STATE_FILE" >/dev/null

REHEARSAL_CALLER_ROOT="$WORK_DIR/rehearsal-caller-root"
cp -R "$CALLER_ROOT" "$REHEARSAL_CALLER_ROOT"
FAKE_INJECTOR="$WORK_DIR/fake-injector.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$FAKE_INJECTOR"
chmod +x "$FAKE_INJECTOR"

expect_fail "the rehearsal refuses when the probes do not pass" 1 "probes did not pass" \
  env CUTOVER_ENVIRONMENT=staging \
      CUTOVER_FAILURE_INJECT_TOOL="$FAKE_INJECTOR" \
      SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/rehearsal-artifacts" \
      SINDUSTRIES_CUTOVER_CALLER_ROOT="$REHEARSAL_CALLER_ROOT" \
  bash "$CUTOVER_DIR/rehearse.sh" --manifest "$STAGING_MANIFEST" --run-id rehearsal-probe-fail

CLEANUP_CALLER_ROOT="$WORK_DIR/cleanup-caller-root"
cp -R "$CALLER_ROOT" "$CLEANUP_CALLER_ROOT"
FAKE_PROBES="$WORK_DIR/fake-probes.mjs"
printf '%s\n' 'process.stdout.write(JSON.stringify({verdict: "PASS"}));' > "$FAKE_PROBES"
FAKE_SCRIPTS="$WORK_DIR/fake-cutover-scripts"
mkdir -p "$FAKE_SCRIPTS"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$FAKE_SCRIPTS/rollback.sh"
chmod +x "$FAKE_SCRIPTS/rollback.sh"
INJECTION_LOG="$WORK_DIR/injection-scenarios.log"
LOGGING_INJECTOR="$WORK_DIR/logging-injector.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" "$1" >> "$FAKE_INJECTION_LOG"' \
  'exit 0' > "$LOGGING_INJECTOR"
chmod +x "$LOGGING_INJECTOR"

expect_fail "a failed rehearsal rollback still recovers the injected failure" 1 "rehearsal rollback failed" \
  env CUTOVER_ENVIRONMENT=staging \
      CUTOVER_FAILURE_INJECT_TOOL="$LOGGING_INJECTOR" \
      CUTOVER_PROBES_OVERRIDE="$FAKE_PROBES" \
      CUTOVER_SCRIPTS_DIR_OVERRIDE="$FAKE_SCRIPTS" \
      FAKE_INJECTION_LOG="$INJECTION_LOG" \
      SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$WORK_DIR/cleanup-artifacts" \
      SINDUSTRIES_CUTOVER_CALLER_ROOT="$CLEANUP_CALLER_ROOT" \
  bash "$CUTOVER_DIR/rehearse.sh" --manifest "$STAGING_MANIFEST" --run-id rehearsal-cleanup

checks=$((checks + 1))
if grep -qFx 'redis-down' "$INJECTION_LOG" && grep -qFx 'redis-up' "$INJECTION_LOG"; then
  printf 'ok   the rehearsal exit cleanup invoked the recovery scenario\n'
else
  printf 'FAIL the rehearsal exit cleanup invoked the recovery scenario\n'
  failures=$((failures + 1))
fi

echo
echo "$checks checks, $failures failure(s)"
[[ "$failures" -eq 0 ]]
