#!/usr/bin/env node
/**
 * infra/cloud/cutover/thresholds.mjs
 *
 * The abort-threshold semantics for the production cutover (task
 * 020f423e). This module is the ONLY place that decides what the
 * manifest's `run.abortThresholds` means.
 *
 * WHY THIS EXISTS
 *
 *   The manifest declares three abort thresholds:
 *
 *     - probeFailureCount — how many failed probe samples abort a phase
 *     - errorRate         — the tolerated error rate of the window
 *     - p95LatencyMs      — the tolerated 95th-percentile latency
 *
 *   Until now only the first of them was enforced. The executor counted
 *   failed samples and compared that count against
 *   `probeFailureCount`, and the probe sample recorded `maxLatencyMs`
 *   without ever comparing it to `p95LatencyMs`. `errorRate` was
 *   validated by the manifest loader and then never read again.
 *
 *   The result was a window that could be quietly unhealthy: every HTTP
 *   status healthy, every sample verdict PASS, and a latency of three
 *   times the approved ceiling — and the manifest's abort policy said
 *   nothing about it, because nothing ever read those two fields.
 *
 *   Two gates were therefore missing, not one:
 *
 *     1. THE LATENCY GATE. A window whose latency is above the
 *        declared ceiling must abort even when every status is
 *        healthy.
 *     2. THE ERROR-RATE GATE. A window whose error rate is above the
 *        declared rate must abort even when the failure COUNT is
 *        still below `probeFailureCount`. The count shortcut only
 *        fires once enough samples have failed; a slow bleed of
 *        failures that never reaches the count still breaches the
 *        rate the manifest declared.
 *
 * WHAT THE METRICS MEAN
 *
 *   ERROR RATE — the request-level error rate of the window: the
 *   fraction of probe CHECKS that failed, across every sample
 *   collected in the window. The probeFailureCount gate counts
 *   failed SAMPLES, so the rate is the finer-grained companion: it
 *   catches a window where a minority of checks keep failing while
 *   the sample-level count has not yet reached its limit.
 *
 *   P95 LATENCY — the 95th percentile of the observed latencies,
 *   computed PER CHECK ID across the window. Per check id, not
 *   globally pooled: a global pool lets a slow surface mask a fast
 *   one and vice versa, and it cannot say WHICH surface breached.
 *   Per check id, the breach names the surface, so the operator
 *   knows what to look at.
 *
 *   The gate is evaluated after EVERY sample, not once at the end of
 *   the phase. A cutover that observes a degraded surface for an
 *   hour before noticing is worse than one that stops at the first
 *   sign of it. With a single observation a percentile is that
 *   observation, so a slow first sample aborts immediately — which is
 *   the fail-fast posture a production route change wants.
 *
 * FAILING CLOSED
 *
 *   Every input problem is an error, never a pass. A manifest with no
 *   thresholds, a sample file that is not JSON, a sample that is not
 *   an object — all of them refuse. A threshold gate that cannot
 *   evaluate its window must never report "no breach".
 *
 * Usage:
 *   node infra/cloud/cutover/thresholds.mjs --manifest <path> --samples <jsonl-path>
 *
 * Exit codes:
 *   0  the window breaches nothing
 *   1  the window breaches at least one threshold
 *   2  the window could not be evaluated (an error, never a pass)
 */

import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from './manifest.mjs';

/**
 * The 95th percentile by nearest rank.
 *
 * Nearest rank, not interpolation: the cutover's windows are small
 * (a handful of samples across a handful of checks), and an
 * interpolated percentile on a small window invents precision the
 * data does not have. Nearest rank always returns a value that was
 * actually observed, which is what an abort reason should quote.
 *
 * @param {number[]} values the observations
 * @param {number} fraction the percentile, 0..1
 * @returns {number|null} the percentile, or null when there are no values
 */
export function percentile(values, fraction) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Fold a window's samples into the observations the thresholds are
 * computed from.
 *
 * @param {object[]} samples the probe samples collected in the window
 * @returns {object} the folded observations
 */
