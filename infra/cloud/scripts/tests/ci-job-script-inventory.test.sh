#!/usr/bin/env bash
# Static contract: the contract tests CONTRIBUTING.md documents for the CI
# jobs that run them must match those jobs' own run steps, and every contract
# test on disk must actually be run by a CI job.
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
#   4. The orphan guard's subject set was a list written inside the guard,
#      so the same drift stayed live in every directory the list did not
#      name, and the guard's own documentation claimed a repo-wide fact
#      the list could not back: six more contract tests in three more
#      directories were run by no job, and two more directories hold
#      contract tests that are run only through an npm script and a glob,
#      which a literal-path match cannot see.
#
# This test makes the documented lists and the executable run steps one
# mechanically comparable pair in both directions, for every job that runs
# contract tests, and adds the orphan guard in both directions. The orphan
# guard now derives its subject set from the working tree rather than from
# a list of directories, so a contract test added to a directory it has
# never seen is covered the moment it lands; it resolves how CI runs a
# contract test — a literal runner argument, a glob a runner expands, or an
# npm script whose command runs one — so a contract test wired only through
# `npm test --workspace …` is not reported as an orphan; and it keeps the
# "contract tests not run by CI" ledger honest in both directions, against
# the files on disk, against the workflows' run steps, and against
# CONTRIBUTING.md. Sentinel self-tests prove each assertion can go red.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import glob
import json
import os
import pathlib
import re
import shlex
import sys
import tempfile

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


# The shapes this guard covers. A contract test is a shell test (`*.test.sh`
# or `test_*.sh`) or an mjs test (`*.test.mjs`). TypeScript and Python tests
# are unit tests with their own CI suites, and are out of scope here.
CONTRACT_TEST_SUFFIXES = ('.test.sh', '.test.mjs')

# Directories that never hold source contract tests. Pruning them keeps the
# derivation from walking installed dependencies or build output.
SKIP_DIRECTORIES = frozenset({
    '.git',
    '.next',
    '.turbo',
    '__pycache__',
    'build',
    'coverage',
    'dist',
    'node_modules',
})


def is_contract_test(name):
    """Whether a file name is a contract test rather than a helper."""
    return (
        name.endswith('.test.sh')
        or name.endswith('.test.mjs')
        or (name.startswith('test_') and name.endswith('.sh'))
    )


def all_contract_tests(base=None):
    """Every contract test on disk, grouped by the directory that holds it.

    The subject set is derived from the working tree rather than listed, so
    a contract test added to a directory this guard has never seen is
    covered the moment it lands.
    """
    base = pathlib.Path(base) if base is not None else root
    found = {}
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(
            name for name in dirnames if name not in SKIP_DIRECTORIES
        )
        for name in sorted(filenames):
            if not is_contract_test(name):
                continue
            relative = os.path.relpath(os.path.join(dirpath, name), base)
            relative = relative.replace(os.sep, '/')
            directory = os.path.dirname(relative)
            key = f'{directory}/' if directory else './'
            found.setdefault(key, []).append(relative)
    return {key: sorted(values) for key, values in sorted(found.items())}


# Contract tests that no CI workflow runs. Each one is recorded here and in
# the "Contract tests not run by CI" section of CONTRIBUTING.md, and the two
# are asserted to name the same files, so a contract test that no workflow
# executes is visible instead of silent, and a new one fails the gate.
NOT_RUN_BY_CI = frozenset({
    'agents/skills/dev/pr-open/tests/test_assert_opener_identity.sh',
    'scripts/cloud/database/tests/common.test.sh',
    'scripts/cloud/database/tests/manifest-constraints.test.sh',
    'scripts/cloud/database/tests/restore-result-dir.test.sh',
    'scripts/cloud/database/tests/schema-presence.test.sh',
    'scripts/ops/tests/sync-agent-definitions.test.sh',
    'scripts/test/build-tailwind-theme.test.mjs',
    'scripts/test/check-no-legacy-approval-marker.test.mjs',
    'tests/cloud/tests/check-cors-origin-matrix.test.mjs',
    'tests/cloud/tests/check-deploy-workflow-stable-hostname.test.mjs',
    'tests/cloud/tests/check-stable-hostname-matrix.test.mjs',
    'tests/cloud/tests/check-stable-url-fallbacks.test.mjs',
    'tests/cloud/tests/check-vercel-env-matrix.test.mjs',
    'tests/cloud/tests/staging-db-migration-failure-drill.test.sh',
})


