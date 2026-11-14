#!/usr/bin/env bash
# grafana-cloud-otel-env.test.sh — contract test for the Grafana Cloud OTel
# cutover (task a7938522).
#
# WHAT THIS GUARDS
# -----------------
# The local collector forwards spans and metrics to Grafana Cloud. Two mistakes
# in that path are silent and expensive:
#
# 1. Using the raw `GRAFANA_CLOUD_OTLP_HEADERS` value as a header. That value
#    is an OTLP exporter header *string* (`Authorization=Basic <base64>`), so
#    the collector would send `Authorization: Authorization=Basic <base64>` and
#    the tenant would answer 401 — with the collector looking perfectly
#    healthy.
# 2. Pointing the exporter at the gateway without the `/otlp` prefix. The
#    tenant serves traces at `/otlp/v1/traces` and answers 404 on `/v1/traces`.
#
# Both are configuration mistakes, and neither is caught by a unit test of the
# runtime: the collector starts, the exporter is "configured", and the data
# silently never arrives. So this test asserts the CONFIGURATION, plus the
# helper that produces it.
#
# The header-parsing rules are asserted against the same input/output cases as
# `apps/gymtrack/api/telemetry.js::parseOtlpHeaderString()`, so the two
# consumers cannot silently diverge.
#
# This is an offline test — no Grafana access and no credential required.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HELPER="scripts/dev/grafana-cloud-otel-env.sh"
COLLECTOR_CONFIG="infra/otel-collector/config.yaml"
COMPOSE="infra/docker-compose.observability.yml"
UP_SH="scripts/dev/up.sh"

failures=0
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
ok()   { echo "ok: $1"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Run the helper against a fixture credential file and echo the two exported
# values, one per line. The helper exports when sourced, so drive it in a
# subshell that sources it — that makes the exports observable.
run_helper() {
  local fixture="$1"
  env -u GRAFANA_CLOUD_OTLP_ENDPOINT -u GRAFANA_CLOUD_OTLP_AUTHORIZATION \
    GRAFANA_CLOUD_OTEL_ENV_FILE="$fixture" \
    bash -c "source '$REPO_ROOT/$HELPER'; printf '%s\n%s\n' \"\$GRAFANA_CLOUD_OTLP_ENDPOINT\" \"\$GRAFANA_CLOUD_OTLP_AUTHORIZATION\""
}

write_fixture() {
  local name="$1" endpoint="$2" headers="$3"
  local path="$TMP_DIR/$name.env"
  {
    echo "GRAFANA_CLOUD_OTLP_ENDPOINT=$endpoint"
    echo "GRAFANA_CLOUD_OTLP_HEADERS=$headers"
  } >"$path"
  printf '%s' "$path"
}

expect_equal() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# ---------------------------------------------------------------------------
# 1. Header parsing — the same cases as the GymTrack parser.
# ---------------------------------------------------------------------------

# Named header: `Authorization=Basic <base64>`.
f="$(write_fixture named 'https://gw.example.net' 'Authorization=Basic abc123')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "named header: helper exited non-zero"; out=""; }
expect_equal "named header — endpoint normalized" "$(printf '%s' "$out" | sed -n 1p)" "https://gw.example.net/otlp"
expect_equal "named header — authorization value" "$(printf '%s' "$out" | sed -n 2p)" "Basic abc123"

# Percent-encoded space: `Basic%20abc` decodes to `Basic abc`.
f="$(write_fixture encoded 'https://gw.example.net' 'Authorization=Basic%20abc123')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "encoded header: helper exited non-zero"; out=""; }
expect_equal "percent-encoded header — decoded value" "$(printf '%s' "$out" | sed -n 2p)" "Basic abc123"

# Bare value with no `name=` prefix.
f="$(write_fixture bare 'https://gw.example.net' 'Basic abc123')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "bare header: helper exited non-zero"; out=""; }
expect_equal "bare header — value kept whole" "$(printf '%s' "$out" | sed -n 2p)" "Basic abc123"

# Base64 padding: the `=` is padding, not a name/value separator. The segment
# before it is not a valid header name, so the whole segment is the value.
f="$(write_fixture padded 'https://gw.example.net' 'Basic YWJj==')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "padded header: helper exited non-zero"; out=""; }
expect_equal "base64-padded header — padding preserved" "$(printf '%s' "$out" | sed -n 2p)" "Basic YWJj=="

# A header string with no Authorization must fail closed: the collector would
# send an unauthenticated request.
f="$(write_fixture noauth 'https://gw.example.net' 'X-Some-Header=whatever')"
if run_helper "$f" >/dev/null 2>&1; then
  fail "header without Authorization — helper should have refused"
else
  ok "header without Authorization — refused"
fi

# An empty header string must fail closed too.
f="$(write_fixture empty 'https://gw.example.net' '')"
if run_helper "$f" >/dev/null 2>&1; then
  fail "empty header string — helper should have refused"
else
  ok "empty header string — refused"
fi

# ---------------------------------------------------------------------------
# 2. Endpoint normalization — the `/otlp` prefix the tenant requires.
# ---------------------------------------------------------------------------

# Already-prefixed endpoint is preserved, not double-prefixed.
f="$(write_fixture prefixed 'https://gw.example.net/otlp' 'Authorization=Basic abc')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "prefixed endpoint: helper exited non-zero"; out=""; }
expect_equal "prefixed endpoint — not double-prefixed" "$(printf '%s' "$out" | sed -n 1p)" "https://gw.example.net/otlp"

# A trailing slash is tolerated and normalized away.
f="$(write_fixture trailing 'https://gw.example.net/otlp/' 'Authorization=Basic abc')"
out="$(run_helper "$f" 2>/dev/null)" || { fail "trailing slash endpoint: helper exited non-zero"; out=""; }
expect_equal "trailing-slash endpoint — normalized" "$(printf '%s' "$out" | sed -n 1p)" "https://gw.example.net/otlp"

# The known-404 path must fail closed rather than pass through.
f="$(write_fixture badpath 'https://gw.example.net/v1/traces' 'Authorization=Basic abc')"
if run_helper "$f" >/dev/null 2>&1; then
  fail "endpoint without /otlp prefix — helper should have refused"
else
  ok "endpoint without /otlp prefix — refused"
fi

# A non-HTTP scheme must fail closed.
f="$(write_fixture badscheme 'ftp://gw.example.net' 'Authorization=Basic abc')"
if run_helper "$f" >/dev/null 2>&1; then
  fail "non-http endpoint — helper should have refused"
else
  ok "non-http endpoint — refused"
fi

# ---------------------------------------------------------------------------
# 3. The collector config must not interpolate the raw header string.
# ---------------------------------------------------------------------------

# The raw header string must never be interpolated. The check looks for the
# interpolation form specifically — the config file may name the variable in a
# comment explaining why it must not be used.
if grep -q 'env:GRAFANA_CLOUD_OTLP_HEADERS' "$COLLECTOR_CONFIG"; then
  fail "collector config interpolates the raw GRAFANA_CLOUD_OTLP_HEADERS value"
else
  ok "collector config does not interpolate the raw GRAFANA_CLOUD_OTLP_HEADERS value"
fi

if grep -q 'GRAFANA_CLOUD_OTLP_AUTHORIZATION' "$COLLECTOR_CONFIG"; then
  ok "collector config reads the parsed Authorization value"
else
  fail "collector config does not read GRAFANA_CLOUD_OTLP_AUTHORIZATION"
fi

# The local exporters must be gone.
if grep -qE '^\s*otlp/tempo:' "$COLLECTOR_CONFIG"; then
  fail "collector config still declares the otlp/tempo exporter"
else
  ok "collector config has no otlp/tempo exporter"
fi

if grep -qE '^\s*prometheus:' "$COLLECTOR_CONFIG"; then
  fail "collector config still declares the prometheus exporter"
else
  ok "collector config has no prometheus exporter"
fi

# Every pipeline must forward to the cloud exporter.
if grep -qE '^\s*otlphttp/grafana_cloud:' "$COLLECTOR_CONFIG"; then
  ok "collector config declares the otlphttp/grafana_cloud exporter"
else
  fail "collector config does not declare the otlphttp/grafana_cloud exporter"
fi

# Every pipeline must forward to the cloud exporter. Parsed structurally (not
# by grep) so a pipeline that keeps a second exporter is still caught.
cloud_pipeline_count="$(python3 - "$COLLECTOR_CONFIG" <<'PY'
import re, sys

text = open(sys.argv[1]).read().splitlines()
pipelines = ("traces", "metrics", "metrics/spanmetrics")
current = None
exporters = {}
for line in text:
    m = re.match(r"^    ([A-Za-z0-9/_-]+):\s*$", line)
    if m and m.group(1) in pipelines:
        current = m.group(1)
        exporters[current] = []
        continue
    if current is None:
        continue
    if re.match(r"^    [A-Za-z0-9/_-]+:", line):
        current = None
        continue
    m = re.match(r"^      exporters:\s*\[(.*)\]\s*$", line)
    if m:
        exporters[current] = [e.strip() for e in m.group(1).split(",") if e.strip()]

missing = [p for p in pipelines if "otlphttp/grafana_cloud" not in exporters.get(p, [])]
if missing:
    print("MISSING:" + ",".join(missing))
else:
    print(len(pipelines))
PY
)"

