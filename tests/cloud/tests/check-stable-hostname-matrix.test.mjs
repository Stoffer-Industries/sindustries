#!/usr/bin/env node
// check-stable-hostname-matrix.test.mjs — task 5cb4a8fe static check.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-stable-hostname-matrix.mjs via execFile on three cases:
//   1. The real repo tree passes (no synthetic fixture needed; the matrix
//      and the per-hostname fly.toml comment blocks are in the working
//      tree).
//   2. A synthetic matrix missing a required public surface fails with a
//      recognisable error.
//   3. A synthetic fly.toml whose comment block omits the staging
//      hostname fails with a recognisable error.
//
// Run with: node --test tests/cloud/tests/check-stable-hostname-matrix.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-stable-hostname-matrix.mjs');

test('real repo tree: check-stable-hostname-matrix exits 0 on the committed matrix + fly.toml comment blocks', async () => {
  const { stdout, stderr } = await exec('node', [SCRIPT], { cwd: REPO_ROOT });
  // The script writes its pass message to stdout; ensure no error text on stderr.
  assert.match(stdout, /hostname matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
  assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
});

test('synthetic matrix missing a required public surface fails the check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = {
      taskId: 'test',
      apexDomain: 'sindustries.co.nz',
      stagingSubdomainSuffix: 'staging.sindustries.co.nz',
      productionApex: 'sindustries.co.nz',
      surfaces: [
        { id: 'tasks-api', kind: 'api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz', providerFallback: 'sindustries-tasks-api.fly.dev' },
        { id: 'budget-api', kind: 'api', staging: 'budget-api.staging.sindustries.co.nz', production: 'budget-api.sindustries.co.nz', providerFallback: 'sindustries-budget-api.fly.dev' },
        { id: 'auto-post-worker', kind: 'worker', staging: null, production: null, providerFallback: null, publicUrl: false, rationale: 'no public URL' },
      ],
    };
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    // No fly-dir passed; the script defaults to <repo-root>/infra/cloud/fly —
    // but the synthetic matrix has surfaces whose fly.toml files DO exist
    // there (tasks-api, budget-api, auto-post-worker), and the test is
    // specifically checking the matrix-shape error path before the toml
    // check runs. To make that explicit, point the script at an empty
    // fly-dir so the surface-row error fires first.
    const emptyFlyDir = join(dir, 'fly');
    mkdirSync(emptyFlyDir);
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, emptyFlyDir]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a matrix missing required public surfaces');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /surfaces must include public surface "mission-control"|surfaces must include public surface "tasks-app"|surfaces must include public surface "content-scheduler-api"|surfaces must include public surface "health-probe"/, `expected a missing-surface error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic fly.toml whose comment block omits the staging hostname fails the check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = {
      taskId: 'test',
      apexDomain: 'sindustries.co.nz',
      stagingSubdomainSuffix: 'staging.sindustries.co.nz',
      productionApex: 'sindustries.co.nz',
      surfaces: [
        { id: 'tasks-api', kind: 'api', flyApp: 'sindustries-tasks-api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz', providerFallback: 'sindustries-tasks-api.fly.dev' },
      ],
    };
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    // The fly.toml comment block names the production hostname but omits
    // the staging hostname; the script should report the missing-staging
    // assertion.
    const flyDir = join(dir, 'fly');
    mkdirSync(flyDir);
    writeFileSync(join(flyDir, 'tasks-api.fly.toml'),
      '# tasks-api\n# Source of truth: infra/cloud/hostname-matrix.json\n# production: tasks-api.sindustries.co.nz\n\napp = "sindustries-tasks-api-staging"\n');
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, flyDir]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a fly.toml missing the staging hostname in its comment block');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /tasks-api\.fly\.toml: leading comment block must mention staging hostname/, `expected a missing-staging-hostname error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
