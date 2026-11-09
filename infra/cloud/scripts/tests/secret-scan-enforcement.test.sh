#!/usr/bin/env bash
# Contract test for the enforceable merge-gate secret scan (task 2b3962b1).
#
# The `gitleaks` job is a required `merge-gate` input, and it had never
# scanned a commit: `gitleaks/gitleaks-action@v2` refuses to start on an
# organisation repo without a paid `GITLEAKS_LICENSE` secret, so it aborted
# before scanning anything, and `continue-on-error: true` turned that abort
# into a green `success`. A green check from a job that scanned nothing is
# indistinguishable from a clean repository, which is exactly what a secret
# scan has to rule out.
#
# This test asserts both halves of the fix:
#   - statically: the job runs the shared entrypoint through the pinned,
#     licence-free gitleaks CLI, carries no fail-open construct, no longer
#     claims to be advisory, and still gates the merge;
#   - behaviourally: the entrypoint fails on a synthetic secret, passes a
#     clean repository, and fails loudly — with a visible `::error::`
#     annotation — when the binary, the config or the scan scope is
#     missing.
#
# The behavioural half needs the real gitleaks binary. It never skips: a
# skipped assertion asserts nothing, and the failure this task exists to
# close was precisely a check that reported success without running.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
ENTRYPOINT="infra/cloud/scripts/run-secret-scan.sh"
CONFIG="$REPO_ROOT/.gitleaks.toml"
CANARY="SINDUSTRIES_SECRET_SCAN_CANARY_0123456789ABCDEF"
# The canary rule is scoped to this path, so the canary is only ever
# detected at the path the negative control and this test write it to.
CANARY_PATH="infra/cloud/secret-scan-canary.txt"

cd "$REPO_ROOT"

# --- static assertions ------------------------------------------------------

python3 - "$REPO_ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
failures = []

CI = '.github/workflows/ci.yml'
CONTRIBUTING = 'CONTRIBUTING.md'
CONFIG = '.gitleaks.toml'
ENTRYPOINT = 'infra/cloud/scripts/run-secret-scan.sh'

EXPECTED_VERSION = '8.30.1'
EXPECTED_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
CANARY_RULE = 'sindustries-secret-scan-canary'


def fail(message):
    failures.append(message)


def job_block(ci_text, job_id):
    """The text of one CI job, by id."""
    lines = ci_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.rstrip() == f'  {job_id}:':
            start = index
            break
    if start is None:
        return None
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if re.match(r'^  [A-Za-z0-9_-]+:\s*$', line):
            return '\n'.join(lines[start:index])
    return '\n'.join(lines[start:])


def strip_comments(text):
    """The executable content of a block, with full-line comments removed.

    The `gitleaks` job's comment quotes `continue-on-error` and
    `gitleaks/gitleaks-action` precisely to say that neither is used any
    more, so a check that reads the comment text would match the very
    wording that documents the fix. Assertions about what a block
    *does* therefore read the code; assertions about what a comment
    *says* read the raw text.
    """
    return '\n'.join(
        line for line in text.splitlines()
        if not line.lstrip().startswith('#')
    )


def contributing_bullet(contributing_text, job_id):
    """The inventory bullet CONTRIBUTING.md documents for a CI job."""
    lines = contributing_text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith('- ') and f'`{job_id}`' in line:
            body = [line]
            for follow in lines[index + 1:]:
                if follow.startswith('- ') or follow.strip() == '':
                    break
                body.append(follow)
            return '\n'.join(body)
    return None


