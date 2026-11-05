#!/usr/bin/env bash
# Static contract: the contract tests CONTRIBUTING.md documents for the
# `infra-cloud-bootstrap-staging-tests` CI job must match the job's own run
# steps.
#
# Finding (W44 code-garden follow-up, T5 continued): CONTRIBUTING.md's CI
# inventory described that job as "infra/cloud bootstrap, fly.toml, and
# no-pnpm-pin tests", but the job runs nine contract-test scripts. Three of
# them - `mission-control-deploy-fixtures.test.sh`,
# `fly-deploy-trigger-paths.test.sh` and `budget-mobile-ota-inputs.test.sh` -
# were named nowhere in the documentation at all. The documented list and the
# executable list were two sources of truth for one fact, and nothing
# compared them - the same prose-versus-executable drift that PRs #905-#907
# closed for the CI job inventory and that PRs #911 and #914 closed for the
# local test commands and the path-lint scope.
#
# The consequence was concrete: a contributor who edited (or assumed dead)
# one of the three undocumented contract tests had no signal that CI executes
# it, and a contributor reading the inventory could not tell which contracts
# actually gate a merge.
#
# This test makes the documented list and the job's run steps one
# mechanically comparable pair, in both directions, and carries sentinel
# self-tests proving each assertion can go red.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
failures = []

JOB_ID = 'infra-cloud-bootstrap-staging-tests'
CONTRIBUTING = 'CONTRIBUTING.md'
CI_WORKFLOW = '.github/workflows/ci.yml'
SCRIPT_DIR = 'infra/cloud/scripts/tests/'

TEST_SCRIPT_RE = re.compile(rf'^{re.escape(SCRIPT_DIR)}[A-Za-z0-9._-]+\.test\.sh$')
BACKTICKED_RE = re.compile(r'`([^`]+)`')


def fail(message):
    failures.append(message)


def ci_job_scripts(ci_text):
    """The contract-test scripts the named CI job runs, in job order."""
    lines = ci_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if re.match(rf'^  {re.escape(JOB_ID)}:\s*$', line):
            start = index
            break
    if start is None:
        return None
    scripts = []
    for line in lines[start + 1:]:
        if re.match(r'^  [A-Za-z0-9_-]+:\s*$', line):
            break
        match = re.search(rf'run:\s*(?:bash\s+)?({re.escape(SCRIPT_DIR)}[A-Za-z0-9._-]+\.test\.sh)', line)
        if match:
            scripts.append(match.group(1))
    return scripts


def documented_scripts(contributing_text):
    """The contract-test scripts the CONTRIBUTING.md inventory names for the job."""
    lines = contributing_text.splitlines()
    bullet = None
    for index, line in enumerate(lines):
        if line.startswith('- ') and f'`{JOB_ID}`' in line:
            bullet = index
            break
    if bullet is None:
        return None
    body = [lines[bullet]]
    for line in lines[bullet + 1:]:
        if line.startswith('- ') or line.strip() == '':
            break
        body.append(line)
    names = []
    for token in BACKTICKED_RE.findall('\n'.join(body)):
        name = token if token.startswith(SCRIPT_DIR) else f'{SCRIPT_DIR}{token}'
        if TEST_SCRIPT_RE.match(name):
            names.append(name)
    return names


def check(ci_text, contributing_text):
    """Every drift this contract guards against, as a list of messages."""
    problems = []

    ci_scripts = ci_job_scripts(ci_text)
    if ci_scripts is None:
        problems.append(f'{CI_WORKFLOW}: no `{JOB_ID}` job found')
        return problems

    doc_scripts = documented_scripts(contributing_text)
    if doc_scripts is None:
        problems.append(f'{CONTRIBUTING}: no inventory bullet for `{JOB_ID}` found')
        return problems

    if not ci_scripts:
        problems.append(f'{CI_WORKFLOW}: the `{JOB_ID}` job runs no contract-test script')
    if not doc_scripts:
        problems.append(f'{CONTRIBUTING}: the `{JOB_ID}` inventory bullet names no contract-test script')

    for script in sorted(set(ci_scripts) - set(doc_scripts)):
        problems.append(
            f'{CI_WORKFLOW}: `{JOB_ID}` runs `{script}`, which is not documented'
        )
    for script in sorted(set(doc_scripts) - set(ci_scripts)):
        problems.append(
            f'{CONTRIBUTING}: documents `{script}` as a `{JOB_ID}` contract test, '
            'but the job does not run it'
        )

    duplicates = sorted({s for s in doc_scripts if doc_scripts.count(s) > 1})
    for script in duplicates:
        problems.append(
            f'{CONTRIBUTING}: documents `{script}` more than once for `{JOB_ID}`'
        )

    return problems


ci_text = (root / CI_WORKFLOW).read_text()
contributing_text = (root / CONTRIBUTING).read_text()

for problem in check(ci_text, contributing_text):
    fail(problem)


# Sentinel self-tests: each drift shape below must be detected, so a green
# run means the assertions can actually go red rather than passing vacuously.
def mutate(text, pattern, replacement, label):
    mutated, count = re.subn(pattern, replacement, text, count=1)
    if not count:
        fail(f'sentinel self-test could not be applied (pattern moved): {label}')
        return text
    return mutated


sentinels = [
    (
        'the job runs a contract test that is not documented',
        mutate(
            ci_text,
            r'run: bash infra/cloud/scripts/tests/budget-mobile-ota-inputs\.test\.sh',
            'run: bash infra/cloud/scripts/tests/undocumented-contract.test.sh',
            'undocumented contract test',
        ),
        contributing_text,
    ),
    (
        'the job stops running a documented contract test',
        mutate(
            ci_text,
            r'run: bash infra/cloud/scripts/tests/budget-mobile-ota-inputs\.test\.sh',
            'run: bash infra/cloud/scripts/tests/renamed-contract.test.sh',
            'renamed contract test',
        ),
        contributing_text,
    ),
    (
        'CONTRIBUTING.md documents a contract test the job does not run',
        ci_text,
        mutate(
            contributing_text,
            r'`budget-mobile-ota-inputs\.test\.sh`',
            '`not-run-contract.test.sh`',
            'documented contract test removed',
        ),
    ),
    (
        'CONTRIBUTING.md drops a contract test the job runs',
        ci_text,
        mutate(
            contributing_text,
            r'`budget-mobile-ota-inputs\.test\.sh`',
            '',
            'documented contract test dropped',
        ),
    ),
    (
        'CONTRIBUTING.md documents the same contract test twice',
        ci_text,
        mutate(
            contributing_text,
            r'`budget-mobile-ota-inputs\.test\.sh`',
            '`budget-mobile-ota-inputs.test.sh`, `budget-mobile-ota-inputs.test.sh`',
            'duplicated contract test',
        ),
    ),
]

for label, mutated_ci, mutated_contributing in sentinels:
    if not check(mutated_ci, mutated_contributing):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('ci-job-script-inventory: ok')
PY