export function summariseWindow(samples) {
  const perCheck = new Map();
  let failedChecks = 0;
  let totalChecks = 0;
  let failedSamples = 0;

  for (const sample of samples) {
    if (sample?.verdict !== 'PASS') failedSamples += 1;
    const checks = Array.isArray(sample?.checks) ? sample.checks : [];
    for (const check of checks) {
      const id = String(check?.id ?? 'unknown-check');
      const entry = perCheck.get(id) ?? { id, latencies: [], failed: 0, total: 0 };
      entry.total += 1;
      totalChecks += 1;
      if (!check?.ok) {
        entry.failed += 1;
        failedChecks += 1;
      }
      if (typeof check?.latencyMs === 'number' && Number.isFinite(check.latencyMs)) {
        entry.latencies.push(check.latencyMs);
      }
      perCheck.set(id, entry);
    }
  }

  return {
    perCheck: [...perCheck.values()],
    failedChecks,
    totalChecks,
    failedSamples,
  };
}

/**
 * Evaluate the manifest's abort thresholds against a window's samples.
 *
 * @param {object} options
 * @param {object} options.manifest the loaded manifest
 * @param {object[]} options.samples the probe samples collected in the window
 * @returns {object} the metrics and the breaches
 */
export function evaluateThresholds({ manifest, samples }) {
  const thresholds = manifest?.run?.abortThresholds;
  if (!thresholds || typeof thresholds !== 'object') {
    throw new Error('thresholds: manifest.run.abortThresholds is missing — the abort policy cannot be evaluated');
  }
  const window = summariseWindow(Array.isArray(samples) ? samples : []);
  const breaches = [];

  const errorRateLimit = Number(thresholds.errorRate);
  if (!Number.isFinite(errorRateLimit)) {
    throw new Error('thresholds: manifest.run.abortThresholds.errorRate is not a number');
  }
  const latencyLimit = Number(thresholds.p95LatencyMs);
  if (!Number.isFinite(latencyLimit)) {
    throw new Error('thresholds: manifest.run.abortThresholds.p95LatencyMs is not a number');
  }

  const errorRate =
    window.totalChecks > 0 ? window.failedChecks / window.totalChecks : 0;

  const p95LatencyMsByCheck = {};
  let worstP95LatencyMs = null;
  for (const entry of window.perCheck) {
    const p95 = percentile(entry.latencies, 0.95);
    if (p95 === null) continue;
    p95LatencyMsByCheck[entry.id] = p95;
    worstP95LatencyMs =
      worstP95LatencyMs === null ? p95 : Math.max(worstP95LatencyMs, p95);
    if (p95 > latencyLimit) {
      breaches.push({
        threshold: 'p95LatencyMs',
        check: entry.id,
        measured: p95,
        limit: latencyLimit,
        observations: entry.latencies.length,
        detail:
          `check '${entry.id}' recorded a p95 latency of ${p95}ms over ${entry.latencies.length} observation(s) — ` +
          `above the ${latencyLimit}ms abort threshold, with every HTTP status healthy`,
      });
    }
  }

  if (errorRate > errorRateLimit) {
    breaches.push({
      threshold: 'errorRate',
      measured: errorRate,
      limit: errorRateLimit,
      failedChecks: window.failedChecks,
      totalChecks: window.totalChecks,
      detail:
        `${window.failedChecks} of ${window.totalChecks} probe check(s) failed — an error rate of ${errorRate} ` +
        `is above the ${errorRateLimit} abort threshold`,
    });
  }

  return {
    metrics: {
      totalSamples: Array.isArray(samples) ? samples.length : 0,
      failedSamples: window.failedSamples,
      totalChecks: window.totalChecks,
      failedChecks: window.failedChecks,
      errorRate,
      p95LatencyMsByCheck,
      worstP95LatencyMs,
    },
    breaches,
  };
}

/**
 * Read a window's samples from a JSON-lines file.
 *
 * One compact JSON document per line. A line that is not a JSON
 * object is an error: a sample the evaluator cannot read is a sample
 * it cannot judge, and an unjudged sample must never read as a pass.
 *
 * @param {string} path the samples file
 * @returns {object[]} the samples
 */
