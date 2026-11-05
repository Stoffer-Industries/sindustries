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
#   3. The orphan guard from #918 covered that one directory. Contract tests
#      also live in `infra/cloud/bin/tests/`, `agents/lib/tests/`,
#      `tests/cloud/tests/` and `scripts/test/`, and the same invariant was
#      unenforced in all four: a contract test added there and wired to no
#      job would silently never run. It was not hypothetical — eight
#      contract tests on disk are run by no CI job today, including the
#      five stable-hostname and CORS matrix suites the task-5cb4a8fe slices
#      shipped.
#
# This test makes the documented lists and the executable run steps one
# mechanically comparable pair in both directions, for every job that runs
# contract tests, adds the orphan guard in both directions, and carries
# sentinel self-tests proving each assertion can go red. It now also holds
# the orphan guard to every contract-test directory: each contract test
# outside `infra/cloud/scripts/tests/` must be run by a CI job or be
# recorded as one that no job runs, and that record is asserted against the
# files on disk and against the "Contract tests not run by CI" section of
# CONTRIBUTING.md in both directions, so it cannot grow silently and cannot
# go stale.

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


# The directories that hold contract tests outside the shared contract-test
# directory. The orphan guard above covers `infra/cloud/scripts/tests/`;
# these four are where the same drift was live.
CONTRACT_TEST_DIRS = (
    'infra/cloud/bin/tests/',
    'agents/lib/tests/',
    'tests/cloud/tests/',
    'scripts/test/',
)

# Contract tests that no CI job runs. Each one is recorded here and in the
# "Contract tests not run by CI" section of CONTRIBUTING.md, and the two are
# asserted to name the same files, so a contract test that no job executes is
# visible instead of silent, and a new one fails the gate.
NOT_RUN_BY_CI = frozenset({
    'scripts/test/build-tailwind-theme.test.mjs',
    'scripts/test/check-no-legacy-approval-marker.test.mjs',
    'tests/cloud/tests/check-cors-origin-matrix.test.mjs',
    'tests/cloud/tests/check-deploy-workflow-stable-hostname.test.mjs',
    'tests/cloud/tests/check-stable-hostname-matrix.test.mjs',
    'tests/cloud/tests/check-stable-url-fallbacks.test.mjs',
    'tests/cloud/tests/check-vercel-env-matrix.test.mjs',
    'tests/cloud/tests/staging-db-migration-failure-drill.test.sh',
})


def is_contract_test(name):
    """Whether a file name is a contract test rather than a helper."""
    return (
        name.endswith('.test.sh')
        or name.endswith('.test.mjs')
        or (name.startswith('test_') and name.endswith('.sh'))
    )


def all_contract_tests():
    """Every contract test on disk, across every contract-test directory."""
    found = {}
    for directory in CONTRACT_TEST_DIRS:
        path = root / directory
        if not path.is_dir():
            continue
        found[directory] = sorted(
            f'{directory}{child.name}'
            for child in path.iterdir()
            if child.is_file() and is_contract_test(child.name)
        )
    return found


def ci_run_texts(workflow_text):
    """Every line that belongs to a `run:` step, single-line or block scalar."""
    texts = []
    block_indent = None
    for line in workflow_text.splitlines():
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if block_indent is not None:
            if stripped and indent <= block_indent:
                block_indent = None
            else:
                texts.append(line)
                continue
        match = re.match(r'^\s*(?:-\s+)?run:\s*(.*)$', line)
        if match is None:
            continue
        value = match.group(1).strip()
        if value in ('|', '|-', '|+', '>', '>-', '>+'):
            block_indent = indent
            continue
        texts.append(line)
    return texts


def ci_executed_paths(workflow_texts, paths):
    """Which of `paths` a CI job actually executes."""
    texts = []
    for text in workflow_texts.values():
        texts.extend(ci_run_texts(text))
    executed = set()
    for path in paths:
        pattern = re.compile(rf'(?<![\w./-]){re.escape(path)}(?![\w./-])')
        if any(pattern.search(text) for text in texts):
            executed.add(path)
    return executed


def documented_not_run(contributing_text):
    """The contract tests CONTRIBUTING.md records as run by no CI job."""
    lines = contributing_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == '### Contract tests not run by CI':
            start = index + 1
            break
    if start is None:
        return None
    names = []
    for line in lines[start:]:
        if line.startswith('### ') or line.startswith('## '):
            break
        bullet = re.match(r'^- `([^`]+)`', line)
        if bullet and is_contract_test(bullet.group(1)):
            names.append(bullet.group(1))
    return sorted(set(names))