def check(ci_text, contributing_text, config_text, entrypoint_text, entrypoint_mode):
    """Every drift this contract guards against, as a list of messages."""
    problems = []

    job = job_block(ci_text, 'gitleaks')
    if job is None:
        problems.append(f'{CI}: no `gitleaks` job found')
        return problems

    job_code = strip_comments(job)

    if 'continue-on-error: true' in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job still sets `continue-on-error: true` — a '
            'scanner setup failure must fail the job, not be swallowed'
        )

    if ENTRYPOINT not in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job does not run `{ENTRYPOINT}`'
        )

    if 'gitleaks/gitleaks-action' in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job still uses `gitleaks/gitleaks-action`, which '
            'refuses to start on an organisation repo without a paid licence'
        )

    if 'GITLEAKS_LICENSE' in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job still depends on a `GITLEAKS_LICENSE` secret — '
            'the CLI path needs no credential'
        )

    if EXPECTED_VERSION not in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job does not pin the gitleaks version {EXPECTED_VERSION}'
        )
    if EXPECTED_SHA256 not in job_code:
        problems.append(
            f'{CI}: the `gitleaks` job does not pin the gitleaks SHA256 '
            f'{EXPECTED_SHA256}'
        )

    if 'still runs' in job and 'without blocking CI' in job:
        problems.append(
            f'{CI}: the `gitleaks` job comment still claims the scan "still runs ... '
            'without blocking CI", which is the opposite of what the job does'
        )

    if 'merge-gate' not in ci_text:
        problems.append(f'{CI}: no `merge-gate` job found')
    else:
        gate = job_block(ci_text, 'merge-gate')
        if gate is not None and 'gitleaks' not in gate:
            problems.append(
                f'{CI}: `merge-gate` no longer requires the `gitleaks` job — the '
                'secret scan must keep gating the merge'
            )

    if f'id = "{CANARY_RULE}"' not in config_text:
        problems.append(
            f'{CONFIG}: the test-only canary rule `{CANARY_RULE}` is missing — the '
            'negative control needs a detection it cannot defeat'
        )

    # The canary rule must be scoped to the canary's path. An unscoped
    # rule matches the token wherever it is mentioned — including in this
    # contract test, which holds the token as a literal — and the gate
    # then fails on the repository's own test source.
    canary_block = ''
    for block in re.findall(r'^\[\[rules\]\](.*?)(?=^\[|\Z)', config_text, flags=re.MULTILINE | re.DOTALL):
        if f'id = "{CANARY_RULE}"' in block:
            canary_block = block
            break
    if canary_block and not re.search(
        r'^path\s*=.*secret-scan-canary', canary_block, flags=re.MULTILINE
    ):
        problems.append(
            f'{CONFIG}: the canary rule is not scoped to the canary path — an '
            'unscoped rule matches the token wherever it is mentioned, including '
            'in the contract test that holds it as a literal'
        )

    # The config's `[extend]` table decides whether the bundled default
    # ruleset is loaded at all. `useDefault` has defaulted to false since
    # gitleaks v8.19, and a config that extends nothing and defines only
    # its own rules detects nothing — which is exactly how this
    # repository's scan shipped: a green merge gate that could not fail.
    if 'useDefault = true' not in config_text:
        problems.append(
            f'{CONFIG}: `[extend]` does not set `useDefault = true` — the bundled '
            'default ruleset is not loaded, so the scan detects nothing'
        )

    # A custom rule's pattern is read from `regex` (singular). The plural
    # `regexes` form is silently ignored by a rule, which leaves the rule
    # with no pattern at all. (An allowlist legitimately uses the plural
    # form, so only the `[[rules]]` sections are checked.)
    for block in re.findall(r'^\[\[rules\]\](.*?)(?=^\[|\Z)', config_text, flags=re.MULTILINE | re.DOTALL):
        if re.search(r'^regexes\s*=', block, flags=re.MULTILINE):
            problems.append(
                f'{CONFIG}: a rule uses the plural `regexes` field, which gitleaks '
                'ignores — the rule needs `regex` (singular)'
            )
            break

    entrypoint_code = strip_comments(entrypoint_text)
    for construct in ('|| true', 'continue-on-error', 'set +e'):
        if construct in entrypoint_code:
            problems.append(
                f'{ENTRYPOINT}: contains the fail-open construct `{construct}`'
            )

    if entrypoint_mode != 'executable':
        problems.append(f'{ENTRYPOINT}: is not executable')

    bullet = contributing_bullet(contributing_text, 'gitleaks')
    if bullet is None:
        problems.append(f'{CONTRIBUTING}: no inventory bullet for `gitleaks` found')
    else:
        if 'advisory-only' in bullet:
            problems.append(
                f'{CONTRIBUTING}: the `gitleaks` inventory bullet still describes the '
                'job as advisory-only — the scan now blocks the merge'
            )
        if 'secret-scan-enforcement.test.sh' not in bullet:
            problems.append(
                f'{CONTRIBUTING}: the `gitleaks` inventory bullet does not name '
                '`secret-scan-enforcement.test.sh`, which the job runs'
            )

    return problems


