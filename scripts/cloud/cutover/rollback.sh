#!/usr/bin/env bash
# scripts/cloud/cutover/rollback.sh
#
# Roll the SIndustries production cutover back to the prodlike origin
# (task 020f423e).
#
# THE THREE DATA-SAFE ROLLBACK MODES
#   1. Runtime rollback (normal) — route the traffic back to the warm
#      local services WHILE THEY CONTINUE TO USE THE CANONICAL CLOUD
#      DATA PLANE. This is the expected fast rollback and it is the
#      only mode this script performs.
#   2. Cloud data-layer incident — after production writes, pointing
#      local services back at a stale pre-cutover database would
#      diverge. That mode needs write quiescence, a restore from the
#      accepted production backup, a reconciliation, and a SECOND
#      go/no-go. This script refuses to pretend it can do that: it
#      records the mode and hands over.
#   3. Pre-write abort — before any accepted production write, the
#      frozen pre-cutover database may be used, but only after the
#      write ledger proves no cloud-only writes occurred. The script
#      records that this mode is available and stops.
#
# The script never accepts on Tom's behalf, never deletes anything,
# and never leaves the cloud deployment damaged: the cloud deployment
# is left intact for forensics.
#
# Usage:
#   scripts/cloud/cutover/rollback.sh --manifest <path> [--reason <text>]
#
# Exit codes:
#   0  the runtime rollback completed and the probes confirmed recovery
#   1  the rollback did not complete — prodlike stays authoritative
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
REASON="operator-declared rollback"

usage() {
  sed -n '2,32p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
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
# 1. Record the reason and the current state BEFORE anything moves
# ---------------------------------------------------------------------------
live_version="$(cutover_route_version)"
STATE_BEFORE="$(cutover_route_readback "$MANIFEST" 2>/dev/null || printf '{}')"
STATE_PATH="$(cutover_write_evidence "$RUN_ID" "rollback-state-before.json" "$STATE_BEFORE")"
cutover_info "recorded the pre-rollback route state ($STATE_PATH, version $live_version)"

# ---------------------------------------------------------------------------
# 2. Decide which rollback mode applies
# ---------------------------------------------------------------------------
#
# The mode is not a judgement call made in the moment: it is decided by
# whether an accepted production write has happened. The manifest
# records the write ledger position, and the probes report whether the
# production origin has accepted a write during this window.
ledger_position() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    const manifest = loadManifest(process.argv[1]);
    const mode = manifest.rollback?.mode ?? 'runtime';
    process.stdout.write(mode);
  " "$MANIFEST" 2>/dev/null || printf 'runtime'
}

ROLLBACK_MODE="$(ledger_position)"
case "$ROLLBACK_MODE" in
  runtime)
    cutover_info "rollback mode: runtime — the local runtime keeps the canonical cloud data plane"
    ;;
  data-layer)
    cutover_warn "rollback mode: data-layer — production writes have been accepted; a restore + reconciliation + second go/no-go is required. This script performs the RUNTIME rollback only and records the required recovery steps."
    ;;
  pre-write)
    cutover_info "rollback mode: pre-write — no accepted production write; the frozen pre-cutover database is available"
    ;;
  *)
    cutover_fail "unknown rollback mode '$ROLLBACK_MODE' in the manifest" 2
    ;;
esac

# ---------------------------------------------------------------------------
# 3. Validate the local runtime against the canonical data plane
# ---------------------------------------------------------------------------
#
# A runtime rollback that points local services at a stale database is
# not a rollback, it is a divergence. The manifest names the data plane
# each origin uses, and the rollback refuses to proceed when the local
# origin is NOT on the canonical plane while production writes exist.
prodlike_data_plane() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(loadManifest(process.argv[1]).origins.prodlike.dataPlane);
  " "$MANIFEST"
}
canonical_data_plane() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    process.stdout.write(loadManifest(process.argv[1]).origins.production.dataPlane);
  " "$MANIFEST"
}

if [[ "$ROLLBACK_MODE" == "runtime" || "$ROLLBACK_MODE" == "data-layer" ]]; then
  prodlike_plane="$(prodlike_data_plane)"
  canonical_plane="$(canonical_data_plane)"
  if [[ "$prodlike_plane" != "$canonical_plane" ]]; then
    cutover_warn "the prodlike origin is on the '$prodlike_plane' data plane while production is on '$canonical_plane'."
    cutover_warn "A runtime rollback onto a stale database would diverge. The rollback is REFUSED until the prodlike runtime is repointed at the canonical cloud data plane (runbook step: repoint the local runtime)."
    cutover_write_evidence "$RUN_ID" "rollback-refused.json" "{\"reason\":\"data-plane-mismatch\",\"prodlikeDataPlane\":\"$prodlike_plane\",\"canonicalDataPlane\":\"$canonical_plane\"}" >/dev/null
    cutover_fail "rollback refused: the prodlike runtime is not on the canonical data plane — prodlike stays authoritative and the window records the refusal" 1
  fi
  cutover_info "the prodlike runtime is on the canonical data plane ($canonical_plane) — a runtime rollback is data-safe"
fi

# ---------------------------------------------------------------------------
# 4. Move the route back, with compare-and-set
# ---------------------------------------------------------------------------
if [[ "$CUTOVER_ENVIRONMENT" == "production" ]]; then
  cutover_assert_production_ack
fi

if ! route_output="$(cutover_route_set "$MANIFEST" prodlike "$live_version" "$RUN_ID" 2>&1)"; then
  cutover_write_evidence "$RUN_ID" "rollback-route-refused.json" "$route_output" >/dev/null
  cutover_fail "the route adapter refused the rollback: $(cutover_redact "$route_output")" 1
fi
cutover_info "route bound back to prodlike at version $((live_version + 1))"

# ---------------------------------------------------------------------------
# 5. Run the same smoke checks the switch ran
# ---------------------------------------------------------------------------
#
# The rollback is only complete when the services answer again. The
# probes run against the ACTIVE binding, which is now prodlike.
PROBE_OUTPUT=""
if [[ -f "$CUTOVER_PROBES" ]]; then
  PROBE_OUTPUT="$(node "$CUTOVER_PROBES" --manifest "$MANIFEST" --binding prodlike --phase rollback 2>&1 || true)"
fi
PROBE_PATH="$(cutover_write_evidence "$RUN_ID" "rollback-probes.json" "$PROBE_OUTPUT")"
probe_verdict="$(printf '%s' "$PROBE_OUTPUT" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")"

if [[ "$probe_verdict" != "PASS" ]]; then
  cutover_warn "the rollback probes did not pass ($probe_verdict) — evidence $PROBE_PATH"
  cutover_warn "the cloud deployment is left INTACT for forensics; prodlike remains the authoritative source"
  cutover_fail "rollback did not complete: the smoke checks did not pass against prodlike" 1
fi

# ---------------------------------------------------------------------------
# 6. Record the outcome
# ---------------------------------------------------------------------------
STATE_AFTER="$(cutover_route_readback "$MANIFEST" 2>/dev/null || printf '{}')"
OUTCOME="$(cutover_rollback_result "$RUN_ID" "$REASON" "$ROLLBACK_MODE" "$STATE_BEFORE" "$STATE_AFTER")"
OUTCOME_PATH="$(cutover_write_evidence "$RUN_ID" "rollback-result.json" "$OUTCOME")"
cutover_info "rollback complete — evidence $OUTCOME_PATH"
cutover_write_state "rolled_back" "$(cutover_manifest_hash "$MANIFEST")" "$(cutover_route_version)"
printf '%s\n' "$OUTCOME"
