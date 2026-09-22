#!/usr/bin/env bash
#
# bootstrap-observability.sh — idempotent provisioning of the hosted
# observability stack (Grafana Cloud + Fly.io health-probe).
#
# Quinn-owned secrets live in infra/cloud/observability/.env.local
# (NEVER commit). This script reads them with `set -a; source`, sets
# them as Fly secrets on the health-probe app, and uses the Grafana
# Cloud provisioning API to upload dashboards + alert rules.
#
# Re-running is safe: existing alerts are updated in place (not
# duplicated), dashboards are replaced via the Grafana dashboard
# import API, and Fly secrets are set idempotently.
#
# USAGE
#   bootstrap-observability.sh [<subcommand>] [--dry-run] [-h|--help]
#
# SUBCOMMANDS
#   validate    Pre-flight check: source .env.local, list required vars,
#               report which are missing. Exits with the missing count.
#               Does NOT require Fly or Grafana access. Safe to run as
#               Tom hands over each secret.
#   secrets     Set Fly secrets from .env.local on the health-probe app.
#   dashboards  Upload dashboard JSONs to the hosted Grafana.
#   alerts      Upload alert rule JSONs to the hosted Grafana.
#   deploy      Run the Fly canary deploy for the health-probe app.
#   smoke       Run the /healthz smoke check against the deployed app.
#   evidence    Run evidence-capture.sh to print the dashboard URLs,
#               alert state queries, and closing-PR markdown template.
#   all         validate + secrets + dashboards + alerts + deploy +
#               smoke + evidence. DEFAULT when no subcommand is given.
#
# FLAGS
#   --dry-run   Print actions without applying. Works with every
#               subcommand. Does not require Fly or Grafana auth — use
#               this to preview a step before running it for real.
#   -h/--help   Show this header.
#
# Quinn-approved answers from docs/specs/hosted-observability-migration-alerts-tech-design.md
# §"Bootstrap script":
#   - Idempotent (re-running does not destroy existing alerts).
#   - Verifies fly, curl, and the Grafana Cloud API key are available.
#   - Creates the health-probe Fly app if missing.
#   - Sets Fly secrets from Quinn's local .env.local.
#   - Uploads dashboard JSONs via the Grafana provisioning API.
#   - Creates the alert rules via the Grafana provisioning API.
#   - Performs a smoke deploy (fly deploy --strategy canary).
#   - Surfaces a final report (Grafana URL, dashboard URLs, smoke-check result).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLY_CONFIG="${REPO_ROOT}/infra/cloud/observability/health-probe/fly.toml"
FLY_APP="$(grep '^app = ' "${FLY_CONFIG}" | sed -E "s/^app = '([^']+)'/\1/")"
DASHBOARD_DIR="${SCRIPT_DIR}/grafana/dashboards"
ALERT_DIR="${SCRIPT_DIR}/grafana/alerts"
ENV_LOCAL="${SCRIPT_DIR}/.env.local"
EVIDENCE_CAPTURE="${SCRIPT_DIR}/evidence-capture.sh"

DRY_RUN=false
SUBCOMMAND="all"

print_help() {
  cat <<'HELP'
bootstrap-observability.sh — idempotent provisioning of the hosted
observability stack (Grafana Cloud + Fly.io health-probe).

Quinn-owned secrets live in infra/cloud/observability/.env.local
(NEVER commit). This script reads them with `set -a; source`, sets
them as Fly secrets on the health-probe app, and uses the Grafana
Cloud provisioning API to upload dashboards + alert rules.

Re-running is safe: existing alerts are updated in place (not
duplicated), dashboards are replaced via the Grafana dashboard
import API, and Fly secrets are set idempotently.

USAGE
  bootstrap-observability.sh [<subcommand>] [--dry-run] [-h|--help]

SUBCOMMANDS
  validate    Pre-flight check: source .env.local, list required vars,
              report which are missing. Exits with the missing count.
              Does NOT require Fly or Grafana access. Safe to run as
              Tom hands over each secret.
  app         Create the Fly app (sindustries-health-probe-staging)
              if it doesn't already exist. Idempotent.
  secrets     Set Fly secrets from .env.local on the health-probe app.
  dashboards  Upload dashboard JSONs to the hosted Grafana.
  alerts      Upload alert rule JSONs to the hosted Grafana.
  deploy      Run the Fly canary deploy for the health-probe app.
  smoke       Run the /healthz smoke check against the deployed app.
  evidence    Run evidence-capture.sh to print the dashboard URLs,
              alert state queries, and closing-PR markdown template.
  all         validate + app + secrets + dashboards + alerts +
              deploy + smoke + evidence. DEFAULT when no
              subcommand is given.

FLAGS
  --dry-run   Print actions without applying. Works with every
              subcommand. Does not require Fly or Grafana auth — use
              this to preview a step before running it for real.
  -h/--help   Show this header.
HELP
}

while [ "${#}" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    validate|app|secrets|dashboards|alerts|deploy|smoke|evidence|all)
      SUBCOMMAND="$1"
      shift
      ;;
    *)
      echo "::error::unknown argument: $1" >&2
      print_help
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "::error::required command not found: ${cmd}" >&2
    exit 1
  fi
}

