#!/usr/bin/env node
// check-staging-target-preflight.test.mjs — task 219fb673, PR #936.
//
// The staging-validation preflight must reject a target that is NOT the
// surface it claims to be.
//
// The bug this guards: the preflight used to build ONE allow-list from
// every staging hostname in the matrix and apply it to all three target
// variables. `STAGING_TASKS_API_URL=https://budget-api.staging.sindustries.co.nz`
// therefore PASSED. Every service exposes /health, so the harness probed
// the WRONG service, got 200, and reported `tasks.health: pass` — a
// wrong-service validation reported as a success.
//
// These are unit tests over the pure matcher, so they run offline: no
// network, no Fly, no GitHub environment.
//
// Run with: node --test tests/cloud/tests/check-staging-target-preflight.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  checkTarget,
  loadMatrix,
  parseTargetUrl,
  pathMatchesPrefix,
  routesForSurface,
} from '../scripts/check-staging-target-preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MATRIX = loadMatrix(join(REPO_ROOT, 'infra/cloud/hostname-matrix.json'));

// ---------------------------------------------------------------------
// The rejections — each one was a FALSE GREEN before the fix.
// ---------------------------------------------------------------------

test('a tasks-api target pointing at the budget-api hostname is rejected', () => {
  const result = checkTarget(MATRIX, 'tasks-api', 'https://budget-api.staging.sindustries.co.nz');
  assert.equal(result.ok, false, 'cross-wiring to another surface must be rejected');
  assert.match(result.reason, /budget-api/, 'the reason names the surface the host actually belongs to');
  assert.match(result.reason, /tasks-api\.staging\.sindustries\.co\.nz/, 'the reason lists the allowed routes');
});

test('a tasks-api target pointing at the platform host with the budget-api path is rejected', () => {
  const result = checkTarget(MATRIX, 'tasks-api', 'https://sindustries-platform-staging.fly.dev/budget-api');
  assert.equal(result.ok, false, 'the right host with the wrong path must be rejected');
  assert.match(result.reason, /path/, 'the reason names the path problem');
});

test('a tasks-api target pointing at the platform host with no path is rejected', () => {
  const result = checkTarget(MATRIX, 'tasks-api', 'https://sindustries-platform-staging.fly.dev');
  assert.equal(result.ok, false, 'the platform host with no path prefix must be rejected');
});

test('a target without an https scheme is rejected', () => {
  for (const url of [
    'tasks-api.staging.sindustries.co.nz',
    'http://tasks-api.staging.sindustries.co.nz',
  ]) {
    const result = checkTarget(MATRIX, 'tasks-api', url);
    assert.equal(result.ok, false, `a target without an https:// scheme must be rejected: ${url}`);
  }
});

test('a target with an empty or malformed value is rejected', () => {
  for (const url of ['', '   ', 'not-a-url', 'https://']) {
    const result = checkTarget(MATRIX, 'tasks-api', url);
    assert.equal(result.ok, false, `a malformed target must be rejected: ${JSON.stringify(url)}`);
  }
});

test('an unknown surface is rejected rather than silently accepted', () => {
  const result = checkTarget(MATRIX, 'not-a-surface', 'https://tasks-api.staging.sindustries.co.nz');
  assert.equal(result.ok, false, 'an unknown surface must be rejected');
});

// ---------------------------------------------------------------------
// The acceptances — the routes that must keep working.
// ---------------------------------------------------------------------

test('each surface accepts its own stable hostname', () => {
  for (const surfaceId of ['tasks-api', 'budget-api', 'content-scheduler-api']) {
    const routes = routesForSurface(MATRIX, surfaceId);
    const stable = routes.find((r) => r.pathPrefix === '');
    assert.ok(stable, `${surfaceId} must record a root route`);
    const result = checkTarget(MATRIX, surfaceId, `https://${stable.host}`);
    assert.equal(result.ok, true, `${surfaceId} must accept its stable hostname: ${result.reason ?? ''}`);
  }
});

