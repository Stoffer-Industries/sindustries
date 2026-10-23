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
#               report which are missing, then resolve each configured
#               endpoint with a read-only reachability probe and name any
#               var that points somewhere unusable. Exits with the missing
#               count, or with the failed-endpoint count when every var is
#               present. Set PROBE_SKIP_NETWORK=1 for an air-gapped run.
#               Does NOT require Fly or Grafana access — probes are
#               unauthenticated, so a 401 is reported as healthy.
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
              report which are missing, then resolve each configured
              endpoint with a read-only reachability probe and name any
              var that points somewhere unusable. Exits with the missing
              count, or with the failed-endpoint count when every var is
              present. Set PROBE_SKIP_NETWORK=1 for an air-gapped run.
              Does NOT require Fly or Grafana access — probes are
              unauthenticated, so a 401 is reported as healthy.
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
  GRAFANA_CLOUD_INSTANCE_URL
  HEALTH_PROBE_DATABASES
  HEALTH_PROBE_FLY_APPS
  HEALTH_PROBE_REDIS
)

# ---------------------------------------------------------------------------
# Endpoint resolution (task f3909b89)
#
# `validate` used to prove only that the vars above are *populated*, never
# that the URLs they point at resolve. Five defects behind PR #836's AC4
# live-verification step were invisible to a green pre-flight for exactly
# that reason — each surfaced hours later as "telemetry is broken", pointing
# at the transport instead of at a misconfigured endpoint.
#
# ENDPOINT_SPECS is the single source of truth for BOTH the reachability
# probes and the generated documentation block (render_endpoint_docs), so a
# var that exists in code cannot be missing from every doc. That is the
# `GRAFANA_CLOUD_LOKI_ENDPOINT` gap that motivated this task.
#
# Fields are pipe-delimited; no field may contain '|':
#   <id>|<role>|<url-source>|<required shape>
#
# <url-source> is one of:
#   env:<VAR>            base URL comes from <VAR>
#   env:<VAR>;derive-loki-push
#                        use <VAR> when set; when unset, derive the Loki
#                        push URL from GRAFANA_CLOUD_OTLP_ENDPOINT using the
#                        same strict rule the relay applies
#   literal:<URL>        a fixed endpoint, no env var
#
# The table is a function rather than an array so the values are read once
# per run (endpoint specs are read from a here-doc, not evaluated at
# declaration time before source_env_local has populated the environment).
ENDPOINT_DOCS_MARKER='bootstrap-observability endpoint table'

endpoint_specs() {
  cat <<'ENDPOINTS'
grafana_instance|grafana-instance|env:GRAFANA_CLOUD_INSTANCE_URL|https://<stack>.grafana.net — stack base URL only, no trailing path
otlp_endpoint|otlp-endpoint|env:GRAFANA_CLOUD_OTLP_ENDPOINT|https://<host> (Grafana Cloud serves OTLP under /otlp/v1/*) or https://<host>/v1/
loki_push|loki-push-endpoint|env:GRAFANA_CLOUD_LOKI_ENDPOINT;derive-loki-push|OPTIONAL — https://<logs-host>/loki/api/v1/push — set on multi-host tenants, where Loki push is a different host from OTLP
gymtrack_relay|gymtrack-telemetry-relay|env:GYMTRACK_RELAY_BASE_URL|OPTIONAL — https://<gymtrack-host> — SPA base URL, no trailing path; validate probes <base>/api/telemetry
fly_api|fly-api|literal:https://api.fly.io/|https://api.fly.io/ — no path, no credentials in the URL
ENDPOINTS
}

# Strips userinfo and any query string from a URL before it is printed or
# probed. AC4: probe output must never carry a secret, and an operator can
# legitimately write credentials into a URL by mistake.
sanitize_url() {
  printf '%s' "$1" | sed -E -e 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@#\1#' -e 's#\?.*$##'
}

