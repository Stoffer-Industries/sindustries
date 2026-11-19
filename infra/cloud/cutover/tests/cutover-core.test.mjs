/**
 * cutover-core.test.mjs — unit tests for the cutover manifest
 * validator and the route adapter (task 020f423e).
 *
 * These are the tests that matter for the Sunday window: the validator
 * decides whether a malformed manifest is refused, and the adapter
 * decides whether two operators can overwrite each other's route
 * change. Neither needs a Fly app, a database or a network, so these
 * assertions run in CI on every change.
 *
 * Run:
 *   node --test infra/cloud/cutover/tests/cutover-core.test.mjs
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  baseUrlFor,
  inScopeSurfaces,
  loadManifest,
  rollbackSurfaces,
  validateManifest,
} from '../manifest.mjs';
import {
  applyBinding,
  applyRouteSwitch,
  main,
  planBinding,
  prodlikeReadBack,
  readRouteState,
  routeSwitchNotMoved,
  targetBindings,
  waitForBinding,
  writeRouteState,
} from '../traffic-route.mjs';

// infra/cloud/cutover/tests -> four levels up is the repository root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXAMPLE_MANIFEST = `${REPO_ROOT}/infra/cloud/cutover/production-manifest.example.json`;

/**
 * A deep copy of the example manifest, so a test can mutate it without
 * touching the file other tests read.
 *
 * @returns {object}
 */
function exampleManifest() {
  return JSON.parse(readFileSync(EXAMPLE_MANIFEST, 'utf8'));
}

/**
 * @param {object} manifest
 * @param {RegExp} expected
 */
function assertRefused(manifest, expected) {
  assert.throws(
    () => validateManifest(manifest),
    (error) => {
      assert.match(error.message, expected);
      return true;
    },
    'the manifest should have been refused',
  );
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

test('the shipped example manifest validates', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.equal(manifest.environment, 'production');
  assert.equal(manifest.taskId, '020f423e-a18d-4435-98cb-664b655f675b');
  assert.ok(inScopeSurfaces(manifest).length > 0);
});

test('an unset observation duration is refused', () => {
  const manifest = exampleManifest();
  delete manifest.run.observationMinutes;
  assertRefused(manifest, /observationMinutes must be a positive number/);
});

test('a zero observation duration is refused', () => {
  const manifest = exampleManifest();
  manifest.run.observationMinutes = 0;
  assertRefused(manifest, /observationMinutes must be a positive number/);
});

test('an unset abort threshold is refused', () => {
  const manifest = exampleManifest();
  delete manifest.run.abortThresholds.errorRate;
  assertRefused(manifest, /abortThresholds\.errorRate must be a rate/);
});

test('an unset operator role is refused', () => {
  const manifest = exampleManifest();
  manifest.run.operatorRoles.execution = '';
  assertRefused(manifest, /operatorRoles\.execution must name an operator/);
});

test('a phase order that returns to prodlike is refused', () => {
  const manifest = exampleManifest();
  manifest.phases = [
    { phase: 'baseline', binding: 'prodlike', holdSeconds: 60, minSamples: 1 },
    { phase: 'canary', binding: 'production', holdSeconds: 60, minSamples: 1 },
    { phase: 'rollbackish', binding: 'prodlike', holdSeconds: 60, minSamples: 1 },
    { phase: 'acceptance_pending', binding: 'production', holdSeconds: 0, minSamples: 1 },
  ];
  assertRefused(manifest, /must be monotonic/);
});

test('a window that does not start on prodlike is refused', () => {
  const manifest = exampleManifest();
  manifest.phases = [
    { phase: 'canary', binding: 'production', holdSeconds: 60, minSamples: 1 },
    { phase: 'acceptance_pending', binding: 'production', holdSeconds: 0, minSamples: 1 },
  ];
  assertRefused(manifest, /first phase must bind prodlike/);
});

test('a window that does not end at acceptance_pending is refused', () => {
  const manifest = exampleManifest();
  manifest.phases = [
    { phase: 'baseline', binding: 'prodlike', holdSeconds: 60, minSamples: 1 },
    { phase: 'cloud_active', binding: 'production', holdSeconds: 60, minSamples: 1 },
  ];
  assertRefused(manifest, /final phase must be acceptance_pending/);
});

test('a manifest that carries a credential is refused', () => {
  const manifest = exampleManifest();
  manifest.surfaces[0].productionBaseUrl = 'https://user:hunter2@tasks-api.sindustries.co.nz/api/v1';
  assertRefused(manifest, /credential-shaped value/);
});

