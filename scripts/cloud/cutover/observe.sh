#!/usr/bin/env bash
# scripts/cloud/cutover/observe.sh
#
# Observe the live cutover route without changing it (task 020f423e).
#
# WHAT THIS IS FOR
#   The cutover's observation period (AC3) is a continuous watch, not a
#   single check. This script runs the SAME probes the executor runs,
#   against whichever binding the route is actually on right now, and
#   writes one redacted sample per interval.
#
# WHY IT EXISTS ALONGSIDE execute.sh
#   execute.sh walks the manifest's phases and runs the observation
#   phase itself. This script is the standalone observer: a second pair
#   of eyes during the window, and the `observe` mode of
#   .github/workflows/production-cloud-cutover.yml, which keeps sampling
#   while a human watches the dashboards.
#
# IT NEVER MOVES THE ROUTE
#   It does not take the operator lock, and it never calls the adapter's
#   `set`. The route state is written atomically by the adapter (write
#   beside, then rename), so reading it while the executor advances a
#   phase sees either the old state or the new one — never a half
#   written file. An observer must not be able to interfere with the
#   window it is watching.
#
# Usage:
#   scripts/cloud/cutover/observe.sh --manifest <path> [--samples N] [--phase <name>]
#
# Exit codes:
#   0  every sample passed
#   1  at least one sample failed
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
SAMPLES=""
PHASE="observing"
BINDING_OVERRIDE=""
PROBE_INTERVAL_OVERRIDE=""

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    --binding) BINDING_OVERRIDE="$2"; shift 2 ;;
    --probe-interval) PROBE_INTERVAL_OVERRIDE="$2"; shift 2 ;;
    --run-id) CUTOVER_RUN_ID="$2"; export CUTOVER_RUN_ID; shift 2 ;;
    --help|-h) usage 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage 2 ;;
  esac
done

cutover_require_commands
MANIFEST="$(cutover_resolve_manifest "$MANIFEST")"
cutover_assert_environment "$MANIFEST" "$CUTOVER_ENVIRONMENT"
RUN_ID="$(cutover_run_id)"

# ---------------------------------------------------------------------------
# The binding the route is on RIGHT NOW
# ---------------------------------------------------------------------------
#
# The observer probes the live binding, not the one the manifest would
# apply next. If the operator has not switched yet, that is prodlike;
# after the switch, production. An operator can override it, but the
# default is the truth on the ground.
live_binding() {
  if [[ -n "$BINDING_OVERRIDE" ]]; then
    printf '%s' "$BINDING_OVERRIDE"
    return
  fi
  node "$CUTOVER_ADAPTER" get --state-file "$CUTOVER_ROUTE_STATE_FILE" 2>/dev/null \
    | node -e "
      let raw = '';
      process.stdin.on('data', (chunk) => { raw += chunk; });
      process.stdin.on('end', () => {
        let state = {};
        try { state = JSON.parse(raw); } catch { state = {}; }
        process.stdout.write(state.binding ?? '');
      });
    "
}

BINDING="$(live_binding)"
if [[ -z "$BINDING" ]]; then
  cutover_fail "the live route has no binding yet — there is nothing to observe" 1
fi

if [[ -z "$SAMPLES" ]]; then
  SAMPLES="$(node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(String(loadManifest(process.argv[1]).probes.minSamplesPerStep));
  " "$MANIFEST")"
fi

INTERVAL="$PROBE_INTERVAL_OVERRIDE"
if [[ -z "$INTERVAL" ]]; then
  INTERVAL="$(node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(String(loadManifest(process.argv[1]).probes.intervalSeconds));
  " "$MANIFEST")"
fi

cutover_info "observing binding '$BINDING' — $SAMPLES sample(s) at ${INTERVAL}s intervals (run id $RUN_ID)"

# ---------------------------------------------------------------------------
# The samples
# ---------------------------------------------------------------------------
EVIDENCE_LINES=""
FAILURES=0
INDEX=0

while (( INDEX < SAMPLES )); do
  INDEX=$((INDEX + 1))
  SAMPLE_OUTPUT="$(node "$CUTOVER_PROBES" \
    --manifest "$MANIFEST" \
    --binding "$BINDING" \
    --phase "$PHASE" \
    --sample "$INDEX" \
    --run-id "$RUN_ID" \
    2>&1 || true)"

  VERDICT="$(printf '%s' "$SAMPLE_OUTPUT" | node -e "
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      try { process.stdout.write(JSON.parse(raw).verdict); } catch { process.stdout.write('UNPARSEABLE'); }
    });
  ")"

  if [[ "$VERDICT" != "PASS" ]]; then
    FAILURES=$((FAILURES + 1))
    cutover_warn "sample $INDEX verdict=$VERDICT"
  else
    cutover_info "sample $INDEX verdict=PASS"
  fi

  EVIDENCE_LINES+="$(printf '%s' "$SAMPLE_OUTPUT" | tr '\n' ' ')"$'\n'

  if (( INDEX < SAMPLES )); then
    sleep "$INTERVAL"
  fi
done

EVIDENCE_PATH="$(cutover_write_evidence "$RUN_ID" "observe-${PHASE}.json" "$EVIDENCE_LINES")"
cutover_info "observation evidence: $EVIDENCE_PATH"

if (( FAILURES > 0 )); then
  cutover_fail "observation failed: $FAILURES of $SAMPLES sample(s) did not pass — the abort thresholds in the manifest decide whether this window continues" 1
fi

cutover_info "observation complete — every sample passed against binding '$BINDING'"
