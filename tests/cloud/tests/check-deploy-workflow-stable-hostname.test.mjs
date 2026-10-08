#!/usr/bin/env node
// check-deploy-workflow-stable-hostname.test.mjs — task 5cb4a8fe static
// check (AC4 — CI deploy workflows use the stable hostnames; slice 3).
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-deploy-workflow-stable-hostname.mjs on three cases:
//   1. A synthetic tree with the tasks-api, budget-api, and
//      content-scheduler-api deploy workflows all pointing at the
//      matrix stable staging URLs passes the check.
//   2. A synthetic tree with the tasks-api deploy workflow still
//      pointing at the provider URL fails the check (catches AC4
//      regressions where someone reverts the smoke URL to fly.dev).
//   3. A synthetic tree missing the budget-api deploy workflow file
//      fails the check on "deploy-staging-budget-api.yml not found".
//
// Run with: node --test tests/cloud/tests/check-deploy-workflow-stable-hostname.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-deploy-workflow-stable-hostname.mjs');

const TASKS_API_WORKFLOW_OK = [
  'name: Deploy tasks-api (Fly.io staging)',
  'on:',
  '  workflow_call:',
  'jobs:',
  '  deploy:',
  '    steps:',
  '      - name: Smoke check',
  '        run: |',
  '          set -euo pipefail',
  '          # <!-- stable-fallback --> https://sindustries-tasks-api-staging.fly.dev/health',
  '          URL="https://tasks-api.staging.sindustries.co.nz/health"',
  '          for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
  '            if curl --fail --silent --max-time 10 "$URL"; then',
  '              echo "Smoke OK on attempt $i"',
  '              exit 0',
  '            fi',
  '            sleep 5',
  '          done',
  '          echo "Smoke failed" >&2',
  '          exit 1',
  '',
].join('\n');

const TASKS_API_WORKFLOW_BAD = [
  'name: Deploy tasks-api (Fly.io staging)',
  'on:',
  '  workflow_call:',
  'jobs:',
  '  deploy:',
  '    steps:',
  '      - name: Smoke check',
  '        run: |',
  '          set -euo pipefail',
  '          URL="https://sindustries-tasks-api-staging.fly.dev/health"',
  '          for i in 1 2 3 4 5 6 7 8 9 10; do',
  '            if curl --fail --silent --max-time 10 "$URL"; then',
  '              exit 0',
  '            fi',
  '            sleep 5',
  '          done',
  '          exit 1',
  '',
].join('\n');

// Build a per-service workflow by replacing every occurrence of the
// tasks-api slug in name + URL + comment. The first replace() would
// only swap the workflow name and leave the URL pointing at tasks-api,
// which is exactly the regression we are testing for. split/join is
// the portable "replaceAll" that works on every Node version.
function workflowFor(slug) {
  return TASKS_API_WORKFLOW_OK.split('tasks-api').join(slug);
}

function matrixFile(rows) {
  const surfaces = Array.isArray(rows) ? rows : [rows];
  return JSON.stringify({
    taskId: '00000000-0000-0000-0000-000000000000',
    apexDomain: 'sindustries.co.nz',
    stagingSubdomainSuffix: 'staging.sindustries.co.nz',
    productionApex: 'sindustries.co.nz',
    surfaces,
  }, null, 2) + '\n';
}

// The script asserts every required deploy workflow matches a surface
// in the matrix. The tests below only validate a single surface at a
// time, so the matrix must include every required api surface even
// when the test focuses on one — otherwise the script short-circuits
// on "matrix missing required surface" before it inspects the surface
// under test. This factory builds the minimum matrix the test needs.
const MINIMUM_API_SURFACES = [
  {
    id: 'tasks-api',
    kind: 'api',
    flyApp: 'sindustries-tasks-api',
    staging: 'tasks-api.staging.sindustries.co.nz',
    production: 'tasks-api.sindustries.co.nz',
    providerFallback: 'sindustries-tasks-api-staging.fly.dev',
  },
  {
    id: 'budget-api',
    kind: 'api',
    flyApp: 'sindustries-budget-api',
    staging: 'budget-api.staging.sindustries.co.nz',
    production: 'budget-api.sindustries.co.nz',
    providerFallback: 'sindustries-budget-api-staging.fly.dev',
  },
  {
    id: 'content-scheduler-api',
    kind: 'api',
    flyApp: 'sindustries-content-scheduler-api',
    staging: 'content-scheduler-api.staging.sindustries.co.nz',
    production: 'content-scheduler-api.staging.sindustries.co.nz',
    providerFallback: 'sindustries-content-scheduler-api-staging.fly.dev',
  },
];

function makeTree(layout) {
  const dir = mkdtempSync(join(tmpdir(), 'check-deploy-workflow-stable-hostname-'));
  for (const [rel, content] of layout) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test('synthetic tree: all required deploy workflows target the matrix stable staging URLs', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', matrixFile(MINIMUM_API_SURFACES)],
    ['.github/workflows/deploy-staging-tasks-api.yml', TASKS_API_WORKFLOW_OK],
    ['.github/workflows/deploy-staging-budget-api.yml', workflowFor('budget-api')],
    ['.github/workflows/deploy-staging-content-scheduler-api.yml', workflowFor('content-scheduler-api')],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /deploy-workflow stable-hostname check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: a required deploy workflow still targeting the provider URL fails the check', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', matrixFile(MINIMUM_API_SURFACES)],
    ['.github/workflows/deploy-staging-tasks-api.yml', TASKS_API_WORKFLOW_BAD],
    ['.github/workflows/deploy-staging-budget-api.yml', workflowFor('budget-api')],
    ['.github/workflows/deploy-staging-content-scheduler-api.yml', workflowFor('content-scheduler-api')],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail when the workflow still targets the provider URL');
    const combined = (err.stderr || '') + (err.stdout || '');
    assert.match(
      combined,
      /smoke check does not target matrix stable URL/,
      `expected the smoke-url error, got: ${combined}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: a required deploy workflow file missing fails the check', async () => {
  // No .github/workflows/deploy-staging-budget-api.yml written; the
  // matrix still lists budget-api so the script reports a missing file.
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', matrixFile(MINIMUM_API_SURFACES)],
    ['.github/workflows/deploy-staging-tasks-api.yml', TASKS_API_WORKFLOW_OK],
    ['.github/workflows/deploy-staging-content-scheduler-api.yml', workflowFor('content-scheduler-api')],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail when a required deploy workflow is missing');
    const combined = (err.stderr || '') + (err.stdout || '');
    assert.match(
      combined,
      /deploy-staging-budget-api\.yml not found/,
      `expected the missing-workflow error, got: ${combined}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
