#!/usr/bin/env bash
# Static + behavioural contract for the bootstrap / evidence / failure-inject
# tooling shipped under task 31233a0a (hosted observability runtime evidence).
#
# What this test asserts:
#   1. All three scripts pass `bash -n`.
#   2. `bootstrap-observability.sh --help` lists every subcommand and flag.
#   3. `bootstrap-observability.sh validate` reports the missing var count
#      and exits with that count when .env.local is absent.
#   4. Every `bootstrap-observability.sh <subcommand> --dry-run` produces
#      output WITHOUT requiring .env.local to exist.
#   5. `evidence-capture.sh --dry-run --format md|sh|json` produces output
#      whose JSON validates (5 dashboards + 10 alerts).
#   6. `failure-inject.sh --help` lists every scenario.
#   7. Every `failure-inject.sh <scenario> --dry-run` exits 0 without
#      requiring .env.local.
#
# This is an offline test — no Fly or Grafana access required.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
OBS="${REPO_ROOT}/infra/cloud/observability"
BOOT="${OBS}/bootstrap-observability.sh"
EVID="${OBS}/evidence-capture.sh"
INJ="${OBS}/failure-inject.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

failures=()
fail() { failures+=("$1"); printf 'FAIL: %s\n' "$1" >&2; }
ok()   { printf 'ok: %s\n' "$1"; }

# 1. bash -n
for script in "${BOOT}" "${EVID}" "${INJ}"; do
  if bash -n "${script}" >/dev/null 2>&1; then
    ok "bash -n $(basename "${script}")"
  else
    fail "bash -n failed for ${script}"
  fi
done

# 2. bootstrap-observability.sh --help
help_out="$(bash "${BOOT}" --help 2>&1)"
for needle in validate secrets dashboards alerts deploy smoke evidence all --dry-run; do
  if printf '%s\n' "${help_out}" | grep -q -E "(^| )${needle}( |$)"; then
    ok "bootstrap --help lists ${needle}"
  else
    fail "bootstrap --help missing: ${needle}"
  fi
done

# 3. bootstrap-observability.sh validate with no .env.local
ensure_no_env_local() {
  if [ -e "${OBS}/.env.local" ]; then
    mv "${OBS}/.env.local" "${TMP_DIR}/.env.local.bak"
  fi
}
restore_env_local() {
  if [ -e "${TMP_DIR}/.env.local.bak" ]; then
    mv "${TMP_DIR}/.env.local.bak" "${OBS}/.env.local"
  fi
}
trap 'restore_env_local; rm -rf "${TMP_DIR}"' EXIT

ensure_no_env_local

set +e
validate_out="$(bash "${BOOT}" validate 2>&1)"
validate_code=$?
set -e
if [ "${validate_code}" -ge 1 ] && [ "${validate_code}" -le 125 ]; then
  ok "validate exits with missing-var count (got ${validate_code})"
else
  fail "validate exit code unexpected: ${validate_code}"
fi
if printf '%s\n' "${validate_out}" | grep -q "required var(s) missing"; then
  ok "validate reports missing vars"
else
  fail "validate did not report missing vars"
fi

# 4. Every subcommand --dry-run produces output without env
for sub in validate secrets dashboards alerts deploy smoke; do
  set +e
  out="$(bash "${BOOT}" "${sub}" --dry-run 2>&1)"
  code=$?
  set -e
  if [ -z "${out}" ]; then
    fail "${sub} --dry-run produced empty output"
    continue
  fi
  ok "${sub} --dry-run produced output (exit=${code})"
done

# 5. evidence-capture.sh --dry-run formats
for fmt in md sh json; do
  out="$(bash "${EVID}" --dry-run --format "${fmt}" 2>&1)"
  if [ -z "${out}" ]; then
    fail "evidence --dry-run --format ${fmt} produced empty output"
    continue
  fi
  ok "evidence --dry-run --format ${fmt} produced output"
