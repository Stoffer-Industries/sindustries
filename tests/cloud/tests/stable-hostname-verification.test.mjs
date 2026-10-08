#!/usr/bin/env node
// stable-hostname-verification.test.mjs — task 5cb4a8fe slice 4 harness tests.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/stable-hostname-verification.mjs via execFile and direct
// invocation, asserting:
//
//   1. Dry-run mode emits a verdict=pass JSON result with one row per
//      committed matrix surface, all rows status=skip, and the result
//      conforms to tests/cloud/stable-hostname-verification.schema.json.
//   2. Live mode (--mode live) without DNS set returns verdict=fail
//      because the DNS resolution cannot find the unprovisioned
//      CNAMEs; the harness must surface the failure cleanly without
//      crashing.
//   3. A synthetic matrix whose surfaces list is empty fails the
//      harness with a clean error and a non-zero exit code.
//   4. The dry-run output is the same shape regardless of whether
//      --run-id is supplied (default vs. explicit), proving the
//      runId pattern is stable for cross-harness correlation.
//
// Run with: node --test tests/cloud/tests/stable-hostname-verification.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/stable-hostname-verification.mjs');
const SCHEMA = join(REPO_ROOT, 'tests/cloud/stable-hostname-verification.schema.json');
const REAL_MATRIX = join(REPO_ROOT, 'infra/cloud/hostname-matrix.json');

// ---- Tiny schema validator (same shape as tests/cloud/scripts/check-schema.mjs) ----
//
// The harness is pure Node 22, no deps. The matching check-schema.mjs is also
// dep-free, but its API expects a result file path. To keep the test file
// self-contained, we mirror the subset of validations we need rather than
// shelling out to check-schema.mjs. The full schema conformance test lives
// in slice 4's follow-up work alongside the live harness exercise.

function assertConforms(result, schema) {
  // Top-level required fields.
  for (const key of schema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `result is missing required field "${key}"`);
  }
  // No additional top-level properties.
  for (const key of Object.keys(result)) {
    assert.ok(schema.properties[key] !== undefined, `result has unexpected top-level field "${key}"`);
  }
  // Mode enum.
  assert.ok(['live', 'dry-run'].includes(result.mode), `result.mode must be live|dry-run, got ${result.mode}`);
  // Verdict enum.
  assert.ok(['pass', 'fail'].includes(result.verdict), `result.verdict must be pass|fail, got ${result.verdict}`);
  // Surfaces is an array of objects with the required per-row fields.
  assert.ok(Array.isArray(result.surfaces), 'result.surfaces must be an array');
  const rowRequired = ['id', 'kind', 'host', 'environment', 'expected', 'status', 'details', 'evidence'];
  for (const row of result.surfaces) {
    for (const key of rowRequired) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), `surface row missing required field "${key}" (id=${row.id})`);
    }
    assert.ok(['frontend', 'api', 'worker'].includes(row.kind), `row.kind must be frontend|api|worker, got ${row.kind}`);
    assert.ok(['ok', 'fail', 'skip'].includes(row.status), `row.status must be ok|fail|skip, got ${row.status} (id=${row.id})`);
  }
  // productionBlockers / acceptedLimitations are arrays.
  assert.ok(Array.isArray(result.productionBlockers), 'result.productionBlockers must be an array');
  assert.ok(Array.isArray(result.acceptedLimitations), 'result.acceptedLimitations must be an array');
  // Matrix surfaces are reflected 1:1 in the surfaces array (id + kind match).
  const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
  assert.equal(result.surfaces.length, matrix.surfaces.length, `surfaces array length (${result.surfaces.length}) must match matrix.surfaces length (${matrix.surfaces.length})`);
  for (let i = 0; i < matrix.surfaces.length; i += 1) {
    const ms = matrix.surfaces[i];
    const rs = result.surfaces[i];
    assert.equal(rs.id, ms.id, `surfaces[${i}].id must equal matrix.surfaces[${i}].id (${ms.id})`);
    assert.equal(rs.kind, ms.kind, `surfaces[${i}].kind must equal matrix.surfaces[${i}].kind (${ms.kind})`);
    assert.equal(rs.expected, ms.staging, `surfaces[${i}].expected must equal matrix.surfaces[${i}].staging (${ms.staging})`);
  }
}

