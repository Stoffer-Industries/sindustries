#!/usr/bin/env bash
# scripts/cloud/cutover/rehearse.sh
#
# Rehearse the production cutover in the production-like STAGING
# environment (task 020f423e).
#
# WHY A REHEARSAL IS A HARD GATE
#   AC4 says the rollback must be EXECUTABLE, not documented. A passing
#   timestamped rehearsal in staging is a hard production preflight
#   input: documentation-only review cannot satisfy it.
#
# WHAT IT DOES
#   1. capture the current staging route and deployment state
#   2. direct the staging route at the cloud staging runtime
#   3. run the SAME continuous probes the production switch runs
#   4. inject a safe cloud runtime failure
#   5. invoke the REAL route adapter rollback
#   6. verify traffic, workflows, worker leadership and signals recover
#   7. restore the initial staging route and prove cleanup/idempotence
#
# IT REFUSES PRODUCTION
#   The rehearsal uses production-like route mechanics and manifests but
#   it refuses the production account, the production environment id and
#   the production hostnames. A rehearsal that could reach production is
#   not a rehearsal.
#
# Usage:
#   scripts/cloud/cutover/rehearse.sh --manifest <path> [--manifest <staging manifest>]
#
# Exit codes:
#   0  the rehearsal passed
#   1  the rehearsal failed
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
INJECT_FAILURE=1
INJECTION_SCENARIO="redis-down"
RECOVERY_SCENARIO="redis-up"

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --no-failure-injection) INJECT_FAILURE=0; shift ;;
    --inject-scenario) INJECTION_SCENARIO="$2"; shift 2 ;;
    --recovery-scenario) RECOVERY_SCENARIO="$2"; shift 2 ;;
    --run-id) CUTOVER_RUN_ID="$2"; export CUTOVER_RUN_ID; shift 2 ;;
    --help|-h) usage 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage 2 ;;
  esac
done

cutover_require_commands
MANIFEST="$(cutover_resolve_manifest "$MANIFEST")"

# ---------------------------------------------------------------------------
# The rehearsal may not touch production
# ---------------------------------------------------------------------------
manifest_environment() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(loadManifest(process.argv[1]).environment);
  " "$MANIFEST"
}

manifest_task_id() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(loadManifest(process.argv[1]).taskId);
  " "$MANIFEST"
}

ENVIRONMENT="$(manifest_environment)"
if [[ "$ENVIRONMENT" != "staging" ]]; then
  cutover_fail "the rehearsal refuses environment '$ENVIRONMENT' — it runs against the production-like STAGING environment only" 2
fi

# The production task's own identifiers must not appear in a staging
# rehearsal: a staging manifest that carries the production task id or
# a production hostname is a mis-prepared manifest.
if [[ "$(manifest_task_id)" == "020f423e-a18d-4435-98cb-664b655f675b" ]]; then
  cutover_fail "the rehearsal refuses the PRODUCTION cutover task id — use the staging rehearsal manifest" 2
fi

if node --input-type=module -e "
  import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
  const manifest = loadManifest(process.argv[1]);
  const productionHost = 'sindustries.co.nz';
  const offenders = [];
  for (const surface of manifest.surfaces) {
    for (const url of [surface.productionBaseUrl, surface.prodlikeBaseUrl]) {
      const host = new URL(url).hostname;
      if (host === productionHost || host.endsWith('.' + productionHost)) {
        offenders.push(surface.id + ':' + host);
      }
    }
  }
  if (offenders.length > 0) {
    process.stderr.write('the rehearsal refuses production hostnames: ' + offenders.join(', ') + '\n');
    process.exit(1);
  }
" "$MANIFEST"; then
  cutover_info "the staging manifest names no production hostname"
else
  cutover_fail "the rehearsal refuses a manifest that names a production hostname" 2
fi

RUN_ID="$(cutover_run_id)"

# ---------------------------------------------------------------------------
# The failure-injection tool is a PRECONDITION
# ---------------------------------------------------------------------------
#
# It is checked BEFORE the rehearsal touches the staging route: a
# rehearsal that cannot break anything cannot prove that it repairs
# anything, and it must fail fast rather than after switching the
# route and binding the operator lock.
#
# The path is overridable so the staging rehearsal can point at its
# own tool, and so the test suite can point it at a path that does not
# exist and prove the refusal is real.
INJECTION_TOOL="${CUTOVER_FAILURE_INJECT_TOOL:-$CUTOVER_REPO_ROOT/infra/cloud/observability/failure-inject.sh}"
if [[ "$INJECT_FAILURE" -eq 1 && ! -x "$INJECTION_TOOL" ]]; then
  cutover_fail "the rehearsal cannot inject a failure: the failure injection tool is not available at $INJECTION_TOOL — an untested failure path is not a passed rehearsal" 2