test('a manifest that carries a token in a credential field is refused', () => {
  const manifest = exampleManifest();
  manifest.surfaces[0].token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  assertRefused(manifest, /credential-shaped value/);
});

test('a manifest with no rollback surface is refused', () => {
  const manifest = exampleManifest();
  manifest.surfaces = manifest.surfaces.map((surface) => ({
    ...surface,
    rollbackSurface: false,
  }));
  assertRefused(manifest, /at least one surface must be declared as a rollback surface/);
});

test('a manifest whose surfaces drop the rollback flag is refused', () => {
  const manifest = exampleManifest();
  delete manifest.surfaces[0].rollbackSurface;
  assertRefused(manifest, /must declare rollbackSurface as a boolean/);
});

test('a manifest with a duplicate surface id is refused', () => {
  const manifest = exampleManifest();
  manifest.surfaces.push({ ...manifest.surfaces[0] });
  assertRefused(manifest, /duplicate surface id/);
});

test('a manifest whose surface URL is not a plain hostname is refused', () => {
  const manifest = exampleManifest();
  manifest.surfaces[0].productionBaseUrl = 'https://tasks-api.sindustries.co.nz/api/v1; rm -rf /';
  assertRefused(manifest, /is not a URL|hostname is not a plain hostname|path carries unsafe characters/);
});

test('a manifest that names an unknown environment is refused', () => {
  const manifest = exampleManifest();
  manifest.environment = 'prod';
  assertRefused(manifest, /environment must be one of/);
});

test('a manifest whose dependency ids are not task uuids is refused', () => {
  const manifest = exampleManifest();
  manifest.gates.requiredDependencyTaskIds = ['not-a-uuid'];
  assertRefused(manifest, /is not a task UUID/);
});

test('the validator refuses a manifest whose probe interval is unset', () => {
  const manifest = exampleManifest();
  delete manifest.probes.intervalSeconds;
  assertRefused(manifest, /probes\.intervalSeconds must be a positive number/);
});

// ---------------------------------------------------------------------------
// The route adapter
// ---------------------------------------------------------------------------

const LIVE = {
  version: 3,
  environment: 'production',
  binding: 'prodlike',
  surfaces: {},
  updatedAt: null,
  runId: null,
  history: [],
};

test('a plan lists the surfaces that move and leaves the rollback surface alone', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const plan = planBinding(manifest, LIVE, 'production');
  const moved = plan.changes.map((change) => change.surface);
  assert.ok(moved.includes('tasks-api'));
  assert.ok(moved.includes('content-scheduler-api'));
  assert.ok(
    !moved.includes('prodlike-fallback'),
    'the documented rollback surface must not be moved by the switch',
  );
  assert.equal(plan.rollbackSurfaces.length, 1);
  assert.match(plan.rollbackSurfaces[0].reason, /documented rollback surface/);
});

test('target bindings leave the rollback surface on prodlike', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const bindings = targetBindings(manifest, 'production');
  assert.equal(bindings['prodlike-fallback'], 'prodlike');
  assert.equal(bindings['tasks-api'], 'production');
});

test('applying a binding advances the version and records the history', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const next = applyBinding(manifest, LIVE, {
    binding: 'production',
    expectedVersion: 3,
    runId: 'run-1',
    confirm: 'run-1',
  });
  assert.equal(next.version, 4);
  assert.equal(next.binding, 'production');
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].fromVersion, 3);
});

test('a stale expected version is refused', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.throws(
    () =>
      applyBinding(manifest, LIVE, {
        binding: 'production',
        expectedVersion: 2,
        runId: 'run-1',
        confirm: 'run-1',
      }),
    /route version moved underneath this operator/,
  );
});

test('a confirmation that does not match the run id is refused', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.throws(
    () =>
      applyBinding(manifest, LIVE, {
        binding: 'production',
        expectedVersion: 3,
        runId: 'run-1',
        confirm: 'run-2',
      }),
    /--confirm must equal the run id/,
  );
});

test('an unknown binding is refused', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.throws(
    () =>
      applyBinding(manifest, LIVE, {
        binding: 'prodlike2',
        expectedVersion: 3,
        runId: 'run-1',
        confirm: 'run-1',
      }),
    /unknown binding/,
  );
});

