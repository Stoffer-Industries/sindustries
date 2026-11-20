#!/usr/bin/env node
// check-agent-caller-routes.test.mjs — task 020f423e
// sentinel tests for the production cutover's AC2 caller-inventory gate.
//
// The checker (tests/cloud/scripts/check-agent-caller-routes.mjs) decides
// whether a live agent automation surface pins a prodlike origin instead of
// resolving its route from the runtime environment.
//
// A gate that cannot go red asserts nothing, so every case below is a
// SENTINEL: a passing artifact with exactly ONE fact changed, and the
// assertion that the checker notices.
//
//   1. A caller that resolves the route from the runtime env passes.
//   2. A hard assignment of the route variable to prodlike fails.
//   3. A curl that targets prodlike fails.
//   4. An HTTP client call that targets prodlike fails.
//   5. A method paired with a prodlike URL fails.
//   6. The shell default form of the origin is allowed.
//   7. The Python env-fallback forms of the origin are allowed.
//   8. Prose that merely mentions an origin is allowed.
//   9. The DEFAULT_ constant form is allowed.
//  10. The real repository tree is clean.
//  11. The CLI exits 0 on a clean tree and 1 on a pinned one.
//
// Run with: node --test tests/cloud/tests/check-agent-caller-routes.test.mjs

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import {
  checkRepo,
  detectPins,
  listScannedFiles,
} from '../scripts/check-agent-caller-routes.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHECKER = join(REPO_ROOT, 'tests/cloud/scripts/check-agent-caller-routes.mjs');

/** Write one markdown file into a synthetic tree and return the tree root. */
function treeWith(relPath, contents) {
  const root = join(tmpdir(), `agent-route-check-${Math.random().toString(36).slice(2)}`);
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return root;
}

test('a caller that resolves the route from the runtime env is not pinned', () => {
  const findings = detectPins(
    [
      'set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a',
      'export TASKS_API_BASE_URL="${TASKS_API_BASE_URL:-http://localhost:4001/api/v1}"',
      'curl -s "${TASKS_API_BASE_URL}/tasks?status=open" | jq .',
    ].join('\n'),
  );
  assert.deepEqual(findings, []);
});

test('a hard assignment of the route variable to prodlike is pinned', () => {
  const findings = detectPins(
    ['export TASKS_API_BASE_URL=http://localhost:4001/api/v1', 'python3 client.py list'].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'hard-assignment');
});

test('a curl that targets prodlike is pinned', () => {
  const findings = detectPins(
    'curl -s "http://localhost:4001/api/v1/tasks?status=open&limit=1000" | jq .',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'curl-target');
});

test('an HTTP client call that targets prodlike is pinned', () => {
  const findings = detectPins(
    "with urllib.request.urlopen(f'http://localhost:4001/api/v1/tasks?status={status}') as r:",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'http-client-target');
});

test('a method paired with a prodlike URL is pinned', () => {
  const findings = detectPins('POST http://localhost:4001/api/v1/tasks');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'method-and-url');
});

test('the shell default form of the origin is allowed', () => {
  const findings = detectPins(
    'TASKS_API_BASE_URL="${TASKS_API_BASE_URL:-http://localhost:4004/api/v1}" python3 client.py',
  );
  assert.deepEqual(findings, []);
});

test('the Python env-fallback forms of the origin are allowed', () => {
  const findings = detectPins(
    [
      'base = (os.getenv("TASKS_API_BASE_URL", "http://localhost:4001/api/v1") or "").strip()',
      'base = (os.environ.get("TASKS_API_BASE_URL") or "http://localhost:4001/api/v1").strip()',
    ].join('\n'),
  );
  assert.deepEqual(findings, []);
});

test('prose that merely mentions an origin is allowed', () => {
  const findings = detectPins(
    '`CONTENT_SCHEDULER_BASE_URL` is the live route owned by `~/.openclaw/.env`. Prodlike uses `http://localhost:4004` and production uses the stable Content Scheduler origin.',
  );
  assert.deepEqual(findings, []);
});

test('the DEFAULT_ constant form is allowed', () => {
  const findings = detectPins(
    [
      'DEFAULT_BASE_URL = "http://localhost:4001/api/v1"',
      'DEFAULT_TASKS_API_BASE_URL = "http://localhost:4001/api/v1"',
    ].join('\n'),
  );
  assert.deepEqual(findings, []);
});

test('the real repository tree is clean', () => {
  const violations = checkRepo(REPO_ROOT);
  assert.deepEqual(
    violations,
    [],
    `agent automation surfaces pin a prodlike origin:\n${violations
      .map((v) => `  ${v.file}:${v.line} ${v.pattern}: ${v.lineText}`)
      .join('\n')}`,
  );
});

test('the checker scans the live agent automation trees', () => {
  const files = listScannedFiles(REPO_ROOT);
  assert.ok(files.length > 0, 'expected at least one scanned markdown surface');
  assert.ok(files.includes('agents/skills/ops/tasks-api/SKILL.md'));
  assert.ok(files.includes('agents/crons/prompts/backlog-maintenance.md'));
  assert.ok(
    files.every((file) => file.endsWith('.md')),
    'only markdown surfaces are in scope',
  );
});

test('the CLI exits 0 on a clean tree and 1 on a pinned one', async () => {
  const clean = treeWith(
    'agents/skills/example/SKILL.md',
    '```bash\ncurl -s "${TASKS_API_BASE_URL}/tasks" | jq .\n```\n',
  );
  const cleanRun = await execFileAsync('node', [CHECKER, clean]);
  assert.match(cleanRun.stdout, /\[check-agent-caller-routes\] OK/);

  const pinned = treeWith(
    'agents/crons/prompts/example.md',
    '```bash\ncurl -s "http://localhost:4001/api/v1/tasks" | jq .\n```\n',
  );
  await assert.rejects(
    () => execFileAsync('node', [CHECKER, pinned]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /PINNED agents\/crons\/prompts\/example\.md:2/);
      return true;
    },
  );
});
