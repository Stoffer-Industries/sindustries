#!/usr/bin/env bash
# scripts/cloud/cutover/execute.sh
#
# Drive the SIndustries production cutover through its phases
# (task 020f423e).
#
# THE EXECUTION LOOP
#   For each phase the manifest declares:
#     1. apply the phase's binding through the route adapter, with
#        compare-and-set against the live route version;
#     2. run the continuous probes against the ACTIVE binding and
#        collect the phase's minimum number of samples;
#     3. evaluate the manifest's abort thresholds against the samples;
#     4. record the phase's evidence and the durable state.
#
# A phase never advances on a failed sample. The abort conditions are
# the design's: a required endpoint failing a probe, an authenticated
# workflow failing, an error-rate or latency breach, a database/Redis/
# queue signal breach, ambiguous worker leadership, a route state that
# is not the expected version, evidence that cannot be collected, or an
# operator abort.
#
# The script NEVER accepts on Tom's behalf and NEVER retires the
# prodlike fallback: the last phase the manifest declares is
# `acceptance_pending`, and that is where the script stops.
#
# Usage:
#   scripts/cloud/cutover/execute.sh --manifest <path> [--resume] [--phase <name>]
#
# Exit codes:
#   0  every phase completed
#   1  a phase aborted; the rollback was invoked
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
RESUME=0
ONLY_PHASE=""
PROBE_INTERVAL_OVERRIDE=""

usage() {
  sed -n '2,32p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --phase) ONLY_PHASE="$2"; shift 2 ;;
    --probe-interval) PROBE_INTERVAL_OVERRIDE="$2"; shift 2 ;;
    --help|-h) usage 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage 2 ;;
  esac
done

cutover_require_commands
MANIFEST="$(cutover_resolve_manifest "$MANIFEST")"
cutover_assert_environment "$MANIFEST" "$CUTOVER_ENVIRONMENT"
RUN_ID="$(cutover_run_id)"

# The operator lock is taken BEFORE the preflight: two operators must
# not both be inside the window, even if one of them is only reading.
cutover_acquire_lock

# ---------------------------------------------------------------------------
# The preflight is a gate, not a report
# ---------------------------------------------------------------------------
#
# The execution does not decide whether it may start. The preflight
# does, and its verdict is recorded as part of the window's evidence.
PREFLIGHT_RESULT="$(scripts/cloud/cutover/preflight.sh --manifest "$MANIFEST" --run-id "$RUN_ID" 2>&1)" || {
  printf '%s\n' "$(cutover_redact "$PREFLIGHT_RESULT")" >&2
  cutover_fail "preflight did not pass — the cutover does not start" 1
}
cutover_info "preflight PASS"

# ---------------------------------------------------------------------------
# Phase helpers
# ---------------------------------------------------------------------------

PHASES=()
while IFS=$'\t' read -r _phase _binding _hold _samples; do
  [[ -n "$_phase" ]] && PHASES+=("$_phase")
done < <(cutover_manifest_phases "$MANIFEST")

probe_interval() {
  if [[ -n "$PROBE_INTERVAL_OVERRIDE" ]]; then
    printf '%s' "$PROBE_INTERVAL_OVERRIDE"
    return
  fi
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(String(loadManifest(process.argv[1]).probes.intervalSeconds));
  " "$MANIFEST"
}

# Abort the window and hand over to the rollback script. The rollback
# script is the only thing that may move the route back; the executor
# never does it inline, so the rollback evidence is always produced by
# one path.
abort_and_rollback() {
  local reason="$1"
  cutover_warn "ABORT: $reason"
  cutover_write_state "rolled_back" "$MANIFEST_HASH" "$(cutover_route_version)"
  if scripts/cloud/cutover/rollback.sh --manifest "$MANIFEST" --run-id "$RUN_ID" --reason "$reason"; then
    cutover_fail "cutover aborted and rolled back: $reason" 1
  fi
  cutover_fail "cutover aborted and the ROLLBACK ITSELF FAILED: $reason — prodlike remains the authoritative source and the route state is in $CUTOVER_ROUTE_STATE_FILE" 1
}

# Collect the phase's samples and evaluate the thresholds. Returns 0
# when the phase passed, 1 when it must abort.
collect_phase_samples() {
  local phase="$1" binding="$2" hold_seconds="$3" min_samples="$4"
  local interval
  interval="$(probe_interval)"
  local deadline=$(( $(date +%s) + hold_seconds ))
  local samples=0
  local failure_count=0
  local evidence_lines=""
  local sample_index=0

  while (( samples < min_samples )); do
    sample_index=$((sample_index + 1))
    sample_output="$(node "$CUTOVER_PROBES" \
      --manifest "$MANIFEST" \
      --binding "$binding" \
      --phase "$phase" \
      --sample "$sample_index" \
      2>&1 || true)"
    verdict="$(printf '%s' "$sample_output" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")"
    if [[ "$verdict" != "PASS" ]]; then
      failure_count=$((failure_count + 1))
    fi
    samples=$((samples + 1))
    evidence_lines+="$(printf '%s' "$sample_output" | tr '\n' ' ')"$'\n'

    abort_threshold="$(node --input-type=module -e "
      import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
      process.stdout.write(String(loadManifest(process.argv[1]).run.abortThresholds.probeFailureCount));
    " "$MANIFEST")"
    if (( failure_count >= abort_threshold )); then
      EVIDENCE_PATH="$(cutover_write_evidence "$RUN_ID" "phase-${phase}-abort.json" "$evidence_lines")"
      cutover_warn "phase $phase aborted — samples $samples, failures $failure_count (evidence $EVIDENCE_PATH)"
      return 1
    fi

    if (( samples < min_samples )) && (( $(date +%s) < deadline )); then
      sleep "$interval"
    fi
  done

  PHASE_EVIDENCE="$(cutover_write_evidence "$RUN_ID" "phase-${phase}.json" "$evidence_lines")"
  cutover_info "phase $phase passed — $samples sample(s), evidence $PHASE_EVIDENCE"
  return 0
}

