#!/usr/bin/env bash
# Static contract for task 02c5475c: merge/deployment gates, pinning, and concurrency.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 - "$REPO_ROOT" <<'PY'
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
    'mission-control-tests',
    'tasks-api-tests',
    'content-scheduler-api-tests',
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
    'deploy-auto-post-worker-staging',
    'deploy-gymtrack-production',
    'deploy-gymtrack-mcp-production',
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
    'deploy-staging-auto-post-worker.yml',
    'gymtrack-deploy.yml',
    'gymtrack-mcp-deploy.yml',
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
    'deploy-staging-auto-post-worker.yml',
    'gymtrack-mcp-deploy.yml',
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

for name in ('deploy-staging-tasks-api.yml', 'deploy-staging-budget-api.yml', 'deploy-staging-auto-post-worker.yml'):
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

if failures:
    for message in failures:
        print(f'FAIL: {message}', file=sys.stderr)
    raise SystemExit(1)

print('ci-deployment-gates: ok')
PY
