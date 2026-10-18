#!/usr/bin/env bash
# Static contract for task 02c5475c: merge/deployment gates, pinning, and concurrency.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
import fnmatch
import json
import pathlib
import re
import subprocess
import sys

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
expected_required = {
    'changes',
    'python-workflow-tests',
    'cto-craft-tweet-drafts-tests',
    'otel-node-tests',
    'health-probe-tests',
    'mission-control-tests',
    'tasks-api-tests',
    'content-scheduler-api-tests',
    'content-scheduler-api-db-integration',
    'feature-task-workflow-tests',
    'ash-tests',
    'budget-api-unit',
    'budget-api-db-integration',
    'tasks-app-tests',
    'tasks-app-e2e',
    'website-app-tests',
    'gymtrack-tests',
    'gymtrack-mcp-tests',
    'design-system-sync',
    'frontend-design-system-lint',
    'no-absolute-paths-lint',
    'infra-cloud-bootstrap-staging-tests',
    'gitleaks',
    'feature-task-clippy',
}

if gate.get('name') != 'merge gate':
    fail("ci.yml: merge-gate must expose the stable job name 'merge gate'")
if gate.get('if') != 'always()':
    fail('ci.yml: merge-gate must run under always()')
if set(gate.get('needs', [])) != expected_required:
    missing = expected_required - set(gate.get('needs', []))
    extra = set(gate.get('needs', [])) - expected_required
    fail(f'ci.yml: merge-gate needs mismatch; missing={sorted(missing)}, extra={sorted(extra)}')
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
