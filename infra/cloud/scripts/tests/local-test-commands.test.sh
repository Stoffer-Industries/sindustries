#!/usr/bin/env bash
# Static contract: the local test commands documented in CONTRIBUTING.md must
# match the targets and prerequisites the Makefile actually defines.
#
# Finding (W44 code-garden follow-up, T5 continued): CONTRIBUTING.md claimed
# `make test-all` "runs the four commands above (Tasks/Budget APIs, website,
# Tasks app + e2e)", but the block above listed only `make test`, `make
# test-api`, `make test-app` and `make test-e2e`. The Makefile's `test-all`
# target runs `test-api test-website test-app test-e2e`, so:
#   - it never runs `make test` (the first of the "four commands above"), and
#   - it does run `make test-website`, which was documented nowhere.
# The Makefile was the only accurate source; the prose could not be checked
# against anything, so the drift was invisible until a human re-read it.
#
# This test makes the documented commands and the executable targets one
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

COMMAND_RE = re.compile(r'\bmake\s+([A-Za-z0-9_.-]+)')


def fail(message):
    failures.append(message)


def makefile_targets(text):
    """Map target name -> prerequisites for simple `name: dep dep` rules."""
    targets = {}
    for raw in text.splitlines():
        if raw.lstrip().startswith('#'):
            continue
        line = raw.split('#', 1)[0].rstrip()
        if not line or line[0].isspace() or ':' not in line:
            continue
        name, _, rest = line.partition(':')
        name = name.strip()
        if not name or '=' in name:
            continue
        targets[name] = rest.replace('\\', ' ').split()
    return targets


def documented_commands(text):
    """`make <target>` lines from the 'Common commands:' bash block."""
    match = re.search(r'Common commands:\s*\n+```bash\n(.*?)```', text, re.S)
    if not match:
        return None
    commands = []
    for line in match.group(1).splitlines():
        entry = line.strip()
        if entry.startswith('make '):
            commands.append(entry.split()[1])
    return commands


def local_test_paragraph(text):
    for block in re.split(r'\n\s*\n', text):
        if '`make test-all`' in block and 'local convenience target' in block:
            return ' '.join(block.split())
    return None


def commands_in(fragment):
    return set(COMMAND_RE.findall(fragment or ''))


def check(makefile_text, contributing_text):
    """Every drift this contract guards against, as a list of messages."""
    problems = []
    targets = makefile_targets(makefile_text)

    for required in ('test', 'test-all'):
        if required not in targets:
            problems.append(f'Makefile has no `{required}` target')

    block = documented_commands(contributing_text)
    if block is None:
        problems.append("CONTRIBUTING.md has no 'Common commands:' bash block")
        return problems

    for command in block:
        if command not in targets:
            problems.append(
                f'CONTRIBUTING.md documents `make {command}` but the Makefile has no `{command}` target'
            )

    for prereq in targets.get('test-all', []):
        if prereq not in block:
            problems.append(
                f"Makefile target `test-all` requires `{prereq}`, which the CONTRIBUTING.md "
                'common-commands block does not list'
            )

    paragraph = local_test_paragraph(contributing_text)
    if paragraph is None:
        problems.append("CONTRIBUTING.md no longer describes what `make test-all` runs")
        return problems

    match = re.search(
        r'`make test-all` is a local convenience target that runs (.*?)(?:;|\.)',
        paragraph,
    )
    if not match:
        problems.append(
            'CONTRIBUTING.md no longer states which commands `make test-all` runs'
        )
    else:
        documented = commands_in(match.group(1))
        actual = set(targets.get('test-all', []))
        if documented != actual:
            problems.append(
                'CONTRIBUTING.md says `make test-all` runs '
                + (', '.join(f'`{c}`' for c in sorted(documented)) or 'nothing')
                + ' but the Makefile runs '
                + (', '.join(f'`{c}`' for c in sorted(actual)) or 'nothing')
            )

    match = re.search(r'`make test` runs (.*?)\.', paragraph)
    if not match:
        problems.append('CONTRIBUTING.md does not state which commands `make test` runs')
    else:
        documented = commands_in(match.group(1))
        actual = set(targets.get('test', []))
        if documented != actual:
            problems.append(
                'CONTRIBUTING.md says `make test` runs '
                + (', '.join(f'`{c}`' for c in sorted(documented)) or 'nothing')
                + ' but the Makefile runs '
                + (', '.join(f'`{c}`' for c in sorted(actual)) or 'nothing')
            )

    return problems


makefile_text = (root / 'Makefile').read_text()
contributing_text = (root / 'CONTRIBUTING.md').read_text()

for problem in check(makefile_text, contributing_text):
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
        'the documented block omits `make test-website`',
        mutate(contributing_text, r'make test-website\n', '', 'block omits website'),
        makefile_text,
    ),
    (
        'the prose omits `make test-website`',
        mutate(
            contributing_text,
            r'`make test-website`,\s*',
            '',
            'prose omits website',
        ),
        makefile_text,
    ),
    (
        'the Makefile adds an undocumented prerequisite',
        contributing_text,
        mutate(
            makefile_text,
            r'test-all: test-api test-website test-app test-e2e',
            'test-all: test-api test-website test-app test-e2e test-billing',
            'undocumented prerequisite',
        ),
    ),
    (
        'a documented command has no Makefile target',
        mutate(
            contributing_text,
            r'make test-website\n',
            'make test-web\n',
            'renamed command',
        ),
        makefile_text,
    ),
    (
        'the prose names a command the Makefile does not run',
        mutate(
            contributing_text,
            r'`make test-api`,\s*`make test-website`,\s*`make test-app`',
            '`make test-api`, `make test-app`',
            'prose names fewer commands',
        ),
        makefile_text,
    ),
]

for label, mutated_contributing, mutated_makefile in sentinels:
    if not check(mutated_makefile, mutated_contributing):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('local-test-commands: ok')
PY
