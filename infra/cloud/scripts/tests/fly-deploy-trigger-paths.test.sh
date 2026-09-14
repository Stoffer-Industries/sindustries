#!/usr/bin/env bash
# Regression guard for Fly deploy change filters (task 2b66ae79, moved to
# the central CI caller by task 02c5475c).

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import fnmatch
import pathlib
import sys

import yaml

root = pathlib.Path(sys.argv[1])
ci_path = root / '.github' / 'workflows' / 'ci.yml'
ci = yaml.safe_load(ci_path.read_text())
steps = ci['jobs']['changes']['steps']
filter_step = next(step for step in steps if step.get('id') == 'filter')
filters = yaml.safe_load(filter_step['with']['filters'])

names = ('tasks_api', 'budget_api', 'auto_post_worker', 'gymtrack_mcp')
failures = []
for name in names:
    paths = filters.get(name)
    if not isinstance(paths, list):
        failures.append(f'ci.yml: changes filter {name!r} is missing or not a list')
        continue
    if 'package.json' not in paths:
        failures.append(f'ci.yml: changes filter {name!r} is missing package.json')
    if 'package-lock.json' not in paths:
        failures.append(f'ci.yml: changes filter {name!r} is missing package-lock.json')
    if 'pnpm-lock.yaml' in paths:
        failures.append(f'ci.yml: changes filter {name!r} contains pnpm-lock.yaml')


def selected(changed):
    return {
        name
        for name in names
        if any(fnmatch.fnmatch(changed, pattern) for pattern in filters.get(name, []))
    }


expected_all = set(names)
cases = (
    ('package-lock.json', expected_all),
    ('package.json', expected_all),
    ('docs/specs/foo.md', set()),
    ('apps/website/src/App.jsx', set()),
)
for changed, expected in cases:
    actual = selected(changed)
    if actual != expected:
        failures.append(
            f'synthetic commit {changed!r}: expected {sorted(expected)}, got {sorted(actual)}'
        )

if failures:
    for failure in failures:
        print(f'FAIL: {failure}', file=sys.stderr)
    raise SystemExit(1)

print('fly-deploy-trigger-paths: ok')
PY
