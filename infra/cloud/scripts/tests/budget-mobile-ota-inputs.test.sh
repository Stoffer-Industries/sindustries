#!/usr/bin/env bash
# Regression guard for the `budget_mobile` change filter (task 74503fe7,
# W39 audit F3).
#
# Before the W39 F3 fix, the filter only selected apps/budget-mobile/**,
# packages/budget-domain/**, and the root package/manifest files. A commit
# that changed only packages/ui/** or packages/design-tokens/** — both of
# which the mobile dashboard imports (apps/budget-mobile/src/screens/DashboardScreen.tsx:15)
# and, for ui, source-exported (packages/ui/package.json:7) — could pass CI
# without triggering the EAS `eas-update-production` job that publishes the
# OTA containing the change.
#
# AC coverage:
#   AC1 — UI-only commit selects budget_mobile
#   AC2 — design-tokens-only commit selects budget_mobile
#   AC3 — existing positives still select budget_mobile
#   AC4 — docs-only commit does NOT select budget_mobile
#   AC6 — parses the centralised filter from .github/workflows/ci.yml
#         (no EAS invocation, no live deploy)
#   AC7 — both missing-input cases fail against the OLD filter (UI-only
#         and tokens-only) and pass with T3's new filter lines

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


def selected(changed, filter_paths):
    return any(fnmatch.fnmatch(changed, pattern) for pattern in filter_paths)


failures = []

current = filters.get('budget_mobile')
if not isinstance(current, list):
    failures.append("ci.yml: changes filter 'budget_mobile' is missing or not a list")
    raise SystemExit(' / '.join(failures) or 'no failures')

# AC1: UI-only commit must select budget_mobile
if not selected('packages/ui/src/components/Button.tsx', current):
    failures.append(
        "AC1: packages/ui/** change must select budget_mobile "
        f"(filter={current!r})"
    )

if not selected('packages/ui/package.json', current):
    failures.append(
        "AC1: packages/ui/package.json change must select budget_mobile "
        f"(filter={current!r})"
    )

# AC2: design-tokens-only commit must select budget_mobile
if not selected('packages/design-tokens/src/colors.ts', current):
    failures.append(
        "AC2: packages/design-tokens/** change must select budget_mobile "
        f"(filter={current!r})"
    )

# AC3: existing positives must still select budget_mobile
for positive in (
    'apps/budget-mobile/src/App.tsx',
    'packages/budget-domain/src/index.ts',
    'package.json',
    'package-lock.json',
):
    if not selected(positive, current):
        failures.append(
            f"AC3: existing positive {positive!r} must still select budget_mobile "
            f"(filter={current!r})"
        )

# AC4: docs-only commits must not select budget_mobile
for doc_path in (
    'docs/specs/foo.md',
    'docs/repo-audits/2026-W40.md',
    'README.md',
    'AGENTS.md',
):
    if selected(doc_path, current):
        failures.append(
            f"AC4: docs-only commit {doc_path!r} must NOT select budget_mobile "
            f"(filter={current!r})"
        )

# AC7: confirm the OLD filter would have missed the new shared-input cases.
# The pre-fix filter is the historical baseline documented in the W39
# audit (F3) — apps/budget-mobile/**, packages/budget-domain/**, root
# package.json, root package-lock.json. The test asserts both
# regression cases against that baseline to demonstrate the audit
# finding is real and the fix is the only thing that closes it.
old_filter = [
    'apps/budget-mobile/**',
    'packages/budget-domain/**',
    'package.json',
    'package-lock.json',
]
regression_cases = (
    ('packages/ui/src/components/Button.tsx', old_filter, False),
    ('packages/design-tokens/src/colors.ts', old_filter, False),
    ('packages/ui/package.json', old_filter, False),
)
for changed, against, should_select in regression_cases:
    actual = selected(changed, against)
    if actual != should_select:
        failures.append(
            f"AC7: regression guard against old filter — "
            f"changed={changed!r} expected_selected={should_select} got={actual}"
        )

# Sanity: docs-only must also not select under the OLD filter
for doc_path in ('docs/specs/foo.md', 'README.md'):
    if selected(doc_path, old_filter):
        failures.append(
            f"AC7 sanity: docs-only commit {doc_path!r} unexpectedly selected "
            f"budget_mobile under old filter"
        )

# Sanity: the positive cases still select under both filters, so AC3 is
# exercised against both the old baseline and the new filter above.
for positive in (
    'apps/budget-mobile/src/App.tsx',
    'packages/budget-domain/src/index.ts',
    'package.json',
    'package-lock.json',
):
    if not selected(positive, old_filter):
        failures.append(
            f"AC3 baseline: existing positive {positive!r} unexpectedly "
            f"missed by old filter"
        )

if failures:
    for failure in failures:
        print(f'FAIL: {failure}', file=sys.stderr)
    raise SystemExit(1)

print('budget-mobile-ota-inputs: ok')
PY