def join_directory(base, path):
    """A repository-relative directory, from a base directory and a path."""
    if path.startswith('/'):
        return path.lstrip('/')
    if not base:
        return os.path.normpath(path).replace(os.sep, '/')
    return os.path.normpath(os.path.join(base, path)).replace(os.sep, '/')


def split_commands(line):
    """The logical commands in one shell line, split on `&&`, `||`, `;`, `|`."""
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = '#'
    try:
        tokens = list(lexer)
    except ValueError:
        return []
    segments = []
    current = []
    for token in tokens:
        if token in ('&&', '||', ';', '|', '&'):
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def ci_run_steps(workflow_text):
    """Every `run:` step in a workflow, as (body, working directory).

    The working directory is the step's own `working-directory:`, else the
    job's `defaults.run.working-directory`, else the repository root.
    """
    lines = workflow_text.splitlines()
    steps = []
    index = 0
    defaults_working_directory = None
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped == 'defaults:' and indent <= 4:
            cursor = index + 1
            defaults_working_directory = None
            while cursor < len(lines):
                candidate = lines[cursor]
                if candidate.strip() and (
                    len(candidate) - len(candidate.lstrip())
                ) <= indent:
                    break
                match = re.match(r'^\s*working-directory:\s*(\S+)\s*$', candidate)
                if match:
                    defaults_working_directory = match.group(1)
                cursor += 1
            index = cursor
            continue
        working_directory = None
        match = re.match(r'^\s*working-directory:\s*(\S+)\s*$', line)
        if match:
            working_directory = match.group(1)
        match = re.match(r'^\s*(?:-\s+)?run:\s*(.*)$', line)
        if match:
            value = match.group(1).strip()
            if value in ('|', '|-', '|+', '>', '>-', '>+'):
                body = []
                cursor = index + 1
                while cursor < len(lines):
                    candidate = lines[cursor]
                    if candidate.strip():
                        candidate_indent = len(candidate) - len(candidate.lstrip())
                        if candidate_indent <= indent:
                            break
                    body.append(candidate)
                    cursor += 1
                steps.append((
                    '\n'.join(body),
                    working_directory or defaults_working_directory,
                ))
                index = cursor
                continue
            steps.append((value, working_directory or defaults_working_directory))
        index += 1
    return steps


def step_commands(body, working_directory):
    """The logical commands in a run step, each with its working directory."""
    directory = working_directory or ''
    commands = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        change = re.match(r'^cd\s+(\S+)', line)
        if change:
            directory = join_directory(directory, change.group(1))
            continue
        for tokens in split_commands(line):
            commands.append((tokens, directory))
    return commands


def read_manifest(directory):
    """The package.json of a directory, or an empty manifest."""
    path = (root / directory / 'package.json') if directory else (root / 'package.json')
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


WORKSPACE_PACKAGES = None


def workspace_packages():
    """Map every workspace package name to its directory."""
    global WORKSPACE_PACKAGES
    if WORKSPACE_PACKAGES is None:
        packages = {}
        manifest = read_manifest('')
        workspaces = manifest.get('workspaces', [])
        if isinstance(workspaces, dict):
            workspaces = workspaces.get('packages', [])
        for pattern in workspaces:
            for path in sorted(glob.glob(str(root / pattern))):
                if not os.path.isdir(path):
                    continue
                relative = os.path.relpath(path, root).replace(os.sep, '/')
                name = read_manifest(relative).get('name')
                if name:
                    packages[name] = relative
        WORKSPACE_PACKAGES = packages
    return WORKSPACE_PACKAGES


def resolve_workspace(spec, directory):
    """The directory an npm `--workspace` spec names.

    The spec is a package name (`@sindustries/design-tokens`) or a path
    (`services/tasks-api`); a scoped name contains a slash too, so the
    workspace map is consulted first.
    """
    packages = workspace_packages()
    if spec in packages:
        return packages[spec]
    if '/' in spec or spec.startswith('.'):
        return join_directory(directory, spec)
    return directory


