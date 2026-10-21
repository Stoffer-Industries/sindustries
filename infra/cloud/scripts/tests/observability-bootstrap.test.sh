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

# 5d. sh-format runbook references the full Grafana provisioning auth var
#     name. Quinn's review of PR #756 (2026-10-05T09:51:03Z) flagged that
#     the bootstrap contract test covered JSON enumeration but not the sh
#     runbook var refs, which would let a truncated ${GRAF…AUTH}
#     (Unicode ellipsis) slip through into the emitted runbook and 401 on
#     live creds. Lock the contract so future commits cannot reintroduce
#     the truncated form.
sh_out="$(bash "${EVID}" --dry-run --format sh 2>&1)"
if printf '%s\n' "${sh_out}" | grep -qF '${GRAFANA_CLOUD_PROVISIONING_AUTH}'; then
  ok "evidence --dry-run --format sh references full \${GRAFANA_CLOUD_PROVISIONING_AUTH}"
else
  fail "evidence --dry-run --format sh missing full \${GRAFANA_CLOUD_PROVISIONING_AUTH}"
fi
if printf '%s\n' "${sh_out}" | grep -qF $'GRAF\xe2\x80\xa6AUTH'; then
  fail "evidence --dry-run --format sh contains truncated \${GRAF…AUTH} form"
else
  ok "evidence --dry-run --format sh free of truncated \${GRAF…AUTH} form"
fi

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
  GRAFANA_CLOUD_INSTANCE_URL
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

# 10. Grafana HTTP payloads match the API contract. The checked-in alert
# files intentionally remain in portable file-provisioning format; bootstrap
# must translate them into per-rule HTTP payloads at runtime.
mkdir -p "${TMP_DIR}/bin"
FAKE_CURL_LOG="${TMP_DIR}/curl.log"
export FAKE_CURL_LOG
cat > "${TMP_DIR}/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
set -euo pipefail
method=GET
data=''
output=''
write_out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H|--header) shift 2 ;;
    --data-binary)
      data="$2"
      if [ "${data}" = '@-' ]; then data="$(cat)"; fi
      shift 2
      ;;
    -o|--output) output="$2"; shift 2 ;;
    -w|--write-out) write_out="$2"; shift 2 ;;
    --fail|--silent|--show-error) shift ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\t%s\t%s\n' "${method}" "${url}" "${data}" >> "${FAKE_CURL_LOG}"
status=200
body='{}'
case "${url}" in
  */api/datasources)
    body='[{"type":"prometheus","uid":"grafanacloud-prom","isDefault":true}]'
    ;;
  */api/folders/*)
    status=404
    ;;
  */api/v1/provisioning/alert-rules/*)
    if [ "${FAKE_ALERT_EXISTS:-false}" = true ]; then status=200; else status=404; fi
    ;;
  */api/v1/provisioning/alert-rules)
    status=201
    ;;
esac
if [ -n "${output}" ]; then
  printf '%s' "${body}" > "${output}"
else
  printf '%s' "${body}"
fi
if [ -n "${write_out}" ]; then printf '%s' "${status}"; fi
FAKECURL
chmod +x "${TMP_DIR}/bin/curl"

cat > "${OBS}/.env.local" <<'TESTENV'
FLY_API_TOKEN=test
FLY_ORG=personal
GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp.example/v1/
GRAFANA_CLOUD_OTLP_HEADERS="Authorization=Basic test"
GRAFANA_CLOUD_PROVISIONING_AUTH="Bearer test"
GRAFANA_CLOUD_INSTANCE_URL=https://grafana.example
HEALTH_PROBE_DATABASES=test=postgres://test
HEALTH_PROBE_FLY_APPS=test=https://example.test/health
HEALTH_PROBE_REDIS=test=rediss://example.test
TESTENV

: > "${FAKE_CURL_LOG}"
PATH="${TMP_DIR}/bin:${PATH}" bash "${BOOT}" dashboards >/dev/null
dashboard_payload="$(awk -F '\t' '$2 ~ /\/api\/dashboards\/db$/ {print $3; exit}' "${FAKE_CURL_LOG}")"
if jq -e '.overwrite == true and (.dashboard.uid | length > 0)' <<<"${dashboard_payload}" >/dev/null \
    && grep -q 'grafanacloud-prom' <<<"${dashboard_payload}"; then
  ok "dashboard upload wraps the model and resolves the Prometheus datasource UID"
else
  fail "dashboard upload payload does not match Grafana API contract"
fi