# Splits a base URL into URL_SCHEME / URL_HOST / URL_PATH. URL_PATH is ''
# when the URL has no path at all — which is the *production* Grafana Cloud
# OTLP shape, so the bare-host case must not be treated as malformed.
split_url() {
  local base="${1:-}" scheme_host
  base="${base%/}"
  case "${base}" in
    *://*) ;;
    *) return 1 ;;
  esac
  URL_SCHEME="${base%%://*}"
  scheme_host="${base#*://}"
  URL_HOST="${scheme_host%%/*}"
  case "${scheme_host}" in
    */*) URL_PATH="/${scheme_host#*/}" ;;
    *) URL_PATH='' ;;
  esac
}

# Mirrors the relay's lokiPushUrl(): only a base whose entire path is
# /v1[-{traces,metrics,logs}] is rewritten. A bare host, an /otlp prefix,
# or any multi-segment path is NOT derivable — the relay would return
# 502 misconfigured_loki_endpoint for those, so validate reports it here.
# Returns 1 when no Loki push URL can be derived.
loki_push_url() {
  local base="${1:-}"
  split_url "${base}" || return 1
  case "${URL_PATH}" in
    /v1|/v1/traces|/v1/metrics|/v1/logs)
      printf '%s://%s/loki/api/v1/push' "${URL_SCHEME}" "${URL_HOST}"
      ;;
    *)
      return 1
      ;;
  esac
}

# Probes the OTLP traces path rather than the configured base, because the
# base alone is not a route: Grafana Cloud serves /otlp/v1/* on a bare host
# while a single-host collector serves /v1/*. Either way a GET returns 405
# (that path is POST-only) or 401, both of which prove the path exists.
otlp_probe_url() {
  local base="${1:-}"
  split_url "${base}" || return 1
  case "${URL_PATH}" in
    "")
      printf '%s://%s/otlp/v1/traces' "${URL_SCHEME}" "${URL_HOST}"
      ;;
    /v1)
      printf '%s://%s/v1/traces' "${URL_SCHEME}" "${URL_HOST}"
      ;;
    *)
      printf '%s://%s%s/traces' "${URL_SCHEME}" "${URL_HOST}" "${URL_PATH}"
      ;;
  esac
}

# Echoes the URL to probe for <id> given its <url-source>.
#   exit 0 — URL printed
#   exit 1 — endpoint not configured (optional var unset); caller skips it
#   exit 2 — endpoint configured but no probe URL is derivable from it
endpoint_probe_url() {
  local id="$1" source="$2" var fallback base
  case "${source}" in
    literal:*)
      printf '%s' "${source#literal:}"
      ;;
    env:*)
      var="${source#env:}"
      var="${var%%;*}"
      if [ "${source}" = "${var}" ]; then
        fallback=''
      else
        fallback="${source#*;}"
      fi
      base="${!var:-}"
      if [ -z "${base}" ]; then
        if [ "${fallback}" = 'derive-loki-push' ]; then
          loki_push_url "${GRAFANA_CLOUD_OTLP_ENDPOINT:-}" || return 2
          return 0
        fi
        return 1
      fi
      case "${id}" in
        grafana_instance)
          printf '%s/api/health' "${base%/}"
          ;;
        otlp_endpoint)
          otlp_probe_url "${base}" || return 2
          ;;
        gymtrack_relay)
          # The base URL is the SPA origin; the relay function lives at a
          # fixed sub-path of it.
          printf '%s/api/telemetry' "${base%/}"
          ;;
        *)
          # loki_push and anything else: probe the configured value verbatim,
          # which is what the relay actually posts to.
          printf '%s' "${base}"
          ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

# No --fail: the status code IS the signal. --fail would collapse every
# taxonomy code below into exit 22 and destroy the AC2 oracle. Bodies are
# discarded so a misconfigured endpoint cannot spill content into
# operator scrollback.
probe_status() {
  local url="$1" status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time "${PROBE_TIMEOUT:-10}" \
    --connect-timeout 5 \
    "${url}" 2>/dev/null)" || status='000'
  [ -n "${status}" ] || status='000'
  printf '%s' "${status}"
}

classify_probe_status() {
  case "$1" in
    000)            printf 'unreachable' ;;
    2??)            printf 'ok' ;;
    401|403)        printf 'auth-required' ;;
    302|303|307)    printf 'instance-auth-wall' ;;
    404)            printf 'path-absent' ;;
    405)            printf 'method-not-allowed' ;;
    530)            printf 'gateway-origin-failure' ;;
    5??)            printf 'origin-error' ;;
    *)              printf 'unexpected-status' ;;
  esac
}

