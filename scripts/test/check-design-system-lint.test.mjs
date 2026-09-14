// scripts/test/check-design-system-lint.test.mjs
//
// Unit tests for scripts/check-design-system-lint.mjs. Run with:
//   node --test scripts/test/check-design-system-lint.test.mjs
//
// These tests stub .oxlintrc.json and components.json in an isolated temp
// directory and assert the wrapper's exit-code behaviour against each stub.
// They do NOT exercise oxlint itself — that's the job of the live CI job
// (`frontend-design-system-lint`), which runs the real @shadcn/lint plugin
// against the repo's actual frontend surface.

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
    jsPlugins: [{ name: '@shadcn/lint', specifier: '0.1.0' }],
    settings: { 'shadcn-lint': { rulesEnabled: false } },
  },
  null,
  2,
);

const VALID_COMPONENTS = JSON.stringify({ style: 'default', rsc: false, tsx: true });

test('exits 2 when .oxlintrc.json is missing', () => {
  const dir = makeTree({ 'components.json': VALID_COMPONENTS });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 2, `expected exit 2\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /\.oxlintrc\.json missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 2 when components.json is missing', () => {
  const dir = makeTree({ '.oxlintrc.json': VALID_OXLINTRC });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 2, `expected exit 2\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /components\.json missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 2 when .oxlintrc.json is unparseable', () => {
  const dir = makeTree({
    '.oxlintrc.json': '{ this is not valid json',
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    // The wrapper reads the file with JSON.parse and exits 2 on a parse error.
    assert.equal(r.status, 2, `expected exit 2\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configSummary surfaces @shadcn/lint plugin registration in stderr banner', () => {
  // We can't run oxlint here (the script invokes `npx oxlint`), but the
  // config summary prints before that. Verify the wrapper correctly reads
  // the registered plugin specifier and reports rulesEnabled from settings.
  const dir = makeTree({
    '.oxlintrc.json': VALID_OXLINTRC,
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    // oxlint may not be installed in this isolated tempdir; either the script
    // succeeds (status 0) or surfaces a meaningful stderr. We accept either
    // path as long as the config summary prints plugin metadata.
    assert.ok(
      r.stderr.includes('@shadcn/lint plugin'),
      `expected plugin metadata in stderr; got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('rulesEnabled: false'),
      `expected rulesEnabled=false in stderr; got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
