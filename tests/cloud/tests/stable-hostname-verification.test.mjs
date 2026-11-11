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
//   2. Dry-run rows assert the matrix's per-environment CNAME target
//      rather than the production provider fallback.
//   3. Live mode against a synthetic matrix with unresolvable hostnames
//      returns verdict=fail; the harness must surface the failure
//      cleanly without crashing, and must record the DNS, HTTPS and
//      CORS stages independently (no short-circuit).
//   4. A synthetic matrix whose surfaces list is empty fails the
//      harness with a clean error and a non-zero exit code.
//   5. The default runId is generated and matches the stable pattern.
//   6. The pure helpers are unit-tested directly: the AC2
//      production-target set is the union of cnameTargets.production and
//      providerFallback, host comparison normalises case and the
//      trailing root dot and matches on a label boundary, and the
//      Content Scheduler surface is probed at the auto-post health
//      endpoint AC5 names.
//
// Run with: node --test tests/cloud/tests/stable-hostname-verification.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  expectedCnameTarget,
  normalizeHost,
  isSameOrSubdomain,
  productionCnameTargets,
  healthPathsForSurface,
  classifyHttpsFailure,
  classifyCorsPreflight,
  looksLikeProxyError,
  proxyEnvFacts,
  readBodyExcerpt,
  redactMessage,
} from '../scripts/stable-hostname-verification.mjs';

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