test('a route state from another environment is refused', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const foreign = { ...LIVE, environment: 'staging' };
  assert.throws(
    () =>
      applyBinding(manifest, foreign, {
        binding: 'production',
        expectedVersion: 3,
        runId: 'run-1',
        confirm: 'run-1',
      }),
    /belongs to environment staging/,
  );
});

test('the prodlike read-back names the surfaces still on prodlike', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const live = {
    ...LIVE,
    binding: 'prodlike',
    surfaces: targetBindings(manifest, 'prodlike'),
  };
  const readback = prodlikeReadBack(manifest, live);
  assert.equal(readback.clean, false);
  assert.ok(readback.stillTargetingProdlike.some((entry) => entry.surface === 'tasks-api'));
  assert.equal(readback.documentedRollbackSurfaces.length, 1);
});

test('the prodlike read-back is clean once every in-scope surface is on production', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const live = {
    ...LIVE,
    binding: 'production',
    surfaces: targetBindings(manifest, 'production'),
  };
  const readback = prodlikeReadBack(manifest, live);
  assert.equal(readback.clean, true);
  assert.equal(readback.stillTargetingProdlike.length, 0);
});

test('the route switch rewrites live callers and read-back observes the files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-callers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'callers'), { recursive: true });
  const callerPath = join(root, 'callers/tasks.txt');
  writeFileSync(callerPath, 'base=http://localhost:4001/api/v1\n', { mode: 0o600 });

  const manifest = {
    environment: 'production',
    surfaces: [
      {
        id: 'tasks-api',
        callerClass: 'automation',
        rollbackSurface: false,
        prodlikeBaseUrl: 'http://localhost:4001/api/v1',
        productionBaseUrl: 'https://tasks-api.sindustries.co.nz/api/v1',
        callers: [
          {
            id: 'tasks-caller',
            path: 'callers/tasks.txt',
            owner: 'managed',
            prodlikeTarget: 'http://localhost:4001/api/v1',
            productionTarget: 'https://tasks-api.sindustries.co.nz/api/v1',
          },
        ],
      },
      {
        id: 'prodlike-fallback',
        callerClass: 'documented-rollback-surface',
        rollbackSurface: true,
        prodlikeBaseUrl: 'http://localhost:4001/api/v1',
        productionBaseUrl: 'https://tasks-api.sindustries.co.nz/api/v1',
        callers: [],
      },
    ],
  };

  const switched = applyRouteSwitch(root, manifest, 'production');
  assert.deepEqual(switched.failures, []);
  assert.match(readFileSync(callerPath, 'utf8'), /tasks-api\.sindustries/);
  assert.equal(statSync(callerPath).mode & 0o777, 0o600);

  const live = {
    ...LIVE,
    binding: 'production',
    surfaces: targetBindings(manifest, 'production'),
  };
  const readback = prodlikeReadBack(manifest, live, { root });
  assert.equal(readback.clean, true);
  assert.equal(readback.surfaceBindings[0].source, 'live');
  assert.equal(readback.surfaceBindings[0].binding, 'production');
});

test('the route switch refuses all writes when any caller is unreadable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-callers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'callers'), { recursive: true });
  const firstPath = join(root, 'callers/first.txt');
  writeFileSync(firstPath, 'base=http://localhost:4001/api/v1\n');

  const manifest = {
    surfaces: [
      {
        id: 'tasks-api',
        rollbackSurface: false,
        callers: [
          {
            id: 'first',
            path: 'callers/first.txt',
            owner: 'managed',
            prodlikeTarget: 'http://localhost:4001/api/v1',
            productionTarget: 'https://tasks-api.sindustries.co.nz/api/v1',
          },
          {
            id: 'missing',
            path: 'callers/missing.txt',
            owner: 'managed',
            prodlikeTarget: 'http://localhost:4001/api/v1',
            productionTarget: 'https://tasks-api.sindustries.co.nz/api/v1',
          },
        ],
      },
    ],
  };

  const switched = applyRouteSwitch(root, manifest, 'production');
  assert.equal(switched.applied.length, 0);
  assert.equal(switched.failures[0].id, 'missing');
  assert.match(readFileSync(firstPath, 'utf8'), /localhost:4001/);
});