done

# 5b. JSON output validates
json_out="$(bash "${EVID}" --dry-run --format json 2>&1)"
printf '%s' "${json_out}" > "${TMP_DIR}/evidence.json"
json_python_check="$(python3 - "${TMP_DIR}/evidence.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
n_dash = len(data.get('dashboards', []))
n_alerts = len(data.get('alerts', []))
print('OK' if (n_dash == 5 and n_alerts == 10) else 'FAIL n_dash={} n_alerts={}'.format(n_dash, n_alerts))
PYEOF
)"
if [ "${json_python_check}" = "OK" ]; then
  ok "evidence --dry-run --format json validates (5 dashboards, 10 alerts)"
else
  fail "evidence JSON did not validate: ${json_python_check}"
fi

# 5c. md output references every alert uid
md_out="$(bash "${EVID}" --dry-run --format md 2>&1)"
expected_alerts=(
  sindustries-tasks-api-down
  sindustries-budget-api-down
  sindustries-tasks-api-5xx-spike
  sindustries-budget-api-4xx-spike
  sindustries-tasks-api-db-down
  sindustries-budget-api-db-down
  sindustries-db-query-slow
  sindustries-redis-down
  sindustries-worker-queue-stuck
  sindustries-deploy-failed
)
for uid in "${expected_alerts[@]}"; do
  if printf '%s\n' "${md_out}" | grep -q "${uid}"; then
    ok "evidence md mentions ${uid}"
  else
    fail "evidence md missing ${uid}"
  fi
done

# 6. failure-inject.sh --help
inj_help="$(bash "${INJ}" --help 2>&1)"
for needle in redis-down redis-up tasks-api-down tasks-api-up budget-api-down budget-api-up db-down db-up deploy-failed deploy-restored --dry-run; do
  if printf '%s\n' "${inj_help}" | grep -q -E "(^| )${needle}( |$)"; then
    ok "failure-inject --help lists ${needle}"
  else
    fail "failure-inject --help missing: ${needle}"
  fi
done

# 7. every scenario --dry-run exits 0 without env
for scenario in redis-down redis-up tasks-api-down tasks-api-up budget-api-down budget-api-up db-down db-up deploy-failed deploy-restored; do
  set +e
  out="$(bash "${INJ}" "${scenario}" --dry-run 2>&1)"
  code=$?
  set -e
  if [ "${code}" -eq 0 ]; then
    ok "failure-inject ${scenario} --dry-run exits 0"
  else
    fail "failure-inject ${scenario} --dry-run exited ${code}: ${out}"
  fi
done

# 8. Cross-reference: bootstrap-observability.sh validate reports each required var
expected_vars=(
  FLY_API_TOKEN
  FLY_ORG
  GRAFANA_CLOUD_OTLP_ENDPOINT
  GRAFANA_CLOUD_OTLP_HEADERS
  GRAFANA_CLOUD_PROVISIONING_AUTH
  GRAFANA_CLOUD_PROMETHEUS_URL
  GRAFANA_CLOUD_TEMPO_URL
  HEALTH_PROBE_DATABASES
  HEALTH_PROBE_FLY_APPS
  HEALTH_PROBE_REDIS
)
for var in "${expected_vars[@]}"; do
  if printf '%s\n' "${validate_out}" | grep -q "${var}"; then
    ok "validate reports ${var}"
  else
    fail "validate did not report ${var}"
  fi
done

# 9. Bootstrap subcommand dispatch is wired through step_evidence helper
if grep -q 'step_evidence' "${BOOT}"; then
  ok "bootstrap-observability.sh wires step_evidence"
else
  fail "bootstrap-observability.sh missing step_evidence wiring"
fi

restore_env_local

if [ "${#failures[@]}" -gt 0 ]; then
  printf '\n%s failure(s)\n' "${#failures[@]}" >&2
  exit 1
fi

printf '\nobservability-bootstrap: ok\n'
