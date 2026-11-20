#!/usr/bin/env bash
# scripts/cloud/cutover/preflight.sh
#
# Fail-closed preflight for the SIndustries production cutover
# (task 020f423e).
#
# The preflight is the ONLY thing that decides whether the Sunday window
# may start. It produces a result bound to the run id, and every gate
# that is not green is a refusal — not a warning, and not a note for
# the operator to judge.
#
# TWO MODES
#   --plan    Report every gate's status WITHOUT requiring the gates to
#             pass. Used before the window to see what is outstanding,
#             and used by the test suite to prove that each missing
#             prerequisite BLOCKS the cutover rather than being noted.
#             Exits 0 when the report was produced.
#   (default) The real preflight. Every gate must pass, the result is
#             hashed and bound to the run id, and the result is written
#             to the evidence directory. Exits non-zero when any gate
#             fails.
#
# Usage:
#   scripts/cloud/cutover/preflight.sh --manifest <path> [--plan] [--run-id <id>]
#
# Exit codes:
#   0  the preflight passed (or the plan report was produced)
#   1  a gate failed
#   2  invalid usage / missing tooling

set -euo pipefail

# shellcheck shell=bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MANIFEST=""
PLAN=0
EVIDENCE_DIR=""
TASKS_API_BASE="${TASKS_API_BASE_URL:-http://localhost:4001/api/v1}"

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --plan) PLAN=1; shift ;;
    --run-id) CUTOVER_RUN_ID="$2"; export CUTOVER_RUN_ID; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
    --tasks-api) TASKS_API_BASE="$2"; shift 2 ;;
    --help|-h) usage 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage 2 ;;
  esac
done

cutover_require_commands
MANIFEST="$(cutover_resolve_manifest "$MANIFEST")"

# ---------------------------------------------------------------------------
# The manifest is the CONTRACT, not one of the gates
# ---------------------------------------------------------------------------
#
# Nothing can be planned or executed against a manifest the validator
# refuses, so an invalid manifest is a HARD refusal in plan mode too.
# Otherwise --plan prints a plan for a window that cannot exist, and a
# reader takes that plan as a real one.
if ! manifest_summary="$(cutover_validate_manifest "$MANIFEST" 2>&1)"; then
  cutover_fail "the manifest is invalid: $(cutover_redact "$manifest_summary")" 2
fi

# ---------------------------------------------------------------------------
# The gate ledger
# ---------------------------------------------------------------------------
#
# Each gate appends a row to this ledger. The ledger is the result
# document: it is hashed and bound to the run id at the end, so the
# evidence cannot be edited after the fact without the digest changing.
GATES_JSON=""
GATE_FAILURES=0

record_gate() {
  # record_gate <name> <status: pass|fail> <detail>
  local name="$1" status="$2" detail="$3"
  if [[ "$status" == "fail" ]]; then
    GATE_FAILURES=$((GATE_FAILURES + 1))
    cutover_warn "gate FAIL: $name — $detail"
  else
    cutover_info "gate pass: $name — $detail"
  fi
  GATES_JSON="$(node --input-type=module -e "
    const [current, name, status, detail] = process.argv.slice(1);
    const gates = current ? JSON.parse(current) : [];
    gates.push({ name, status, detail });
    process.stdout.write(JSON.stringify(gates));
  " "$GATES_JSON" "$name" "$status" "$detail")"
}

# ---------------------------------------------------------------------------
# Gate: the manifest itself
# ---------------------------------------------------------------------------

manifest_task_and_environment="$(printf '%s' "$manifest_summary" | node -e "
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const manifest = JSON.parse(raw);
      process.stdout.write(manifest.taskId + ' ' + manifest.environment);
    } catch {
      process.stdout.write('unknown');
    }
  });
")"
record_gate "manifest-valid" "pass" "manifest validated: $manifest_task_and_environment"

MANIFEST_HASH="$(cutover_manifest_hash "$MANIFEST")"

# ---------------------------------------------------------------------------
# Gate: the environment the operator is allowed to touch
# ---------------------------------------------------------------------------