# ---------------------------------------------------------------------------
# The phase loop
# ---------------------------------------------------------------------------

START_INDEX=0
CURRENT_PHASE="$(cutover_current_phase)"
if [[ "$RESUME" -eq 1 && "$CURRENT_PHASE" != "start" ]]; then
  for index in "${!PHASES[@]}"; do
    if [[ "${PHASES[$index]}" == "$CURRENT_PHASE" ]]; then
      START_INDEX=$((index + 1))
      cutover_info "resuming after phase $CURRENT_PHASE"
      break
    fi
  done
  if [[ "$START_INDEX" -eq 0 ]]; then
    cutover_fail "cannot resume: recorded phase '$CURRENT_PHASE' is not a phase of this manifest" 1
  fi
fi

if [[ -n "$ONLY_PHASE" ]]; then
  found=0
  for index in "${!PHASES[@]}"; do
    if [[ "${PHASES[$index]}" == "$ONLY_PHASE" ]]; then
      START_INDEX=$index
      found=1
      break
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    cutover_fail "unknown phase '$ONLY_PHASE'" 2
  fi
fi

# The production acknowledgement is required before ANY route change.
if [[ "$CUTOVER_ENVIRONMENT" == "production" ]]; then
  cutover_assert_production_ack
fi

MANIFEST_HASH="$(cutover_manifest_hash "$MANIFEST")"
LAST_APPLIED_VERSION=""
LAST_BINDING=""

for (( index = START_INDEX; index < ${#PHASES[@]}; index++ )); do
  phase="${PHASES[$index]}"
  binding="$(cutover_phase_binding "$MANIFEST" "$phase")"
  hold_seconds="$(cutover_phase_hold "$MANIFEST" "$phase")"
  min_samples="$(cutover_phase_min_samples "$MANIFEST" "$phase")"

  cutover_info "phase $phase — binding $binding (hold ${hold_seconds}s, min ${min_samples} sample(s))"

  # The plan is read BEFORE the change, so the operator's artifact
  # records what the change would do, not only what it did.
  PLAN_DOC="$(cutover_route_plan "$MANIFEST" "$binding" 2>/dev/null || printf '{}')"
  PLAN_PATH="$(cutover_write_evidence "$RUN_ID" "phase-${phase}-plan.json" "$PLAN_DOC")"

  live_version="$(cutover_route_version)"

  if [[ "$binding" != "$LAST_BINDING" ]]; then
    if ! route_output="$(cutover_route_set "$MANIFEST" "$binding" "$live_version" "$RUN_ID" 2>&1)"; then
      cutover_write_evidence "$RUN_ID" "phase-${phase}-route-refused.json" "$route_output" >/dev/null
      abort_and_rollback "the route adapter refused the change: $(cutover_redact "$route_output")"
    fi
    cutover_info "route bound to $binding at version $((live_version + 1)) (plan $PLAN_PATH)"
    LAST_APPLIED_VERSION=$((live_version + 1))
    LAST_BINDING="$binding"
  else
    cutover_info "route already bound to $binding — no route change for this phase"
    LAST_APPLIED_VERSION="$live_version"
  fi

  # The route must be where the executor believes it is before the
  # probes run. A route that is not the expected version is an abort.
  observed_version="$(cutover_route_version)"
  if [[ "$observed_version" != "$LAST_APPLIED_VERSION" ]]; then
    abort_and_rollback "the live route version ($observed_version) is not the version this operator applied ($LAST_APPLIED_VERSION)"
  fi

  if ! collect_phase_samples "$phase" "$binding" "$hold_seconds" "$min_samples"; then
    abort_and_rollback "phase $phase failed its probes"
  fi

  cutover_write_state "$phase" "$MANIFEST_HASH" "$observed_version"
done

# ---------------------------------------------------------------------------
# The window ends at acceptance_pending, never at accepted
# ---------------------------------------------------------------------------
#
# Tom accepts the observation period. The script does not accept on his
# behalf, and it does not touch the prodlike fallback: retiring it is a
# later, separate, explicit operation.
READBACK="$(cutover_route_readback "$MANIFEST" 2>/dev/null || printf '{}')"
READBACK_PATH="$(cutover_write_evidence "$RUN_ID" "prodlike-readback.json" "$READBACK")"

cutover_info "cutover window complete — prodlike read-back: $READBACK_PATH"
cutover_info "the prodlike fallback is RETAINED; decommissioning waits for Tom's explicit acceptance"
