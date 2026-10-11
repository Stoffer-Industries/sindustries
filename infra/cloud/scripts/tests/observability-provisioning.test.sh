#!/usr/bin/env bash
# Provisioning contract test for the hosted observability stack
# (task 31233a0a — AC1/AC2 evidence).
#
# Validates that the JSON artefacts under infra/cloud/observability/grafana/
# are present and well-formed, without invoking Grafana Cloud or EAS. This is
# the offline half of AC1/AC2 evidence; the
# live half is captured in the closing PR's screenshot/export.
#
# AC coverage:
#   AC1 (31233a0a) — hosted observability stack has the expected runtime artefacts
#         (dashboards, datasource discovery, health probe) so a live hosted Grafana
#         can be provisioned against them.
#   AC2 (31233a0a) — alert rules with severity + owner populated. This test
#         asserts the alert JSONs have a `labels.severity` and
#         `labels.owner` field per the tech design §6.
#   AC1 (2c782afb) — Cloud Overview + tasks-api-5xx-spike + budget-api-4xx-spike use
#         the emitted `http_server_duration_milliseconds_*` contract and the
#         ratio-based error-rate expressions. The contract enforces that no
#         JSON file references the dead `http_requests_total` or
#         `http_server_request_duration_seconds_*` strings, and that the two
#         alert JSONs contain a `/` operator in their query expression.
#   AC2 (2c782afb) — `worker-queue-stuck.json` is absent. The contract enforces
#         that no JSON file ships the `sindustries_queue_ready` counter query.
#   AC3 (2c782afb) — `deploy-failed.json` is absent. The contract enforces that
#         no JSON file ships the `sindustries_deploy_failed_total` counter
#         query. The follow-up deploy-failure telemetry design lives in
#         `brain/ideas/deploy-failure-telemetry-pipeline.md`.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
obs = root / 'infra' / 'cloud' / 'observability'
failures: list[str] = []

EXPECTED_DASHBOARDS = [
    'cloud-overview.json',
    'db-health.json',
    'migration-alerts.json',
    'tasks-api-red.json',
    'openclaw-diagnostics.json',
]
EXPECTED_ALERTS = [
    'tasks-api-down.json',
    'budget-api-down.json',
    'tasks-api-5xx-spike.json',
    'budget-api-4xx-spike.json',
    'tasks-api-db-down.json',
    'budget-api-db-down.json',
    'db-query-slow.json',
    'redis-down.json',
]
# Removed by task 2c782afb (AC2 Path B + AC3). Re-add only when each has
# a durable producer (see brain/ideas/deploy-failure-telemetry-pipeline.md
# for the deploy-failure producer design; worker-queue-stuck is gated on
# the BullMQ adapter exposing a stale-aware waiting+active count).
REMOVED_ALERTS = [
    'worker-queue-stuck.json',
    'deploy-failed.json',
]


