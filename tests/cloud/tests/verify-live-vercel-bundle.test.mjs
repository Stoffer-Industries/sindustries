import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLiveBundle } from '../scripts/verify-live-vercel-bundle.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vercel-bundle-'));
  mkdirSync(join(root, 'infra/cloud'), { recursive: true });
  writeFileSync(join(root, 'infra/cloud/hostname-matrix.json'), JSON.stringify({ surfaces: [
    { id: 'mission-control', kind: 'frontend', vercelProject: 'prod', production: 'app.example.com', staging: 'app.staging.example.com' },
    { id: 'tasks-api', kind: 'api', production: 'api.example.com', staging: 'api.staging.example.com' },
  ] }));
  writeFileSync(join(root, 'infra/cloud/vercel-env-matrix.json'), JSON.stringify({ vercelProjects: [{
    vercelProjectId: 'prod',
    environments: { production: { servesEnvironment: 'production', customDomain: 'app.example.com', env: { VITE_TASKS_API_BASE_URL: 'https://api.example.com/api/v1' } } },
  }] }));
  return root;
}

function fetcher(bundle, assetStatus = 200) {
  return async (url) => String(url).endsWith('.js')
    ? new Response(bundle, { status: assetStatus })
    : new Response('<script type="module" src="/assets/index.js"></script>', { status: 200 });
}

test('clean production bundle passes', async () => {
  const root = fixture();
  try {
    const result = await verifyLiveBundle({ surface: 'mission-control', repoRoot: root, url: 'https://app.example.com/', fetchImpl: fetcher('https://api.example.com/api/v1') });
    assert.equal(result.expectedValues, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('staging leak and missing production value fail', async () => {
  const root = fixture();
  try {
    await assert.rejects(() => verifyLiveBundle({ surface: 'mission-control', repoRoot: root, url: 'https://app.example.com/', fetchImpl: fetcher('https://api.staging.example.com/api/v1') }), /missing expected production value|leaks staging value/);
    await assert.rejects(() => verifyLiveBundle({ surface: 'mission-control', repoRoot: root, url: 'https://app.example.com/', fetchImpl: fetcher('unrelated') }), /missing expected production value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing asset fails', async () => {
  const root = fixture();
  try {
    await assert.rejects(() => verifyLiveBundle({ surface: 'mission-control', repoRoot: root, url: 'https://app.example.com/', fetchImpl: fetcher('', 404) }), /returned 404/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
