#!/usr/bin/env node
// check-production-blockers-register.test.mjs — task 5cb4a8fe AC6 static check test.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-production-blockers-register.mjs on six cases:
//   1. A synthetic tree where every public surface has a register row
//      carrying the matrix's exact contract identifier, and the
//      non-public surface has a hostname-less row, passes.
//   2. A synthetic tree where a public surface has no register row
//      fails (coverage).
//   3. A synthetic tree where a register row names the right hostname
//      but the wrong project/app identifier fails (contract drift).
//   4. A synthetic tree where the identifier is only a PREFIX of the
//      matrix value (`sindustries-tasks` for the `sindustries-tasks-api`
//      surface) fails — substring matching would wrongly pass here.
//   5. A synthetic tree where the non-public surface has no
//      hostname-less row fails.
//   6. The real repo tree passes.
//
// The test fixtures are constructed to avoid depending on the real tree's
// register contents; the real tree is scanned by running the script
// directly.
//
// Run with: node --test tests/cloud/tests/check-production-blockers-register.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-blockers-register.mjs');

const MATRIX = JSON.stringify({
  surfaces: [
    {
      id: 'mission-control',
      kind: 'frontend',
      vercelProject: 'sindustries-mission-control',
      production: 'mission-control.sindustries.co.nz',
    },
    {
      id: 'tasks-app',
      kind: 'frontend',
      vercelProject: 'sindustries-tasks',
      production: 'tasks.sindustries.co.nz',
    },
    {
      id: 'tasks-api',
      kind: 'api',
      flyApp: 'sindustries-tasks-api',
      production: 'tasks-api.sindustries.co.nz',
    },
    {
      id: 'auto-post-worker',
      kind: 'worker',
      flyApp: 'sindustries-auto-post-worker',
      production: null,
      publicUrl: false,
    },
  ],
});

const REGISTER_HEADER = [
  '# Production hostname blockers',
  '',
  '| Surface | Production hostname | Required DNS record | Owner | Status |',
  '| --- | --- | --- | --- | --- |',
].join('\n');

const REGISTER_ROWS = {
  missionControl: '| Mission Control | `mission-control.sindustries.co.nz` | CNAME → Vercel project `sindustries-mission-control` | Quinn | Pending |',
  tasksApp: '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` | Quinn | Pending |',
  tasksApi: '| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → Fly app `sindustries-tasks-api` | Quinn | Pending |',
  worker: '| Auto-post worker | _(none — no public URL)_ | n/a | — | Not applicable |',
};

function register(rows) {
  return `${REGISTER_HEADER}\n${rows.join('\n')}\n`;
}

const GOOD_REGISTER = register([
  REGISTER_ROWS.missionControl,
  REGISTER_ROWS.tasksApp,
  REGISTER_ROWS.tasksApi,
  REGISTER_ROWS.worker,
]);

function makeTree(registerText) {
  const dir = mkdtempSync(join(tmpdir(), 'check-production-blockers-register-'));
  const files = {
    'infra/cloud/hostname-matrix.json': MATRIX,
    'docs/cloud/production-blockers.md': registerText,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

async function runCheck(treeDir) {
  try {
    const { stdout } = await exec('node', [SCRIPT, treeDir]);
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('passes when every public surface has a row carrying the exact matrix identifier', async () => {
  const dir = makeTree(GOOD_REGISTER);
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 0, `expected pass, got:\n${result.stderr}`);
    assert.match(result.stdout, /production-blockers-register check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when a public surface has no row in the register', async () => {
  const dir = makeTree(
    register([REGISTER_ROWS.missionControl, REGISTER_ROWS.tasksApi, REGISTER_ROWS.worker])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(result.stderr, /no row in .*production-blockers\.md.*names the production hostname tasks\.sindustries\.co\.nz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the row names the right hostname but the wrong project identifier', async () => {
  const dir = makeTree(
    register([
      REGISTER_ROWS.missionControl,
      '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks-app` | Quinn | Pending |',
      REGISTER_ROWS.tasksApi,
      REGISTER_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(result.stderr, /tasks-app: the .* do not carry the matrix vercelProject `sindustries-tasks` as an exact code span/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the identifier is only a prefix of the matrix value', async () => {
  // `sindustries-tasks` is a substring of `sindustries-tasks-api`; a
  // substring comparison would wrongly accept this row.
  const dir = makeTree(
    register([
      REGISTER_ROWS.missionControl,
      REGISTER_ROWS.tasksApp,
      '| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → Fly app `sindustries-tasks` | Quinn | Pending |',
      REGISTER_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(result.stderr, /tasks-api: the .* do not carry the matrix flyApp `sindustries-tasks-api` as an exact code span/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the non-public surface has no hostname-less row', async () => {
  const dir = makeTree(
    register([REGISTER_ROWS.missionControl, REGISTER_ROWS.tasksApp, REGISTER_ROWS.tasksApi])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(result.stderr, /auto-post-worker: the matrix records publicUrl:false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repo tree passes', async () => {
  const { stdout } = await exec('node', [SCRIPT]);
  assert.match(stdout, /production-blockers-register check passed/);
});
