// scripts/test/check-design-system-lint.test.mjs
//
// Unit tests for scripts/check-design-system-lint.mjs. Run with:
//   node --test scripts/test/check-design-system-lint.test.mjs
//
// These tests stub `.oxlintrc.json` and `components.json` in an isolated
// temp directory and assert the wrapper's exit-code behaviour for each
// contract violation. They do NOT exercise oxlint against real repo code
// — that requires `npm ci` in a non-temp directory; the live CI job
// (`frontend-design-system-lint`) runs the real flow against the repo's
// actual install. The lint-pass invocation here is also stubbed by
// passing `--config` to a path that doesn't load (so oxlint fails with
// status 2, which we treat as a contract pass for these tests — we only
// assert contract violations, not offence counts).

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

const VALID_COMPONENTS = JSON.stringify({ style: 'default', rsc: false, tsx: true });

// Active-install config — slice 4 contract: settings.shadcn + at least
// one shadcn/* rule in the top-level rules block.
function makeActiveOxlintrc(extra = {}) {
  return JSON.stringify(
    {
      jsPlugins: ['@shadcn/lint'],
      settings: { shadcn: { ui: ['@sindustries/ui'] } },
      rules: {
        'shadcn/no-restyle': ['warn', { allow: ['layout'], contracts: [] }],
      },
      ...extra,
    },
    null,
    2,
  );
}

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
  const dir = makeTree({ '.oxlintrc.json': makeActiveOxlintrc() });
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
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['some-other-plugin'],
      settings: { shadcn: { ui: ['@sindustries/ui'] } },
      rules: { 'shadcn/no-restyle': 'warn' },
    }),
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

test('exits 1 when no shadcn/* rules are present in the rules block', () => {
  // Plugin is registered but the rules block has zero shadcn/* entries.
  // This is the dormant-install trap: the plugin was loaded but no
  // rules were enabled, so the lint ran with zero shadcn/* rules.
  const dir = makeTree({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['@shadcn/lint'],
      settings: { shadcn: { ui: ['@sindustries/ui'] } },
      rules: { 'no-unused-vars': 'warn' },
    }),
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /zero shadcn\/\* entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 1 when settings.shadcn is missing (legacy dormant key path)', () => {
  // The dormant install used settings["shadcn-lint"] with rulesEnabled:
  // false — the wrong key path. Slice 4 requires settings.shadcn.
  const dir = makeTree({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['@shadcn/lint'],
      settings: { 'shadcn-lint': { rulesEnabled: true } },
      rules: { 'shadcn/no-restyle': 'warn' },
    }),
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /settings\.shadcn is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configSummary surfaces active rule entries + settings.shadcn banner', () => {
  // The wrapper prints the config summary BEFORE attempting to invoke
  // oxlint. Verify the new (slice 4) contract fields surface correctly
  // from a stub config. When oxlint is resolvable via npx (e.g. the test
  // is run from a worktree where the repo has been npm-installed), the
  // lint pass will fail with status 1 because the stub targets don't
  // exist — which we accept as a pass for this banner assertion. When
  // oxlint is not available, the wrapper exits 2. Either 1 or 2 is
  // acceptable here; we only care that the banner prints correctly.
  const dir = makeTree({
    '.oxlintrc.json': makeActiveOxlintrc(),
    'components.json': VALID_COMPONENTS,
  });
  try {
    const r = runScript(dir);
    assert.ok(
      r.status === 1 || r.status === 2,
      `expected exit 1 (lint failed — stub targets missing) or 2 (no oxlint); got ${r.status}\nstderr: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('@shadcn/lint plugin: registered'),
      `expected plugin registration banner; got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('shadcn/* rule entries:'),
      `expected shadcn/* rule entries banner; got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('settings.shadcn: present'),
      `expected settings.shadcn present banner; got: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('settings.shadcn-lint: absent (correct)'),
      `expected settings.shadcn-lint absent banner; got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