test('a retained rollback caller is not reported as a caller that did not move', () => {
  const manifest = exampleManifest();
  const rollback = manifest.surfaces.find((surface) => surface.rollbackSurface);
  rollback.callers.push({
    id: 'prodlike-rollback-caller',
    path: 'rollback.env',
    owner: 'managed',
    prodlikeTarget: 'http://localhost:4001/api/v1',
    productionTarget: 'https://tasks-api.sindustries.co.nz/api/v1',
  });

  const snapshot = {
    'openclaw-runtime-tasks-api': 'production',
    'workspace-runtime-tasks-api': 'production',
    'openclaw-runtime-content-scheduler': 'production',
    'prodlike-rollback-caller': 'prodlike',
  };

  // The rollback caller stayed on prodlike ON PURPOSE: the switch
  // deliberately leaves the documented rollback surfaces alone.
  assert.deepEqual(routeSwitchNotMoved(manifest, snapshot, 'production'), []);

  // A caller that genuinely did not move is still reported.
  assert.deepEqual(
    routeSwitchNotMoved(
      manifest,
      { ...snapshot, 'openclaw-runtime-tasks-api': 'prodlike' },
      'production',
    ),
    [['openclaw-runtime-tasks-api', 'prodlike']],
  );
});

test('a production set with a retained rollback caller lands and records the route', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-set-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workspace'), { recursive: true });

  // Every caller file still resolves prodlike.
  writeFileSync(
    join(root, '.env'),
    'TASKS_API_BASE_URL=http://localhost:4001/api/v1\nCONTENT_SCHEDULER_BASE_URL=http://localhost:4004\n',
  );
  writeFileSync(
    join(root, 'workspace/.env'),
    'TASKS_API_BASE_URL=http://localhost:4001/api/v1\n',
  );
  writeFileSync(
    join(root, 'rollback.env'),
    'TASKS_API_BASE_URL=http://localhost:4001/api/v1\n',
  );

  // The example manifest with a MANAGED caller on the documented
  // rollback surface. This is the case that used to fail the switch
  // AFTER it had rewritten the in-scope callers, so the command exited
  // non-zero and never wrote the route state.
  const manifest = exampleManifest();
  manifest.surfaces
    .find((surface) => surface.rollbackSurface)
    .callers.push({
      id: 'prodlike-rollback-caller',
      path: 'rollback.env',
      owner: 'managed',
      prodlikeTarget: 'http://localhost:4001/api/v1',
      productionTarget: 'https://tasks-api.sindustries.co.nz/api/v1',
    });
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const statePath = join(root, 'state/route.json');

  const exitCode = main([
    'set',
    '--manifest',
    manifestPath,
    '--binding',
    'production',
    '--expected-version',
    '0',
    '--run-id',
    'run-cutover-1',
    '--confirm',
    'run-cutover-1',
    '--caller-root',
    root,
    '--state-file',
    statePath,
  ]);

  assert.equal(exitCode, 0);

  // The in-scope callers moved to production.
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /tasks-api\.sindustries/);
  assert.match(readFileSync(join(root, 'workspace/.env'), 'utf8'), /tasks-api\.sindustries/);

  // The documented rollback caller did NOT move: prodlike is retained
  // until Tom accepts the observation period.
  assert.match(readFileSync(join(root, 'rollback.env'), 'utf8'), /localhost:4001/);

  // And the route state was recorded, so the journal matches the disk
  // instead of the command failing with the route half-moved.
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.binding, 'production');
  assert.equal(state.version, 1);
});

test('baseUrlFor resolves a surface under each binding', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.match(baseUrlFor(manifest, 'tasks-api', 'production'), /^https:\/\//);
  assert.match(baseUrlFor(manifest, 'tasks-api', 'prodlike'), /^http:\/\/localhost/);
});

test('rollbackSurfaces returns the retained prodlike surface', () => {
  const manifest = loadManifest(EXAMPLE_MANIFEST);
  assert.deepEqual(
    rollbackSurfaces(manifest).map((surface) => surface.id),
    ['prodlike-fallback'],
  );
});

// ---------------------------------------------------------------------------
// The route state file
// ---------------------------------------------------------------------------

test('the route state round-trips through the state file', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'cutover-route-'));
  const stateFile = join(directory, 'production-route.json');

  const manifest = loadManifest(EXAMPLE_MANIFEST);
  const next = applyBinding(manifest, LIVE, {
    binding: 'production',
    expectedVersion: 3,
    runId: 'run-1',
    confirm: 'run-1',
  });
  writeRouteState(stateFile, next);

  const observed = readRouteState(stateFile);
  assert.equal(observed.version, 4);
  assert.equal(observed.binding, 'production');

  const waited = await waitForBinding(stateFile, {
    binding: 'production',
    expectedVersion: 4,
    timeoutSeconds: 5,
    pollMs: 50,
  });
  assert.equal(waited.version, 4);
});