# 401 / 302 / 405 are evidence the endpoint is correctly configured, not
# broken: a real Grafana Cloud tenant answers an unauthenticated probe with
# one of them. Failing there would make validate red on every healthy
# instance, which is the mirror image of the bug this fixes.
# Header-aware probe, used only by endpoints whose reachability cannot be
# decided from a status code (currently the GymTrack telemetry relay).
# Emits "<header block>\n<status>" so the caller gets both in one round trip.
# Same --fail/no --fail stance as probe_status: the body is discarded so a
# misconfigured endpoint cannot spill content into operator scrollback.
probe_status_and_headers() {
  local url="$1" raw
  raw="$(curl --silent --dump-header - --output /dev/null \
    --write-out '\n%{http_code}' \
    --max-time "${PROBE_TIMEOUT:-10}" \
    --connect-timeout 5 \
    "${url}" 2>/dev/null)" || raw=''
  [ -n "${raw}" ] || raw=$'\n000'
  printf '%s' "${raw%$'\n'*}"
  printf '\n'
  printf '%s' "${raw##*$'\n'}"
}

# AC2 of task 8bb78c2d. Decides whether /api/telemetry is actually a Vercel
# function on the deployed site, or whether the SPA catch-all swallowed it.
#
# The discriminator is content-disposition, NOT the status code, and that is
# not a stylistic choice. Two counter-examples, both reproduced live against
# production dpl_3TeE9RPEnSa53GX2YZMgiYdJbWJW, pin the rule down:
#
#   * POST /api/definitely-not-a-route-xyz — a route that exists nowhere —
#     answers 405, exactly like a real POST-only function. Status alone
#     cannot tell routed from unrouted.
#   * x-vercel-cache is MISS for a routed GET and for an unrouted GET
#     alike, so that header discriminates nothing either.
#
# What does discriminate: the SPA catch-all serves the built index.html and
# stamps content-disposition: inline; filename="index.html" on it. A real
# function answers with an application/json content-type and an Allow header
# (GET on the POST-only relay returns 405 + Allow: POST + a JSON body).
probe_route_class() {
  local status="$1" headers="$2" lower
  lower="$(printf '%s' "${headers}" | tr '[:upper:]' '[:lower:]')"
  case "${lower}" in
    *'content-disposition:'*'filename="index.html"'*)
      printf 'spa-catch-all'
      return 0
      ;;
  esac
  if [ "${status}" = '000' ]; then
    classify_probe_status "${status}"
    return 0
  fi
  case "${lower}" in
    *'content-type:'*json*'allow:'*)
      printf 'routed'
      return 0
      ;;
  esac
  # A 405 without the JSON/Allow signature is the unrouted-counter-example
  # shape: a real function would carry both. Report it under its own class
  # rather than the shared method-not-allowed, which passes elsewhere.
  if [ "${status}" = '405' ]; then
    printf 'not-a-function'
    return 0
  fi
  classify_probe_status "${status}"
}

probe_blocks() {
  case "$1" in
    unreachable|path-absent|gateway-origin-failure|origin-error|spa-catch-all|not-a-function) return 0 ;;
    *) return 1 ;;
  esac
}

