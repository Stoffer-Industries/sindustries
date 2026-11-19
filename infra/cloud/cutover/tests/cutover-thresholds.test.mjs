import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  evaluateThresholds,
  percentile,
  readSamplesFile,
  renderReport,
} from '../thresholds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS_MODULE = join(HERE, '..', 'thresholds.mjs');
const EXAMPLE_MANIFEST = join(HERE, '..', 'production-manifest.example.json');

const MANIFEST = {
  run: {
    abortThresholds: {
      probeFailureCount: 3,
      errorRate: 0.005,
      p95LatencyMs: 1500,
      activeAlertCount: 1,
    },
  },
};

/**
 * One probe sample: every check healthy unless a check is failed.
 */
function sample({ verdict = 'PASS', checks = [] } = {}) {
  return { version: 1, kind: 'cutover-probe-sample', verdict, checks };
}

function check(id, { ok = true, latencyMs = 100 } = {}) {
  return { id, ok, status: ok ? 200 : 500, latencyMs };
}

function breachFor(evaluation, threshold) {
  return evaluation.breaches.find((breach) => breach.threshold === threshold);
}

test('a healthy window breaches nothing', () => {
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
    ],
  });

  assert.deepEqual(evaluation.breaches, []);
  assert.equal(evaluation.metrics.totalSamples, 2);
  assert.equal(evaluation.metrics.errorRate, 0);
});

test('a window with healthy statuses but latency above the ceiling breaches p95LatencyMs', () => {
  // The exact gap: every HTTP status is healthy and every sample
  // verdict is PASS, but the surface is three times slower than the
  // manifest's declared ceiling. Before the thresholds were
  // evaluated, this window passed.
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [
      sample({ checks: [check('tasks-api', { latencyMs: 2100 }), check('mission-control')] }),
      sample({ checks: [check('tasks-api', { latencyMs: 2100 }), check('mission-control')] }),
    ],
  });

  const breach = breachFor(evaluation, 'p95LatencyMs');
  assert.ok(breach, 'the latency breach was not detected');
  assert.equal(breach.measured, 2100);
  assert.equal(breach.limit, 1500);
  assert.equal(breach.check, 'tasks-api');
  assert.match(breach.detail, /every HTTP status healthy/);
});

test('the latency breach names the surface that breached', () => {
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [sample({ checks: [check('tasks-api'), check('mission-control', { latencyMs: 3000 })] })],
  });

  const breach = breachFor(evaluation, 'p95LatencyMs');
  assert.ok(breach);
  assert.equal(breach.check, 'mission-control');
  assert.match(renderReport(evaluation), /mission-control/);
});

test('an error rate above the threshold breaches errorRate', () => {
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [
      sample({
        verdict: 'FAIL',
        checks: [check('tasks-api', { ok: false, latencyMs: 100 }), check('mission-control')],
      }),
    ],
  });

  const breach = breachFor(evaluation, 'errorRate');
  assert.ok(breach);
  assert.equal(breach.measured, 0.5);
  assert.equal(breach.limit, 0.005);
  assert.equal(breach.failedChecks, 1);
  assert.equal(breach.totalChecks, 2);
});

test('an error rate below the probe-failure-count shortcut still breaches', () => {
  // The second gap: the failure COUNT is still below
  // `probeFailureCount` (1 of 3), so the count shortcut never fires,
  // but the error RATE the manifest declared is already breached.
  const manifest = {
    run: { abortThresholds: { probeFailureCount: 3, errorRate: 0.005, p95LatencyMs: 1500 } },
  };
  const evaluation = evaluateThresholds({
    manifest,
    samples: [
      sample({
        verdict: 'FAIL',
        checks: [check('tasks-api', { ok: false, latencyMs: 100 }), check('mission-control')],
      }),
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
    ],
  });

  const breach = breachFor(evaluation, 'errorRate');
  assert.ok(breach, 'the error rate breach was not detected');
  assert.equal(breach.failedChecks, 1);
  assert.equal(breach.totalChecks, 8);
  assert.ok(breach.measured > breach.limit);
});

test('a window whose error rate is under the threshold breaches nothing', () => {
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
      sample({ checks: [check('tasks-api'), check('mission-control')] }),
    ],
  });

  assert.equal(breachFor(evaluation, 'errorRate'), undefined);
});

test('the p95 is computed per check id, so a slow surface cannot be hidden by a fast one', () => {
  const evaluation = evaluateThresholds({
    manifest: MANIFEST,
    samples: [
      sample({
        checks: [
          check('tasks-api', { latencyMs: 10 }),
          check('tasks-api', { latencyMs: 10 }),
          check('mission-control', { latencyMs: 4000 }),
        ],
      }),
    ],
  });

  const breach = breachFor(evaluation, 'p95LatencyMs');
  assert.ok(breach);
  assert.equal(breach.check, 'mission-control');
  assert.equal(evaluation.metrics.p95LatencyMsByCheck['tasks-api'], 10);
});

test('percentile returns a value that was actually observed', () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([50, 10, 30, 20, 40], 0.95), 50);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.95), null);
});

test('a manifest with no abort thresholds is an error, never a pass', () => {
  assert.throws(
    () => evaluateThresholds({ manifest: { run: {} }, samples: [] }),
    /abortThresholds is missing/,
  );
});

test('an unreadable sample fails the evaluation closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-thresholds-'));
  const samplesPath = join(directory, 'samples.jsonl');

  writeFileSync(samplesPath, '{"verdict":"PASS","checks":[]}\nnot-json\n');
  assert.throws(() => readSamplesFile(samplesPath), /is not JSON/);

  writeFileSync(samplesPath, '{"verdict":"PASS","checks":[]}\n\n');
  assert.throws(() => readSamplesFile(samplesPath), /is empty/);
});

test('the CLI refuses with exit code 1 on a breach and 0 on a healthy window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-thresholds-cli-'));
  const samplesPath = join(directory, 'samples.jsonl');

  writeFileSync(
    samplesPath,
    `${JSON.stringify(sample({ checks: [check('tasks-api', { latencyMs: 2100 })] }))}\n`,
  );
  let status = 0;
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      [THRESHOLDS_MODULE, '--manifest', EXAMPLE_MANIFEST, '--samples', samplesPath],
      { encoding: 'utf8' },
    );
  } catch (error) {
    status = error.status;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.equal(status, 1);
  assert.match(output, /threshold breach: p95LatencyMs/);

  writeFileSync(samplesPath, `${JSON.stringify(sample({ checks: [check('tasks-api')] }))}\n`);
  output = execFileSync(
    process.execPath,
    [THRESHOLDS_MODULE, '--manifest', EXAMPLE_MANIFEST, '--samples', samplesPath],
    { encoding: 'utf8' },
  );
  assert.match(output, /metrics: samples=1/);
  assert.doesNotMatch(output, /threshold breach/);
});

test('the CLI refuses with exit code 2 when the window cannot be evaluated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-thresholds-cli-'));
  const samplesPath = join(directory, 'samples.jsonl');
  writeFileSync(samplesPath, 'not-json\n');

  let status = 0;
  try {
    execFileSync(
      process.execPath,
      [THRESHOLDS_MODULE, '--manifest', EXAMPLE_MANIFEST, '--samples', samplesPath],
      { encoding: 'utf8' },
    );
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 2);
});