if cutover_assert_environment "$MANIFEST" "$CUTOVER_ENVIRONMENT" 2>/dev/null; then
  record_gate "environment-match" "pass" "manifest environment is $CUTOVER_ENVIRONMENT"
else
  record_gate "environment-match" "fail" "manifest environment is not $CUTOVER_ENVIRONMENT"
fi

# ---------------------------------------------------------------------------
# Gate: the operator-owned values the window cannot start without
# ---------------------------------------------------------------------------

read_manifest_value() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    const manifest = loadManifest(process.argv[1]);
    const path = process.argv[2].split('.');
    let value = manifest;
    for (const key of path) value = value?.[key];
    if (value === undefined || value === null || value === '') {
      process.exit(3);
    }
    process.stdout.write(String(value));
  " "$MANIFEST" "$1" 2>/dev/null || true
}

for field in "run.observationMinutes" "run.operatorRoles.goNoGo" "run.operatorRoles.execution" "run.operatorRoles.engineering" "run.abortThresholds.probeFailureCount" "run.abortThresholds.errorRate" "run.abortThresholds.p95LatencyMs" "run.abortThresholds.activeAlertCount"; do
  if [[ -n "$(read_manifest_value "$field")" ]]; then
    record_gate "operator-value:${field##*.}" "pass" "$field is set"
  else
    record_gate "operator-value:${field##*.}" "fail" "$field is unset — an unset observation duration or abort threshold blocks execution"
  fi
done

# ---------------------------------------------------------------------------
# Gate: the dependency tasks are accepted
# ---------------------------------------------------------------------------
#
# The cutover cannot start before the work it depends on is accepted.
# Each dependency is read from the Tasks API, and a dependency that is
# not accepted is a refusal.
dependency_task_ids() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    for (const id of loadManifest(process.argv[1]).gates.requiredDependencyTaskIds) {
      process.stdout.write(id + '\n');
    }
  " "$MANIFEST"
}

accepted_states() { printf '%s\n' 'done' 'accepted'; }

for dependency_id in $(dependency_task_ids); do
  dependency_status="$(curl --fail --silent --show-error --max-time "${CUTOVER_TASKS_API_TIMEOUT:-15}" \
    "${TASKS_API_BASE}/tasks/${dependency_id}" 2>/dev/null \
    | node -e "
      let raw = '';
      process.stdin.on('data', (chunk) => { raw += chunk; });
      process.stdin.on('end', () => {
        let task = {};
        try {
          const parsed = JSON.parse(raw);
          task = parsed.data ?? parsed;
        } catch {
          task = {};
        }
        process.stdout.write(String(task.status ?? 'unknown'));
      });
    " || true)"
  if [[ -z "$dependency_status" || "$dependency_status" == "unknown" ]]; then
    record_gate "dependency:${dependency_id:0:8}" "fail" "dependency task could not be read from the Tasks API at $TASKS_API_BASE"
  elif accepted_states | grep -qx "$dependency_status"; then
    record_gate "dependency:${dependency_id:0:8}" "pass" "dependency task is $dependency_status"
  else
    record_gate "dependency:${dependency_id:0:8}" "fail" "dependency task is $dependency_status, not accepted"
  fi
done

# ---------------------------------------------------------------------------
# Gate: the route inventory matches the manifest
# ---------------------------------------------------------------------------
#
# The live route must name the same surfaces the manifest does. A route
# that knows about a surface the manifest does not (or the other way
# round) is route drift, and the cutover refuses to run on top of it.
route_inventory() {
  cutover_route_readback "$MANIFEST" 2>/dev/null || printf '{}'
}