test('dry-run rows assert the matrix staging CNAME target, not the production provider fallback', async () => {
  // The harness used to compare a staging hostname's CNAME against
  // `providerFallback`, which is the PRODUCTION provider host. That
  // demanded an alias onto production — the thing AC2 forbids — and
  // made every live staging row fail on an expectation mismatch rather
  // than on a real deployment fault. The expectation now comes from the
  // matrix's per-environment `cnameTargets`, and dry-run records it so
  // the contract is reviewable without a live run.
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const outPath = join(dir, 'cname-target.json');
    await exec('node', [SCRIPT, '--mode', 'dry-run', '--output', outPath], { cwd: REPO_ROOT });
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    let checked = 0;
    for (const row of result.surfaces) {
      if (row.kind === 'worker') continue;
      const surface = matrix.surfaces.find((s) => s.id === row.id);
      assert.ok(surface, `row ${row.id} must map to a matrix surface`);
      assert.ok(surface.cnameTargets, `matrix surface ${row.id} must record cnameTargets`);
      assert.equal(
        row.details.expectedCnameTarget,
        surface.cnameTargets.staging,
        `row ${row.id} must expect the matrix staging CNAME target (${surface.cnameTargets.staging})`,
      );
      assert.notEqual(
        row.details.expectedCnameTarget,
        surface.providerFallback,
        `row ${row.id} must not expect the production provider fallback (${surface.providerFallback})`,
      );
      checked += 1;
    }
    assert.equal(checked, 6, 'all six public surfaces must carry a staging CNAME expectation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live mode with unresolvable hostnames returns verdict=fail and the failure is surfaced cleanly', async () => {
  // A synthetic matrix whose hostnames cannot resolve. The point of
  // this test is to prove the harness does not crash when DNS
  // resolution fails; the verdict must be fail, every public surface
  // row must be fail, and the run must exit non-zero so CI catches a
  // future regression where live mode silently reports pass.
  //
  // The synthetic matrix (rather than the committed one) keeps the
  // assertion stable now that the real staging DNS exists: the
  // committed matrix's rows may legitimately become "ok" as staging
  // converges, and this test must keep proving the failure path.
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const matrixPath = join(dir, 'unresolvable-matrix.json');
    writeFileSync(matrixPath, JSON.stringify({
      taskId: 'test-live-no-dns',
      surfaces: [
        {
          id: 'tasks-api',
          kind: 'api',
          staging: 'tasks-api.unresolvable.sindustries.co.nz',
          production: 'tasks-api.sindustries.co.nz',
          providerFallback: 'sindustries-tasks-api.fly.dev',
          cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-tasks-api.fly.dev' },
        },
        {
          id: 'auto-post-worker',
          kind: 'worker',
          staging: null,
          production: null,
          providerFallback: null,
          cnameTargets: null,
          publicUrl: false,
          rationale: 'no public URL',
        },
      ],
    }, null, 2));
    const outPath = join(dir, 'live.json');
    let err;
    try {
      await exec('node', [
        SCRIPT,
        '--mode', 'live',
        '--matrix', matrixPath,
        '--run-id', 'test-live-no-dns',
        '--output', outPath,
      ], { cwd: REPO_ROOT, timeout: 180_000 });
    } catch (e) { err = e; }
    assert.ok(err, 'live mode with unresolvable hostnames must exit non-zero (verdict=fail)');
    assert.ok(err.code === 1, `live mode must exit 1, got ${err.code}`);
    // stdout may be empty because Node writes the JSON to stdout before
    // exit, but stderr should also not contain a stack trace (the harness
    // swallows the DNS error into the row.evidence field).
    assert.ok(!String(err.stderr).includes('Error:'), `live mode must not crash with a stack trace; got stderr: ${err.stderr}`);
    // The output file should still be written so CI can upload it.
    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(out.mode, 'live', 'mode must be live');
    assert.equal(out.verdict, 'fail', 'live mode with unresolvable hostnames must verdict=fail');
    // Every public surface row must be fail; worker surface must remain
    // skip (the worker has no public URL by design).
    for (const row of out.surfaces) {
      if (row.kind === 'worker') {
        assert.equal(row.status, 'skip', `worker surface row must remain skip (id=${row.id})`);
        continue;
      }
      assert.equal(row.status, 'fail', `public surface row must be fail when DNS cannot resolve (id=${row.id})`);
      assert.match(row.evidence, /CNAME resolution failed/, `the DNS failure must be named in the row evidence (id=${row.id}): ${row.evidence}`);
      // The DNS stage is no longer the only stage that can fail: the
      // harness now records the HTTPS and CORS evidence even when DNS
      // failed, so a broken DNS record no longer hides the deployment
      // state behind it.
      assert.ok('dns' in row.details, `row ${row.id} must record the dns stage detail`);
      assert.ok('https' in row.details, `row ${row.id} must record the https stage detail`);
      assert.ok('cors' in row.details, `row ${row.id} must record the cors stage detail`);
    }
    // Production blockers must be present in live mode.
    assert.ok(out.productionBlockers.length >= 1, 'live mode must list the production manual-gate blocker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the AC2 production-target set is the union of cnameTargets.production and providerFallback', () => {
  // C1/I3. The two fields are deliberately allowed to diverge — task
  // 020f423e renames the production apps, so the CNAME target moves
  // while the documented provider fallback stays. If the leak guard
  // only knew about `cnameTargets.production`, a staging hostname aimed
  // at a surface's own provider fallback would pass the guard the moment
  // the two diverged.
  const matrix = {
    surfaces: [
      {
        id: 'health-probe',
        kind: 'api',
        providerFallback: 'sindustries-health-probe.fly.dev',
        cnameTargets: { staging: 'sindustries-health-probe-staging.fly.dev', production: 'sindustries-health-probe-prod.fly.dev' },
      },
    ],
  };
  const targets = productionCnameTargets(matrix);
  assert.ok(
    targets.has('sindustries-health-probe-prod.fly.dev'),
    'the cnameTargets.production host must be in the production-target set',
  );
  assert.ok(
    targets.has('sindustries-health-probe.fly.dev'),
    'the providerFallback host must be in the production-target set even when cnameTargets.production has diverged from it',
  );
  // Vercel's shared managed target carries no environment identity and
  // must never be treated as a production target.
  const withVercel = productionCnameTargets({
    surfaces: [{ id: 'mission-control', kind: 'frontend', providerFallback: 'sindustries-mission-control.vercel.app', cnameTargets: { staging: 'cname.vercel-dns.com', production: 'cname.vercel-dns.com' } }],
  });
  assert.ok(withVercel.has('sindustries-mission-control.vercel.app'), 'the Vercel production provider host must be in the production-target set');
  assert.ok(!withVercel.has('cname.vercel-dns.com'), 'Vercel shared managed target must not be treated as a production target');
});

test('host comparison normalises case and the trailing root dot, and matches on a label boundary', () => {
  // I4. DNS is case-insensitive and a FQDN may carry a trailing root
  // dot, so both are normalised. Leak comparisons must also hold for a
  // subdomain of a production target — "foo.sindustries-tasks-api.fly.dev"
  // is the same production host for AC2 purposes.
  assert.equal(normalizeHost('SIndustries-Tasks-Api.Fly.Dev.'), 'sindustries-tasks-api.fly.dev');
  assert.ok(isSameOrSubdomain('SIndustries-Tasks-Api.Fly.Dev', 'sindustries-tasks-api.fly.dev'));
  assert.ok(isSameOrSubdomain('foo.sindustries-tasks-api.fly.dev', 'sindustries-tasks-api.fly.dev'));
  assert.ok(!isSameOrSubdomain('sindustries-budget-api.fly.dev', 'sindustries-tasks-api.fly.dev'));
  // A staging-shaped sibling is not a subdomain of the production host.
  assert.ok(!isSameOrSubdomain('sindustries-health-probe-staging.fly.dev', 'sindustries-health-probe.fly.dev'));
});

test('the expected CNAME target comes from cnameTargets, not providerFallback, for staging', () => {
  const surface = {
    id: 'tasks-api',
    kind: 'api',
    providerFallback: 'sindustries-tasks-api.fly.dev',
    cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-tasks-api.fly.dev' },
  };
  assert.equal(expectedCnameTarget(surface, 'staging'), 'sindustries-platform-staging.fly.dev');
  assert.equal(expectedCnameTarget(surface, 'production'), 'sindustries-tasks-api.fly.dev');
  // With no explicit production target the provider fallback is the
  // production expectation — the only place that fallback is correct.
  assert.equal(
    expectedCnameTarget({ id: 'x', kind: 'api', providerFallback: 'x.fly.dev', cnameTargets: null }, 'production'),
    'x.fly.dev',
  );
});

test('the Content Scheduler surface is probed at the auto-post health endpoint AC5 names', () => {
  // AC5 names "the Content Scheduler auto-post health endpoint"
  // explicitly. The auto-post worker has no HTTP surface of its own, so
  // the endpoint is served by the content-scheduler-api surface.
  const paths = healthPathsForSurface({ id: 'content-scheduler-api', kind: 'api' });
  assert.ok(
    paths.includes('/api/v1/content-scheduler/auto-post/health'),
    `content-scheduler-api must be probed at the auto-post health endpoint, got: ${paths.join(', ')}`,
  );
  assert.ok(paths.includes('/health'), 'content-scheduler-api must still be probed at /health');
  assert.deepEqual(healthPathsForSurface({ id: 'health-probe', kind: 'api' }), ['/healthz']);
  assert.deepEqual(healthPathsForSurface({ id: 'tasks-api', kind: 'api' }), ['/health']);
  assert.deepEqual(healthPathsForSurface({ id: 'tasks-app', kind: 'frontend' }), ['/']);
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

// ---- Transport vs upstream classification (task 5cb4a8fe, AC5) ----
//
// A failed probe has two causes the harness used to report identically:
// the deployment answered with a non-2xx status, or the request never
// reached the deployment because a proxy in the request path answered
// first. On 2026-11-11 the second case was observed live: every request
// from the operator's Mac to a *.sindustries.co.nz Vercel-backed host
// came back 502 with the body "Secret egress proxy could not reach the
// upstream host." — which, read as an upstream status, is a false AC5
// failure that sends the operator chasing a deployment fault that does
// not exist.

test('a proxy-generated body classifies as proxy_blocked, not an upstream status', () => {
  const { failureMode } = classifyHttpsFailure({
    status: 502,
    body: 'Secret egress proxy could not reach the upstream host.',
    error: null,
    proxy: proxyEnvFacts('tasks.staging.sindustries.co.nz', {}),
  });
  assert.equal(failureMode, 'proxy_blocked', 'a proxy error body must not be reported as an upstream status');
});

test('a gateway status counts as a proxy block only when a proxy is actually in the path', () => {
  const withProxy = { envVars: ['HTTPS_PROXY'], noProxyApplies: false };
  const exempt = { envVars: ['HTTPS_PROXY'], noProxyApplies: true };
  const none = { envVars: [], noProxyApplies: false };

  assert.equal(
    classifyHttpsFailure({ status: 502, body: null, error: null, proxy: withProxy }).failureMode,
    'proxy_blocked',
    'a gateway status behind a configured proxy is a proxy block',
  );
  assert.equal(
    classifyHttpsFailure({ status: 502, body: null, error: null, proxy: exempt }).failureMode,
    'upstream_status',
    'NO_PROXY exempts the host, so a 502 came from the deployment',
  );
  assert.equal(
    classifyHttpsFailure({ status: 502, body: null, error: null, proxy: none }).failureMode,
    'upstream_status',
    'with no proxy in the path a 502 is an upstream status',
  );
  assert.equal(
    classifyHttpsFailure({ status: 500, body: null, error: null, proxy: withProxy }).failureMode,
    'upstream_status',
    'a non-gateway status is an upstream status even behind a proxy',
  );
});

test('CORS preflight rejects non-2xx responses and classifies the failed response', () => {
  const expectedOrigin = 'https://tasks.staging.sindustries.co.nz';
  const configuredProxy = { envVars: ['HTTPS_PROXY'], noProxyApplies: false };
  const exemptProxy = { envVars: ['HTTPS_PROXY'], noProxyApplies: true };

  const proxyResponse = classifyCorsPreflight({
    status: 502,
    body: 'Secret egress proxy could not reach the upstream host.',
    allowOrigin: expectedOrigin,
    expectedOrigin,
    proxy: configuredProxy,
  });
  assert.equal(proxyResponse.ok, false, 'a proxy 502 must fail even when the expected ACAO header is present');
  assert.equal(proxyResponse.failureMode, 'proxy_blocked', 'a proxy marker must classify a CORS response as proxy_blocked');

  const gatewayResponse = classifyCorsPreflight({
    status: 502,
    body: null,
    allowOrigin: expectedOrigin,
    expectedOrigin,
    proxy: configuredProxy,
  });
  assert.equal(gatewayResponse.ok, false, 'a gateway response must fail the CORS preflight');
  assert.equal(gatewayResponse.failureMode, 'proxy_blocked', 'a gateway status behind a configured proxy is proxy_blocked');

  const exemptResponse = classifyCorsPreflight({
    status: 502,
    body: null,
    allowOrigin: expectedOrigin,
    expectedOrigin,
    proxy: exemptProxy,
  });
  assert.equal(exemptResponse.failureMode, 'upstream_status', 'NO_PROXY exempts the host, so the gateway response is upstream_status');

  const upstreamResponse = classifyCorsPreflight({
    status: 500,
    body: 'application failure',
    allowOrigin: expectedOrigin,
    expectedOrigin,
    proxy: { envVars: [], noProxyApplies: false },
  });
  assert.equal(upstreamResponse.ok, false, 'an upstream non-2xx response must fail the CORS preflight');
  assert.equal(upstreamResponse.failureMode, 'upstream_status', 'an upstream non-2xx response is upstream_status');

  const successfulResponse = classifyCorsPreflight({
    status: 204,
    body: null,
    allowOrigin: expectedOrigin,
    expectedOrigin,
    proxy: configuredProxy,
  });
  assert.equal(successfulResponse.ok, true, 'a 2xx response with the expected ACAO header must pass');
  assert.equal(successfulResponse.failureMode, 'none', 'a successful CORS response has no failure mode');
});

test('response excerpt redaction removes URI userinfo and Basic/Proxy-Authorization credentials', () => {
  // Real-looking credential values, not pre-redacted `***` placeholders: a
  // placeholder would let a redactor that only strips asterisks pass this
  // test, and it would let an assertion pass vacuously because the secret it
  // looks for was never in the body.
  const uriUser = 'proxy-user';
  const uriSecret = 's3cr3t-passw0rd';
  // The Basic credentials are derived rather than committed as literals: a
  // base64 blob in source is indistinguishable from a real credential to
  // the repository's secret scan (generic-api-key), and the scan is right to
  // flag it. The derived bytes are identical to the literals they replace,
  // so the body still carries a real `Basic <base64>` credential and these
  // assertions still fail against a redactor that does not strip it.
  const proxyAuthValue = Buffer.from(`${uriUser}:proxy-password`).toString('base64');
  const authValue = Buffer.from('user:password').toString('base64');
  const uri = ['http://', uriUser, ':', uriSecret, '@proxy.internal:8443/path'].join('');
  const body = [
    ['proxy request failed for ', uri].join(''),
    ['Proxy-Authorization: ', 'Basic ', proxyAuthValue].join(''),
    ['Authorization: ', 'Basic ', authValue].join(''),
  ].join('\n');
  const redacted = redactMessage(body);

  assert.ok(!redacted.includes(uriUser), `URI userinfo username leaked: ${redacted}`);
  assert.ok(!redacted.includes(uriSecret), `URI userinfo password leaked: ${redacted}`);
  assert.ok(!redacted.includes(proxyAuthValue), `Proxy-Authorization value leaked: ${redacted}`);
  assert.ok(!redacted.includes(authValue), `Authorization value leaked: ${redacted}`);
  assert.match(redacted, /http:\/\/\[REDACTED\]@proxy\.internal:8443\/path/, `URI userinfo was not replaced: ${redacted}`);
  assert.match(redacted, /Proxy-Authorization:\s*\[REDACTED\]/i, `Proxy-Authorization was not replaced: ${redacted}`);
  assert.match(redacted, /Authorization:\s*Basic\s*\[REDACTED\]/i, `Authorization was not replaced: ${redacted}`);
});

test('a persisted response-body excerpt is bounded and credential-redacted', async () => {
  const uriUser = 'proxy-user';
  const uriSecret = 's3cr3t-passw0rd';
  // Derived, not literal — see the note in the redaction test above.
  const proxyAuthValue = Buffer.from(`${uriUser}:proxy-password`).toString('base64');
  const uri = ['http://', uriUser, ':', uriSecret, '@proxy.internal:8443/path'].join('');
  const credentialBody = [
    ['proxy request failed for ', uri].join(''),
    ['Proxy-Authorization: ', 'Basic ', proxyAuthValue].join(''),
    'x'.repeat(400),
  ].join('\n');
  const excerpt = await readBodyExcerpt({ text: async () => credentialBody }, 200);

  assert.ok(excerpt.length <= 200, `the response excerpt must be bounded, got ${excerpt.length} characters`);
  assert.ok(!excerpt.includes(uriUser), `URI userinfo username leaked: ${excerpt}`);
  assert.ok(!excerpt.includes(uriSecret), `URI userinfo password leaked: ${excerpt}`);
  assert.ok(!excerpt.includes(proxyAuthValue), `Basic credential leaked: ${excerpt}`);
  assert.match(excerpt, /http:\/\/\[REDACTED\]@proxy\.internal/, `URI userinfo was not replaced: ${excerpt}`);
});

test('a request that never got a response classifies as transport_error or timeout', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(
    classifyHttpsFailure({ status: null, body: null, error: abort, proxy: null }).failureMode,
    'timeout',
    'an aborted request is a timeout, not a transport error',
  );
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' });
  assert.equal(
    classifyHttpsFailure({ status: null, body: null, error: dns, proxy: null }).failureMode,
    'transport_error',
    'a request that failed before any response is a transport error',
  );
});

test('the proxy body marker is narrow enough not to misread an application body', () => {
  assert.ok(looksLikeProxyError('Secret egress proxy could not reach the upstream host.'));
  assert.ok(!looksLikeProxyError('{"error":"NotFound","message":"No route for GET /"}'));
  assert.ok(!looksLikeProxyError(''));
  assert.ok(!looksLikeProxyError(null));
});

test('proxyEnvFacts records variable names only, never the proxy URL', () => {
  const facts = proxyEnvFacts('tasks.staging.sindustries.co.nz', {
    HTTPS_PROXY: 'http://user:secret@127.0.0.1:51667',
    HTTP_PROXY: 'http://user:secret@127.0.0.1:51667',
  });
  assert.deepEqual(facts.envVars.sort(), ['HTTPS_PROXY', 'HTTP_PROXY']);
  assert.ok(
    !JSON.stringify(facts).includes('secret'),
    `the proxy URL must never reach the result JSON, got: ${JSON.stringify(facts)}`,
  );
  assert.equal(facts.noProxyApplies, false, 'no NO_PROXY means the proxy applies');
});

test('NO_PROXY exemptions are honoured for exact hosts, subdomains and the wildcard', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:51667', NO_PROXY: '.sindustries.co.nz,localhost' };
  assert.equal(proxyEnvFacts('tasks.staging.sindustries.co.nz', env).noProxyApplies, true);
  assert.equal(proxyEnvFacts('sindustries.co.nz', env).noProxyApplies, true);
  assert.equal(proxyEnvFacts('localhost', env).noProxyApplies, true);
  assert.equal(proxyEnvFacts('example.com', env).noProxyApplies, false);
  assert.equal(
    proxyEnvFacts('anything.example.com', { HTTPS_PROXY: 'http://127.0.0.1:51667', NO_PROXY: '*' }).noProxyApplies,
    true,
    'a wildcard NO_PROXY exempts every host',
  );
});

test('live mode records a failureMode on every HTTPS check, so a failure is never unattributed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stable-hostname-verification-'));
  try {
    const matrixPath = join(dir, 'live-matrix.json');
    writeFileSync(matrixPath, JSON.stringify({
      taskId: 'test',
      surfaces: [
        {
          id: 'tasks-api',
          kind: 'api',
          staging: 'nonexistent-host-for-tests.invalid',
          production: null,
          providerFallback: 'sindustries-tasks-api.fly.dev',
          cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-tasks-api.fly.dev' },
        },
      ],
    }, null, 2));
    const outPath = join(dir, 'live.json');
    let err;
    try {
      await exec('node', [SCRIPT, '--mode', 'live', '--matrix', matrixPath, '--run-id', 'test-live-failuremode', '--output', outPath], { cwd: REPO_ROOT, timeout: 180_000 });
    } catch (e) { err = e; }
    assert.ok(err, 'live mode against an unresolvable host must exit non-zero');
    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    const row = out.surfaces[0];
    const checks = row.details?.https?.checks ?? [];
    assert.ok(checks.length > 0, 'the https stage must record its per-path checks');
    for (const check of checks) {
      assert.ok(
        ['none', 'upstream_status', 'proxy_blocked', 'transport_error', 'timeout'].includes(check.failureMode),
        `every https check must carry a known failureMode, got: ${JSON.stringify(check)}`,
      );
      assert.ok(check.failureMode !== 'none', `a failed check must not be classified as "none": ${JSON.stringify(check)}`);
      assert.ok('proxyInPath' in check, 'every https check must record whether a proxy was in the request path');
      assert.ok(
        !JSON.stringify(check.proxyInPath).includes('secret'),
        'the recorded proxy facts must never carry a credential',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