# AC2: the operator must never be left inferring which var is wrong.
probe_hint() {
  local class="$1" id="$2" url_source="$3" var="${3#env:}"
  var="${var%%;*}"
  case "${class}" in
    unreachable)
      printf 'no response (DNS, TLS, or timeout) — check the host and network egress for %s' "${var}"
      ;;
    gateway-origin-failure)
      printf '%s points at a gateway whose origin is failing; the host may be wrong or the tenant down' "${var}"
      ;;
    origin-error)
      printf '%s reached a host that returned a server error' "${var}"
      ;;
    spa-catch-all)
      printf '%s served the SPA index.html for /api/telemetry — the relay function is not deployed there, or the SPA catch-all rewrite shadows it; deploy apps/gymtrack/api/telemetry.js first' "${var}"
      ;;
    not-a-function)
      printf '%s answered 405 without a JSON content-type and an allow: header, so /api/telemetry is not the relay function' "${var}"
      ;;
    path-absent)
      case "${id}" in
        grafana_instance)
          printf '%s should be the stack base URL (e.g. https://<stack>.grafana.net); validate probes <base>/api/health' "${var}"
          ;;
        otlp_endpoint)
          printf '%s should be the OTLP base (bare host, or .../v1); validate probes the traces path on it' "${var}"
          ;;
        loki_push)
          printf '%s should be the Loki push URL, e.g. https://<logs-host>/loki/api/v1/push — not an OTLP or Prometheus URL' "${var}"
          ;;
        *)
          printf '%s does not resolve' "${var}"
          ;;
      esac
      ;;
    *)
      printf 'unexpected status from %s' "${var}"
      ;;
  esac
}

# Generated documentation block (AC6). Kept byte-identical in
# infra/cloud/observability/env/.env.example and docs/systems/observability.md;
# observability-bootstrap.test.sh diffs this output against both, so adding a
# row here without updating the docs fails CI.
render_endpoint_docs() {
  printf '<!-- BEGIN generated: %s — edit infra/cloud/observability/bootstrap-observability.sh instead -->\n' "${ENDPOINT_DOCS_MARKER}"
  printf '| Endpoint id | Env var | Role | Required shape |\n'
  printf '| --- | --- | --- | --- |\n'
  local id role url_source shape var
  while IFS='|' read -r id role url_source shape; do
    [ -n "${id:-}" ] || continue
    var="${url_source#env:}"
    var="${var%%;*}"
    if [ "${var}" = "${url_source}" ]; then
      var='(fixed — no env var)'
    fi
    printf '| `%s` | `%s` | `%s` | %s |\n' "${id}" "${var}" "${role}" "${shape}"
  done < <(endpoint_specs)
  printf '<!-- END generated: %s -->\n' "${ENDPOINT_DOCS_MARKER}"
}

PROBE_FAILURES=0

step_probe_endpoints() {
  PROBE_FAILURES=0
  echo "    Endpoints (read-only reachability probe):"
  local id role url_source shape url status class rc
  while IFS='|' read -r id role url_source shape; do
    [ -n "${id:-}" ] || continue
    rc=0
    url="$(endpoint_probe_url "${id}" "${url_source}")" || rc=$?
    if [ "${rc}" -eq 1 ]; then
      printf '      [SKIP] %-22s %-22s (not configured)\n' "${id}" ''
      continue
    fi
    if [ "${rc}" -eq 2 ]; then
      # Configured, but the URL the relay would post to cannot be derived.
      # The relay answers 502 misconfigured_loki_endpoint for this, hours
      # later; fail here instead, by name.
      local fix_var="${url_source#env:}"
      fix_var="${fix_var%%;*}"
      if [ "${fix_var}" = "${url_source}" ]; then
        fix_var='the endpoint definition'
      fi
      printf '      [FAIL] %-22s %-22s %s\n' "${id}" '!not-derivable' ''
      printf '             → fix %s — %s\n' \
        "${fix_var}" "$(probe_hint path-absent "${id}" "${url_source}")"
      if [ "${id}" = 'loki_push' ] && [ -z "${GRAFANA_CLOUD_LOKI_ENDPOINT:-}" ]; then
        printf '               (no Loki push URL can be derived from %s; the relay would answer 502 misconfigured_loki_endpoint)\n' \
          'GRAFANA_CLOUD_OTLP_ENDPOINT'
      fi
      PROBE_FAILURES=$((PROBE_FAILURES + 1))
      continue
    fi
    url="$(sanitize_url "${url}")"
    if [ "${id}" = 'gymtrack_relay' ]; then
      # Header-aware: whether this is the relay function is not decidable
      # from the status code alone (see probe_route_class).
      local raw headers
      raw="$(probe_status_and_headers "${url}")"
      headers="${raw%$'\n'*}"
      status="${raw##*$'\n'}"
      class="$(probe_route_class "${status}" "${headers}")"
    else
      status="$(probe_status "${url}")"
      class="$(classify_probe_status "${status}")"
    fi
    if probe_blocks "${class}"; then
      printf '      [FAIL] %-22s %-22s %-6s %s\n' "${id}" "${class}" "${status}" "${url}"
      printf '             → %s\n' "$(probe_hint "${class}" "${id}" "${url_source}")"
      PROBE_FAILURES=$((PROBE_FAILURES + 1))
    else
      printf '      [OK]   %-22s %-22s %-6s %s\n' "${id}" "${class}" "${status}" "${url}"
    fi
  done < <(endpoint_specs)
}