def expand_paths(arguments, directory):
    """The files runner arguments name, with globs expanded."""
    targets = []
    for argument in arguments:
        if argument.startswith('-'):
            continue
        candidate = join_directory(directory, argument)
        if any(character in argument for character in '*?['):
            for match in glob.glob(str(root / candidate)):
                if os.path.isfile(match):
                    targets.append(os.path.relpath(match, root).replace(os.sep, '/'))
        elif (root / candidate).is_file():
            targets.append(candidate)
    return targets


def npm_targets(arguments, directory, visited):
    """The files an npm invocation runs, resolved through package.json.

    `npm test --workspace @sindustries/design-tokens` runs the package's own
    `test` script, and `npm --prefix tests/cloud run test:…` runs a script of
    the package under that prefix. The script's command is resolved the same
    way a shell command is, so a script that runs `node --test scripts/*.test.mjs`
    is understood to run those files.
    """
    prefix = None
    workspace = None
    verb = None
    script = None
    index = 0
    while index < len(arguments):
        token = arguments[index]
        if token == '--':
            break
        if token in ('--prefix', '-C'):
            index += 1
            prefix = arguments[index] if index < len(arguments) else None
        elif token in ('--workspace', '-w'):
            index += 1
            workspace = arguments[index] if index < len(arguments) else None
        elif token.startswith('--prefix='):
            prefix = token.split('=', 1)[1]
        elif token.startswith('--workspace='):
            workspace = token.split('=', 1)[1]
        elif token in ('run', 'run-script'):
            verb = 'run'
            index += 1
            if index < len(arguments) and not arguments[index].startswith('-'):
                script = arguments[index]
        elif token == 'test':
            verb = 'test'
            script = 'test'
        index += 1
    if verb is None or not script:
        return []
    package_directory = directory
    if prefix:
        package_directory = join_directory(directory, prefix)
    elif workspace:
        package_directory = resolve_workspace(workspace, directory)
    key = (package_directory, script)
    if key in visited:
        return []
    visited.add(key)
    command = read_manifest(package_directory).get('scripts', {}).get(script)
    if not command:
        return []
    targets = []
    for tokens in split_commands(command):
        targets.extend(command_targets(tokens, package_directory, visited))
    return targets


def node_default_test_targets(directory):
    """The mjs tests `node --test` discovers when it is given no file."""
    base = root / (directory or '.')
    targets = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(
            name for name in dirnames if name not in SKIP_DIRECTORIES
        )
        for name in sorted(filenames):
            if not name.endswith('.test.mjs'):
                continue
            relative = os.path.relpath(os.path.join(dirpath, name), root)
            targets.append(relative.replace(os.sep, '/'))
    return targets


def command_targets(tokens, directory, visited):
    """The contract-test files one command actually runs.

    A file counts as run only when a runner executes it: `bash <file>`,
    `node --test <file>`, a glob one of those expands, or an npm script
    whose command runs one. A file a command only mentions — a shellcheck
    target, for example — is linted, not run, and does not count.
    """
    if not tokens:
        return []
    executable = tokens[0]
    arguments = tokens[1:]
    if executable in ('node', 'nodejs'):
        if arguments and arguments[0] == '--test':
            if len(arguments) == 1:
                return node_default_test_targets(directory)
            return expand_paths(arguments[1:], directory)
        return []
    if executable in ('bash', 'sh', 'zsh', 'ksh'):
        return expand_paths(arguments[:1], directory)
    if executable.startswith('./') or executable.startswith('../'):
        return expand_paths([executable], directory)
    if executable == 'npm':
        return npm_targets(arguments, directory, visited)
    return []


def ci_executed_paths(workflow_texts, paths):
    """Which of `paths` a CI workflow actually runs.

    Every workflow counts, not only `ci.yml`: a contract test wired into a
    deployment workflow is run, and one wired into no workflow is not.
    """
    executed = set()
    for text in workflow_texts.values():
        for body, working_directory in ci_run_steps(text):
            for tokens, directory in step_commands(body, working_directory):
                for target in command_targets(tokens, directory, set()):
                    if target in paths:
                        executed.add(target)
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
        if bullet and is_contract_test(os.path.basename(bullet.group(1))):
            names.append(bullet.group(1))
    return sorted(set(names))


