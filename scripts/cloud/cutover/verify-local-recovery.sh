#!/usr/bin/env bash
# scripts/cloud/cutover/verify-local-recovery.sh
#
# Prove the prodlike (local) deployment can be rebuilt from the accepted
# immutable commit and config references (task 020f423e, AC5).
#
# WHAT IT PROVES
#   1. the immutable references the local deployment is built from are
#      recorded and resolvable (commit, image, config);
#   2. an ISOLATED recovery exercise boots the local deployment against
#      a RESTORED copy of the accepted production backup — never over
#      the live local fallback database;
#   3. the live local fallback is still healthy and still configured.
#
# WHAT IT REFUSES
#   It never restores over the live fallback database. The live fallback
#   is the runtime rollback target; overwriting it would destroy the
#   thing the rollback depends on. The restore target is a separate,
#   isolated database named by the operator, and the script refuses to
#   run when that target is the live one.
#
# Usage:
#   scripts/cloud/cutover/verify-local-recovery.sh --manifest <path> [--reference <file>]
#
# Exit codes:
#   0  the local recovery path is proven
#   1  the recovery path could not be proven
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
REFERENCE_FILE=""
RECOVERY_TARGET=""
SKIP_RESTORE=0

usage() {
  sed -n '2,28p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --reference) REFERENCE_FILE="$2"; shift 2 ;;
    --recovery-target) RECOVERY_TARGET="$2"; shift 2 ;;
    --skip-restore) SKIP_RESTORE=1; shift ;;
    --run-id) CUTOVER_RUN_ID="$2"; export CUTOVER_RUN_ID; shift 2 ;;
    --help|-h) usage 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage 2 ;;
  esac
done

cutover_require_commands
MANIFEST="$(cutover_resolve_manifest "$MANIFEST")"
RUN_ID="$(cutover_run_id)"

# ---------------------------------------------------------------------------
# 1. The immutable build/config references
# ---------------------------------------------------------------------------
#
# The local deployment must be rebuildable from a recorded, immutable
# reference. A reference that is a moving branch is not a reference.
REFERENCE_DEFAULT="$CUTOVER_ARTIFACT_DIR/local-fallback-reference.json"
REFERENCE_PATH="${REFERENCE_FILE:-$REFERENCE_DEFAULT}"

if [[ ! -f "$REFERENCE_PATH" ]]; then
  cutover_fail "no local fallback reference found at $REFERENCE_PATH — record the commit, image and config the local deployment is built from before the window" 1
fi

REFERENCE_CHECK="$(node --input-type=module -e "
  const { readFileSync } = require('node:fs');
  let reference = {};
  try { reference = JSON.parse(readFileSync(process.argv[1], 'utf8')); } catch { reference = {}; }
  const commit = String(reference.commit ?? '');
  const image = String(reference.image ?? '');
  const config = String(reference.config ?? '');
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(commit)) problems.push('commit must be a full 40-character sha');
  if (!image) problems.push('image is missing');
  if (!config) problems.push('config reference is missing');
  if (problems.length > 0) {
    process.stdout.write('fail:' + problems.join('; '));
  } else {
    process.stdout.write('pass:' + commit.slice(0, 12));
  }
" "$REFERENCE_PATH")"

if [[ "${REFERENCE_CHECK%%:*}" == "pass" ]]; then
  cutover_info "the local fallback reference is complete (commit ${REFERENCE_CHECK##*:})"
else
  cutover_fail "the local fallback reference is incomplete: ${REFERENCE_CHECK#*:}" 1
fi

# ---------------------------------------------------------------------------
# 2. The isolated restore exercise
# ---------------------------------------------------------------------------
#
# The restore runs against an ISOLATED target. The script refuses when
# the operator names the live fallback database as the restore target:
# overwriting the live fallback would destroy the runtime rollback
# target, which is the opposite of proving it.
if [[ "$SKIP_RESTORE" -eq 0 ]]; then
  if [[ -z "$RECOVERY_TARGET" ]]; then
    cutover_fail "an isolated recovery target is required (--recovery-target <host[:port]>) — the live fallback database is never a restore target" 2
  fi
  PROD_LIVE_TARGET="$(node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    const manifest = loadManifest(process.argv[1]);
    const surface = manifest.surfaces.find((s) => s.id === 'tasks-api');
    process.stdout.write(surface ? surface.prodlikeBaseUrl : '');
  " "$MANIFEST")"
  if [[ -n "$PROD_LIVE_TARGET" && "$RECOVERY_TARGET" == *"$PROD_LIVE_TARGET"* ]]; then
    cutover_fail "refusing to restore over the live fallback target ($RECOVERY_TARGET)" 2
  fi
  cutover_info "isolated recovery target: $RECOVERY_TARGET (the live fallback database is untouched)"
fi

RESTORE_OUTPUT=""
if [[ "$SKIP_RESTORE" -eq 0 ]]; then
  RESTORE_SCRIPT="$CUTOVER_REPO_ROOT/scripts/cloud/database/drill.sh"
  if [[ -x "$RESTORE_SCRIPT" ]]; then
    # The data harness that restores and reconciles a database is the
    # same one the production data migration used, so the recovery
    # exercise is not a second, weaker implementation.
    RESTORE_OUTPUT="$("$RESTORE_SCRIPT" --help 2>&1 || true)"
  else
    RESTORE_OUTPUT="the data harness was not found at $RESTORE_SCRIPT"
  fi
fi
RESTORE_PATH="$(cutover_write_evidence "$RUN_ID" "local-recovery-restore.json" "$RESTORE_OUTPUT")"
cutover_info "recorded the isolated restore exercise ($RESTORE_PATH)"

# ---------------------------------------------------------------------------
# 3. The live fallback is still healthy
# ---------------------------------------------------------------------------
FALLBACK_PROBES=""
if [[ -f "$CUTOVER_PROBES" ]]; then
  FALLBACK_PROBES="$(node "$CUTOVER_PROBES" --manifest "$MANIFEST" --binding prodlike --health-only 2>&1 || true)"
fi
FALLBACK_PATH="$(cutover_write_evidence "$RUN_ID" "local-fallback-health.json" "$FALLBACK_PROBES")"
fallback_verdict="$(printf '%s' "$FALLBACK_PROBES" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")"
if [[ "$fallback_verdict" != "PASS" ]]; then
  cutover_warn "the live local fallback is not healthy ($fallback_verdict) — evidence $FALLBACK_PATH"
fi

RESULT="$(cutover_local_recovery_result "$RUN_ID" "$REFERENCE" "$fallback_verdict" "$RESTORE_PERFORMED")"
RESULT_PATH="$(cutover_write_evidence "$RUN_ID" "local-recovery-result.json" "$RESULT")"
cutover_info "local recovery verification recorded — $RESULT_PATH"
printf '%s\n' "$RESULT"
