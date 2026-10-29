#!/usr/bin/env bash
# Static contract for task 02c5475c: merge/deployment gates, pinning, and concurrency.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import copy
import fnmatch
import json
import pathlib
import re
import subprocess
import sys
import tempfile

import yaml

root = pathlib.Path(sys.argv[1])
workflow_dir = root / '.github' / 'workflows'
failures = []


def load(name):
    with (workflow_dir / name).open() as handle:
        return yaml.safe_load(handle)


def on_block(doc):
    # PyYAML applies YAML 1.1 and coerces bare `on` to True.
    return doc.get('on', doc.get(True, {}))


def fail(message):
    failures.append(message)


ci = load('ci.yml')
jobs = ci.get('jobs', {})
gate = jobs.get('merge-gate', {})

# Jobs intentionally excluded from merge-gate.needs. Empty today — there
# is no verification job whose failure is allowed to not block release.
# Adding a name here is a security-posture decision and requires a tech
# design, same as this one. Do NOT use `continue-on-error` as the
# advisory marker — it already means fail-open on `gitleaks` (W43 F2,
# needs-human-decision) and that is a known gap, not a pattern to copy.
ADVISORY_VERIFICATION_JOBS = frozenset()

# Verified live 2026-10-24 via
# `gh api repos/Stoffer-Industries/sindustries/rulesets/13513816`:
# the `main` branch ruleset's only required_status_checks entry has context
# "merge gate", and classic branch protection on `main` is absent (404) —
# merge-gate is the sole gate standing between a PR and main. Re-verify
# this during repo-audit passes if the ruleset changes; this assertion only
# catches ci.yml drifting away from the last-verified name.
REQUIRED_STATUS_CHECK_CONTEXT = 'merge gate'