export function readSamplesFile(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  // Only the trailing newline is tolerated. An EMPTY line anywhere else
  // is an unreadable sample, and an unreadable sample must fail the
  // evaluation closed rather than be silently dropped from the
  // window: dropping it would shrink the window the thresholds are
  // computed over.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const samples = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      throw new Error(
        `thresholds: sample line ${index + 1} of ${path} is empty — a window with an unreadable sample cannot be evaluated`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`thresholds: sample line ${index + 1} of ${path} is not JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`thresholds: sample line ${index + 1} of ${path} is not a JSON object`);
    }
    samples.push(parsed);
  });
  return samples;
}

/**
 * Render the evaluation as the lines an operator reads.
 *
 * @param {object} evaluation the evaluation result
 * @returns {string} the report
 */
export function renderReport(evaluation) {
  const { metrics, breaches } = evaluation;
  const lines = [];
  for (const breach of breaches) {
    lines.push(`threshold breach: ${breach.threshold} — ${breach.detail}`);
  }
  lines.push(
    `metrics: samples=${metrics.totalSamples} checks=${metrics.totalChecks} failedChecks=${metrics.failedChecks} ` +
      `errorRate=${metrics.errorRate} worstP95LatencyMs=${metrics.worstP95LatencyMs ?? 'none'}`,
  );
  return lines.join('\n');
}

/**
 * The CLI: evaluate a samples file against a manifest.
 *
 * @param {string[]} argv the CLI arguments
 * @returns {number} the exit code
 */
export function runCli(argv) {
  let manifestPath = null;
  let samplesPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`thresholds: ${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--manifest') manifestPath = next();
    else if (arg === '--samples') samplesPath = next();
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: thresholds.mjs --manifest <path> --samples <jsonl-path>\n');
      return 0;
    } else {
      throw new Error(`thresholds: unknown argument ${arg}`);
    }
  }
  if (!manifestPath || !samplesPath) {
    throw new Error('thresholds: --manifest and --samples are both required');
  }

  const manifest = loadManifest(manifestPath);
  const samples = readSamplesFile(samplesPath);
  const evaluation = evaluateThresholds({ manifest, samples });
  process.stdout.write(`${renderReport(evaluation)}\n`);
  return evaluation.breaches.length > 0 ? 1 : 0;
}

/**
 * Whether THIS module is the entry point of the current process.
 *
 * The naive check — `import.meta.url === \`file://${process.argv[1]}\`` — is
 * wrong whenever the raw path is not byte-identical to the module URL:
 *
 *   - Node resolves the entry point through symlinks, so a checkout
 *     reached through a symlinked path (a temporary directory, a
 *     `/tmp` -> `/private/tmp` alias, a symlinked worktree root) gets an
 *     `import.meta.url` of the REAL path and a `process.argv[1]` of the
 *     LINKED one.
 *   - A path containing a space, or any other character that has to be
 *     percent-encoded in a file: URL, comes back different from the raw
 *     path.
 *
 * In both cases the comparison is FALSE, the CLI block below never runs,
 * and the process exits 0 WITHOUT evaluating anything. That is the worst
 * failure mode an abort gate can have: the executor reads exit 0 as "no
 * threshold breached" and the window carries on with the thresholds it
 * was supposed to enforce switched off.
 *
 * So both sides are compared as REAL paths.
 *
 * @returns {boolean} true when this module is the process entry point
 */
function isEntryPoint() {
  if (typeof process === 'undefined') return false;
  if (!Array.isArray(process.argv) || !process.argv[1]) return false;
  const entry = resolve(process.argv[1]);
  let self;
  try {
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
  try {
    return self === realpathSync(entry);
  } catch {
    // The entry path could not be resolved. Fall back to comparing the
    // resolved paths directly: if they are the same file, this IS the
    // entry point.
    try {
      return resolve(fileURLToPath(import.meta.url)) === entry;
    } catch {
      return false;
    }
  }
}

/**
 * Whether the process was given the evaluator's own CLI arguments.
 *
 * Used to FAIL LOUD instead of silent: a process that was asked to
 * evaluate thresholds and did not must not exit 0, because exit 0 is
 * the executor's "no breach" verdict.
 *
 * The guard only applies when THIS module is the one that was
 * launched. When the CLI wrapper is the entry point, the wrapper owns
 * the evaluation — it imports this module and calls runCli()
 * unconditionally — so the guard must not interfere with it.
 *
 * @returns {boolean}
 */
function wasAskedToEvaluate() {
  if (typeof process === 'undefined' || !Array.isArray(process.argv)) return false;
  const asked = process.argv
    .slice(2)
    .some((arg) => arg === '--manifest' || arg === '--samples');
  if (!asked) return false;
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return basename(entry) === basename(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
} else if (wasAskedToEvaluate()) {
  // The CLI arguments reached this module but it did not recognise
  // itself as the entry point, so the evaluation below did not run.
  // Exiting 0 here would tell the executor that no threshold was
  // breached — the exact opposite of what happened. A gate that cannot
  // see the window must stop the window, not bless it.
  process.stderr.write(
    'thresholds: the evaluator was given its CLI arguments but was not the process entry point — refusing to exit 0 without evaluating\n',
  );
  process.exitCode = 2;
}
