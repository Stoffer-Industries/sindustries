#!/usr/bin/env node
// check-stable-url-fallbacks.test.mjs — task 5cb4a8fe static check (AC4).
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-stable-url-fallbacks.mjs on three cases:
//   1. A synthetic tree with an unannotated *.fly.dev reference fails.
//   2. A synthetic tree with an annotated *.fly.dev reference (HTML or
//      YAML comment) passes.
//   3. A synthetic tree with a *.vercel.app reference annotated with
//      `<!-- stable-fallback -->` passes.
//
// The real repo tree is not scanned in this test because it already
// contains several annotated `*.fly.dev` references in the deploy
// workflow smoke checks; running the script against the real tree
// requires the deploy workflow slice to land first, which is a
// follow-up commit on this branch.
//
// Run with: node --test tests/cloud/tests/check-stable-url-fallbacks.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-stable-url-fallbacks.mjs');

function makeTree(layout) {
  // layout: array of [relPath, content]
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-url-fallbacks-'));
  for (const [rel, content] of layout) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test('synthetic tree: unannotated *.fly.dev reference fails the check', async () => {
  const dir = makeTree([
    ['.github/workflows/deploy-staging-tasks-api.yml', 'jobs:\n  deploy:\n    steps:\n      - run: curl https://sindustries-tasks-api-staging.fly.dev/health\n'],
  ]);
  try {
    let err;
    try { await exec('node', [SCRIPT, dir]); } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on an unannotated .fly.dev reference');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /unannotated sindustries-tasks-api-staging\.fly\.dev/, `expected the unannotated-error line, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: annotated *.fly.dev reference (HTML comment on the line above) passes', async () => {
  const dir = makeTree([
    ['.github/workflows/deploy-staging-tasks-api.yml', 'jobs:\n  deploy:\n    steps:\n      - run: |\n          # stable-fallback\n          curl https://sindustries-tasks-api-staging.fly.dev/health\n'],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /stable URL fallback check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic tree: *.vercel.app reference annotated with HTML stable-fallback passes', async () => {
  const dir = makeTree([
    ['docs/systems/cloud-platform.md', '# Cloud Platform\n\n<!-- stable-fallback -->\n\nReference: https://sindustries-mission-control.vercel.app\n'],
  ]);
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, dir]);
    assert.match(stdout, /stable URL fallback check passed/, `expected pass line on stdout, got: ${stdout}`);
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