inventory_check="$(route_inventory | node --input-type=module -e "
  import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    const manifest = loadManifest(process.argv[1]);
    let readback = {};
    try { readback = JSON.parse(raw); } catch { readback = {}; }
    const declared = manifest.surfaces.map((s) => s.id).sort();
    // The inventory is compared against EVERY DECLARED surface, not
    // only the in-scope ones. The read-back deliberately keeps the
    // documented rollback surfaces out of 'inScopeSurfaces', because
    // they are the surfaces that are SUPPOSED to stay on prodlike —
    // so comparing the declared set against the in-scope set always
    // reported the rollback surface as missing, this gate could never
    // pass, and the cutover could never start.
    //
    // Read-back reports active surfaces and retained rollback
    // surfaces separately. Their union is the complete declared route
    // inventory; the retained surface is allowed to remain on
    // prodlike, but it is not allowed to disappear from inventory.
    const observed = [
      ...(readback.inScopeSurfaces ?? []),
      ...(readback.documentedRollbackSurfaces ?? []).map((entry) => entry.surface),
    ].sort();
    const missing = declared.filter((id) => !observed.includes(id));
    if (missing.length > 0) {
      process.stdout.write('missing:' + missing.join(','));
    } else {
      const retained = (readback.documentedRollbackSurfaces ?? []).map((s) => s.surface);
      process.stdout.write('ok:' + declared.length + (retained.length ? ':retained=' + retained.join(',') : ''));
    }
  });
" "$MANIFEST")"

if [[ "${inventory_check%%:*}" == "ok" ]]; then
  inventory_detail="route inventory matches the manifest (${inventory_check#ok:})"
  if [[ "${inventory_check#*retained=}" != "$inventory_check" ]]; then
    inventory_count="${inventory_check#ok:}"
    inventory_count="${inventory_count%%:*}"
    inventory_detail="route inventory matches the manifest (${inventory_count} surfaces; retained rollback surface: ${inventory_check#*retained=})"
  fi
  record_gate "route-inventory" "pass" "$inventory_detail"
else
  record_gate "route-inventory" "fail" "route inventory does not match the manifest (${inventory_check#*:})"
fi

# ---------------------------------------------------------------------------
# Gate: the operator's evidence for the gates only an operator can satisfy
# ---------------------------------------------------------------------------
#
# Some prerequisites cannot be derived from this repository: the backup
# and restore test result, the staging rollback rehearsal, the operator
# roster. The operator supplies them as named files, and the preflight
# refuses to start without them.
required_evidence() {
  node --input-type=module -e "
    import { loadManifest } from '${CUTOVER_MANIFEST_MODULE}';
    for (const name of loadManifest(process.argv[1]).gates.requiredEvidence) {
      process.stdout.write(name + '\n');
    }
  " "$MANIFEST"
}

EVIDENCE_BASE="${EVIDENCE_DIR:-$CUTOVER_ARTIFACT_DIR/evidence}"
for evidence_name in $(required_evidence); do
  if [[ -f "$EVIDENCE_BASE/$evidence_name.json" || -f "$EVIDENCE_BASE/$evidence_name" ]]; then
    record_gate "evidence:${evidence_name}" "pass" "operator evidence present at $EVIDENCE_BASE/$evidence_name"
  else
    record_gate "evidence:${evidence_name}" "fail" "operator evidence missing: $EVIDENCE_BASE/$evidence_name.json"
  fi
done

# ---------------------------------------------------------------------------
# Gate: the hosted-observability read credential is present and read-scoped
# ---------------------------------------------------------------------------
#
# The hosted-signals probe reads the active alert count from the hosted
# Grafana stack, and it fails closed: with no credential there is no
# signal, and an unobserved signal is not a healthy signal. So a
# missing credential already stops the window — but it stops it inside
# the HEALTH gate, where the result reads "the probes do not report
# production healthy". An operator reading that looks at the service
# first and the environment second, and the actual defect is a
# credential nobody provisioned. This gate names the credential.
#
# It also refuses the substitution the runbook forbids. The
# provisioning token can write dashboards and delete alert rules, so it
# must never be the credential the window observes production with,
# and it must never reach the window's evidence. The two tokens are
# separate service accounts; the only way they can collide is an
# operator exporting one as the other under time pressure, which is
# exactly what this gate is here to catch.
#
# The variable precedence mirrors the probe exactly
# (tests/cloud/production-cutover-probes.mjs), so the gate refuses
# precisely when the probe would. The credential is never printed.
hosted_observability_base="${CUTOVER_OBSERVABILITY_BASE_URL:-${GRAFANA_CLOUD_INSTANCE_URL:-}}"
hosted_observability_credential="${CUTOVER_OBSERVABILITY_TOKEN:-${GRAFANA_CLOUD_READER_AUTH:-}}"
hosted_observability_provisioning="${GRAFANA_CLOUD_PROVISIONING_AUTH:-}"

