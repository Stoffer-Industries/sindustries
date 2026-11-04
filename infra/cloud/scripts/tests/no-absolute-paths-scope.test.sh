#!/usr/bin/env bash
# Static contract: the path-lint scope documented in CONTRIBUTING.md must match
# the scope the lint actually runs.
#
# Finding (W44 code-garden follow-up, T5 continued): CONTRIBUTING.md described
# the `no-absolute-paths-lint` job as failing on hard-coded absolute paths
# "under `apps/`, `services/`, `packages/`, `agents/workflows/` and
# `agents/lib/`", with no mention of the one directory the lint opts out of
# (`agents/workflows/feature-task/src`, the Rust workflow monolith). The
# documented list and the executable list were two sources of truth for one
# fact, and nothing compared them — the same prose-versus-executable drift
# that PRs #905-#907 closed for the CI job inventory and that PR #911 closed
# for the local test commands.
#
# The consequence was concrete: a contributor whose file lands in
# `agents/workflows/feature-task/src` reads CONTRIBUTING.md, believes the lint
# covers `agents/workflows/`, and ships a hard-coded `/Users/<name>/` path.
#
# This test makes the documented scope and the executable scope one
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

LINT_SCRIPT = 'scripts/check-no-absolute-paths.mjs'
CONTRIBUTING = 'CONTRIBUTING.md'
CI_WORKFLOW = '.github/workflows/ci.yml'

SCOPE_HEADING = '### Path-lint scope'
ROOTS_LABEL = 'Scanned roots:'
OPTOUTS_LABEL = 'Opted out of the scan:'

# Backticked path-shaped tokens only: `~/` and `/Users/<name>/` are prose
# examples in the same section and must not be read as scope entries.
TOKEN_RE = re.compile(r'`([A-Za-z0-9_][A-Za-z0-9_./-]*)`')


def fail(message):
    failures.append(message)


def strip_js_comments(source):
    """Drop `//` line comments so array literals parse cleanly."""
    return re.sub(r'^\s*//.*$', '', source, flags=re.M)


def js_string_array(source, name):
    """The string entries of a `const <name> = [...]` JS array literal."""
    match = re.search(rf'const\s+{re.escape(name)}\s*=\s*\[(.*?)\]\s*;', source, re.S)
    if not match:
        return None
    return re.findall(r"'([^']*)'", match.group(1))


def scope_section(contributing_text):
    """The body of CONTRIBUTING.md's '### Path-lint scope' section."""
    lines = contributing_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == SCOPE_HEADING:
            start = index
            break
    if start is None:
        return None
    body = []
    for line in lines[start + 1:]:
        if line.startswith('#'):
            break
        body.append(line)
    return '\n'.join(body)


def documented_scope(section_text):
    """(roots, opt-outs) as documented, or (None, None) if unparseable."""
    if section_text is None:
        return None, None
    if ROOTS_LABEL not in section_text or OPTOUTS_LABEL not in section_text:
        return None, None
    roots_part, _, optouts_part = section_text.partition(OPTOUTS_LABEL)
    roots_part = roots_part.partition(ROOTS_LABEL)[2]
    return TOKEN_RE.findall(roots_part), TOKEN_RE.findall(optouts_part)


def ci_lint_roots(ci_text):
    """Roots the CI lint step passes on the command line (empty = script defaults)."""
    in_job = False
    for line in ci_text.splitlines():
        if re.match(r'^  no-absolute-paths-lint:\s*$', line):
            in_job = True
            continue
        if in_job and re.match(r'^  [A-Za-z0-9_-]+:\s*$', line):
            break
        if in_job and 'check-no-absolute-paths.mjs' in line and 'run:' in line:
            run = line.split('run:', 1)[1].strip()
            parts = run.split()
            if LINT_SCRIPT in parts:
                tail = parts[parts.index(LINT_SCRIPT) + 1:]
                return [p for p in tail if not p.startswith('-')]
    return None


def under_root(path, roots):
    return any(path == r or path.startswith(r + '/') for r in roots)