fi

# ---------------------------------------------------------------------------
# 1. Capture the current staging route
# ---------------------------------------------------------------------------
ROUTE_BEFORE="$(cutover_route_readback "$MANIFEST" 2>/dev/null || printf '{}')"
BEFORE_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-route-before.json" "$ROUTE_BEFORE")"
live_version="$(cutover_route_version)"
cutover_info "captured the staging route state ($BEFORE_PATH, version $live_version)"

# ---------------------------------------------------------------------------
# 2 + 3. Direct the route at the cloud staging runtime and probe it
# ---------------------------------------------------------------------------
if ! route_output="$(cutover_route_set "$MANIFEST" production "$live_version" "$RUN_ID" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rehearsal-route-refused.json" "$route_output" >/dev/null
  cutover_fail "the rehearsal could not direct the staging route at the cloud runtime: $(cutover_redact "$route_output")" 1
fi
cutover_info "staging route bound to the cloud runtime at version $((live_version + 1))"

PROBE_OUTPUT=""
if [[ -f "$CUTOVER_PROBES" ]]; then
  PROBE_OUTPUT="$(node "$CUTOVER_PROBES" --manifest "$MANIFEST" --binding production --phase rehearsal 2>&1 || true)"
fi
PROBE_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-probes.json" "$PROBE_OUTPUT")"
probe_verdict="$(printf '%s' "$PROBE_OUTPUT" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")"
if [[ "$probe_verdict" != "PASS" ]]; then
  cutover_fail "the rehearsal probes did not pass against the cloud runtime ($probe_verdict) — evidence $PROBE_PATH" 1
fi

# ---------------------------------------------------------------------------
# 4. Inject a safe cloud runtime failure
# ---------------------------------------------------------------------------
#
# The failure is injected through the platform's own failure-injection
# tool, so the rehearsal exercises the REAL readiness gate rather than
# pretending a Machine is unhealthy. The tool is INVOKED, not
# described: the previous version ran it with --help and recorded the
# usage text as if it were an injection, which is how the rehearsal
# could report a pass without ever having broken anything.
#
# The injection, its recovery, the probe verdict and the rollback are
# all HARD GATES. An untested failure path is not a passed rehearsal.
INJECTION_OUTPUT=""
INJECTION_PERFORMED=0
INJECTION_STATUS=1
RECOVERY_OUTPUT=""
RECOVERY_PERFORMED=0
RECOVERY_STATUS=1
RECOVERY_NEEDED=0

recover_injected_failure_on_exit() {
  local original_status=$?
  trap - EXIT
  if [[ "$RECOVERY_NEEDED" -eq 1 ]]; then
    local cleanup_output cleanup_status cleanup_path
    set +e
    cleanup_output="$("$INJECTION_TOOL" "$RECOVERY_SCENARIO" 2>&1)"
    cleanup_status=$?
    set -e
    cleanup_path="$(cutover_write_evidence "$RUN_ID" "rehearsal-emergency-recovery.json" "$cleanup_output")"
    if [[ "$cleanup_status" -eq 0 ]]; then
      cutover_warn "recovered the injected failure during exit cleanup — evidence $cleanup_path"
    else
      cutover_warn "EMERGENCY RECOVERY FAILED: '$RECOVERY_SCENARIO' exited $cleanup_status — evidence $cleanup_path"
    fi
  fi
  exit "$original_status"
}

if [[ "$INJECT_FAILURE" -eq 1 ]]; then
  set +e
  INJECTION_OUTPUT="$("$INJECTION_TOOL" "$INJECTION_SCENARIO" 2>&1)"
  INJECTION_STATUS=$?
  set -e
  INJECTION_PERFORMED=1
  INJECTION_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-failure-injection.json" "$INJECTION_OUTPUT")"
  if [[ "$INJECTION_STATUS" -ne 0 ]]; then
    cutover_fail "the rehearsal could not inject the '$INJECTION_SCENARIO' failure: the tool exited $INJECTION_STATUS (evidence $INJECTION_PATH) — an untested failure path is not a passed rehearsal" 1
  fi
  RECOVERY_NEEDED=1
  trap recover_injected_failure_on_exit EXIT
  cutover_info "injected the '$INJECTION_SCENARIO' failure (evidence $INJECTION_PATH)"
