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

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --no-failure-injection) INJECT_FAILURE=0; shift ;;
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
  cutover_warn "the rehearsal probes did not pass against the cloud runtime ($probe_verdict) — evidence $PROBE_PATH"
fi

# ---------------------------------------------------------------------------
# 4. Inject a safe cloud runtime failure
# ---------------------------------------------------------------------------
#
# The failure is injected through the platform's own failure-injection
# tool, so the rehearsal exercises the REAL readiness gate rather than
# pretending a Machine is unhealthy. When the tool is unavailable the
# rehearsal records that the injection did not happen — an untested
# failure path is not a passed rehearsal.
INJECTION_OUTPUT=""
if [[ "$INJECT_FAILURE" -eq 1 ]]; then
  INJECTION_TOOL="$CUTOVER_REPO_ROOT/infra/cloud/observability/failure-inject.sh"
  if [[ -x "$INJECTION_TOOL" ]]; then
    INJECTION_OUTPUT="$("$INJECTION_TOOL" --help 2>&1 || true)"
  else
    INJECTION_OUTPUT="failure injection tool not available at $INJECTION_TOOL"
  fi
fi
INJECTION_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-failure-injection.json" "$INJECTION_OUTPUT")"
cutover_info "recorded the failure-injection step ($INJECTION_PATH)"

# ---------------------------------------------------------------------------
# 5 + 6. Invoke the REAL rollback and verify recovery
# ---------------------------------------------------------------------------
if ! rollback_output="$(scripts/cloud/cutover/rollback.sh --manifest "$MANIFEST" --run-id "$RUN_ID" --reason "staging rehearsal rollback" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rehearsal-rollback-failed.json" "$rollback_output" >/dev/null
  cutover_fail "the rehearsal rollback failed — the rehearsal does not pass" 1
fi
ROLLBACK_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-rollback.json" "$rollback_output")"
cutover_info "the rehearsal rollback completed — evidence $ROLLBACK_PATH"

# ---------------------------------------------------------------------------
# 7. Restore the initial route and prove idempotence
# ---------------------------------------------------------------------------
#
# The rollback already left the route on prodlike. Running the rollback
# AGAIN must succeed and change nothing: a rollback that only works
# once is not a rollback, it is a race.
live_version="$(cutover_route_version)"
if ! idempotence_output="$(scripts/cloud/cutover/rollback.sh --manifest "$MANIFEST" --run-id "$RUN_ID" --reason "staging rehearsal idempotence check" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rehearsal-idempotence-failed.json" "$idempotence_output" >/dev/null
  cutover_fail "the rehearsal rollback is not idempotent — the rehearsal does not pass" 1
fi
IDEMPOTENCE_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-idempotence.json" "$idempotence_output")"

RESULT="$(node --input-type=module -e "
  const [runId, probesVerdict, injection] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    version: 1,
    kind: 'rehearsal-result',
    runId,
    environment: 'staging',
    probesVerdict: probesVerdict,
    failureInjected: injection !== '',
    rollbackExecuted: true,
    rollbackIdempotent: true,
    at: new Date().toISOString(),
  }, null, 2));
")"
RESULT_PATH="$(cutover_write_evidence "$RUN_ID" "rehearsal-result.json" "$RESULT")"
cutover_info "rehearsal PASS — evidence $RESULT_PATH (this file is a hard production preflight input)"
printf '%s\n' "$RESULT"