def check(script_text, contributing_text, ci_text):
    """Every drift this contract guards against, as a list of messages."""
    problems = []

    script_roots = js_string_array(strip_js_comments(script_text), 'DEFAULT_ROOTS')
    script_optouts = js_string_array(strip_js_comments(script_text), 'SKIP_PATH_PREFIXES')
    if script_roots is None:
        problems.append(f'{LINT_SCRIPT}: no DEFAULT_ROOTS array literal found')
    if script_optouts is None:
        problems.append(f'{LINT_SCRIPT}: no SKIP_PATH_PREFIXES array literal found')
    if script_roots is None or script_optouts is None:
        return problems

    section = scope_section(contributing_text)
    if section is None:
        problems.append(f'{CONTRIBUTING}: no `{SCOPE_HEADING}` section found')
        return problems

    doc_roots, doc_optouts = documented_scope(section)
    if doc_roots is None:
        problems.append(
            f'{CONTRIBUTING}: the `{SCOPE_HEADING}` section no longer names '
            f'`{ROOTS_LABEL}` and `{OPTOUTS_LABEL}`'
        )
        return problems

    for root in sorted(set(doc_roots) - set(script_roots)):
        problems.append(
            f'{CONTRIBUTING}: documents root `{root}`, which the lint does not scan'
        )
    for root in sorted(set(script_roots) - set(doc_roots)):
        problems.append(
            f'{CONTRIBUTING}: the lint scans root `{root}`, which is not documented'
        )

    for optout in sorted(set(doc_optouts) - set(script_optouts)):
        problems.append(
            f'{CONTRIBUTING}: documents opt-out `{optout}`, which the lint does not have'
        )
    for optout in sorted(set(script_optouts) - set(doc_optouts)):
        problems.append(
            f'{LINT_SCRIPT}: opts out of `{optout}`, which is not documented'
        )

    for optout in sorted(set(script_optouts)):
        if not under_root(optout, script_roots):
            problems.append(
                f'{LINT_SCRIPT}: opt-out `{optout}` is not under any scanned root, '
                'so it has no effect'
            )

    ci_roots = ci_lint_roots(ci_text)
    if ci_roots is None:
        problems.append(f'{CI_WORKFLOW}: no `check-no-absolute-paths.mjs` run step found')
    elif ci_roots and sorted(ci_roots) != sorted(doc_roots):
        problems.append(
            f'{CI_WORKFLOW}: the lint step scans '
            + (', '.join(f'`{r}`' for r in sorted(ci_roots)) or 'nothing')
            + ' but CONTRIBUTING.md documents '
            + (', '.join(f'`{r}`' for r in sorted(doc_roots)) or 'nothing')
        )

    return problems


script_text = (root / LINT_SCRIPT).read_text()
contributing_text = (root / CONTRIBUTING).read_text()
ci_text = (root / CI_WORKFLOW).read_text()

for problem in check(script_text, contributing_text, ci_text):
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
        'the lint scans a root that is not documented',
        script_text,
        mutate(
            script_text,
            r"'packages', 'agents/workflows'",
            "'packages', 'tools', 'agents/workflows'",
            'undocumented root',
        ),
        contributing_text,
        ci_text,
    ),
    (
        'the lint stops scanning a documented root',
        script_text,
        mutate(
            script_text,
            r"'packages', 'agents/workflows', 'agents/lib'",
            "'packages', 'agents/workflows'",
            'dropped root',
        ),
        contributing_text,
        ci_text,
    ),
    (
        'the lint gains an opt-out that is not documented',
        script_text,
        mutate(
            script_text,
            r"'agents/workflows/feature-task/src',",
            "'agents/workflows/feature-task/src', 'agents/evals/cases',",
            'undocumented opt-out',
        ),
        contributing_text,
        ci_text,
    ),
    (
        'the lint loses an opt-out that is documented',
        script_text,
        mutate(
            script_text,
            r"'agents/workflows/feature-task/src',\n",
            '',
            'dropped opt-out',
        ),
        contributing_text,
        ci_text,
    ),
    (
        'CONTRIBUTING.md drops a scanned root',
        script_text,
        script_text,
        mutate(
            contributing_text,
            r'`packages`, `agents/workflows`, `agents/lib`',
            '`packages`, `agents/workflows`',
            'documented root removed',
        ),
        ci_text,
    ),
    (
        'CONTRIBUTING.md drops the documented opt-out',
        script_text,
        script_text,
        mutate(
            contributing_text,
            r'Opted out of the scan: `agents/workflows/feature-task/src`',
            'Opted out of the scan:',
            'documented opt-out removed',
        ),
        ci_text,
    ),
    (
        'the CI lint step scans a different root set than the documentation',
        script_text,
        script_text,
        contributing_text,
        mutate(
            ci_text,
            r'run: node scripts/check-no-absolute-paths\.mjs',
            'run: node scripts/check-no-absolute-paths.mjs apps services',
            'CI roots differ',
        ),
    ),
]

for label, mutated_script, mutated_contributing, mutated_ci in [
    (label, script, contributing, ci)
    for label, _orig_script, script, contributing, ci in sentinels
]:
    if not check(mutated_script, mutated_contributing, mutated_ci):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('no-absolute-paths-scope: ok')
PY