def as_list(value):
    """Normalise a GitHub Actions `needs:` value to a list."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return list(value)


def compute_expected_required(job_map):
    """Derive the jobs the merge gate must depend on.

    Required = every job that is neither the gate itself nor downstream of
    it, minus the explicit advisory allowlist. Deriving this from ci.yml
    removes the second hand-maintained literal that let
    `gh-with-agent-token-tests` sit out of the gate while the test still
    passed (task 5674a6c1).
    """
    required = set()
    for name, job in job_map.items():
        if name == 'merge-gate':
            continue
        if 'merge-gate' in as_list(job.get('needs')):
            continue
        if name in ADVISORY_VERIFICATION_JOBS:
            continue
        required.add(name)
    return required


expected_required = compute_expected_required(jobs)
gate_needs = set(as_list(gate.get('needs')))

if gate.get('name') != REQUIRED_STATUS_CHECK_CONTEXT:
    fail(
        "ci.yml: merge-gate must expose the stable job name "
        f"'{REQUIRED_STATUS_CHECK_CONTEXT}'"
    )
if gate.get('if') != 'always()':
    fail('ci.yml: merge-gate must run under always()')
if gate_needs != expected_required:
    missing = expected_required - gate_needs
    extra = gate_needs - expected_required
    fail(f'ci.yml: merge-gate needs mismatch; missing={sorted(missing)}, extra={sorted(extra)}')

# W44 audit T5: the contributor CI inventory in CONTRIBUTING.md must name
# every merge-gate input by its job id, and must not name a job id that no
# longer exists in ci.yml. Four consecutive audit sweeps (#895, #900, #901,
# #904) each found one more gap, because the inventory was only ever
# compared with the executable gate by a human re-read during an audit
# pass. These assertions compare the two sets mechanically, so a renamed or
# added required job fails the gate instead of drifting silently until the
# next audit.
CONTRIBUTING_INVENTORY_HEADING = 'CI currently covers:'
# Backticked inventory tokens that are deliberately not job ids. Paths, npm
# scripts and file names are excluded by the shape rule below; these are the
# exceptions that still look like a job id.
DOCUMENTED_NON_JOB_IDS = frozenset({'no-pnpm-pin'})
# Documented ids that are legitimately not merge-gate inputs: `merge-gate`
# is the gate itself, and `eas-update-production` is the one deployment job
# that runs *after* the gate (`needs: [changes, merge-gate]`). Every other
# job id the inventory names must be an input to the gate, which is the
# claim CONTRIBUTING.md makes in prose. Without this exception list the
# inventory could name a job the gate does not require (a deployment job, or
# a future advisory job) and stay green while contradicting that sentence.
DOCUMENTED_NON_GATE_INPUTS = frozenset({'merge-gate', 'eas-update-production'})
# Single-word job ids are legitimate (`changes`, `gitleaks`), so the shape
# allows zero or more dash-separated segments. Paths, npm scripts, file
# names and display names all contain a character this rejects.
JOB_ID_SHAPE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def inventory_job_ids(doc_lines):
    """Job-id-shaped backticked tokens in the CONTRIBUTING.md CI inventory."""
    start = None
    for index, line in enumerate(doc_lines):
        if line.strip() == CONTRIBUTING_INVENTORY_HEADING:
            start = index
            break
    if start is None:
        return None
    tokens = []
    for line in doc_lines[start + 1:]:
        if line.startswith('### ') or line.startswith('## '):
            break
        tokens.extend(re.findall(r'`([^`\n]+)`', line))
    return {token for token in tokens if JOB_ID_SHAPE.match(token)}


def inventory_parity_failures(gate_inputs, documented_ids, job_ids):
    """Parity failures between the merge gate and the documented inventory."""
    problems = []
    undocumented = sorted(gate_inputs - documented_ids)
    if undocumented:
        problems.append(
            'CONTRIBUTING.md: merge-gate inputs missing from the CI inventory: '
            f'{undocumented}'
        )
    unknown = sorted(documented_ids - job_ids - DOCUMENTED_NON_JOB_IDS)
    if unknown:
        problems.append(
            'CONTRIBUTING.md: CI inventory names job ids that do not exist in '
            f'ci.yml: {unknown}'
        )
    not_inputs = sorted(
        documented_ids
        - gate_inputs
        - DOCUMENTED_NON_GATE_INPUTS
        - DOCUMENTED_NON_JOB_IDS
    )
    if not_inputs:
        problems.append(
            'CONTRIBUTING.md: CI inventory names jobs that are not merge-gate '
            f'inputs: {not_inputs}'
        )
    return problems


contributing_path = root / 'CONTRIBUTING.md'
if not contributing_path.exists():
    fail('CONTRIBUTING.md: missing from the repository root')
else:
    documented_ids = inventory_job_ids(contributing_path.read_text().split('\n'))
    if documented_ids is None:
        fail(
            'CONTRIBUTING.md: missing the '
            f'"{CONTRIBUTING_INVENTORY_HEADING}" inventory section'
        )
    else:
        for problem in inventory_parity_failures(
            gate_needs, documented_ids, set(jobs)
        ):
            fail(problem)

        # Self-test: the parity assertions must be able to go red. Add a
        # required job nobody documented and confirm it is reported, then
        # document a job id that no job in ci.yml provides and confirm that
        # is reported too. Without this, the two comparisons above could
        # pass for the wrong reason.
        sentinel_input = 'sentinel-undocumented-merge-gate-input'
        sentinel_failures = inventory_parity_failures(
            gate_needs | {sentinel_input}, documented_ids, set(jobs)
        )
        if not any(sentinel_input in problem for problem in sentinel_failures):
            fail(
                'ci-deployment-gates: the CONTRIBUTING.md inventory parity check '
                'did not report an undocumented merge-gate input'
            )
        sentinel_documented = 'sentinel-documented-without-a-ci-job'
        sentinel_failures = inventory_parity_failures(
            gate_needs, documented_ids | {sentinel_documented}, set(jobs)
        )
        if not any(sentinel_documented in problem for problem in sentinel_failures):
            fail(
                'ci-deployment-gates: the CONTRIBUTING.md inventory parity check '
                'did not report a documented job id with no job in ci.yml'
            )
        # The converse direction needs its own non-vacuity proof: a
        # documented job id that the gate does NOT require must be reported,
        # otherwise the inventory's sentence ("every job listed above except
        # eas-update-production is an input to the merge-gate job") stays
        # prose-only and can drift.
        sentinel_not_input = 'sentinel-documented-without-a-gate-input'
        sentinel_failures = inventory_parity_failures(
            gate_needs, documented_ids | {sentinel_not_input}, set(jobs)
        )
        if not any(sentinel_not_input in problem for problem in sentinel_failures):
            fail(
                'ci-deployment-gates: the CONTRIBUTING.md inventory parity check '
                'did not report a documented job id that is not a merge-gate input'
            )

gate_script = '\n'.join(
    step.get('run', '') for step in gate.get('steps', []) if isinstance(step, dict)
)
if 'python3 infra/cloud/scripts/check-ci-results.py' not in gate_script:
    fail('ci.yml: merge-gate must execute the checked-in result validator')

validator = root / 'infra' / 'cloud' / 'scripts' / 'check-ci-results.py'
validator_cases = (
    ({'unit': {'result': 'success'}, 'optional': {'result': 'skipped'}}, 0),
    ({'unit': {'result': 'failure'}}, 1),
    ({'unit': {'result': 'cancelled'}}, 1),
    ({'unit': {'result': None}}, 1),
)
for results, expected_code in validator_cases:
    completed = subprocess.run(
        [sys.executable, str(validator)],
        env={'REQUIRED_RESULTS': json.dumps(results)},
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != expected_code:
        fail(
            f'check-ci-results.py: expected exit {expected_code} for {results}, '
            f'got {completed.returncode}: {completed.stderr.strip()}'
        )

# AC3 (task 5674a6c1): a failing required job must actually fail the gate.
# Drive the validator with the REAL merge-gate.needs job names rather than
# synthetic ones, forcing the job that was previously omitted from the gate
# to fail. Exit code 1 plus the job name in stderr proves the gate reads
# real job names; the deploy_jobs loop below separately proves every
# deployment job's condition requires the aggregate to have succeeded, so a
# failing required job blocks deployment.
AC3_PROBE_JOB = 'gh-with-agent-token-tests'
if AC3_PROBE_JOB not in gate_needs:
    fail(
        f'ci.yml: merge-gate must depend on {AC3_PROBE_JOB} for AC3 to be provable'
    )
else:
    ac3_results = {
        name: {'result': 'success'} for name in sorted(gate_needs)
    }
    ac3_results[AC3_PROBE_JOB] = {'result': 'failure'}
    ac3 = subprocess.run(
        [sys.executable, str(validator)],
        env={'REQUIRED_RESULTS': json.dumps(ac3_results)},
        capture_output=True,
        text=True,
        check=False,
    )
    if ac3.returncode != 1:
        fail(
            f'check-ci-results.py: expected exit 1 when {AC3_PROBE_JOB} fails, '
            f'got {ac3.returncode}: {ac3.stderr.strip()}'
        )
    if AC3_PROBE_JOB not in ac3.stderr:
        fail(
            f'check-ci-results.py: failure output must name {AC3_PROBE_JOB}, '
            f'got: {ac3.stderr.strip()}'
        )

# AC4 (task 5674a6c1): the derived expected-set must be able to go red on a
# future omission. Write a temporary copy of ci.yml with a sentinel
# verification job that nobody wired into merge-gate.needs, parse it back
# through the same loader the real assertion uses, and assert the comparison
# fails AND names the omitted job; then wire the sentinel into
# merge-gate.needs in that copy and assert the comparison passes. This proves
# the contract test catches a job nobody added to the gate, instead of only
# describing the gap after the fact.
sentinel_name = 'sentinel-unwired-verification-job'
with tempfile.TemporaryDirectory() as tmpdir:
    tmp_ci = pathlib.Path(tmpdir) / 'ci.yml'
    mutated_doc = copy.deepcopy(ci)
    # Normalise the gate to the derived set for the sentinel-free job map
    # first, so this fixture is hermetic: the ONLY defect under test is the
    # sentinel. Without this normalisation the fixture inherits whatever
    # omissions the live ci.yml happens to have, and a pre-existing
    # omission would make the sentinel assertion fail for a different
    # cause — reporting a sentinel-specific message about an unrelated
    # missing job. The live ci.yml's own completeness is asserted
    # separately above.
    mutated_doc['jobs']['merge-gate']['needs'] = sorted(
        compute_expected_required(mutated_doc['jobs'])
    )
    mutated_doc['jobs'][sentinel_name] = {'needs': 'changes'}
    tmp_ci.write_text(yaml.safe_dump(mutated_doc, sort_keys=False))
    mutated_jobs = yaml.safe_load(tmp_ci.read_text())['jobs']
    mutated_expected = compute_expected_required(mutated_jobs)
    mutated_gate_needs = set(as_list(mutated_jobs['merge-gate'].get('needs')))
    if mutated_gate_needs == mutated_expected:
        fail(
            'ci-deployment-gates: sentinel unwired job must be detected as '
            'missing from merge-gate.needs'
        )
    else:
        omitted = mutated_expected - mutated_gate_needs
        if sentinel_name not in omitted:
            fail(
                'ci-deployment-gates: the merge-gate needs diff must name the '
                f'omitted job {sentinel_name}, got {sorted(omitted)}'
            )
    mutated_doc['jobs']['merge-gate']['needs'] = sorted(
        mutated_gate_needs | {sentinel_name}
    )
    tmp_ci.write_text(yaml.safe_dump(mutated_doc, sort_keys=False))
    rewired_jobs = yaml.safe_load(tmp_ci.read_text())['jobs']
    if compute_expected_required(rewired_jobs) != set(
        as_list(rewired_jobs['merge-gate'].get('needs'))
    ):
        fail(
            'ci-deployment-gates: adding the sentinel job to merge-gate.needs '
            'must make the derived comparison pass'
        )

deploy_jobs = {
    'deploy-website-staging',
    'deploy-website-production',
    'deploy-tasks-api-staging',
    'deploy-budget-api-staging',
    'deploy-content-scheduler-api-staging',
    'deploy-auto-post-worker-staging',
    'deploy-gymtrack-production',
    'deploy-gymtrack-mcp-production',
    'deploy-health-probe-staging',
    'eas-update-production',
}
for job_name in sorted(deploy_jobs):
    job = jobs.get(job_name)
    if not job:
        fail(f'ci.yml: missing deployment job {job_name}')
        continue
    needs = job.get('needs', [])
    if isinstance(needs, str):
        needs = [needs]
    if 'merge-gate' not in needs:
        fail(f'ci.yml: {job_name} does not depend on merge-gate')
    if 'always()' not in str(job.get('if', '')):
        fail(f'ci.yml: {job_name} must override skipped-ancestor propagation with always()')
    # AC3 (task 5674a6c1): the second half of "a failing required job prevents
    # deployment" is that every deployment job's condition actually requires
    # the aggregate to have SUCCEEDED — not merely that it lists merge-gate as
    # a dependency. Without this clause a deployment job could still be
    # scheduled while the aggregate failed, and the AC3 fixture above would
    # prove nothing about deployment.
    if "needs.merge-gate.result == 'success'" not in str(job.get('if', '')):
        fail(
            f'ci.yml: {job_name} must require the aggregate merge gate to have '
            "succeeded (needs.merge-gate.result == 'success')"
        )

production_jobs = {name for name in deploy_jobs if name.endswith('production')}
for job_name in sorted(production_jobs):
    condition = str(jobs.get(job_name, {}).get('if', ''))
    if "github.ref == 'refs/heads/main'" not in condition:
        fail(f'ci.yml: {job_name} is not explicitly restricted to main')

website_production_needs = jobs.get('deploy-website-production', {}).get('needs', [])
if 'deploy-website-staging' not in website_production_needs:
    fail('ci.yml: website production must depend on website staging smoke success')

called_workflows = {
    'website-deploy.yml',
    'deploy-staging-tasks-api.yml',
    'deploy-staging-budget-api.yml',
    'deploy-staging-content-scheduler-api.yml',
    'deploy-staging-auto-post-worker.yml',
    'gymtrack-deploy.yml',
    'gymtrack-mcp-deploy.yml',
    'deploy-staging-health-probe.yml',
}
docs = {name: load(name) for name in called_workflows}
for name, doc in docs.items():
    triggers = on_block(doc)
    if not isinstance(triggers, dict) or 'workflow_call' not in triggers:
        fail(f'{name}: must be a reusable workflow_call workflow')
        continue
    forbidden = {'push', 'pull_request', 'workflow_dispatch'} & set(triggers)
    if forbidden:
        fail(f'{name}: independent deployment triggers bypass CI: {sorted(forbidden)}')

fly_names = {
    'deploy-staging-tasks-api.yml',
    'deploy-staging-budget-api.yml',
    'deploy-staging-content-scheduler-api.yml',
    'deploy-staging-auto-post-worker.yml',
    'gymtrack-mcp-deploy.yml',
    'deploy-staging-health-probe.yml',
}
sha_ref = re.compile(r'^superfly/flyctl-actions/setup-flyctl@[0-9a-f]{40}$')
for name in sorted(fly_names):
    deploy = docs[name].get('jobs', {}).get('deploy', {})
    steps = deploy.get('steps', [])
    preflight_indexes = [
        index for index, step in enumerate(steps)
        if step.get('name') == 'Require Fly deployment credential'
    ]
    setup_indexes = [
        index for index, step in enumerate(steps)
        if str(step.get('uses', '')).startswith('superfly/flyctl-actions/setup-flyctl@')
    ]
    if len(preflight_indexes) != 1 or len(setup_indexes) != 1:
        fail(f'{name}: expected exactly one Fly credential preflight and one Fly setup step')
        continue
    if preflight_indexes[0] > setup_indexes[0]:
        fail(f'{name}: Fly credential preflight must run before Fly setup')
    preflight = steps[preflight_indexes[0]]
    if preflight.get('env', {}).get('FLY_API_TOKEN') != '${{ secrets.FLY_API_TOKEN }}':
        fail(f'{name}: Fly preflight must read the masked FLY_API_TOKEN secret')
    if '::error::FLY_API_TOKEN is not configured' not in preflight.get('run', ''):
        fail(f'{name}: Fly preflight error is not explicit')
    setup = steps[setup_indexes[0]]
    if not sha_ref.match(str(setup.get('uses', ''))):
        fail(f'{name}: Fly setup action is not pinned to a full commit SHA')
    version = str(setup.get('with', {}).get('version', ''))
    if not version or version == 'latest':
        fail(f'{name}: flyctl must be pinned to an explicit version')

for name in (
    'deploy-staging-tasks-api.yml',
    'deploy-staging-budget-api.yml',
    'deploy-staging-content-scheduler-api.yml',
    'deploy-staging-auto-post-worker.yml',
):
    deploy_steps = docs[name].get('jobs', {}).get('deploy', {}).get('steps', [])
    deploy_command = '\n'.join(
        str(step.get('run', ''))
        for step in deploy_steps
        if step.get('name') == 'Deploy (canary)'
    )
    if '--env GIT_COMMIT_SHA=${{ github.sha }}' not in deploy_command:
        fail(f'{name}: deploy must expose the immutable GitHub SHA to runtime health/version checks')

supabase_steps = docs['gymtrack-deploy.yml']['jobs']['deploy']['steps']
supabase = next((s for s in supabase_steps if str(s.get('uses', '')).startswith('supabase/setup-cli@')), None)
if not supabase:
    fail('gymtrack-deploy.yml: missing Supabase setup action')
else:
    if not re.match(r'^supabase/setup-cli@[0-9a-f]{40}$', str(supabase.get('uses', ''))):
        fail('gymtrack-deploy.yml: Supabase action is not pinned to a full commit SHA')
    version = str(supabase.get('with', {}).get('version', ''))
    if not version or version == 'latest':
        fail('gymtrack-deploy.yml: Supabase CLI must be pinned to an explicit version')

for name in ('deploy-staging-tasks-api.yml', 'deploy-staging-budget-api.yml', 'deploy-staging-content-scheduler-api.yml', 'deploy-staging-auto-post-worker.yml', 'deploy-staging-health-probe.yml'):
    if docs[name].get('concurrency', {}).get('cancel-in-progress') is not True:
        fail(f'{name}: staging must cancel superseded deployments')

for name in ('gymtrack-deploy.yml', 'gymtrack-mcp-deploy.yml'):
    if docs[name].get('concurrency', {}).get('cancel-in-progress') is not False:
        fail(f'{name}: production must never cancel an in-progress deployment')

website_concurrency = docs['website-deploy.yml']['jobs']['deploy'].get('concurrency', {})
if "inputs.target == 'staging'" not in str(website_concurrency.get('cancel-in-progress', '')):
    fail('website-deploy.yml: cancellation must be enabled only for staging')

eas = jobs.get('eas-update-production', {})
if eas.get('environment') != 'production':
    fail('ci.yml: EAS update must use the production environment')
if eas.get('concurrency', {}).get('cancel-in-progress') is not False:
    fail('ci.yml: EAS production update must never cancel in progress')

# W43 audit F1: every `needs.changes.outputs.<name>` reference must resolve
# to a declared job output. The earlier contract suite checked merge-gate
# dependency + always() on the deploy job but not the producer/consumer
# mapping, which is how the unexported `content_scheduler_api` filter
# slipped through. Pair this with the path-fixture block below so the
# regression stays caught even when the workflow is re-shaped.
changes_outputs = set(jobs.get('changes', {}).get('outputs', {}).keys())
output_ref_re = re.compile(r'needs\.changes\.outputs\.([A-Za-z_][A-Za-z0-9_]*)')
consumer_refs = set()
for job_name, job in jobs.items():
    if not isinstance(job, dict):
        continue
    condition = str(job.get('if', ''))
    consumer_refs.update(output_ref_re.findall(condition))
if not consumer_refs:
    fail('ci.yml: no needs.changes.outputs references found in deploy/clippy conditions')
missing_producers = sorted(consumer_refs - changes_outputs)
if missing_producers:
    fail(
        'ci.yml: needs.changes.outputs references without a matching producer: '
        f'{missing_producers}'
    )

# W43 audit F1 (AC3) — self-test: if the scheduler producer is removed, the
# producer/consumer check above must fail. Run the assertion against a
# mutated copy of the changes outputs and confirm it trips. Skipped only
# when the suite has nothing to prove (zero consumers), which the check
# above already guards against.
mutated_outputs = set(changes_outputs)
if 'content_scheduler_api' in mutated_outputs:
    mutated_outputs.discard('content_scheduler_api')
    if not (consumer_refs - mutated_outputs):
        fail(
            'ci.yml: producer/consumer check did not fail when content_scheduler_api '
            'was removed from the changes job outputs — regression test is broken'
        )

# W43 audit F1 (AC2) — schedule-only path fixtures: a scheduler-only
# change must select the scheduler API deployment; an unrelated change
# must not. Parse the dorny/paths-filter `filters:` block so the fixture
# exercises the same matcher the real action uses, instead of relying on
# substring heuristics that drift when filter entries are added.
filter_step = next(
    (
        step for step in jobs.get('changes', {}).get('steps', [])
        if isinstance(step, dict) and step.get('id') == 'filter'
    ),
    None,
)
if not filter_step:
    fail('ci.yml: changes job must include a dorny/paths-filter step with id=filter')
else:
    filters_text = str(filter_step.get('with', {}).get('filters', ''))
    parsed_filters = yaml.safe_load(filters_text) or {}
    if not isinstance(parsed_filters, dict):
        fail('ci.yml: paths-filter filters must parse to a mapping')

    def matches_filter(changed_path, globs):
        if not isinstance(globs, list):
            return False
        for glob in globs:
            if not isinstance(glob, str):
                continue
            if fnmatch.fnmatch(changed_path, glob):
                return True
        return False

    def selected_outputs(changed_paths):
        return {
            name
            for name, globs in parsed_filters.items()
            if any(matches_filter(path, globs) for path in changed_paths)
        }

    scheduler_only_change = ['services/content-scheduler-api/src/server.ts']
    selected_scheduler_only = selected_outputs(scheduler_only_change)
    if 'content_scheduler_api' not in selected_scheduler_only:
        fail(
            'ci.yml: scheduler-only change did not select the content_scheduler_api filter: '
            f'changed={scheduler_only_change}, selected={sorted(selected_scheduler_only)}'
        )
    # The worker shares the same source paths, so the auto_post_worker
    # filter must also fire — this protects against an accidental
    # divergence where one filter is updated without the other.
    if 'auto_post_worker' not in selected_scheduler_only:
        fail(
            'ci.yml: scheduler-only change did not select the auto_post_worker filter: '
            f'changed={scheduler_only_change}, selected={sorted(selected_scheduler_only)}'
        )

    unrelated_change = ['apps/website/src/pages/index.tsx']
    selected_unrelated = selected_outputs(unrelated_change)
    if 'content_scheduler_api' in selected_unrelated:
        fail(
            'ci.yml: unrelated website change selected the content_scheduler_api filter: '
            f'changed={unrelated_change}, selected={sorted(selected_unrelated)}'
        )
    if 'auto_post_worker' in selected_unrelated:
        fail(
            'ci.yml: unrelated website change selected the auto_post_worker filter: '
            f'changed={unrelated_change}, selected={sorted(selected_unrelated)}'
        )
    if 'website' not in selected_unrelated:
        fail(
            'ci.yml: unrelated website change did not select the website filter: '
            f'changed={unrelated_change}, selected={sorted(selected_unrelated)}'
        )

if failures:
    for message in failures:
        print(f'FAIL: {message}', file=sys.stderr)
    raise SystemExit(1)

print('ci-deployment-gates: ok')
PY