ci_text = (root / CI).read_text()
contributing_text = (root / CONTRIBUTING).read_text()
config_text = (root / CONFIG).read_text()
entrypoint_path = root / ENTRYPOINT
entrypoint_text = entrypoint_path.read_text()
entrypoint_mode = (
    'executable'
    if entrypoint_path.exists() and entrypoint_path.stat().st_mode & 0o111
    else 'not-executable'
)

for problem in check(
    ci_text, contributing_text, config_text, entrypoint_text, entrypoint_mode
):
    fail(problem)

# Sentinel self-tests: each drift shape below must be detected, so a green
# run means the assertions can actually go red rather than passing
# vacuously.


def mutate(text, pattern, replacement, label):
    mutated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if not count:
        fail(f'sentinel self-test could not be applied (pattern moved): {label}')
        return text
    return mutated


sentinels = [
    (
        'the job reintroduces `continue-on-error: true`',
        mutate(
            ci_text,
            r'^(\s*)- name: Scan for secrets$',
            r'\1- name: Scan for secrets\n\1  continue-on-error: true',
            'continue-on-error',
        ),
        contributing_text,
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the job stops running the shared entrypoint',
        mutate(
            ci_text,
            r'^(\s*)run: bash infra/cloud/scripts/run-secret-scan\.sh --base "\$BASE_SHA"$',
            r'\1run: echo "secret scan skipped"',
            'entrypoint invocation',
        ),
        contributing_text,
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the job unpins the gitleaks binary',
        mutate(
            ci_text,
            re.escape(EXPECTED_SHA256),
            '0' * 64,
            'pinned checksum',
        ),
        contributing_text,
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the job comment reasserts the old advisory behaviour',
        mutate(
            ci_text,
            r'# Every failure mode blocks this job, and therefore the merge gate:',
            '# NOTE: this step is marked `continue-on-error: true` so the scan still '
            'runs (and surfaces findings via the PR comment) without blocking CI.\n'
            '    # Every failure mode blocks this job, and therefore the merge gate:',
            'advisory comment',
        ),
        contributing_text,
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the job goes back to the licensed action',
        mutate(
            ci_text,
            r'^(\s*)run: bash infra/cloud/scripts/run-secret-scan\.sh --base "\$BASE_SHA"$',
            r'\1uses: gitleaks/gitleaks-action@v2',
            'licensed action',
        ),
        contributing_text,
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the entrypoint regains a fail-open construct',
        ci_text,
        contributing_text,
        config_text,
        entrypoint_text + '\ngitleaks git || true\n',
        entrypoint_mode,
    ),
    (
        'the entrypoint is not executable',
        ci_text,
        contributing_text,
        config_text,
        entrypoint_text,
        'not-executable',
    ),
    (
        'the CONTRIBUTING inventory calls the job advisory-only again',
        ci_text,
        mutate(
            contributing_text,
            r'- `gitleaks` secret scan \(blocking',
            '- `gitleaks` secret scan (advisory-only)',
            'advisory-only inventory entry',
        ),
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the CONTRIBUTING inventory stops naming the contract test',
        ci_text,
        mutate(
            contributing_text,
            r'`infra/cloud/scripts/tests/secret-scan-enforcement\.test\.sh`',
            '`infra/cloud/scripts/tests/other.test.sh`',
            'contract test name',
        ),
        config_text,
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the canary rule is removed from the config',
        ci_text,
        contributing_text,
        mutate(
            config_text,
            r'id = "sindustries-secret-scan-canary"',
            'id = "sindustries-secret-scan-canary-removed"',
            'canary rule',
        ),
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the canary rule loses its path scope',
        ci_text,
        contributing_text,
        mutate(
            config_text,
            r"^path = '''infra/cloud/secret-scan-canary\\\.txt\$'''$",
            '',
            'canary path scope',
        ),
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'the default ruleset stops being loaded',
        ci_text,
        contributing_text,
        mutate(
            config_text,
            r'^useDefault = true$',
            'useDefault = false',
            'useDefault',
        ),
        entrypoint_text,
        entrypoint_mode,
    ),
    (
        'a rule regresses to the ignored plural `regexes` field',
        ci_text,
        contributing_text,
        mutate(
            config_text,
            r'^regex = (\'\'\'SINDUSTRIES_SECRET_SCAN_CANARY)',
            r'regexes = \1',
            'plural regexes field',
        ),
        entrypoint_text,
        entrypoint_mode,
    ),
]

