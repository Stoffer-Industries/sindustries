// scripts/test/check-no-absolute-paths.test.mjs
//
// Unit tests for scripts/check-no-absolute-paths.mjs. Run with:
//   node --test scripts/test/check-no-absolute-paths.test.mjs
//
// Each test creates an isolated temp directory, drops a synthetic file
// tree into it, then invokes the lint script with that directory as the
// cwd and the test's root as the positional scan argument. This keeps
// the test fully independent of the repo's actual contents.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../check-no-absolute-paths.mjs', import.meta.url).pathname;

function runScript(args, cwd) {
  return spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'noabs-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('passes when no offenders exist under the scan root', () => {
  const dir = makeTree({ 'apps/ok.js': 'const x = "/api/v1/tasks";\n' });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /no offenders/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails on a /Users/<name> offender with file:line diagnostic', () => {
  const dir = makeTree({
    'apps/bad.js': 'export const repo = "/Users/quinnstoffer/sindustries";\n',
  });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /apps\/bad\.js:1/);
    assert.match(r.stderr, /\/Users\/quinnstoffer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails on a ~/ shorthand offender that points to a laptop-dev path', () => {
  const dir = makeTree({
    'services/tilde.ts': 'const home = "~/workspaces/rowan/sindustries";\n',
  });
  try {
    const r = runScript(['services'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /services\/tilde\.ts:1/);
    assert.match(r.stderr, /~\/workspaces/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not flag ~/.<config>/... (operator-portable config paths)', () => {
  // ~/.openclaw, ~/.config, ~/.local, ~/.cache are $HOME-relative paths
  // that work identically on every machine — they are not laptop paths
  // and should not trip the lint.
  const dir = makeTree({
    'services/cfg.ts': [
      'const cfg = "~/.openclaw/tasks-api/required-approvals.yaml";',
      'const cache = "~/.cache/my-tool/data";',
      'const local = "~/.local/share/state";',
      '',
    ].join('\n'),
  });
  try {
    const r = runScript(['services'], dir);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails on a /home/<name> offender', () => {
  const dir = makeTree({
    'packages/cfg.js': 'const p = "/home/runner/work/repo";\n',
  });
  try {
    const r = runScript(['packages'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /packages\/cfg\.js:1/);
    assert.match(r.stderr, /\/home\/runner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not descend into node_modules, dist, target, .git, etc.', () => {
  const dir = makeTree({
    'apps/ok.js': 'const x = 1;\n',
    'apps/node_modules/pkg/index.js': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/dist/bundle.js': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/target/output.txt': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/.git/HEAD': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/build/asset.txt': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/coverage/lcov.info': 'const p = "/Users/quinnstoffer/whatever";\n',
    'apps/.next/build-manifest.json': 'const p = "/Users/quinnstoffer/whatever";\n',
  });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skips binary files by extension (no false positive on avatar.png bytes)', () => {
  const dir = makeTree({
    // Bytes that contain the literal "/Users/quinnstoffer" substring.
    'apps/avatar.png': Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('/Users/quinnstoffer/png-bytes'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    ]),
  });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports multiple offenders across multiple files', () => {
  const dir = makeTree({
    'apps/a.js': 'const a = "/Users/alice/x";\n',
    'apps/b.js': 'const b = "/Users/bob/y";\n',
    'apps/c.js': 'const c = "~/workspaces/dev/c";\n',
  });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /apps\/a\.js:1/);
    assert.match(r.stderr, /apps\/b\.js:1/);
    assert.match(r.stderr, /apps\/c\.js:1/);
    // 3 offenders counted in the summary line
    assert.match(r.stderr, /3 hard-coded absolute path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom scan roots: only the requested root is scanned', () => {
  const dir = makeTree({
    'apps/offender.js': 'const p = "/Users/quinnstoffer/whatever";\n',
    'services/offender.ts': 'const p = "/Users/quinnstoffer/whatever";\n',
  });
  try {
    const r1 = runScript(['apps'], dir);
    assert.equal(r1.status, 1, 'apps should be flagged');
    assert.match(r1.stderr, /apps\/offender\.js:1/);
    assert.doesNotMatch(r1.stderr, /services\/offender\.ts/);

    const r2 = runScript(['services'], dir);
    assert.equal(r2.status, 1, 'services should be flagged');
    assert.match(r2.stderr, /services\/offender\.ts:1/);
    assert.doesNotMatch(r2.stderr, /apps\/offender\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing scan root is treated as no offenders (idempotent on absent dirs)', () => {
  const dir = makeTree({});
  try {
    const r = runScript(['does-not-exist'], dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not flag generic /users/ in URL paths (lowercase, not a username)', () => {
  // /Users/ is the macOS convention; lowercase /users/ in URLs is a
  // different shape and not what this lint targets.
  const dir = makeTree({
    'apps/api.js': 'fetch("/users/42/profile")\n',
  });
  try {
    const r = runScript(['apps'], dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});