require_env_var() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "${value}" ]; then
    echo "::error::required env var not set: ${name}" >&2
    exit 1
  fi
}

# Required vars — must be present in .env.local for any non-validate step.
REQUIRED_VARS=(
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

source_env_local() {
  if [ ! -f "${ENV_LOCAL}" ]; then
    echo "::error::Quinn-owned secret file not found: ${ENV_LOCAL}" >&2
    echo "::error::Copy infra/cloud/observability/env/.env.example to ${ENV_LOCAL} and fill in the values." >&2
    return 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "${ENV_LOCAL}"
  set +a
}

step_validate() {
  echo "==> Validate: pre-flight"
  echo "    Fly app: ${FLY_APP}"
  echo "    Required vars (${#REQUIRED_VARS[@]}):"
  local missing=0
  local sourced=false
  # `source_env_local` returns 1 when .env.local is missing; capture the
  # exit without tripping `set -e` so the rest of the validation still runs.
  if source_env_local; then
    sourced=true
  else
    echo "    (env file not present; cannot check var values)"
  fi
  for var in "${REQUIRED_VARS[@]}"; do
    if [ "${sourced}" = true ] && [ -n "${!var:-}" ]; then
      printf '      [OK]   %s\n' "${var}"
    else
      printf '      [MISS] %s\n' "${var}"
      missing=$((missing + 1))
    fi
  done
  echo
  if [ "${missing}" -gt 0 ]; then
    echo "==> Validate: ${missing} required var(s) missing"
    # Clamp exit code to 125 so a single missing var stays scriptable;
    # the script wraps the rest of the call site anyway.
    if [ "${missing}" -gt 125 ]; then
      missing=125
    fi
    return "${missing}"
  fi
  echo "==> Validate: all required vars present"
  return 0
}

step_secrets() {
  echo "==> Secrets: Fly secrets on ${FLY_APP}"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] flyctl secrets set --config ${FLY_CONFIG} --app ${FLY_APP} \\"
    echo "                OTEL_EXPORTER_OTLP_ENDPOINT=<from \${GRAFANA_CLOUD_OTLP_ENDPOINT}> \\"
    echo "                OTEL_EXPORTER_OTLP_HEADERS=<from \${GRAFANA_CLOUD_OTLP_HEADERS}> \\"
    echo "                OTEL_RESOURCE_ATTRIBUTES=deployment.environment=staging \\"
    echo "                HEALTH_PROBE_DATABASES=<from \${HEALTH_PROBE_DATABASES}> \\"
    echo "                HEALTH_PROBE_FLY_APPS=<from \${HEALTH_PROBE_FLY_APPS}> \\"
    echo "                HEALTH_PROBE_REDIS=<from \${HEALTH_PROBE_REDIS}> \\"
    echo "                HEALTH_PROBE_TIMEOUT_MS=5000"
    return 0
  fi
  source_env_local
  require_env_var FLY_API_TOKEN
  require_env_var FLY_ORG
  export FLY_API_TOKEN
  flyctl secrets set \
    --config "${FLY_CONFIG}" \
    --app "${FLY_APP}" \
    OTEL_EXPORTER_OTLP_ENDPOINT="${GRAFANA_CLOUD_OTLP_ENDPOINT}" \
    OTEL_EXPORTER_OTLP_HEADERS="${GRAFANA_CLOUD_OTLP_HEADERS}" \
    OTEL_RESOURCE_ATTRIBUTES="${OTEL_RESOURCE_ATTRIBUTES:-deployment.environment=staging}" \
    HEALTH_PROBE_DATABASES="${HEALTH_PROBE_DATABASES}" \
    HEALTH_PROBE_FLY_APPS="${HEALTH_PROBE_FLY_APPS}" \
    HEALTH_PROBE_REDIS="${HEALTH_PROBE_REDIS}" \
    HEALTH_PROBE_TIMEOUT_MS="${HEALTH_PROBE_TIMEOUT_MS:-5000}"
}