for label, mutated_ci, mutated_contributing, mutated_config, mutated_entrypoint, mutated_mode in sentinels:
    if not check(
        mutated_ci,
        mutated_contributing,
        mutated_config,
        mutated_entrypoint,
        mutated_mode,
    ):
        fail(f'sentinel self-test did not detect: {label}')

if failures:
    for message in failures:
        print(f'FAIL: {message}')
    sys.exit(1)

print('secret-scan-enforcement (static): ok')
PY

# --- behavioural assertions -------------------------------------------------

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "FAIL: the gitleaks binary is not on PATH; this contract test never skips." >&2
  echo "  install it (brew install gitleaks) or run this test in the CI job that" >&2
  echo "  installs the pinned binary." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

new_repo() {
  local path="$1"
  mkdir -p "$path"
  git -C "$path" init -q -b main
  git -C "$path" config user.email "secret-scan-contract@example.invalid"
  git -C "$path" config user.name "secret scan contract test"
  git -C "$path" config commit.gpgsign false
}

# A repository with one innocuous commit, used as the base of the change scan.
new_repo "$WORK_DIR/clean"
printf 'hello\n' > "$WORK_DIR/clean/README.md"
git -C "$WORK_DIR/clean" add README.md
git -C "$WORK_DIR/clean" commit -q -m "add readme"
CLEAN_BASE="$(git -C "$WORK_DIR/clean" rev-parse HEAD)"
# A second commit is what the change scan covers: the scope is the commits
# after the base, so a repository with only the base commit would have an
# empty scope, which is a different case and is asserted separately.
printf 'a note\n' > "$WORK_DIR/clean/NOTES.md"
git -C "$WORK_DIR/clean" add NOTES.md
git -C "$WORK_DIR/clean" commit -q -m "add notes"

# 1. A clean repository passes, and the summary says what was scanned — a
#    green that cannot name its scope is a green that scanned nothing.
clean_output="$WORK_DIR/clean.out"
clean_status=0
bash "$REPO_ROOT/$ENTRYPOINT" --config "$CONFIG" --base "$CLEAN_BASE" \
  "$WORK_DIR/clean" >"$clean_output" 2>&1 || clean_status=$?
if [ "$clean_status" -ne 0 ]; then
  echo "FAIL: a clean repository did not pass the scan (exit $clean_status)" >&2
  cat "$clean_output" >&2
  exit 1
fi
if ! grep -q "secret scan: no secrets found" "$clean_output"; then
  echo "FAIL: a passing scan did not report the scope it scanned" >&2
  cat "$clean_output" >&2
  exit 1
