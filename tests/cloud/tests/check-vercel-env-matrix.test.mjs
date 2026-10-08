#!/usr/bin/env node
// check-vercel-env-matrix.test.mjs — task 5cb4a8fe slice 5 static check test.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-vercel-env-matrix.mjs on six cases:
//   1. A synthetic tree with matrix-derived env values + customDomain
//      from the matrix passes.
//   2. A synthetic tree where a VITE_* value's host is not in the
//      matrix fails.
//   3. A synthetic tree where the production env var references a
//      staging hostname fails (cross-environment drift).
//   4. A synthetic tree where customDomain is not in the matrix fails.
//   5. A synthetic tree where an unknown VITE_* env var (e.g.
//      VITE_BOOKMARK_STATE_BASE_URL) is present passes — the check
//      intentionally skips non-matrix-derived env vars.
//   6. A synthetic tree with a bare-hostname env value (no scheme)
//      passes when the host is in the matrix.
//
// The real repo tree is scanned by running the script directly; the
// test fixtures are constructed to avoid depending on the real tree.
//
// Run with: node --test tests/cloud/tests/check-vercel-env-matrix.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-vercel-env-matrix.mjs');

const MATRIX = JSON.stringify({
  surfaces: [
    { id: 'mission-control', staging: 'mission-control.staging.sindustries.co.nz', production: 'mission-control.sindustries.co.nz' },
    { id: 'tasks-app', staging: 'tasks.staging.sindustries.co.nz', production: 'tasks.sindustries.co.nz' },
    { id: 'tasks-api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz' },
    { id: 'content-scheduler-api', staging: 'content-scheduler-api.staging.sindustries.co.nz', production: 'content-scheduler-api.sindustries.co.nz' },
  ],
});

function makeTree(layout) {
  const dir = mkdtempSync(join(tmpdir(), 'check-vercel-env-matrix-'));
  for (const [rel, content] of layout) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const GOOD_VERCEL = JSON.stringify({
  vercelProjects: [
    {
      vercelProjectId: 'sindustries-mission-control',
      appPath: 'apps/mission-control',
      environments: {
        production: {
          branch: 'main',
          customDomain: 'mission-control.sindustries.co.nz',
          env: {
            VITE_TASKS_API_BASE_URL: 'https://tasks-api.sindustries.co.nz/api/v1',
            VITE_CONTENT_SCHEDULER_API_BASE_URL: 'https://content-scheduler-api.sindustries.co.nz/api/v1',
          },
        },
        preview: {
          branch: 'staging',
          customDomain: 'mission-control.staging.sindustries.co.nz',
          env: {
            VITE_TASKS_API_BASE_URL: 'https://tasks-api.staging.sindustries.co.nz/api/v1',
            VITE_CONTENT_SCHEDULER_API_BASE_URL: 'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
          },
        },
      },
    },
  ],
});

test('synthetic tree: matrix-derived VITE_* values + customDomain pass', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', GOOD_VERCEL],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /vercel-env-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: non-matrix VITE_* value fails the check', async () => {
  const bad = JSON.parse(GOOD_VERCEL);
  bad.vercelProjects[0].environments.production.env.VITE_TASKS_API_BASE_URL = 'https://evil.example.com/api/v1';
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', JSON.stringify(bad)],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a non-matrix value');
    const out = (err.stderr || '') + (err.stdout || '');
    assert.match(out, /evil\.example\.com/, `expected the non-matrix error, got: ${out}`);
    assert.match(out, /does not match the production hostname/, `expected the matrix-miss note, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: production env referencing a staging hostname fails', async () => {
  const bad = JSON.parse(GOOD_VERCEL);
  bad.vercelProjects[0].environments.production.env.VITE_TASKS_API_BASE_URL = 'https://tasks-api.staging.sindustries.co.nz/api/v1';
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', JSON.stringify(bad)],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on cross-environment drift');
    const out = (err.stderr || '') + (err.stdout || '');
    assert.match(out, /references a preview\/staging hostname .* but the Vercel environment is production/, `expected cross-env drift error, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: customDomain not in matrix fails the check', async () => {
  const bad = JSON.parse(GOOD_VERCEL);
  bad.vercelProjects[0].environments.production.customDomain = 'not-in-matrix.example.com';
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', JSON.stringify(bad)],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a non-matrix customDomain');
    const out = (err.stderr || '') + (err.stdout || '');
    assert.match(out, /not-in-matrix\.example\.com/, `expected the customDomain error, got: ${out}`);
    assert.match(out, /is not a production hostname/, `expected the matrix-miss note, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: unknown VITE_* env var is silently skipped', async () => {
  // VITE_BOOKMARK_STATE_BASE_URL is a real env var on mission-control
  // for the dev-only brain state API. It is not matrix-derived, so the
  // check should pass without flagging it.
  const with_unknown = JSON.parse(GOOD_VERCEL);
  with_unknown.vercelProjects[0].environments.production.env.VITE_BOOKMARK_STATE_BASE_URL = 'http://localhost:5173';
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', JSON.stringify(with_unknown)],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /vercel-env-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: bare-hostname env value passes when host is in matrix', async () => {
  const with_bare = JSON.parse(GOOD_VERCEL);
  with_bare.vercelProjects[0].environments.production.env.VITE_TASKS_API_BASE_URL = 'tasks-api.sindustries.co.nz';
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/vercel-env-matrix.json', JSON.stringify(with_bare)],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /vercel-env-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