def check_orphan_scope(workflow_texts, contributing_text, disk_tests, not_run):
    """Every contract test outside the shared directory must be run or recorded."""
    problems = []

    every_path = sorted(path for paths in disk_tests.values() for path in paths)
    executed = ci_executed_paths(workflow_texts, every_path)

    for path in every_path:
        if path in executed or path in not_run:
            continue
        problems.append(
            f'{path}: is not run by any CI job and is not recorded as a contract '
            'test that no CI job runs'
        )

    for path in sorted(not_run):
        if path not in every_path:
            problems.append(
                f'{path}: is recorded as a contract test that no CI job runs, but no '
                'such file exists on disk'
            )
        elif path in executed:
            problems.append(
                f'{path}: is recorded as a contract test that no CI job runs, but a CI '
                'job runs it'
            )

    documented = documented_not_run(contributing_text)
    if documented is None:
        problems.append(
            f'{CONTRIBUTING}: no `### Contract tests not run by CI` section found'
        )
    else:
        for path in sorted(set(documented) - set(not_run)):
            problems.append(
                f'{CONTRIBUTING}: lists `{path}` as a contract test that no CI job runs, '
                'but the guard does not record it'
            )
        for path in sorted(set(not_run) - set(documented)):
            problems.append(
                f'{CONTRIBUTING}: does not list `{path}`, which the guard records as a '
                'contract test that no CI job runs'
            )

    return problems


ci_text = (root / CI_WORKFLOW).read_text()
contributing_text = (root / CONTRIBUTING).read_text()
disk_scripts = on_disk_scripts()

if disk_scripts is None:
    fail(f'{SCRIPT_DIR}: contract-test directory not found')
else:
    for problem in check(ci_text, contributing_text, disk_scripts):
        fail(problem)

# Orphan guard for the contract-test directories the guard above does not
# cover. Every workflow counts, not only `ci.yml`: a contract test wired into
# a deployment workflow is run, and one wired into no workflow is not.
workflow_texts = {}
for workflow in sorted((root / '.github/workflows').glob('*.y*ml')):
    workflow_texts[workflow.name] = workflow.read_text()
disk_tests = all_contract_tests()
for problem in check_orphan_scope(
    workflow_texts, contributing_text, disk_tests, NOT_RUN_BY_CI
):
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

# Sentinel self-tests for the orphan guard across the other contract-test
# directories: each drift shape below must be detected, so a green run means
# the new assertions can actually go red rather than passing vacuously.
orphan_sentinels = [
    (
        'a contract test exists outside the shared directory that no CI job runs',
        workflow_texts,
        contributing_text,
        {
            **disk_tests,
            'tests/cloud/tests/': sorted(
                disk_tests.get('tests/cloud/tests/', [])
                + ['tests/cloud/tests/orphan-contract.test.mjs']
            ),
        },
        NOT_RUN_BY_CI,
    ),
    (
        'a recorded contract test no longer exists on disk',
        workflow_texts,
        contributing_text,
        disk_tests,
        set(NOT_RUN_BY_CI) | {'tests/cloud/tests/deleted-contract.test.mjs'},
    ),
    (
        'a recorded contract test is run by a CI job',
        {
            **workflow_texts,
            'sentinel.yml': (
                'jobs:\n'
                '  sentinel:\n'
                '    steps:\n'
                '      - run: node --test tests/cloud/tests/check-cors-origin-matrix.test.mjs\n'
            ),
        },
        contributing_text,
        disk_tests,
        NOT_RUN_BY_CI,
    ),
    (
        'the documentation omits a recorded contract test',
        workflow_texts,
        mutate(
            contributing_text,
            r'`tests/cloud/tests/check-cors-origin-matrix\.test\.mjs`',
            '',
            'recorded contract test removed from the documentation',
        ),
        disk_tests,
        NOT_RUN_BY_CI,
    ),
    (
        'the documentation names a contract test the guard does not record',
        workflow_texts,
        mutate(
            contributing_text,
            r'- `tests/cloud/tests/check-cors-origin-matrix\.test\.mjs`',
            '- `tests/cloud/tests/not-recorded.test.mjs`',
            'recorded contract test renamed in the documentation',
        ),
        disk_tests,
        NOT_RUN_BY_CI,
    ),
]

for label, mutated_workflows, mutated_contributing, mutated_disk, mutated_not_run in orphan_sentinels:
    if not check_orphan_scope(
        mutated_workflows, mutated_contributing, mutated_disk, mutated_not_run
    ):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('ci-job-script-inventory: ok')
PY