grafana_api_url() {
  printf '%s%s' "${GRAFANA_CLOUD_INSTANCE_URL%/}" "$1"
}

grafana_auth_header() {
  printf 'Authorization: %s' "${GRAFANA_CLOUD_PROVISIONING_AUTH}"
}

resolve_datasource_uid() {
  local type="$1" response uid
  response="$(curl --fail --silent --show-error \
    -H "$(grafana_auth_header)" \
    "$(grafana_api_url '/api/datasources')")"
  uid="$(jq -r --arg type "${type}" '
    map(select(.type == $type))
    | (map(select(.isDefault == true))[0] // .[0] // {})
    | .uid // empty
  ' <<<"${response}")"
  printf '%s' "${uid}"
}

resolve_prometheus_datasource_uid() {
  local uid
  uid="$(resolve_datasource_uid prometheus)"
  if [ -z "${uid}" ]; then
    echo "::error::hosted Grafana has no Prometheus datasource" >&2
    return 1
  fi
  printf '%s' "${uid}"
}

# Loki is optional: canonical observability dashboards are Prometheus-backed,
# but product dashboards (GymTrack browser error telemetry) are Loki-backed. A
# missing Loki datasource must not fail provisioning for Prometheus-only setups,
# so callers pass the empty string through and fall back to the placeholder uid.
resolve_loki_datasource_uid() {
  resolve_datasource_uid loki
}

grafana_folder_uid() {
  local title="$1" slug
  slug="$(printf '%s' "${title}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  printf 'sindustries-%s' "${slug#sindustries-}"
}

ensure_grafana_folder() {
  local title="$1" uid="$2" response_file status
  response_file="$(mktemp)"
  status="$(curl --silent --show-error \
    --output "${response_file}" \
    --write-out '%{http_code}' \
    -H "$(grafana_auth_header)" \
    "$(grafana_api_url "/api/folders/${uid}")")"
  case "${status}" in
    200)
      ;;
    404)
      jq -n --arg uid "${uid}" --arg title "${title}" \
        '{uid: $uid, title: $title}' \
        | curl --fail --silent --show-error \
            -H "$(grafana_auth_header)" \
            -H "Content-Type: application/json" \
            --data-binary @- \
            "$(grafana_api_url '/api/folders')" >/dev/null
      ;;
    *)
      echo "::error::Grafana folder lookup failed (${status}): $(cat "${response_file}")" >&2
      rm -f "${response_file}"
      return 1
      ;;
  esac
  rm -f "${response_file}"
}

