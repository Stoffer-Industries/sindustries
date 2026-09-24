#!/usr/bin/env bash
# Provisioning contract test for the hosted observability stack
# (task 31233a0a — AC1/AC2 evidence).
#
# Validates that the JSON artefacts under infra/cloud/observability/grafana/
# and the datasources YAML are present and well-formed, without invoking
# Grafana Cloud or EAS. This is the offline half of AC1/AC2 evidence; the
# live half is captured in the closing PR's screenshot/export.
#
# AC coverage:
#   AC1 — hosted observability stack has the expected runtime artefacts
#         (dashboards, datasources, health probe) so a live hosted Grafana
#         can be provisioned against them.
#   AC2 — ten alert rules with severity + owner populated. This test
#         asserts the alert JSONs have a `labels.severity` and
#         `labels.owner` field per the tech design §6.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import json
import pathlib
import sys

import yaml

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


def assert_datasources() -> None:
    path = obs / 'grafana' / 'datasources.yaml'
    if not path.exists():
        add_failure(f"missing datasources: {path}")
        return
    data = yaml.safe_load(path.read_text())
    names = {d.get('name') for d in data.get('datasources', [])}
    for expected in ('Prometheus', 'Tempo', 'Postgres'):
        if expected not in names:
            add_failure(f"datasources.yaml missing expected datasource: {expected}")


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
        '/api/v1/provisioning/alert-rules',
        'HEALTH_PROBE_DATABASES',
    ):
        if expected not in body:
            add_failure(f"bootstrap-observability.sh missing reference to {expected}")


def assert_health_probe() -> None:
    probe_pkg = obs / 'health-probe' / 'package.json'
    if not probe_pkg.exists():
        add_failure(f"missing health-probe package.json: {probe_pkg}")
        return
    pkg = json.loads(probe_pkg.read_text())
    for dep in ('@sindustries/otel-node', 'express', 'ioredis', 'pg', 'prom-client'):
        if dep not in pkg.get('dependencies', {}):
            add_failure(f"health-probe package.json missing dependency: {dep}")


assert_dashboards()
assert_alerts()
assert_datasources()
assert_bootstrap_references()
assert_health_probe()

if failures:
    print(f"\n{len(failures)} failure(s) detected", file=sys.stderr)
    sys.exit(1)

print(
    f"OK: {len(EXPECTED_DASHBOARDS)} dashboards, "
    f"{len(EXPECTED_ALERTS)} alert rules, "
    f"3 datasources, bootstrap + health-probe present"
)
PY