if [[ "$cloud_pipeline_count" == "3" ]]; then
  ok "all three pipelines export to the cloud exporter"
else
  fail "expected all three pipelines to export to the cloud exporter (got: $cloud_pipeline_count)"
fi

# The spanmetrics dimensions the dashboards depend on must survive.
for dim in agent_id llm.model; do
  if grep -q "name: $dim" "$COLLECTOR_CONFIG"; then
    ok "spanmetrics dimension '$dim' preserved"
  else
    fail "spanmetrics dimension '$dim' was dropped"
  fi
done

# ---------------------------------------------------------------------------
# 4. The compose service must hand the collector its export environment.
# ---------------------------------------------------------------------------

for var_name in GRAFANA_CLOUD_OTLP_ENDPOINT GRAFANA_CLOUD_OTLP_AUTHORIZATION; do
  if awk '/^  otel-collector:/{insvc=1; next} insvc && /^  [a-z-]+:/{insvc=0} insvc' "$COMPOSE" | grep -q "$var_name"; then
    ok "compose passes $var_name to the collector"
  else
    fail "compose does not pass $var_name to the collector"
  fi
done

# ---------------------------------------------------------------------------
# 5. The supported startup path must resolve the credential before starting.
# ---------------------------------------------------------------------------

if grep -q 'grafana-cloud-otel-env.sh' "$UP_SH"; then
  ok "up.sh sources the Grafana Cloud OTel env helper"
else
  fail "up.sh does not source the Grafana Cloud OTel env helper"
fi

# ---------------------------------------------------------------------------

if [[ "$failures" -gt 0 ]]; then
  echo "" >&2
  echo "$failures check(s) failed." >&2
  exit 1
fi

echo ""
echo "All Grafana Cloud OTel cutover contract checks passed."