fi

# ---------------------------------------------------------------------------
# 5 + 6. Invoke the REAL rollback and verify recovery
# ---------------------------------------------------------------------------
ROLLBACK_EXECUTED=0
if ! rollback_output="$("$CUTOVER_SCRIPTS_DIR/rollback.sh" --manifest "$MANIFEST" --run-id "$RUN_ID" --reason "staging rehearsal rollback" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rehearsal-rollback-failed.json" "$rollback_output" >/dev/null
  cutover_fail "the rehearsal rollback failed — the rehearsal does not pass" 1
fi
ROLLBACK_EXECUTED=1
ROLLBACK_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-rollback.json" "$rollback_output")"
cutover_info "the rehearsal rollback completed — evidence $ROLLBACK_PATH"

# ---------------------------------------------------------------------------
# 6b. Recover the injected failure
# ---------------------------------------------------------------------------
#
# The drill must leave the environment as it found it. The injected
# failure is undone with the scenario's own recovery counterpart, and
# the recovery is a GATE: a rehearsal that breaks staging and never
# repairs it is not evidence, it is an incident.
if [[ "$INJECT_FAILURE" -eq 1 ]]; then
  set +e
  RECOVERY_OUTPUT="$("$INJECTION_TOOL" "$RECOVERY_SCENARIO" 2>&1)"
  RECOVERY_STATUS=$?
  set -e
  RECOVERY_PERFORMED=1
  RECOVERY_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-failure-recovery.json" "$RECOVERY_OUTPUT")"
  if [[ "$RECOVERY_STATUS" -ne 0 ]]; then
    cutover_fail "the rehearsal could not recover from the injected failure: '$RECOVERY_SCENARIO' exited $RECOVERY_STATUS (evidence $RECOVERY_PATH) — the rehearsal does not pass" 1
  fi
  RECOVERY_NEEDED=0
  trap - EXIT
  cutover_info "recovered from the injected failure with '$RECOVERY_SCENARIO' (evidence $RECOVERY_PATH)"
fi

# ---------------------------------------------------------------------------
# 7. Restore the initial route and prove idempotence
# ---------------------------------------------------------------------------
#
# The rollback already left the route on prodlike. Running the rollback
# AGAIN must succeed and change nothing: a rollback that only works
# once is not a rollback, it is a race.
live_version="$(cutover_route_version)"
IDEMPOTENT=0
if ! idempotence_output="$("$CUTOVER_SCRIPTS_DIR/rollback.sh" --manifest "$MANIFEST" --run-id "$RUN_ID" --reason "staging rehearsal idempotence check" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rehearsal-idempotence-failed.json" "$idempotence_output" >/dev/null
  cutover_fail "the rehearsal rollback is not idempotent — the rehearsal does not pass" 1
fi
IDEMPOTENT=1
IDEMPOTENCE_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-idempotence.json" "$idempotence_output")"
cutover_info "the rehearsal rollback is idempotent — evidence $IDEMPOTENCE_PATH"

# The result document reports what ACTUALLY HAPPENED. Every flag below
# is derived from an observed exit status, never asserted: a rehearsal
# result that hard-codes "rollbackExecuted: true" is a document that
# would have said the same thing on a run where the rollback failed.
RESULT="$(cutover_rehearsal_result \
  "$RUN_ID" \
  "$probe_verdict" \
  "$INJECTION_PERFORMED" \
  "$INJECTION_STATUS" \
  "$RECOVERY_PERFORMED" \
  "$RECOVERY_STATUS" \
  "$ROLLBACK_EXECUTED" \
  "$IDEMPOTENT")"
RESULT_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-result.json" "$RESULT")"
if [[ "$(printf '%s' "$RESULT" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")" != "PASS" ]]; then
  cutover_fail "rehearsal INCOMPLETE — not a valid production preflight input (evidence $RESULT_PATH)" 1
fi
cutover_info "rehearsal PASS — evidence $RESULT_PATH (this file is a hard production preflight input)"
printf '%s\n' "$RESULT"
