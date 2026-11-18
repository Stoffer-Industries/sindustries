import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const root = new URL('../../..', import.meta.url).pathname;
const script = join(root, 'tests/cloud/scripts/check-production-vercel-deploy-contract.mjs');
const workflowPath = '.github/workflows/deploy-production-vercel-frontends.yml';

test('real production Vercel workflow satisfies the contract', async () => {
  const { stdout } = await exec('node', [script, root]);
  assert.match(stdout, /check passed/);
});

test('contract check rejects cancellation and an unscoped Vercel command', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'vercel-deploy-contract-'));
  try {
    mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
    const source = readFileSync(join(root, workflowPath), 'utf8')
      .replace('cancel-in-progress: false', 'cancel-in-progress: true')
      .replace('vercel promote "${{ steps.candidate.outputs.url }}" --yes --scope "$VERCEL_TEAM_SCOPE" --token="$VERCEL_TOKEN"', 'vercel promote "${{ steps.candidate.outputs.url }}" --yes');
    writeFileSync(join(fixture, workflowPath), source);
    let failure;
    try { await exec('node', [script, fixture]); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(`${failure.stdout}${failure.stderr}`, /must not cancel|not explicitly scoped/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('contract check rejects a lone Vercel scope export and a hardcoded team scope', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'vercel-deploy-contract-scope-'));
  try {
    mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
    const source = readFileSync(join(root, workflowPath), 'utf8')
      .replace('VERCEL_TEAM_SCOPE: ${{ secrets.VERCEL_ORG_ID }}', 'VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}')
      .replace('--scope "$VERCEL_TEAM_SCOPE"', '--scope "toms-projects-7a48f06e"');
    writeFileSync(join(fixture, workflowPath), source);
    let failure;
    try { await exec('node', [script, fixture]); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(`${failure.stdout}${failure.stderr}`, /must be exported together|must not hardcode/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('contract check rejects running the Vercel CLI inside the app path', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'vercel-deploy-contract-cwd-'));
  try {
    mkdirSync(join(fixture, '.github/workflows'), { recursive: true });
    const source = readFileSync(join(root, workflowPath), 'utf8')
      .replace(
        '      - name: Build production candidate\n        if: steps.gate.outputs.enabled == \'true\'\n',
        '      - name: Build production candidate\n        if: steps.gate.outputs.enabled == \'true\'\n        working-directory: ${{ steps.facts.outputs.app_path }}\n'
      );
    writeFileSync(join(fixture, workflowPath), source);
    let failure;
    try { await exec('node', [script, fixture]); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(`${failure.stdout}${failure.stderr}`, /must run at the repository root/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