test('each surface accepts the platform host at its own path prefix', () => {
  for (const surfaceId of ['tasks-api', 'budget-api', 'content-scheduler-api']) {
    const routes = routesForSurface(MATRIX, surfaceId);
    const platform = routes.find((r) => r.pathPrefix !== '');
    assert.ok(platform, `${surfaceId} must record a platform route`);
    const result = checkTarget(MATRIX, surfaceId, `https://${platform.host}${platform.pathPrefix}`);
    assert.equal(result.ok, true, `${surfaceId} must accept the platform host at its prefix: ${result.reason ?? ''}`);
  }
});

test('a host in the wrong case is accepted after normalisation', () => {
  const result = checkTarget(MATRIX, 'tasks-api', 'https://TASKS-API.STAGING.SINDUSTRIES.CO.NZ');
  assert.equal(result.ok, true, 'host comparison must be case-insensitive');
});

test('a trailing path under the platform prefix is accepted', () => {
  const result = checkTarget(MATRIX, 'tasks-api', 'https://sindustries-platform-staging.fly.dev/tasks-api/health');
  assert.equal(result.ok, true, 'a path under the surface prefix must be accepted');
});

// ---------------------------------------------------------------------
// The deliberate no-DNS behaviour.
// ---------------------------------------------------------------------

test('the checker never resolves DNS', () => {
  // The stable staging hostnames do not resolve yet (the CNAME gap on
  // task 5cb4a8fe). They are still valid targets, so the preflight must
  // be a pure string check. This asserts it structurally: the module
  // must not import a resolver at all.
  const source = readFileSync(
    join(REPO_ROOT, 'tests/cloud/scripts/check-staging-target-preflight.mjs'),
    'utf8'
  );
  assert.doesNotMatch(source, /node:dns|require\(['"]dns['"]\)|\.resolve\(|\blookup\(/,
    'the preflight must never resolve a hostname');
});

test('an accepted target is accepted without any network access', () => {
  // `localhost` does not resolve to a staging route, so this is a
  // negative control; the positive case below proves acceptance is
  // decided by the string comparison alone.
  const rejected = checkTarget(MATRIX, 'tasks-api', 'https://localhost:8080');
  assert.equal(rejected.ok, false, 'a host that is not a staging route must be rejected');

  const accepted = checkTarget(MATRIX, 'tasks-api', 'https://tasks-api.staging.sindustries.co.nz');
  assert.equal(accepted.ok, true, 'acceptance must depend only on the configured string');
});

// ---------------------------------------------------------------------
// The parsing helpers.
// ---------------------------------------------------------------------

test('parseTargetUrl splits scheme, host and path', () => {
  const parsed = parseTargetUrl('https://sindustries-platform-staging.fly.dev/tasks-api?x=1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scheme, 'https');
  assert.equal(parsed.host, 'sindustries-platform-staging.fly.dev');
  assert.equal(parsed.path, '/tasks-api');
});

test('parseTargetUrl strips a port and a query string', () => {
  const parsed = parseTargetUrl('https://tasks-api.staging.sindustries.co.nz:443/health?a=b');
  assert.equal(parsed.host, 'tasks-api.staging.sindustries.co.nz');
  assert.equal(parsed.path, '/health');
});

test('pathMatchesPrefix treats the root as empty-or-slash only', () => {
  assert.equal(pathMatchesPrefix('', ''), true);
  assert.equal(pathMatchesPrefix('/', ''), true);
  assert.equal(pathMatchesPrefix('/health', ''), false);
  assert.equal(pathMatchesPrefix('/tasks-api', '/tasks-api'), true);
  assert.equal(pathMatchesPrefix('/tasks-api/health', '/tasks-api'), true);
  assert.equal(pathMatchesPrefix('/tasks-apifoo', '/tasks-api'), false);
});

// ---------------------------------------------------------------------
// The matrix itself must carry the routes the preflight depends on.
// ---------------------------------------------------------------------

test('the committed matrix records a staging route for every consolidated API surface', () => {
  for (const surfaceId of ['tasks-api', 'budget-api', 'content-scheduler-api']) {
    const routes = routesForSurface(MATRIX, surfaceId);
    assert.ok(routes.length >= 2, `${surfaceId} must record both the stable hostname and the platform host`);
    assert.ok(routes.some((r) => r.pathPrefix === ''), `${surfaceId} must record a root route for the stable hostname`);
    assert.ok(routes.some((r) => r.pathPrefix === `/${surfaceId}`), `${surfaceId} must record the platform route "/${surfaceId}"`);
  }
});