def check_orphan_scope(workflow_texts, contributing_text, disk_tests, not_run):
    """Every contract test must be run by a workflow or be recorded as one."""
    problems = []

    every_path = sorted(path for paths in disk_tests.values() for path in paths)
    executed = ci_executed_paths(workflow_texts, set(every_path))

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

# Orphan guard for every contract test in the repository. Every workflow
# counts, not only `ci.yml`: a contract test wired into a deployment
# workflow is run, and one wired into no workflow is not.
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

# Sentinel self-tests for the orphan guard across the whole repository: each
# drift shape below must be detected, so a green run means the new
# assertions can actually go red rather than passing vacuously.
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

# Sentinel self-test: the subject set is derived from the working tree, so a
# contract test in a directory the guard has never seen is covered too.
with tempfile.TemporaryDirectory() as temporary:
    probe = pathlib.Path(temporary)
    (probe / 'brand' / 'new' / 'tests').mkdir(parents=True)
    (probe / 'brand' / 'new' / 'tests' / 'orphan-contract.test.sh').write_text(
        '#!/usr/bin/env bash\n'
    )
    derived = all_contract_tests(probe)
    if 'brand/new/tests/orphan-contract.test.sh' not in derived.get(
        'brand/new/tests/', []
    ):
        fail(
            'sentinel self-test did not detect: a contract test in a directory the '
            'guard has never seen'
        )

# Sentinel self-test: a contract test wired through an npm script and a glob
# is run by CI, even though no run step names the file itself.
npm_script_workflow = {
    'sentinel.yml': (
        'jobs:\n'
        '  sentinel:\n'
        '    steps:\n'
        '      - run: npm test --workspace @sindustries/design-tokens\n'
    )
}
npm_script_paths = {
    'packages/design-tokens/scripts/pen-document.test.mjs',
    'packages/design-tokens/scripts/pen-refs.test.mjs',
}
npm_script_executed = ci_executed_paths(npm_script_workflow, npm_script_paths)
for path in sorted(npm_script_paths - npm_script_executed):
    fail(
        f'sentinel self-test did not detect: a contract test wired through an npm '
        f'script and a glob is not recognised as run ({path})'
    )

# Sentinel self-test: a file a workflow only lints is not a file a workflow
# runs. `npm run lint:cloud-db` shellchecks the cloud database tests, which
# is not the same as executing them.
lint_workflow = {
    'sentinel.yml': (
        'jobs:\n'
        '  sentinel:\n'
        '    steps:\n'
        '      - run: npm run lint:cloud-db\n'
    )
}
lint_paths = {
    'scripts/cloud/database/tests/common.test.sh',
    'scripts/cloud/database/tests/manifest-constraints.test.sh',
    'scripts/cloud/database/tests/restore-result-dir.test.sh',
    'scripts/cloud/database/tests/schema-presence.test.sh',
}
lint_executed = ci_executed_paths(lint_workflow, lint_paths)
for path in sorted(lint_executed):
    fail(
        f'sentinel self-test did not detect: a linted contract test is counted as '
        f'run ({path})'
    )

# Sentinel self-test: a recorded contract test that later gets wired into CI
# is reported as a stale record rather than left behind.
stale_workflows = {
    **workflow_texts,
    'sentinel.yml': (
        'jobs:\n'
        '  sentinel:\n'
        '    steps:\n'
        '      - run: npm --prefix tests/cloud run test:cors-origin-matrix\n'
    ),
}
stale_problems = check_orphan_scope(
    stale_workflows, contributing_text, disk_tests, NOT_RUN_BY_CI
)
if not any(
    'check-cors-origin-matrix.test.mjs' in problem and 'a CI job runs it' in problem
    for problem in stale_problems
):
    fail(
        'sentinel self-test did not detect: a recorded contract test wired into CI '
        'is not reported as a stale record'
    )

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('ci-job-script-inventory: ok')
PY
