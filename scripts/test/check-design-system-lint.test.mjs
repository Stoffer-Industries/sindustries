// scripts/test/check-design-system-lint.test.mjs
//
// Unit tests for scripts/check-design-system-lint.mjs. Run with:
//   node --test scripts/test/check-design-system-lint.test.mjs
//
// These tests stub `.oxlintrc.json` and `components.json` in an isolated
// temp directory and assert the wrapper's exit-code behaviour for each
// contract violation. They do NOT exercise oxlint itself — that requires
// `npm ci` in a non-temp directory; the live CI job
// (`frontend-design-system-lint`) runs the real flow against the repo's
// actual install.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../check-design-system-lint.mjs', import.meta.url).pathname;

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsl-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runScript(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' });
}

const VALID_OXLINTRC = JSON.stringify(
  {
    jsPlugins: ['@shadcn/lint'],
    settings: { 'shadcn-lint': { rulesEnabled: false } },
  },
  null,
  2,
);

const VALID_COMPONENTS = JSON.stringify({ style: 'default', rsc: false, tsx: true });

test('exits 1 when .oxlintrc.json is missing', () => {
  const dir = makeTree({ 'components.json': VALID_COMPONENTS });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /\.oxlintrc\.json missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 1 when components.json is missing', () => {
  const dir = makeTree({ '.oxlintrc.json': VALID_OXLINTRC });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /components\.json missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 1 when .oxlintrc.json is unparseable', () => {
  const dir = makeTree({
    '.oxlintrc.json': '{ this is not valid json',
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /parse failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 1 when @shadcn/lint is not registered in jsPlugins', () => {
  const dir = makeTree({
    '.oxlintrc.json': JSON.stringify({ jsPlugins: ['some-other-plugin'] }),
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /NOT REGISTERED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 1 when rulesEnabled is not explicitly false', () => {
  const dir = makeTree({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['@shadcn/lint'],
      settings: { 'shadcn-lint': { rulesEnabled: true } },
    }),
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /rulesEnabled is not explicitly false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configSummary surfaces @shadcn/lint registration + rulesEnabled=false in stderr banner', () => {
  // The wrapper prints the config summary BEFORE attempting to invoke
  // oxlint. Verify both fields surface correctly from a stub config.
  // When oxlint is resolvable via npx (e.g. the test is run from a worktree
  // where the repo has been npm-installed), the smoke test will pass with
  // exit 0. When oxlint is not available, it exits 2. Either is acceptable
  // for this assertion — we only care that the banner prints correctly.
  const dir = makeTree({
    '.oxlintrc.json': VALID_OXLINTRC,
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.ok(
      r.status === 0 || r.status === 2,
      `expected exit 0 (oxlint available) or 2 (no oxlint); got ${r.status}\nstderr: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('@shadcn/lint plugin: registered'),
      `expected plugin registration banner; got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('rulesEnabled: false'),
      `expected rulesEnabled=false in banner; got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