: > "${FAKE_CURL_LOG}"
PATH="${TMP_DIR}/bin:${PATH}" bash "${BOOT}" alerts >/dev/null
alert_payload="$(awk -F '\t' '$1 == "POST" && $2 ~ /\/api\/v1\/provisioning\/alert-rules$/ {print $3; exit}' "${FAKE_CURL_LOG}")"
if jq -e '
  .uid and .folderUID and .ruleGroup and .orgID
  and ([.data[].datasourceUid] | index("grafanacloud-prom") != null)
  and (has("groups") | not)
' <<<"${alert_payload}" >/dev/null; then
  ok "alert upload translates file provisioning JSON into a per-rule API payload"
else
  fail "alert upload payload does not match Grafana per-rule API contract"
fi

: > "${FAKE_CURL_LOG}"
FAKE_ALERT_EXISTS=true PATH="${TMP_DIR}/bin:${PATH}" bash "${BOOT}" alerts >/dev/null
if awk -F '\t' '$1 == "PUT" && $2 ~ /\/api\/v1\/provisioning\/alert-rules\/sindustries-/ {found=1} END {exit !found}' "${FAKE_CURL_LOG}"; then
  ok "alert upload updates existing rules by UID"
else
  fail "alert upload did not PUT existing rules by UID"
fi

# 11. Endpoint-resolving validate (task f3909b89). `validate` must not only
#     report that the vars are populated — it must resolve the endpoints they
#     point at, classify what it sees, name the var to fix, and keep secret
#     values out of its own output.
mkdir -p "${TMP_DIR}/probe-bin"
cat > "${TMP_DIR}/probe-bin/curl" <<'PROBECURL'
#!/usr/bin/env bash
# Scripted reachability-probe stub.
#   PROBE_STATUS_MAP   "|host/path=code|host/path=code", first match wins.
#   PROBE_DEFAULT      code when nothing matches (default 200).
#   PROBE_EXIT_URL     substring whose probe exits non-zero (DNS failure).
#   PROBE_HEADER_MAP   "|host/path=header1\nheader2|...", emitted when the
#                      caller asks for headers (--dump-header). Entries are
#                      printf-escaped so \n in the map becomes a real newline.
# Deliberately does not implement --fail or --output: probes must not use
# them, and honouring --fail here would mask a regression that reintroduces it.
url=''
prev=''
dump_headers=0
for arg in "$@"; do
  case "${prev}" in
    -o|--output|-w|--write-out|--max-time|--connect-timeout|-H|--header)
      prev="${arg}"
      continue
      ;;
  esac
  case "${arg}" in
    http*) url="${arg}" ;;
    -D|--dump-header) dump_headers=1 ;;
  esac
  prev="${arg}"
done
if [ -n "${PROBE_EXIT_URL:-}" ]; then
  case "${url}" in
    *"${PROBE_EXIT_URL}"*) exit 7 ;;
  esac
fi
code="${PROBE_DEFAULT:-200}"
headers='content-type: text/plain'
if [ -n "${PROBE_STATUS_MAP:-}" ]; then
  IFS='|' read -r -a entries <<< "${PROBE_STATUS_MAP}"
  for entry in "${entries[@]}"; do
    [ -n "${entry}" ] || continue
    case "${url}" in
      *"${entry%%=*}"*)
        code="${entry##*=}"
        break
        ;;
    esac
  done
