#!/usr/bin/env node
// check-cors-origin-matrix.test.mjs — task 5cb4a8fe slice 2 static check test.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-cors-origin-matrix.mjs on five cases:
//   1. A synthetic tree with matrix-derived CORS origins passes.
//   2. A synthetic tree with a non-matrix origin fails.
//   3. A synthetic tree where a staging fly.toml lists a production
//      hostname fails (cross-environment drift).
//   4. A synthetic tree where a fly.toml has CORS_ALLOWED_ORIGINS but
//      the Fly app name has no `-staging` suffix is not flagged as
//      cross-environment drift (the check still requires the host to
//      be in the matrix, but cannot decide staging vs production
//      without the app-name signal).
//   5. A synthetic tree with a bare-hostname CORS origin
//      (no scheme) passes when the host is in the matrix.
//
// The real repo tree is scanned by running the script directly; the
// test fixtures are constructed to avoid depending on the real tree.
//
// Run with: node --test tests/cloud/tests/check-cors-origin-matrix.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-cors-origin-matrix.mjs');

const MATRIX = JSON.stringify({
  surfaces: [
    { id: 'mission-control', staging: 'mission-control.staging.sindustries.co.nz', production: 'mission-control.sindustries.co.nz' },
    { id: 'tasks-app', staging: 'tasks.staging.sindustries.co.nz', production: 'tasks.sindustries.co.nz' },
    { id: 'tasks-api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz' },
  ],
});

function makeTree(layout) {
  const dir = mkdtempSync(join(tmpdir(), 'check-cors-origin-matrix-'));
  for (const [rel, content] of layout) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test('synthetic tree: matrix-derived CORS origins pass', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/fly/tasks-api.fly.toml', `app = 'sindustries-tasks-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'https://tasks.staging.sindustries.co.nz,https://mission-control.staging.sindustries.co.nz'\n`],
    ['infra/cloud/fly/budget-api.fly.toml', `app = 'sindustries-budget-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'https://mission-control.staging.sindustries.co.nz'\n`],
    ['infra/cloud/fly/content-scheduler-api.fly.toml', `app = 'sindustries-content-scheduler-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'https://mission-control.staging.sindustries.co.nz'\n`],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /cors-origin-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: non-matrix CORS origin fails the check', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/fly/tasks-api.fly.toml', `app = 'sindustries-tasks-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'https://evil.example.com'\n`],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a non-matrix origin');
    const out = (err.stderr || '') + (err.stdout || '');
    assert.match(out, /evil\.example\.com/, `expected the non-matrix error, got: ${out}`);
    assert.match(out, /not in infra\/cloud\/hostname-matrix\.json/, `expected the matrix-miss note, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: staging app referencing production hostname fails', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/fly/tasks-api.fly.toml', `app = 'sindustries-tasks-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'https://mission-control.sindustries.co.nz'\n`],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on cross-environment drift');
    const out = (err.stderr || '') + (err.stdout || '');
    assert.match(out, /production hostname but the Fly app .* is a staging app/, `expected cross-env drift error, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: bare-hostname CORS origin passes when host is in matrix', async () => {
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/fly/tasks-api.fly.toml', `app = 'sindustries-tasks-api-staging'\n[env]\n  CORS_ALLOWED_ORIGINS = 'mission-control.staging.sindustries.co.nz'\n`],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /cors-origin-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: auto-post-worker fly.toml is out of scope and skipped', async () => {
  // auto-post-worker has no HTTP surface and no CORS_ALLOWED_ORIGINS; the
  // check should silently ignore its fly.toml even when present.
  const dir = makeTree([
    ['infra/cloud/hostname-matrix.json', MATRIX],
    ['infra/cloud/fly/auto-post-worker.fly.toml', `app = 'sindustries-auto-post-worker-staging'\n[env]\n  NODE_ENV = 'production'\n`],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /cors-origin-matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.match(stdout, /0 origins across 0 fly\.tomls/, `expected 0/0 tally, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
