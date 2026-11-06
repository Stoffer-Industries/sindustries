#!/usr/bin/env node
// check-workflow-shell-syntax.test.mjs — task 83edc146 regression guard.
//
// Pure Node 22, no deps (node:test + node:assert). Exercises
// scripts/check-workflow-shell-syntax.mjs against synthetic workflows and
// proves each assertion can actually fail:
//
//   1. A workflow whose run blocks parse passes.
//   2. The exact production failure — a `stable-fallback` comment placed
//      inside a backslash-continued pipeline — fails, and the diagnostic
//      names the workflow, the job and the step.
//   3. A run block containing GitHub Actions expressions passes (the
//      expressions are masked before bash parses the script).
//   4. A step with a non-bash `shell:` is not checked.
//   5. The `run:` block scalar is extracted with its content intact.
//
// Run with: node --test tests/cloud/tests/check-workflow-shell-syntax.test.mjs

import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-workflow-shell-syntax.mjs');

const GOOD_WORKFLOW = [
  'name: Good',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  deploy:',
  '    name: Deploy',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Smoke check',
  '        run: |',
  '          set -euo pipefail',
  '          curl --fail --silent --show-error --max-time 15 \\',
  '            "https://example.fly.dev/health" \\',
  '            | grep -F \'"status":"ok"\'',
  '',
  '      - name: Inline step',
  '        run: npm ci',
  '',
].join('\n');

// The production failure, reproduced exactly: the annotation comment sits
// between the two halves of the continued pipeline.
const BROKEN_WORKFLOW = [
  'name: Broken',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  deploy:',
  '    name: Deploy',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Smoke check (OAuth discovery)',
  '        run: |',
  '          set -euo pipefail',
  '          curl --fail --silent --show-error --max-time 15 \\',
  '            "https://gymtrack-mcp.fly.dev/.well-known/oauth-authorization-server" \\',
  '            # stable-fallback: the *.fly.dev URL remains the live production target.',
  '            | grep -F \'"registration_endpoint":"https://gymtrack-mcp.fly.dev/oauth/register"\'',
  '',
].join('\n');

const EXPRESSION_WORKFLOW = [
  'name: Expressions',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  deploy:',
    '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Use a matrix value',
  '        run: |',
  '          set -euo pipefail',
  '          echo "target is ${{ matrix.target }}"',
  '          if [ "${{ matrix.target }}" = "staging" ]; then',
  '            echo staging',
  '          fi',
  '',
].join('\n');

const NON_BASH_WORKFLOW = [
  'name: Non bash',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Python step',
  '        shell: python {0}',
  '        run: |',
  '          def broken(:',
  '          print("not bash")',
  '',
  '      - name: PowerShell step',
  "        shell: pwsh -command \". '{0}'\"",
  '        run: |',
  '          function broken {',
  '          print("not bash")',
  '',
].join('\n');

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-workflow-shell-syntax-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, '.github/workflows', name), content);
  }
  return dir;
}

async function runChecker(repoRoot, scriptPath = SCRIPT) {
  try {
    const { stdout, stderr } = await exec('node', [scriptPath, repoRoot]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('a workflow whose run blocks parse passes', async () => {
  const repo = makeRepo({ 'good.yml': GOOD_WORKFLOW });
  try {
    const result = await runChecker(repo);
    assert.equal(result.code, 0, result.stderr);
    // One block scalar plus one inline run.
    assert.match(result.stdout, /2 workflow run block\(s\) parse as bash/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a comment inside a backslash-continued pipeline fails and is reported', async () => {
  const repo = makeRepo({ 'broken.yml': BROKEN_WORKFLOW });
  try {
    const result = await runChecker(repo);
    assert.equal(result.code, 1, 'the broken workflow must fail the check');
    assert.match(result.stderr, /broken\.yml/);
    assert.match(result.stderr, /job "deploy"/);
    assert.match(result.stderr, /Smoke check \(OAuth discovery\)/);
    assert.match(result.stderr, /syntax error/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GitHub Actions expressions do not fail the check', async () => {
  const repo = makeRepo({ 'expressions.yml': EXPRESSION_WORKFLOW });
  try {
    const result = await runChecker(repo);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a non-bash shell is not checked', async () => {
  const repo = makeRepo({ 'python.yml': NON_BASH_WORKFLOW });
  try {
    const result = await runChecker(repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /0 workflow run block\(s\) parse as bash/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an absolute script path containing spaces still runs the checker', async () => {
  const repo = makeRepo({ 'good.yml': GOOD_WORKFLOW });
  const scriptDir = mkdtempSync(join(tmpdir(), 'workflow shell syntax '));
  const scriptPath = join(scriptDir, 'check workflow shell syntax.mjs');
  copyFileSync(SCRIPT, scriptPath);
  try {
    const result = await runChecker(repo, scriptPath);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /2 workflow run block\(s\) parse as bash/);
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a symlinked script path still runs the checker', async () => {
  const repo = makeRepo({ 'good.yml': GOOD_WORKFLOW });
  const scriptDir = mkdtempSync(join(tmpdir(), 'workflow-shell-syntax-link-'));
  const scriptPath = join(scriptDir, 'check-workflow-shell-syntax.mjs');
  symlinkSync(SCRIPT, scriptPath);
  try {
    const result = await runChecker(repo, scriptPath);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /2 workflow run block\(s\) parse as bash/);
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the block scalar is extracted with its content intact', async () => {
  const { extractRunScripts } = await import(
    join(REPO_ROOT, 'tests/cloud/scripts/check-workflow-shell-syntax.mjs')
  );
  const entries = extractRunScripts(GOOD_WORKFLOW);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].job, 'deploy');
  assert.equal(entries[0].step, 'Smoke check');
  assert.match(entries[0].script, /set -euo pipefail/);
  assert.match(entries[0].script, /grep -F/);
  assert.equal(entries[1].script, 'npm ci');
});