step_dashboards() {
  echo "==> Dashboards: upload to hosted Grafana"
  if [ "${DRY_RUN}" = true ]; then
    for dashboard_file in "${DASHBOARD_DIR}"/*.json; do
      filename="$(basename "${dashboard_file}" .json)"
      echo "    [dry-run] POST \${GRAFANA_CLOUD_PROMETHEUS_URL}/api/dashboards/db  body=${dashboard_file}  (uid=${filename})"
    done
    return 0
  fi
  source_env_local
  require_env_var GRAFANA_CLOUD_PROVISIONING_AUTH
  require_env_var GRAFANA_CLOUD_PROMETHEUS_URL
  for dashboard_file in "${DASHBOARD_DIR}"/*.json; do
    filename="$(basename "${dashboard_file}" .json)"
    echo "    - ${filename}"
    curl --fail --silent --show-error \
      -H "Authorization: ${GRAFANA_CLOUD_PROVISIONING_AUTH}" \
      -H "Content-Type: application/json" \
      --data-binary "@${dashboard_file}" \
      "${GRAFANA_CLOUD_PROMETHEUS_URL%/}/api/dashboards/db"
  done
}

step_alerts() {
  echo "==> Alerts: upload to hosted Grafana"
  if [ "${DRY_RUN}" = true ]; then
    for alert_file in "${ALERT_DIR}"/*.json; do
      filename="$(basename "${alert_file}" .json)"
      echo "    [dry-run] PUT  \${GRAFANA_CLOUD_PROMETHEUS_URL}/api/v1/provisioning/alert-rules  body=${alert_file}  (uid=${filename})"
    done
    return 0
  fi
  source_env_local
  require_env_var GRAFANA_CLOUD_PROVISIONING_AUTH
  require_env_var GRAFANA_CLOUD_PROMETHEUS_URL
  for alert_file in "${ALERT_DIR}"/*.json; do
    filename="$(basename "${alert_file}" .json)"
    echo "    - ${filename}"
    curl --fail --silent --show-error \
      -X PUT \
      -H "Authorization: ${GRAFANA_CLOUD_PROVISIONING_AUTH}" \
      -H "Content-Type: application/json" \
      --data-binary "@${alert_file}" \
      "${GRAFANA_CLOUD_PROMETHEUS_URL%/}/api/v1/provisioning/alert-rules"
  done
}

step_deploy() {
  echo "==> Deploy: Fly canary for ${FLY_APP}"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] flyctl deploy --config ${FLY_CONFIG} --strategy canary --wait-timeout 600"
    return 0
  fi
  source_env_local
  require_env_var FLY_API_TOKEN
  export FLY_API_TOKEN
  flyctl deploy \
    --config "${FLY_CONFIG}" \
    --strategy canary \
    --wait-timeout 600
}

step_smoke() {
  echo "==> Smoke: /healthz"
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] curl -sS -o /dev/null -w '%{http_code}' https://${FLY_APP}.fly.dev/healthz"
    return 0
  fi
  SMOKE_URL="https://${FLY_APP}.fly.dev/healthz"
  SMOKE_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "${SMOKE_URL}")"
  if [ "${SMOKE_STATUS}" != "200" ]; then
    echo "::error::smoke check failed: GET ${SMOKE_URL} returned ${SMOKE_STATUS}" >&2
    exit 1
  fi
  echo "    GET ${SMOKE_URL} → ${SMOKE_STATUS}"
}

step_app() {
  echo "==> App: ensure ${FLY_APP} exists"
  source_env_local
  require_env_var FLY_API_TOKEN
  require_env_var FLY_ORG
  export FLY_API_TOKEN
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] if ! flyctl status --config ${FLY_CONFIG} --app ${FLY_APP}; then"
    echo "        flyctl apps create ${FLY_APP} --org ${FLY_ORG}"
    echo "    fi"
    return 0
  fi
  if ! flyctl status --config "${FLY_CONFIG}" --app "${FLY_APP}" >/dev/null 2>&1; then
    flyctl apps create "${FLY_APP}" --org "${FLY_ORG}"
  fi
}

step_evidence() {
  echo "==> Evidence: capture helper"
  if [ ! -x "${EVIDENCE_CAPTURE}" ]; then
    echo "::error::evidence helper not found or not executable: ${EVIDENCE_CAPTURE}" >&2
    exit 1
  fi
  local extra_args=()
  if [ "${DRY_RUN}" = true ]; then
    extra_args+=("--dry-run")
  fi
  "${EVIDENCE_CAPTURE}" "${extra_args[@]}" --format md
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${SUBCOMMAND}" in
  validate)  step_validate ;;
  app)       require_command fly; require_command jq; step_app ;;
  secrets)   require_command fly; require_command jq; step_secrets ;;
  dashboards) require_command curl; require_command jq; step_dashboards ;;
  alerts)    require_command curl; require_command jq; step_alerts ;;
  deploy)    require_command fly; step_deploy ;;
  smoke)     require_command curl; step_smoke ;;
  evidence)  step_evidence ;;
  all)
    require_command fly
    require_command curl
    require_command jq
    step_validate
    step_app
    step_secrets
    step_dashboards
    step_alerts
    step_deploy
    step_smoke
    step_evidence
    cat <<EOF

==> Bootstrap complete

Fly app:    ${FLY_APP}
Grafana:    ${GRAFANA_CLOUD_PROMETHEUS_URL%/}

Dashboards provisioned:
$(for f in "${DASHBOARD_DIR}"/*.json; do printf '  - /d/%s\n' "$(basename "${f}" .json)"; done)

Alert rules provisioned:
$(for f in "${ALERT_DIR}"/*.json; do printf '  - %s\n' "$(basename "${f}" .json)"; done)

Next steps:
  1. Open the four dashboards and confirm data appears within 5 minutes.
  2. Trigger a synthetic failure (\`./infra/cloud/observability/failure-inject.sh <scenario>\`)
     and confirm the corresponding alert enters the firing state within 2 minutes.
  3. Capture screenshots / exported signals for the closing PR's AC4 evidence
     (use \`./infra/cloud/observability/evidence-capture.sh --format md > evidence.md\`).
EOF
    ;;
esac