fi
if [ -n "${PROBE_HEADER_MAP:-}" ]; then
  IFS='|' read -r -a hentries <<< "${PROBE_HEADER_MAP}"
  for hentry in "${hentries[@]}"; do
    [ -n "${hentry}" ] || continue
    case "${url}" in
      *"${hentry%%=*}"*)
        headers="$(printf '%b' "${hentry#*=}")"
        break
        ;;
    esac
  done
fi
if [ "${dump_headers}" -eq 1 ]; then
  printf '%s\n' "${headers}"
fi
printf '%s' "${code}"
PROBECURL
chmod +x "${TMP_DIR}/probe-bin/curl"

PROBE_SENTINEL_HEADERS='Authorization=Basic c2VjcmV0LW9ubHktaW4tdGhpcy1lc2NhcGUtc2VudGluZWw='
PROBE_SENTINEL_AUTH='Bearer probe-hygiene-sentinel-value'
write_probe_env() {
  cat > "${OBS}/.env.local" <<PROBEENV
FLY_API_TOKEN=probe-token-sentinel
FLY_ORG=personal
GRAFANA_CLOUD_OTLP_ENDPOINT=${PROBE_OTLP:-https://otlp.example}
GRAFANA_CLOUD_OTLP_HEADERS="${PROBE_SENTINEL_HEADERS}"
GRAFANA_CLOUD_PROVISIONING_AUTH="${PROBE_SENTINEL_AUTH}"
GRAFANA_CLOUD_INSTANCE_URL=https://grafana.example
HEALTH_PROBE_DATABASES=x=postgres://x
HEALTH_PROBE_FLY_APPS=x=https://x/health
HEALTH_PROBE_REDIS=x=rediss://x
PROBEENV
  if [ -n "${PROBE_LOKI:-}" ]; then
    printf 'GRAFANA_CLOUD_LOKI_ENDPOINT=%s\n' "${PROBE_LOKI}" >> "${OBS}/.env.local"
  fi
  if [ -n "${PROBE_RELAY:-}" ]; then
    printf 'GYMTRACK_RELAY_BASE_URL=%s\n' "${PROBE_RELAY}" >> "${OBS}/.env.local"
  fi
}
run_validate() {
  set +e
  VALIDATE_OUT="$(PATH="${TMP_DIR}/probe-bin:${PATH}" bash "${BOOT}" validate 2>&1)"
  VALIDATE_CODE=$?
  set -e
}

# 11a. 404 on an endpoint: validate fails AND names the var to fix.
PROBE_LOKI='https://logs.example/loki/api/v1/push'
write_probe_env
PROBE_STATUS_MAP='|logs.example/loki/api/v1/push=404' PROBE_DEFAULT=200 \
  run_validate
if [ "${VALIDATE_CODE}" -ge 1 ]; then
  ok "validate fails when an endpoint returns 404 (exit=${VALIDATE_CODE})"
else
  fail "validate exited 0 despite a 404 endpoint"
fi
if printf '%s\n' "${VALIDATE_OUT}" | grep -q 'path-absent'; then
  ok "404 is classified as path-absent"
else
  fail "404 not classified as path-absent: ${VALIDATE_OUT}"
fi
if printf '%s\n' "${VALIDATE_OUT}" | grep -q 'GRAFANA_CLOUD_LOKI_ENDPOINT'; then
  ok "404 message names GRAFANA_CLOUD_LOKI_ENDPOINT"
else
  fail "404 message does not name the var to fix"
fi

# 11b. 401 is a correctly-configured endpoint: passes, and is reported as
#      auth-required rather than conflated with path-absent.
write_probe_env
PROBE_STATUS_MAP='|grafana.example/api/health=401|otlp.example=401|api.fly.io=401' \
  run_validate
if [ "${VALIDATE_CODE}" -eq 0 ]; then
  ok "401 on every endpoint exits 0 (unauthenticated probe, path exists)"
else
  fail "401 should not fail validate (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi
if printf '%s\n' "${VALIDATE_OUT}" | grep -q 'auth-required'; then
  ok "401 reported as auth-required"
else
  fail "401 not reported as auth-required: ${VALIDATE_OUT}"
fi
if printf '%s\n' "${VALIDATE_OUT}" | grep -q 'path-absent'; then
  fail "401 was conflated with path-absent"
else
  ok "401 not conflated with path-absent"
fi

# 11c. 200 everywhere: ok, exit 0.
write_probe_env
PROBE_STATUS_MAP='|grafana.example/api/health=200|otlp.example=200|logs.example=200|api.fly.io=200' \
  run_validate
if [ "${VALIDATE_CODE}" -eq 0 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'ok  '; then
  ok "healthy 200 endpoints exit 0 and report ok"
else
  fail "200 endpoints did not exit 0 as ok (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11d. 405 on the POST-only Loki push path is proof the path exists, so it
#      must pass. A naive 2xx-only check reports a healthy tenant as broken.
write_probe_env
PROBE_STATUS_MAP='|logs.example/loki/api/v1/push=405|otlp.example=401|api.fly.io=401' \
  run_validate
if [ "${VALIDATE_CODE}" -eq 0 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'method-not-allowed'; then
  ok "405 on the Loki push path exits 0 as method-not-allowed"
else
  fail "405 mis-classified (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11e. 530 gateway origin failure fails pre-flight.
write_probe_env
PROBE_STATUS_MAP='|grafana.example/api/health=530' run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'gateway-origin-failure'; then
  ok "530 exits non-zero as gateway-origin-failure"
else
  fail "530 did not fail validate (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11f. curl exiting non-zero is 000 (unreachable), not a silent pass.
write_probe_env
PROBE_EXIT_URL='api.fly.io' run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'unreachable.*000'; then
  ok "unreachable host reports 000 and fails pre-flight"
else
  fail "unreachable host not caught (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11g. A bare-host OTLP base with no Loki override is the exact production
#      tenant shape: the relay cannot derive a push URL and answers 502
#      misconfigured_loki_endpoint. validate must fail on it by name.
PROBE_LOKI=''
write_probe_env
run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] \
    && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'not-derivable' \
    && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'GRAFANA_CLOUD_LOKI_ENDPOINT'; then
  ok "non-derivable Loki push URL fails and names GRAFANA_CLOUD_LOKI_ENDPOINT"
else
  fail "non-derivable Loki push URL not caught (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11h. Presence behaviour is unchanged: a missing var still returns the
#      clamped missing count, and no probe fires (nothing is configured).
rm -f "${OBS}/.env.local"
set +e
presence_out="$(PATH="${TMP_DIR}/probe-bin:${PATH}" bash "${BOOT}" validate 2>&1)"
presence_code=$?
set -e
if [ "${presence_code}" -ge 1 ] && [ "${presence_code}" -le 125 ]; then
  ok "missing vars still exit with the clamped missing count (${presence_code})"
else
  fail "presence exit code changed: ${presence_code}"
fi
if printf '%s\n' "${presence_out}" | grep -q 'required var(s) missing'; then
  ok "presence failure message unchanged"
else
  fail "presence failure message changed"
fi
if printf '%s\n' "${presence_out}" | grep -q 'endpoint probes skipped'; then
  ok "probes skipped while required vars are missing"
else
  fail "probes ran despite missing required vars"
fi

# 11i. Secret hygiene: no credential value may appear anywhere in output.
PROBE_LOKI='https://logs.example/loki/api/v1/push'
write_probe_env
PROBE_STATUS_MAP='|logs.example/loki/api/v1/push=404' run_validate
leaked=0
for sentinel in "${PROBE_SENTINEL_HEADERS}" "${PROBE_SENTINEL_AUTH}" \
                'probe-token-sentinel' 'c2VjcmV0LW9ubHktaW4tdGhpcy1lc2NhcGUtc2VudGluZWw='; do
  if printf '%s\n' "${VALIDATE_OUT}" | grep -qF "${sentinel}"; then
    fail "validate output leaked a credential value"
    leaked=1
  fi
done
[ "${leaked}" -eq 0 ] && ok "validate output contains no credential values (incl. error paths)"

# 11j. PROBE_SKIP_NETWORK=1 keeps validate usable with no egress.
PROBE_SKIP_NETWORK=1 run_validate
if [ "${VALIDATE_CODE}" -eq 0 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'PROBE_SKIP_NETWORK'; then
  ok "PROBE_SKIP_NETWORK=1 skips probes and exits 0"
else
  fail "PROBE_SKIP_NETWORK=1 not honoured (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11k. Doc parity (AC6): the generated block must match, byte for byte, the
#      copy committed to .env.example and docs/systems/observability.md. A
#      var added to endpoint_specs without a docs update fails here.
set +e
dry_out="$(PATH="${TMP_DIR}/probe-bin:${PATH}" bash "${BOOT}" validate --dry-run 2>&1)"
set -e
sed -n '/BEGIN generated: bootstrap-observability endpoint table/,/END generated: bootstrap-observability endpoint table/p' \
  <<<"${dry_out}" > "${TMP_DIR}/endpoint-block.md"
if [ -s "${TMP_DIR}/endpoint-block.md" ]; then
  ok "validate --dry-run renders the generated endpoint table"
else
  fail "validate --dry-run did not render the endpoint table"
fi
parity="$(python3 - "${TMP_DIR}/endpoint-block.md" "${OBS}/env/.env.example" \
  "${REPO_ROOT}/docs/systems/observability.md" <<'PYEOF'
import sys
block = open(sys.argv[1]).read().strip()
missing = [f for f in sys.argv[2:] if block not in open(f).read()]
print('OK' if not missing else 'DRIFT: ' + ', '.join(missing))
PYEOF
)"
if [ "${parity}" = "OK" ]; then
  ok "generated endpoint table matches .env.example and docs/systems/observability.md"
else
  fail "endpoint table drifted from the docs (${parity})"
fi
for endpoint_id in grafana_instance otlp_endpoint loki_push gymtrack_relay fly_api; do
  if printf '%s\n' "${VALIDATE_OUT}" | grep -q "${endpoint_id}" \
      || printf '%s\n' "${dry_out}" | grep -q "\`${endpoint_id}\`"; then
    ok "endpoint ${endpoint_id} is documented and probed"
  else
    fail "endpoint ${endpoint_id} missing from probe plan or docs"
  fi
done

# 11l. GymTrack telemetry relay (task 8bb78c2d). The relay's verdict cannot
#      come from the status code: the SPA catch-all serves index.html with a
#      200 for a path with no function behind it, and an unrouted route
#      answers 405 on a POST just like a real POST-only function does.
PROBE_LOKI='https://logs.example/loki/api/v1/push'

# 11l-1. Deployed relay: JSON content-type + allow: header -> routed, passes.
PROBE_RELAY='https://gymtrack.example'
write_probe_env
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=405' \
  PROBE_HEADER_MAP='|gymtrack.example/api/telemetry=HTTP/1.1 405 Method Not Allowed\r\ncontent-type: application/json\r\nallow: POST\r\n\r\n{"error":"method_not_allowed"}' \
  run_validate
if [ "${VALIDATE_CODE}" -eq 0 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'gymtrack_relay.*routed'; then
  ok "a routed /api/telemetry (JSON + allow:) is classified routed and passes"
else
  fail "routed relay not detected (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11l-2. SPA catch-all: content-disposition index.html -> FAIL. This is the
#      case a status-code rule gets wrong, because the response is 200.
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=200' \
  PROBE_HEADER_MAP='|gymtrack.example/api/telemetry=HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-disposition: inline; filename="index.html"\r\n\r\n<!doctype html>' \
  run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'gymtrack_relay.*spa-catch-all'; then
  ok "an SPA-catch-all /api/telemetry is classified spa-catch-all and fails"
else
  fail "SPA catch-all not caught (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11l-3. Unrouted 405: the counter-example that decides the rule. A 405 is a
#      passing class everywhere else in the table, so if this passes, the
#      check is being made on status code rather than response shape.
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=405' \
  PROBE_HEADER_MAP='|gymtrack.example/api/telemetry=HTTP/1.1 405 Method Not Allowed\r\ncontent-disposition: inline; filename="index.html"\r\n\r\n' \
  run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'gymtrack_relay.*spa-catch-all'; then
  ok "an unrouted 405 is NOT treated as OK on the relay row"
else
  fail "unrouted 405 wrongly passed (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11l-4. A 405 with neither JSON nor allow: is not-a-function, so it fails
#      even when the catch-all's content-disposition is absent.
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=405' \
  PROBE_HEADER_MAP='|gymtrack.example/api/telemetry=HTTP/1.1 405 Method Not Allowed\r\ncontent-type: text/plain\r\n\r\n' \
  run_validate
if [ "${VALIDATE_CODE}" -ge 1 ] && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'gymtrack_relay.*not-a-function'; then
  ok "a 405 without JSON/allow: is not-a-function and fails"
else
  fail "405 without the JSON/allow signature wrongly passed (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11l-5. Unconfigured relay: SKIP, not FAIL — consistent with the existing
#      optional-endpoint handling for Loki.
PROBE_RELAY=''
write_probe_env
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=405' run_validate
if [ "${VALIDATE_CODE}" -eq 0 ] \
    && printf '%s\n' "${VALIDATE_OUT}" | grep -q 'SKIP.*gymtrack_relay'; then
  ok "an unconfigured GYMTRACK_RELAY_BASE_URL is SKIP, not FAIL"
else
  fail "unconfigured relay not skipped (exit=${VALIDATE_CODE}): ${VALIDATE_OUT}"
fi

# 11l-6. The probe output names the relay and its verdict is identifiable.
if printf '%s\n' "${VALIDATE_OUT}" | grep -qE '\[(OK|FAIL|SKIP)\][[:space:]]+gymtrack_relay'; then
  ok "relay probe line names gymtrack_relay with a verdict"
else
  fail "relay probe line does not name gymtrack_relay: ${VALIDATE_OUT}"
fi

# 11l-7. Secret hygiene still holds on the header-aware path: the relay
#      probe must not echo response headers into operator scrollback.
PROBE_RELAY='https://gymtrack.example'
write_probe_env
PROBE_STATUS_MAP='|gymtrack.example/api/telemetry=200' \
  PROBE_HEADER_MAP='|gymtrack.example/api/telemetry=HTTP/1.1 200 OK\r\nset-cookie: relay-header-sentinel\r\ncontent-disposition: inline; filename="index.html"\r\n\r\n' \
  run_validate
if printf '%s\n' "${VALIDATE_OUT}" | grep -qF 'relay-header-sentinel'; then
  fail "relay probe leaked a response header value into validate output"
else
  ok "relay probe output carries no response header values"
fi

rm -f "${OBS}/.env.local"

restore_env_local

if [ "${#failures[@]}" -gt 0 ]; then
  printf '\n%s failure(s)\n' "${#failures[@]}" >&2
  exit 1
fi

printf '\nobservability-bootstrap: ok\n'
