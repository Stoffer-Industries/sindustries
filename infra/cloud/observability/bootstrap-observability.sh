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

require_command fly
require_command curl
require_command jq

ENV_LOCAL="${SCRIPT_DIR}/.env.local"
if [ ! -f "${ENV_LOCAL}" ]; then
  echo "::error::Quinn-owned secret file not found: ${ENV_LOCAL}" >&2
  echo "::error::Copy infra/cloud/observability/env/.env.example to ${ENV_LOCAL} and fill in the values." >&2
  exit 1
fi

# Source Quinn's local secret file. set -a exports every variable so
# subsequent `fly secrets set` invocations can reference them by name.
set -a
# shellcheck source=/dev/null
source "${ENV_LOCAL}"
set +a

require_env_var FLY_API_TOKEN
require_env_var FLY_ORG
require_env_var GRAFANA_CLOUD_OTLP_ENDPOINT
require_env_var GRAFANA_CLOUD_OTLP_HEADERS
require_env_var GRAFANA_CLOUD_PROVISIONING_AUTH
require_env_var GRAFANA_CLOUD_PROMETHEUS_URL
require_env_var GRAFANA_CLOUD_TEMPO_URL
require_env_var HEALTH_PROBE_DATABASES
require_env_var HEALTH_PROBE_FLY_APPS
require_env_var HEALTH_PROBE_REDIS

FLY_CONFIG="${REPO_ROOT}/infra/cloud/observability/health-probe/fly.toml"
FLY_APP="$(grep '^app = ' "${FLY_CONFIG}" | sed -E "s/^app = '([^']+)'/\1/")"

echo "==> Using Fly app: ${FLY_APP}"
echo "==> Using Fly org: ${FLY_ORG}"

export FLY_API_TOKEN

# ---------------------------------------------------------------------------
# 1. Ensure the health-probe Fly app exists.
# ---------------------------------------------------------------------------
echo "==> Ensuring Fly app exists"
if ! flyctl status --config "${FLY_CONFIG}" --app "${FLY_APP}" >/dev/null 2>&1; then
  flyctl apps create "${FLY_APP}" --org "${FLY_ORG}"
fi

# ---------------------------------------------------------------------------
# 2. Set Fly secrets.
# ---------------------------------------------------------------------------
echo "==> Setting Fly secrets"
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

# ---------------------------------------------------------------------------
# 3. Upload dashboards to the hosted Grafana.
# ---------------------------------------------------------------------------
echo "==> Uploading dashboards"
DASHBOARD_DIR="${SCRIPT_DIR}/grafana/dashboards"
for dashboard_file in "${DASHBOARD_DIR}"/*.json; do
  filename="$(basename "${dashboard_file}" .json)"
  echo "    - ${filename}"
  curl --fail --silent --show-error \
    -H "Authorization: ${GRAFANA_CLOUD_PROVISIONING_AUTH}" \
    -H "Content-Type: application/json" \
    --data-binary "@${dashboard_file}" \
    "${GRAFANA_CLOUD_PROMETHEUS_URL%/}/api/dashboards/db"
done

# ---------------------------------------------------------------------------
# 4. Upload alert rules to the hosted Grafana.
# ---------------------------------------------------------------------------
echo "==> Uploading alert rules"
ALERT_DIR="${SCRIPT_DIR}/grafana/alerts"
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

# ---------------------------------------------------------------------------
# 5. Smoke deploy.
# ---------------------------------------------------------------------------
echo "==> Deploying health-probe"
flyctl deploy \
  --config "${FLY_CONFIG}" \
  --strategy canary \
  --wait-timeout 600

echo "==> Smoke check (/healthz)"
SMOKE_URL="https://${FLY_APP}.fly.dev/healthz"
SMOKE_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "${SMOKE_URL}")"
if [ "${SMOKE_STATUS}" != "200" ]; then
  echo "::error::smoke check failed: GET ${SMOKE_URL} returned ${SMOKE_STATUS}" >&2
  exit 1
fi
echo "    GET ${SMOKE_URL} → ${SMOKE_STATUS}"

# ---------------------------------------------------------------------------
# 6. Final report.
# ---------------------------------------------------------------------------
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
  2. Trigger a synthetic failure (flyctl scale count 0 --app <app>) and confirm
     the corresponding alert enters the firing state within 2 minutes.
  3. Capture screenshots / exported signals for the closing PR's AC4 evidence.
EOF