fi
if ! grep -q "commit(s)" "$clean_output"; then
  echo "FAIL: a passing scan did not report how many commits it scanned" >&2
  cat "$clean_output" >&2
  exit 1
fi

# 2. A synthetic secret fails the scan — the detection the whole task exists
#    to guarantee.
new_repo "$WORK_DIR/canary"
printf 'hello\n' > "$WORK_DIR/canary/README.md"
git -C "$WORK_DIR/canary" add README.md
git -C "$WORK_DIR/canary" commit -q -m "add readme"
CANARY_BASE="$(git -C "$WORK_DIR/canary" rev-parse HEAD)"
mkdir -p "$WORK_DIR/canary/infra/cloud"
printf '%s\n' "$CANARY" > "$WORK_DIR/canary/$CANARY_PATH"
git -C "$WORK_DIR/canary" add "$CANARY_PATH"
git -C "$WORK_DIR/canary" commit -q -m "add canary"

canary_output="$WORK_DIR/canary.out"
canary_status=0
bash "$REPO_ROOT/$ENTRYPOINT" --config "$CONFIG" --base "$CANARY_BASE" \
  "$WORK_DIR/canary" >"$canary_output" 2>&1 || canary_status=$?
if [ "$canary_status" -eq 0 ]; then
  echo "FAIL: a repository containing the synthetic canary passed the scan" >&2
  cat "$canary_output" >&2
  exit 1
fi
if ! grep -q "::error::secret scan failed" "$canary_output"; then
  echo "FAIL: a failing scan did not emit a visible ::error:: annotation" >&2
  cat "$canary_output" >&2
  exit 1
fi

# 3. An empty commit range fails: a green check must never mean "scanned
#    nothing".
empty_output="$WORK_DIR/empty.out"
empty_status=0
bash "$REPO_ROOT/$ENTRYPOINT" --config "$CONFIG" --base "$(git -C "$WORK_DIR/clean" rev-parse HEAD)" \
  "$WORK_DIR/clean" >"$empty_output" 2>&1 || empty_status=$?
if [ "$empty_status" -eq 0 ]; then
  echo "FAIL: an empty commit range passed the scan" >&2
  cat "$empty_output" >&2
  exit 1
fi
if ! grep -q "::error::secret scan scope resolved to zero commits" "$empty_output"; then
  echo "FAIL: an empty scan scope did not fail with the documented annotation" >&2
  cat "$empty_output" >&2
  exit 1
fi

# 4. A missing config fails visibly.
config_output="$WORK_DIR/config.out"
config_status=0
bash "$REPO_ROOT/$ENTRYPOINT" --config "$WORK_DIR/does-not-exist.toml" \
  "$WORK_DIR/clean" >"$config_output" 2>&1 || config_status=$?
if [ "$config_status" -eq 0 ]; then
  echo "FAIL: a missing gitleaks config passed the scan" >&2
  cat "$config_output" >&2
  exit 1
fi
if ! grep -q "::error::gitleaks config not found" "$config_output"; then
  echo "FAIL: a missing config did not fail with a visible ::error:: annotation" >&2
  cat "$config_output" >&2
  exit 1
fi

# 5. A missing binary fails visibly.
binary_output="$WORK_DIR/binary.out"
binary_status=0
PATH="$WORK_DIR/empty-bin:/usr/bin:/bin" \
  bash "$REPO_ROOT/$ENTRYPOINT" --config "$CONFIG" --base "$CLEAN_BASE" \
  "$WORK_DIR/clean" >"$binary_output" 2>&1 || binary_status=$?
if [ "$binary_status" -eq 0 ]; then
  echo "FAIL: a missing gitleaks binary passed the scan" >&2
  cat "$binary_output" >&2
  exit 1
fi
if ! grep -q "::error::gitleaks binary not found" "$binary_output"; then
  echo "FAIL: a missing binary did not fail with a visible ::error:: annotation" >&2
  cat "$binary_output" >&2
  exit 1
fi

echo "secret-scan-enforcement (behavioural): ok"
