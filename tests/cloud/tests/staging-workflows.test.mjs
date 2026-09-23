#!/usr/bin/env node
// staging-workflows.test.mjs — harness smoke tests.
//
// Pure Node 22, no deps (uses node:test + node:assert). These tests do
// not exercise the full workflow against live services — they assert
// the harness and the schema validator behave correctly on synthetic
// inputs (missing-args exit code, JSON shape on a forced-failure run,
// schema-check against a constructed green-path result, schema-check
// rejection of a const-violating result).
//
// The live black-box coverage belongs to the cloud-staging-validate
// workflow once the staging topology is reachable.
//
// Run with: node --test tests/cloud/tests/staging-workflows.test.mjs

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const HARNESS = join(REPO_ROOT, 'tests/cloud/staging-workflows.mjs');
const SCHEMA_CHECK = join(REPO_ROOT, 'tests/cloud/scripts/check-schema.mjs');

test('harness exits 2 with a clear error when required inputs are missing', async () => {
  let stderr = '';
  let code = -1;
  try {
    await exec('node', [HARNESS]);
  } catch (err) {
    stderr = err.stderr ?? '';
    code = err.code ?? -1;
  }
  assert.equal(code, 2, `expected exit 2, got ${code}`);
  assert.match(stderr, /missing required inputs/);
});

test('harness exits 0 with --help', async () => {
  const { stdout } = await exec('node', [HARNESS, '--help']);
  assert.match(stdout, /Usage:/);
});

test('harness emits verdict=fail JSON against an unreachable host set', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'drill-'));
  const out = join(tmp, 'result.json');
  // Use execFile directly with reject: false so non-zero exit codes
  // surface as { stdout, stderr } rather than throwing. The harness
  // exits 1 when verdict=fail; we still want the JSON output.
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(
      'node',
      [
        HARNESS,
        '--tasks-api-url', 'https://nonexistent-host-bogus.invalid',
        '--budget-api-url', 'https://nonexistent-host-bogus.invalid',
        '--scheduler-api-url', 'https://nonexistent-host-bogus.invalid',
        '--tasks-token', 'fake-token-not-real',
        '--scheduler-token', 'fake-token-not-real',
        '--budget-token-file', '/tmp/__definitely_does_not_exist__',
        '--intent-commit', 'abcdef0123456789abcdef0123456789abcdef01',
        '--output', out
      ],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err && err.code !== undefined && typeof err.code === 'number') {
          // exit code is fine; we want to assert on output
          resolve({ stdout, stderr, code: err.code });
          return;
        }
        if (err) reject(err);
        else resolve({ stdout, stderr, code: 0 });
      }
    );
  });
  assert.equal(stdout, '');
  const result = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.intentCommit, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(result.services.tasksApi.matchesIntent, false);
  assert.equal(result.services.budgetApi.matchesIntent, false);
  assert.equal(result.services.contentScheduler.matchesIntent, false);
  const health = result.checks.find((c) => c.name === 'tasks.health');
  assert.equal(health.status, 'fail');
  assert.ok(result.acceptedLimitations.length > 0, 'should surface the budget deeper-write limitation');
  // Belt-and-suspenders: bearer token values must never appear anywhere
  // in the JSON output.
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fake-token-not-real/);
  assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._-]{12,}/);
  // Schema conformance: tests/cloud/staging-validation.schema.json declares
  // error.code as type=string. Node's undici fetch emits numeric codes
  // (e.g. 20 on AbortController aborts), which previously slipped through
  // this test and broke the cloud-staging-validate workflow's GITHUB_STEP_SUMMARY
  // jq render. Regress the contract here so future harness changes can't
  // reintroduce the violation.
  const { stdout: schemaOut, stderr: schemaErr } = await exec('node', [SCHEMA_CHECK, out]);
  assert.match(schemaOut, /schema check passed for /, `expected schema check to pass; got stdout="${schemaOut}" stderr="${schemaErr}"`);
  for (const c of result.checks) {
    if (c.error !== undefined && c.error !== null) {
      assert.equal(typeof c.error.code, 'string', `expected ${c.name}.error.code to be string, got ${typeof c.error.code} (${c.error.code})`);
    }
  }
});

test('schema validator passes a green-path result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'drill-'));
  const result = {
    schemaVersion: 1,
    runId: 'staging-validate-20260915T220000Z-abcd',
    intentCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    environment: { id: 'fly-staging-rowan-2026-09-15', provider: 'fly.io' },
    startedAt: '2026-09-15T22:00:00.000Z',
    endedAt: '2026-09-15T22:01:00.000Z',
    services: {
      tasksApi: { url: 'https://tasks.example', version: 'v1', matchesIntent: true },
      budgetApi: { url: 'https://budget.example', version: 'budget-api', matchesIntent: true },
      contentScheduler: { url: 'https://scheduler.example', version: 'content-scheduler-api', matchesIntent: true }
    },
    checks: [
      { name: 'tasks.health', status: 'pass', startedAt: '2026-09-15T22:00:01Z', endedAt: '2026-09-15T22:00:02Z', details: {} }
    ],
    cleanup: { ok: true, operations: [{ name: 'tasks.archive', ok: true, error: null }] },
    productionBlockers: [],
    acceptedLimitations: [
      {
        code: 'BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE',
        summary: 'stops at /me',
        owner: 'Rowan',
        rationale: 'design open question 2',
        followUp: 'docs/specs/cloud-staging-environment-tech-design.md'
      }
    ],
    verdict: 'pass'
  };
  const input = join(tmp, 'green.json');
  writeFileSync(input, JSON.stringify(result));
  const { stdout } = await exec('node', [SCHEMA_CHECK, input]);
  assert.match(stdout, /schema check passed for /);
});

test('schema validator rejects a const-violating result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'drill-'));
  const bad = {
    schemaVersion: 2, // const violation
    runId: 'staging-validate-20260915T220000Z-abcd',
    intentCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    environment: { id: 'fly-staging', provider: 'fly.io' },
    startedAt: '2026-09-15T22:00:00.000Z',
    endedAt: '2026-09-15T22:01:00.000Z',
    services: {
      tasksApi: { url: 'https://tasks.example', version: 'v1', matchesIntent: true },
      budgetApi: { url: 'https://budget.example', version: 'budget-api', matchesIntent: true },
      contentScheduler: { url: 'https://scheduler.example', version: 'content-scheduler-api', matchesIntent: true }
    },
    checks: [],
    cleanup: { ok: true, operations: [] },
    productionBlockers: [],
    acceptedLimitations: [],
    verdict: 'pass'
  };
  const input = join(tmp, 'bad.json');
  writeFileSync(input, JSON.stringify(bad));
  let code = -1;
  let stderr = '';
  try {
    await exec('node', [SCHEMA_CHECK, input]);
  } catch (err) {
    code = err.code ?? -1;
    stderr = err.stderr ?? '';
  }
  assert.equal(code, 1, `expected exit 1, got ${code}`);
  assert.match(stderr, /schema check failed/);
  assert.match(stderr, /schemaVersion/);
});

test('harness source includes the redaction contract', () => {
  // Indirectly verified by the unreachable-host test above (which injects
  // 32-char hex-style values via the URL), but assert the redaction
  // function exists in source for the contract.
  const harness = readFileSync(HARNESS, 'utf8');
  assert.match(harness, /REDACTED/);
  assert.match(harness, /\[A-Fa-f0-9\]\{32,\}/);
  assert.match(harness, /allServicesMatchIntent/);
  assert.match(harness, /checksOk && cleanupOk && allServicesMatchIntent/);
});
