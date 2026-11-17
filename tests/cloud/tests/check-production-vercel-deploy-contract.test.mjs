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
      .replace('vercel promote "${{ steps.candidate.outputs.url }}" --yes --scope "$VERCEL_ORG_ID" --token="$VERCEL_TOKEN"', 'vercel promote "${{ steps.candidate.outputs.url }}" --yes');
    writeFileSync(join(fixture, workflowPath), source);
    let failure;
    try { await exec('node', [script, fixture]); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(`${failure.stdout}${failure.stderr}`, /must not cancel|not explicitly scoped/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