if [[ -z "${hosted_observability_base// /}" ]]; then
  record_gate "hosted-observability-credential" "fail" \
    "no hosted observability endpoint in the environment — set GRAFANA_CLOUD_INSTANCE_URL (the hosted stack base URL) or CUTOVER_OBSERVABILITY_BASE_URL; an unobserved signal is not a healthy signal"
elif [[ -z "${hosted_observability_credential// /}" ]]; then
  record_gate "hosted-observability-credential" "fail" \
    "no hosted observability credential in the environment — set GRAFANA_CLOUD_READER_AUTH (the read-scoped service-account token, provisioned separately from the provisioning token) or CUTOVER_OBSERVABILITY_TOKEN; an unobserved signal is not a healthy signal"
elif [[ -n "${hosted_observability_provisioning// /}" && "${hosted_observability_credential}" == "${hosted_observability_provisioning}" ]]; then
  record_gate "hosted-observability-credential" "fail" \
    "the hosted-observability credential is the provisioning token — the window must be observed with the read-scoped token; the provisioning credential can write dashboards and delete alert rules and must not stand in for it"
else
  record_gate "hosted-observability-credential" "pass" \
    "hosted observability read credential present and distinct from the provisioning token"
fi

# ---------------------------------------------------------------------------
# Gate: the services are healthy on both origins
# ---------------------------------------------------------------------------
#
# The probes are the only component that talks to the services. They run
# here in health-only mode: no synthetic write, no side effect, just the
# question "is this origin serving?".
if [[ -f "$CUTOVER_PROBES" ]]; then
  for origin_binding in production prodlike; do
    probe_output="$(node "$CUTOVER_PROBES" --manifest "$MANIFEST" --binding "$origin_binding" --health-only 2>&1 || true)"
    if [[ "$(printf '%s' "$probe_output" | node -e "let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(raw).verdict)}catch{process.stdout.write('UNPARSEABLE')}});")" == "PASS" ]]; then
      record_gate "health:${origin_binding}" "pass" "probes report $origin_binding healthy"
    else
      record_gate "health:${origin_binding}" "fail" "probes do not report $origin_binding healthy"
    fi
  done
else
  record_gate "health" "fail" "probe suite not found at $CUTOVER_PROBES"
fi

# ---------------------------------------------------------------------------
# The result document
# ---------------------------------------------------------------------------

RUN_ID="$(cutover_run_id)"
RESULT="$(node --input-type=module -e "
  const [gates, runId, manifestHash, environment, plan] = process.argv.slice(1);
  const parsedGates = JSON.parse(gates);
  const failures = parsedGates.filter((gate) => gate.status === 'fail');
  const result = {
    version: 1,
    kind: 'preflight-result',
    runId,
    manifestHash,
    environment,
    mode: plan === '1' ? 'plan' : 'execution',
    gates: parsedGates,
    failureCount: failures.length,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    at: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(result, null, 2));
" "$GATES_JSON" "$RUN_ID" "$MANIFEST_HASH" "$CUTOVER_ENVIRONMENT" "$PLAN")"

if [[ "$PLAN" -eq 1 ]]; then
  printf '%s\n' "$RESULT"
  cutover_info "plan report produced: $GATE_FAILURES gate(s) outstanding"
  exit 0
fi

if [[ "$GATE_FAILURES" -gt 0 ]]; then
  printf '%s\n' "$RESULT" >&2
  cutover_fail "preflight failed: $GATE_FAILURES gate(s) outstanding — the cutover does not start" 1
fi

EVIDENCE_PATH="$(cutover_write_evidence "$RUN_ID" "preflight-result.json" "$RESULT")"
DIGEST="$(cutover_digest "$EVIDENCE_PATH")"
cutover_info "preflight PASS — evidence: $EVIDENCE_PATH (sha256 $DIGEST)"
cutover_write_state "preflight" "$MANIFEST_HASH" "$(cutover_route_version)"
printf '%s\n' "$RESULT"