upsert_grafana_alert_rule() {
  local uid="$1" payload="$2" response_file status method url
  response_file="$(mktemp)"
  status="$(curl --silent --show-error \
    --output "${response_file}" \
    --write-out '%{http_code}' \
    -H "$(grafana_auth_header)" \
    "$(grafana_api_url "/api/v1/provisioning/alert-rules/${uid}")")"
  case "${status}" in
    200)
      method="PUT"
      url="$(grafana_api_url "/api/v1/provisioning/alert-rules/${uid}")"
      ;;
    404)
      method="POST"
      url="$(grafana_api_url '/api/v1/provisioning/alert-rules')"
      ;;
    *)
      echo "::error::Grafana alert lookup failed for ${uid} (${status}): $(cat "${response_file}")" >&2
      rm -f "${response_file}"
      return 1
      ;;
  esac
  rm -f "${response_file}"
  curl --fail --silent --show-error \
    -X "${method}" \
    -H "$(grafana_auth_header)" \
    -H "Content-Type: application/json" \
    -H "X-Disable-Provenance: true" \
    --data-binary "${payload}" \
    "${url}" >/dev/null
}

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
    # No reachability probe on this path: with vars missing there is
    # nothing configured to resolve, and validate must stay usable as Tom
    # hands over each secret one at a time.
    echo "==> Validate: endpoint probes skipped (required vars missing)"
    return "${missing}"
  fi

  echo
  if [ "${DRY_RUN}" = true ]; then
    echo "    [dry-run] endpoint plan — no probes fired:"
    render_endpoint_docs
  elif [ "${PROBE_SKIP_NETWORK:-0}" = '1' ]; then
    echo "    [skip] endpoint probes disabled (PROBE_SKIP_NETWORK=1)"
  elif ! command -v curl >/dev/null 2>&1; then
    echo "    [skip] endpoint probes need curl, which is not installed"
  else
    step_probe_endpoints
  fi

  echo
  if [ "${PROBE_FAILURES}" -gt 0 ]; then
    echo "==> Validate: ${PROBE_FAILURES} endpoint(s) did not resolve"
    if [ "${PROBE_FAILURES}" -gt 125 ]; then
      PROBE_FAILURES=125
    fi
    return "${PROBE_FAILURES}"
  fi
  if [ "${DRY_RUN}" = true ] || [ "${PROBE_SKIP_NETWORK:-0}" = '1' ]; then
    echo "==> Validate: all required vars present (endpoints not probed)"
    return 0
  fi
  echo "==> Validate: all required vars present and every endpoint resolved"
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
  # Dashboard JSON may live in two trees: the canonical observability
  # dashboards (infra/cloud/observability/grafana/dashboards) and
  # product-local dashboards co-located with the app that owns them
  # (apps/gymtrack/grafana/dashboards for GymTrack's browser error
  # telemetry dashboard — task e89db27f). Upload both trees so a
  # product that ships an app-owned dashboard does not need a
  # separate provisioning step.
  local extra_dashboard_dirs=()
  if [ -d "${REPO_ROOT}/apps/gymtrack/grafana/dashboards" ]; then
    extra_dashboard_dirs+=("${REPO_ROOT}/apps/gymtrack/grafana/dashboards")
  fi
  if [ "${DRY_RUN}" = true ]; then
    for dashboard_file in "${DASHBOARD_DIR}"/*.json "${extra_dashboard_dirs[@]}"/*.json; do
      [ -e "${dashboard_file}" ] || continue
      filename="$(basename "${dashboard_file}" .json)"
      echo "    [dry-run] POST \${GRAFANA_CLOUD_INSTANCE_URL}/api/dashboards/db  body=${dashboard_file}  (uid=${filename})"
    done
    return 0
  fi
  source_env_local
  require_env_var GRAFANA_CLOUD_PROVISIONING_AUTH
  require_env_var GRAFANA_CLOUD_INSTANCE_URL
  local prometheus_uid loki_uid wrapped_payload
  prometheus_uid="$(resolve_prometheus_datasource_uid)"
  loki_uid="$(resolve_loki_datasource_uid)"
  if [ -z "${loki_uid}" ]; then
    loki_uid="loki"
    echo "::warning::hosted Grafana has no Loki datasource; Loki-backed dashboards keep the placeholder uid" >&2
  fi
  for dashboard_file in "${DASHBOARD_DIR}"/*.json "${extra_dashboard_dirs[@]}"/*.json; do
    [ -e "${dashboard_file}" ] || continue
    filename="$(basename "${dashboard_file}" .json)"
    echo "    - ${filename}"
    # Rewrite only the placeholder uids that dashboards ship in the repo
    # ("prometheus" / "loki") to the real per-type datasource UIDs. Rewriting
    # every datasource to the Prometheus UID silently breaks Loki-backed
    # dashboards (GymTrack browser error telemetry), because LogQL panels
    # would be pointed at a Prometheus datasource.
    wrapped_payload="$(jq -c \
      --arg prometheus_uid "${prometheus_uid}" \
      --arg loki_uid "${loki_uid}" '
      def is_loki: (.type? == "loki") or (.uid? == "loki");
      def is_prometheus: (.type? == "prometheus") or (.uid? == "prometheus");
      walk(
        if type == "object" and has("datasource") then
          .datasource |= (
            if type == "object" and (is_loki or is_prometheus) then
              .uid = (if is_loki then $loki_uid else $prometheus_uid end)
            elif type == "string" and (. == "loki" or . == "prometheus") then
              (if . == "loki" then $loki_uid else $prometheus_uid end)
            else . end
          )
        else . end
      )
      | {dashboard: ., overwrite: true}
    ' "${dashboard_file}")"
    curl --fail --silent --show-error \
      -H "$(grafana_auth_header)" \
      -H "Content-Type: application/json" \
      --data-binary "${wrapped_payload}" \
      "$(grafana_api_url '/api/dashboards/db')" >/dev/null
  done
}

step_alerts() {
  echo "==> Alerts: upload to hosted Grafana"
  if [ "${DRY_RUN}" = true ]; then
    for alert_file in "${ALERT_DIR}"/*.json; do
      filename="$(basename "${alert_file}" .json)"
      echo "    [dry-run] POST-or-PUT \${GRAFANA_CLOUD_INSTANCE_URL}/api/v1/provisioning/alert-rules[/<uid>]  source=${alert_file}"
    done
    return 0
  fi
  source_env_local
  require_env_var GRAFANA_CLOUD_PROVISIONING_AUTH
  require_env_var GRAFANA_CLOUD_INSTANCE_URL
  local prometheus_uid folder_title folder_uid rule_payload rule_uid
  prometheus_uid="$(resolve_prometheus_datasource_uid)"
  for alert_file in "${ALERT_DIR}"/*.json; do
    filename="$(basename "${alert_file}" .json)"
    echo "    - ${filename}"
    folder_title="$(jq -r '.groups[0].folder' "${alert_file}")"
    folder_uid="$(grafana_folder_uid "${folder_title}")"
    ensure_grafana_folder "${folder_title}" "${folder_uid}"
    while IFS= read -r rule_payload; do
      rule_uid="$(jq -r '.uid' <<<"${rule_payload}")"
      upsert_grafana_alert_rule "${rule_uid}" "${rule_payload}"
    done < <(jq -c \
      --arg folder_uid "${folder_uid}" \
      --arg prometheus_uid "${prometheus_uid}" '
        .groups[] as $group
        | $group.rules[]
        | . + {
            folderUID: $folder_uid,
            ruleGroup: $group.name,
            orgID: ($group.orgId // 1)
          }
        | .data |= map(
            if .datasourceUid == "prometheus" then
              .datasourceUid = $prometheus_uid
            else . end
          )
      ' "${alert_file}")
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
  # fly.toml documents a repo-root build context. Keep the deploy cwd
  # aligned with that contract: Fly's remote builder resolves a relative
  # [build].context from the CLI cwd in some versions, not the config dir.
  (
    cd "${REPO_ROOT}"
    flyctl deploy \
      --config "${FLY_CONFIG}" \
      --strategy canary \
      --wait-timeout 600
  )
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
  if [ "${DRY_RUN}" = true ]; then
    "${EVIDENCE_CAPTURE}" --dry-run --format md
  else
    "${EVIDENCE_CAPTURE}" --format md
  fi
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
Grafana:    ${GRAFANA_CLOUD_INSTANCE_URL%/}

Dashboards provisioned:
$(for f in "${DASHBOARD_DIR}"/*.json; do printf '  - /d/%s\n' "$(basename "${f}" .json)"; done)

Alert rules provisioned:
$(for f in "${ALERT_DIR}"/*.json; do printf '  - %s\n' "$(basename "${f}" .json)"; done)

Next steps:
  1. Open the five dashboards and confirm data appears within 5 minutes.
  2. Trigger a synthetic failure (\`./infra/cloud/observability/failure-inject.sh <scenario>\`)
     and confirm the corresponding alert enters the firing state within 2 minutes.
  3. Capture screenshots / exported signals for the closing PR's AC4 evidence
     (use \`./infra/cloud/observability/evidence-capture.sh --format md > evidence.md\`).
EOF
    ;;
esac
