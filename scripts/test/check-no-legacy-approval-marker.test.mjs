#!/usr/bin/env node
// scripts/test/check-no-legacy-approval-marker.test.mjs
//
// Unit-test the script's offender-detection logic in isolation. We do not
// shell out to the script because the offender-detection core is a pure
// function over filesystem inputs and an `execSync` test would be slow
// and brittle.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ALLOWLIST_FILES,
  PATTERN,
  LINE_ESCAPE_RE,
  findOffenders
} from '../check-no-legacy-approval-marker.mjs';

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-approval-marker-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  return root;
}

function writeFixture(root, rel, body) {
  const full = join(root, rel);
  mkdirSync(full.split(sep).slice(0, -1).join(sep), { recursive: true });
  writeFileSync(full, body);
}

test('PATTERN matches the checked marker literal exactly', () => {
  PATTERN.lastIndex = 0;
  assert.ok(PATTERN.test('- [x] **Approved by Tom**'));
  PATTERN.lastIndex = 0;
  assert.equal(PATTERN.test('- [ ] **Approved by Tom**'), false);
  PATTERN.lastIndex = 0;
  assert.equal(PATTERN.test('Approved by Tom'), false);
});

test('PATTERN ignores nested unmarked text', () => {
  PATTERN.lastIndex = 0;
  assert.equal(PATTERN.test('- [x] Approved by Tom'), false);
});

test('LINE_ESCAPE_RE matches the allow-line marker', () => {
  assert.equal(LINE_ESCAPE_RE.test('// allow-legacy-approval-marker: fixture'),
    true);
  assert.equal(LINE_ESCAPE_RE.test('# allow-legacy-approval-marker: fixture'),
    true);
  assert.equal(LINE_ESCAPE_RE.test('foo'), false);
});

function runFindOffenders(root, overrides = {}) {
  return findOffenders([root], {
    repoRoot: root,
    skipDirs: new Set(['node_modules', 'target', '.git']),
    binaryExt: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
    ...overrides
  });
}

test('findOffenders: clean tree returns zero offenders', () => {
  const root = fixtureTree();
  try {
    writeFixture(root, 'src/clean.ts', 'export const a = 1;\n');
    const { offenders, scannedFiles } = runFindOffenders(root);
    assert.equal(offenders.length, 0);
    assert.equal(scannedFiles, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findOffenders: flags the checked literal in a source file', () => {
  const root = fixtureTree();
  try {
    writeFixture(root, 'src/regressed.ts',
      'export const a = 1;\n- [x] **Approved by Tom**\n');
    const { offenders } = runFindOffenders(root);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].file, /regressed\.ts$/);
    assert.equal(offenders[0].line, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findOffenders: allowlist suppresses offender from detector file', () => {
  const root = fixtureTree();
  try {
    writeFixture(root, 'services/tasks-api/src/lib/legacyApprovals.ts',
      'const A = "- [x] **Approved by Tom**";\n');
    const { offenders } = runFindOffenders(root);
    assert.equal(offenders.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findOffenders: per-line escape hatch suppresses fixture lines', () => {
  const root = fixtureTree();
  try {
    writeFixture(root, 'src/fixture.rs',
      'let _ = "- [x] **Approved by Tom**"; // allow-legacy-approval-marker: fixture\n');
    const { offenders } = runFindOffenders(root);
    assert.equal(offenders.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findOffenders: trailing-comment escape without keyword still flags', () => {
  const root = fixtureTree();
  try {
    writeFixture(root, 'src/loose.ts',
      '// legacy fixture: - [x] **Approved by Tom**\n');
    const { offenders } = runFindOffenders(root);
    assert.equal(offenders.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findOffenders: skipDirs excludes common build outputs', () => {
  const root = fixtureTree();
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFixture(root, 'node_modules/leaked.js',
      'var a = "- [x] **Approved by Tom**";\n');
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFixture(root, 'target/leaked.rs',
      'let _ = "- [x] **Approved by Tom**";\n');
    const offenders = findOffenders([root], {
      repoRoot: root,
      skipDirs: new Set(['node_modules', 'target', '.git']),
      binaryExt: new Set(),
      ALLOWLIST_FILES,
      PATTERN,
      LINE_ESCAPE_RE
    }).offenders;
    assert.equal(offenders.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
