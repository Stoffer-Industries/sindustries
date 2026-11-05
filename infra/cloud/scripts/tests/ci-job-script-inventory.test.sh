#!/usr/bin/env bash
# Static contract: the contract tests CONTRIBUTING.md documents for the CI
# jobs that run them must match those jobs' own run steps, and every contract
# test on disk must actually be run by some CI job.
#
# Finding (W44 code-garden follow-up, T5 continued): PR #915 closed the gap
# for one job — CONTRIBUTING.md's inventory described the
# `infra-cloud-bootstrap-staging-tests` job as "infra/cloud bootstrap,
# fly.toml, and no-pnpm-pin tests", while the job runs ten contract-test
# scripts, three of which were named nowhere in the documentation. The same
# class was still open one surface over:
#
#   1. The parity check was hard-coded to a single job. The second CI job
#      that runs contract tests from the same directory,
#      `health-probe-tests`, had no parity check at all, and its two
#      contract tests were documented only in prose ("the observability
#      provisioning / bootstrap / evidence / failure-inject contract
#      tests"), so a contributor could not tell which file to edit for
#      "failure-inject".
#   2. Nothing required a contract test to be wired into CI at all. The
#      directory `infra/cloud/scripts/tests/` is the shared home of the
#      contract-test suite, but a new `*.test.sh` file added there and not
#      referenced by any job would never run — and every gate would stay
#      green. A contract test that no CI job executes is a test that
#      asserts nothing.
#
# This test makes the documented lists and the executable run steps one
# mechanically comparable pair in both directions, for every job that runs
# contract tests, adds the orphan guard in both directions, and carries
# sentinel self-tests proving each assertion can go red.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
failures = []

CONTRIBUTING = 'CONTRIBUTING.md'
CI_WORKFLOW = '.github/workflows/ci.yml'
SCRIPT_DIR = 'infra/cloud/scripts/tests/'

TEST_SCRIPT_RE = re.compile(rf'^{re.escape(SCRIPT_DIR)}[A-Za-z0-9._-]+\.test\.sh$')
BACKTICKED_RE = re.compile(r'`([^`]+)`')
JOB_ID_RE = re.compile(r'^  ([A-Za-z0-9_-]+):\s*$')
RUN_SCRIPT_RE = re.compile(
    rf'run:\s*(?:bash\s+)?({re.escape(SCRIPT_DIR)}[A-Za-z0-9._-]+\.test\.sh)'
)


def fail(message):
    failures.append(message)


def ci_jobs(ci_text):
    """Map every CI job id to the contract-test scripts it runs, in job order."""
    lines = ci_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.rstrip() == 'jobs:':
            start = index + 1
            break
    if start is None:
        return None
    jobs = {}
    job = None
    for line in lines[start:]:
        job_match = JOB_ID_RE.match(line)
        if job_match:
            job = job_match.group(1)
            continue
        if job is None:
            continue
        script_match = RUN_SCRIPT_RE.search(line)
        if script_match:
            jobs.setdefault(job, []).append(script_match.group(1))
    return jobs


def documented_scripts(contributing_text, job_id):
    """The contract-test scripts the CONTRIBUTING.md inventory names for a job."""
    lines = contributing_text.splitlines()
    bullet = None
    for index, line in enumerate(lines):
        if line.startswith('- ') and f'`{job_id}`' in line:
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


def on_disk_scripts():
    """Every contract test that exists in the shared contract-test directory."""
    directory = root / SCRIPT_DIR
    if not directory.is_dir():
        return None
    return sorted(
        f'{SCRIPT_DIR}{path.name}'
        for path in directory.iterdir()
        if path.is_file() and path.name.endswith('.test.sh')
    )


def check(ci_text, contributing_text, disk_scripts):
    """Every drift this contract guards against, as a list of messages."""
    problems = []

    jobs = ci_jobs(ci_text)
    if jobs is None:
        problems.append(f'{CI_WORKFLOW}: no `jobs:` section found')
        return problems

    if not jobs:
        problems.append(
            f'{CI_WORKFLOW}: no CI job runs a contract test from `{SCRIPT_DIR}`'
        )
        return problems

    run_scripts = set()
    for job_id, scripts in jobs.items():
        run_scripts.update(scripts)

        doc_scripts = documented_scripts(contributing_text, job_id)
        if doc_scripts is None:
            problems.append(f'{CONTRIBUTING}: no inventory bullet for `{job_id}` found')
            continue
        if not doc_scripts:
            problems.append(
                f'{CONTRIBUTING}: the `{job_id}` inventory bullet names no contract-test script'
            )

        for script in sorted(set(scripts) - set(doc_scripts)):
            problems.append(
                f'{CI_WORKFLOW}: `{job_id}` runs `{script}`, which is not documented'
            )
        for script in sorted(set(doc_scripts) - set(scripts)):
            problems.append(
                f'{CONTRIBUTING}: documents `{script}` as a `{job_id}` contract test, '
                'but the job does not run it'
            )

        duplicates = sorted({s for s in doc_scripts if doc_scripts.count(s) > 1})
        for script in duplicates:
            problems.append(
                f'{CONTRIBUTING}: documents `{script}` more than once for `{job_id}`'
            )

    # Orphan guard: a contract test that no CI job runs asserts nothing.
    for script in sorted(set(disk_scripts) - run_scripts):
        problems.append(
            f'{SCRIPT_DIR}: `{script}` is not run by any CI job in `{CI_WORKFLOW}`'
        )

    # Reverse guard: a CI job cannot run a contract test that does not exist.
    for script in sorted(run_scripts - set(disk_scripts)):
        problems.append(f'{CI_WORKFLOW}: runs `{script}`, which does not exist')

    return problems


ci_text = (root / CI_WORKFLOW).read_text()
contributing_text = (root / CONTRIBUTING).read_text()
disk_scripts = on_disk_scripts()

if disk_scripts is None:
    fail(f'{SCRIPT_DIR}: contract-test directory not found')
else:
    for problem in check(ci_text, contributing_text, disk_scripts):
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
        disk_scripts,
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
        disk_scripts,
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
        disk_scripts,
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
        disk_scripts,
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
        disk_scripts,
    ),
    (
        'a second CI job runs a contract test its inventory bullet does not name',
        ci_text,
        mutate(
            contributing_text,
            r'`observability-provisioning\.test\.sh`',
            '',
            'health-probe contract test dropped',
        ),
        disk_scripts,
    ),
    (
        'a CI job that runs contract tests has no inventory bullet',
        ci_text,
        mutate(
            contributing_text,
            r'`health-probe-tests`',
            '`health-probe-tests-renamed`',
            'health-probe job id renamed',
        ),
        disk_scripts,
    ),
    (
        'a CI job runs a contract test that does not exist on disk',
        mutate(
            ci_text,
            r'run: bash infra/cloud/scripts/tests/observability-bootstrap\.test\.sh',
            'run: bash infra/cloud/scripts/tests/ghost-contract.test.sh',
            'ghost contract test',
        ),
        contributing_text,
        disk_scripts,
    ),
    (
        'a contract test exists on disk that no CI job runs',
        ci_text,
        contributing_text,
        sorted(set(disk_scripts) | {f'{SCRIPT_DIR}orphan-contract.test.sh'}),
    ),
]

for label, mutated_ci, mutated_contributing, mutated_disk in sentinels:
    if not check(mutated_ci, mutated_contributing, mutated_disk):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('ci-job-script-inventory: ok')
PY