def add_failure(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL: {msg}", file=sys.stderr)


def assert_dashboards() -> None:
    dash_dir = obs / 'grafana' / 'dashboards'
    for name in EXPECTED_DASHBOARDS:
        path = dash_dir / name
        if not path.exists():
            add_failure(f"missing dashboard: {path}")
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            add_failure(f"dashboard JSON invalid ({path}): {exc}")
            continue
        for required in ('uid', 'title', 'panels'):
            if required not in data:
                add_failure(f"dashboard {name} missing required field: {required}")


def assert_alerts() -> None:
    alert_dir = obs / 'grafana' / 'alerts'
    for name in EXPECTED_ALERTS:
        path = alert_dir / name
        if not path.exists():
            add_failure(f"missing alert rule: {path}")
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            add_failure(f"alert JSON invalid ({path}): {exc}")
            continue
        groups = data.get('groups', [])
        if not groups:
            add_failure(f"alert {name} has no groups")
            continue
        for group in groups:
            for rule in group.get('rules', []):
                labels = rule.get('labels', {})
                if 'severity' not in labels or labels['severity'] not in ('page', 'warn'):
                    add_failure(
                        f"alert {name} rule {rule.get('uid')} missing severity=page|warn",
                    )
                if 'owner' not in labels or not labels['owner']:
                    add_failure(
                        f"alert {name} rule {rule.get('uid')} missing owner",
                    )


def assert_bootstrap_references() -> None:
    bootstrap = obs / 'bootstrap-observability.sh'
    if not bootstrap.exists():
        add_failure(f"missing bootstrap script: {bootstrap}")
        return
    body = bootstrap.read_text()
    for expected in (
        'flyctl apps create',
        'flyctl secrets set',
        '/api/dashboards/db',
        '/api/datasources',
        '/api/v1/provisioning/alert-rules',
        'folderUID',
        'ruleGroup',
        'HEALTH_PROBE_DATABASES',
    ):
        if expected not in body:
            add_failure(f"bootstrap-observability.sh missing reference to {expected}")


def assert_removed_alerts_absent() -> None:
    """Task 2c782afb AC2 (worker-queue-stuck) + AC3 (deploy-failed).

    The disabled alerts must be absent from the alerts directory AND must
    not be referenced anywhere as a query expression (their dead metrics
    should not creep back in). Re-add only when each has a durable
    producer; see brain/ideas/deploy-failure-telemetry-pipeline.md for
    the deploy-failure producer design.
    """
    alert_dir = obs / 'grafana' / 'alerts'
    for name in REMOVED_ALERTS:
        path = alert_dir / name
        if path.exists():
            add_failure(f"removed alert file still present: {path}")
    dead_query_strings = {
        'worker-queue-stuck': 'sindustries_queue_ready',
        'deploy-failed': 'sindustries_deploy_failed_total',
    }
    if alert_dir.exists():
        for path in alert_dir.glob('*.json'):
            try:
                data = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            text = json.dumps(data)
            for label, needle in dead_query_strings.items():
                if needle in text:
                    add_failure(
                        f"removed alert {label!r} query string {needle!r} "
                        f"still present in {path}",
                    )


def assert_emitted_http_metric_contract() -> None:
    """Task 2c782afb AC1.

    Hosted dashboards + alert rules must use the OTel semantic-convention
    `http_server_duration_milliseconds_*` contract that the deployed
    stack actually emits, and must not reference the dead
    `http_requests_total` or `http_server_request_duration_seconds_*`
    strings.
    """
    dead_metric_strings = (
        'http_requests_total',
        'http_server_request_duration_seconds',
    )
    for sub in ('dashboards', 'alerts'):
        sub_dir = obs / 'grafana' / sub
        if not sub_dir.exists():
            continue
        for path in sub_dir.glob('*.json'):
            try:
                data = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            text = json.dumps(data)
            for dead in dead_metric_strings:
                if dead in text:
                    add_failure(
                        f"{path} references dead metric {dead!r}; "
                        f"use http_server_duration_milliseconds instead",
                    )


def assert_cloud_overview_metric_contract() -> None:
    """Task 2c782afb AC1 — Cloud Overview must reference the emitted
    `http_server_duration_milliseconds_*` metric in its HTTP panels."""
    path = obs / 'grafana' / 'dashboards' / 'cloud-overview.json'
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        add_failure(f"cloud-overview.json invalid JSON: {exc}")
        return
    text = json.dumps(data)
    if 'http_server_duration_milliseconds' not in text:
        add_failure(
            'cloud-overview.json does not reference '
            'http_server_duration_milliseconds_*',
        )


def assert_alert_ratio_contract() -> None:
    """Task 2c782afb AC1 — the two HTTP error-rate alerts must use a
    ratio expression (`/` operator across the http status regex on A
    and the total count on B). The contract here is a static shape
    check: the alert JSON must contain the `/` math operator. The
    semantic ratio (5xx/total, 4xx/total) is verified by the live
    Grafana evaluation Quinn runs during bootstrap.
    """
    expected_alerts = (
        'tasks-api-5xx-spike.json',
        'budget-api-4xx-spike.json',
    )
    alert_dir = obs / 'grafana' / 'alerts'
    for name in expected_alerts:
        path = alert_dir / name
        if not path.exists():
            add_failure(f"missing alert rule: {path}")
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            add_failure(f"alert JSON invalid ({path}): {exc}")
            continue
        text = json.dumps(data)
        if 'http_server_duration_milliseconds' not in text:
            add_failure(
                f"alert {name} does not reference "
                f'http_server_duration_milliseconds_*',
            )
        if ' / ' not in text:
            add_failure(
                f"alert {name} does not contain a ratio expression "
                f"(` / ` math step); the error-rate alert must compute "
                f"5xx (or 4xx) over total requests, not an absolute rate "
                f"threshold",
            )


def assert_health_probe() -> None:
    probe_pkg = obs / 'health-probe' / 'package.json'
    if not probe_pkg.exists():
        add_failure(f"missing health-probe package.json: {probe_pkg}")
        return
    pkg = json.loads(probe_pkg.read_text())
    start_script = pkg.get('scripts', {}).get('start', '')
    if '--require @sindustries/otel-node/register' not in start_script:
        add_failure('health-probe start script must preload the OTel register hook')
    otel_spec = pkg.get('dependencies', {}).get('@sindustries/otel-node', '')
    if not otel_spec.startswith('file:'):
        add_failure('health-probe must reference @sindustries/otel-node via a file: dependency')
    else:
        resolved_otel = (probe_pkg.parent / otel_spec.removeprefix('file:')).resolve()
        expected_otel = (root / 'packages' / 'otel-node').resolve()
        if resolved_otel != expected_otel:
            add_failure(
                'health-probe @sindustries/otel-node path resolves to '
                f'{resolved_otel}, expected {expected_otel}',
            )
    server = (probe_pkg.parent / 'src' / 'server.ts').read_text()
    if "from '@sindustries/otel-node/register'" in server:
        add_failure(
            'health-probe server must not ESM-import the require-only OTel register export',
        )
    fly_config = (probe_pkg.parent / 'fly.toml').read_text()
    if "OTEL_SERVICE_NAME = 'health-probe'" not in fly_config:
        add_failure('health-probe Fly config must name the preloaded OTel service')
    for dep in ('@sindustries/otel-node', 'express', 'ioredis', 'pg', 'prom-client'):
        if dep not in pkg.get('dependencies', {}):
            add_failure(f"health-probe package.json missing dependency: {dep}")


assert_dashboards()
assert_alerts()
assert_bootstrap_references()
assert_health_probe()
assert_removed_alerts_absent()
assert_emitted_http_metric_contract()
assert_cloud_overview_metric_contract()
assert_alert_ratio_contract()

if failures:
    print(f"\n{len(failures)} failure(s) detected", file=sys.stderr)
    sys.exit(1)

print(
    f"OK: {len(EXPECTED_DASHBOARDS)} dashboards, "
    f"{len(EXPECTED_ALERTS)} alert rules, "
    f"{len(REMOVED_ALERTS)} disabled alerts absent, "
    f"hosted datasource discovery, bootstrap + health-probe present"
)
PY

# Exercise the production startup command, not just the source-level tests.
# This catches package-export and workspace-link failures that only appear when
# tsx applies the OTel preload hook before loading the ESM server entrypoint.
probe_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
probe_log="$(mktemp)"
probe_pid=''
cleanup_probe() {
  if [[ -n "${probe_pid}" ]]; then
    kill "${probe_pid}" >/dev/null 2>&1 || true
    wait "${probe_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${probe_log}"
}
trap cleanup_probe EXIT
OTEL_SDK_DISABLED=true PORT="${probe_port}" \
  npm run start --workspace infra/cloud/observability/health-probe \
  >"${probe_log}" 2>&1 &
probe_pid=$!

probe_ready=false
for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:${probe_port}/healthz" \
      | grep -q '"service":"health-probe"'; then
    probe_ready=true
    break
  fi
  if ! kill -0 "${probe_pid}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if [[ "${probe_ready}" != true ]]; then
  cat "${probe_log}" >&2
  echo 'FAIL: health-probe production start command did not serve /healthz' >&2
  exit 1
fi
echo 'OK: health-probe production start command serves /healthz'