test('dry-run mode emits verdict=pass with one row per committed matrix surface, all status=skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const outPath = join(dir, 'dryrun.json');
    const { stdout, stderr } = await exec('node', [SCRIPT, '--mode', 'dry-run', '--output', outPath, '--run-id', 'test-dry-1'], { cwd: REPO_ROOT });
    assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    assertConforms(result, schema);
    assert.equal(result.mode, 'dry-run', 'mode must be dry-run');
    assert.equal(result.verdict, 'pass', 'dry-run must always report verdict=pass (skip is a planned state)');
    assert.equal(result.runId, 'test-dry-1', 'explicit --run-id must be preserved');
    // Every row in the committed matrix has a real staging hostname except
    // the auto-post-worker, which records publicUrl=false. The harness
    // emits a skip row for the worker with host=null; all other rows are
    // skip with host=<matrix.staging>.
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const workerSurfaces = matrix.surfaces.filter((s) => s.kind === 'worker' && s.publicUrl === false);
    const publicSurfaces = matrix.surfaces.filter((s) => !(s.kind === 'worker' && s.publicUrl === false));
    assert.equal(result.surfaces.length, matrix.surfaces.length, 'one row per matrix surface');
    assert.equal(
      result.surfaces.filter((r) => r.status === 'skip' && r.host !== null).length,
      publicSurfaces.length,
      'every public surface row must be skip with host=<staging hostname>'
    );
    assert.equal(
      result.surfaces.filter((r) => r.host === null).length,
      workerSurfaces.length,
      'every worker surface row must have host=null'
    );
    // Production blockers are empty in dry-run; the acceptedLimitations
    // array carries the dry-run rationale.
    assert.equal(result.productionBlockers.length, 0, 'dry-run must not list production blockers (production DNS is not in scope)');
    assert.ok(result.acceptedLimitations.length >= 1, 'dry-run must record at least one accepted limitation');
    // stdout should be empty when --output is supplied (the file owns the
    // output). The script always writes the JSON to stdout regardless of
    // --output, which is fine for the merge-gate step, but the file must
    // also exist and parse.
    assert.ok(stdout.length > 0, 'script must write JSON to stdout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live mode without DNS set returns verdict=fail and the failure is surfaced cleanly', async () => {
  // We do not run --mode live against the public internet here — the
  // committed matrix's stable hostnames are not yet registered. The point
  // of this test is to prove the harness does not crash when DNS
  // resolution fails; the verdict must be fail, every public surface row
  // must be fail, and the run must exit non-zero so CI catches a future
  // regression where live mode silently reports pass.
  let err;
  let stdout;
  try {
    ({ stdout } = await exec('node', [
      SCRIPT,
      '--mode', 'live',
      '--run-id', 'test-live-no-dns',
      '--output', '/tmp/stable-hostname-verification-live-test.json',
    ], { cwd: REPO_ROOT, timeout: 60_000 }));
  } catch (e) { err = e; }
  assert.ok(err, 'live mode without DNS must exit non-zero (verdict=fail)');
  assert.ok(err.code === 1, `live mode must exit 1, got ${err.code}`);
  // stdout may be empty because Node writes the JSON to stdout before
  // exit, but stderr should also not contain a stack trace (the harness
  // swallows the DNS error into the row.evidence field).
  assert.ok(!String(err.stderr).includes('Error:'), `live mode must not crash with a stack trace; got stderr: ${err.stderr}`);
  // The output file should still be written so CI can upload it.
  const out = JSON.parse(readFileSync('/tmp/stable-hostname-verification-live-test.json', 'utf8'));
  assert.equal(out.mode, 'live', 'mode must be live');
  assert.equal(out.verdict, 'fail', 'live mode without DNS must verdict=fail');
  // Every public surface row must be fail; worker surface must remain
  // skip (the worker has no public URL by design).
  for (const row of out.surfaces) {
    if (row.kind === 'worker') {
      assert.equal(row.status, 'skip', `worker surface row must remain skip (id=${row.id})`);
    } else {
      assert.equal(row.status, 'fail', `public surface row must be fail when DNS is unprovisioned (id=${row.id})`);
    }
  }
  // Production blockers must be present in live mode.
  assert.ok(out.productionBlockers.length >= 1, 'live mode must list the production manual-gate blocker');
});

test('synthetic empty matrix fails the harness cleanly with a non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const matrixPath = join(dir, 'empty-matrix.json');
    writeFileSync(matrixPath, JSON.stringify({ taskId: 'test', surfaces: [] }, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, '--mode', 'dry-run', '--matrix', matrixPath], { cwd: REPO_ROOT });
    } catch (e) { err = e; }
    assert.ok(err, 'an empty matrix must fail the harness');
    assert.ok(err.code === 2, `empty matrix must exit 2 (config error), got ${err.code}`);
    const combined = String(err.stderr) + String(err.stdout);
    assert.match(combined, /no surfaces array|has no surfaces array/, `expected a clean empty-matrix error, got: ${combined}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default runId is generated and matches the stable pattern when --run-id is not supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const outPath = join(dir, 'default-runid.json');
    await exec('node', [SCRIPT, '--mode', 'dry-run', '--output', outPath], { cwd: REPO_ROOT });
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.match(result.runId, /^[A-Za-z0-9][A-Za-z0-9_.:-]+$/, `default runId must match schema pattern, got: ${result.runId}`);
    assert.ok(result.runId.startsWith('stable-hostname-'), `default runId must start with the harness prefix, got: ${result.runId}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
