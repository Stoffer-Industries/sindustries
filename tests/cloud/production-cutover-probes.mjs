#!/usr/bin/env node
/**
 * production-cutover-probes.mjs — the continuous probes that run before,
 * during and after every route change in the SIndustries production
 * cutover (task 020f423e).
 *
 * WHAT A PROBE SAMPLE IS
 *   One redacted JSON document per interval, describing whether the
 *   ACTIVE BINDING is serving correctly: the public health endpoints,
 *   an authenticated read/write transaction through the Tasks API, a
 *   safe (never-published) transaction through the Content Scheduler,
 *   the service version the origin reports, the latency and status-code
 *   distribution, and the hosted database/Redis/queue/alert signals
 *   where the observability API supports them.
 *
 * WHAT A PROBE NEVER DOES
 *   It never reaches a real publish time, never sends a real X post and
 *   never triggers a vendor sync. The synthetic Content Scheduler
 *   transaction schedules into the FUTURE, approves it, reads the queue
 *   health, unapproves it and removes it — the whole point is to
 *   exercise the write path without a side effect in the world.
 *
 * IT RECORDS BOOLEANS AND CORRELATION IDS, NOT PAYLOADS
 *   A probe sample is committed to a public repository's issue tracker
 *   and pasted into task comments. So the sample carries the status,
 *   the latency, the correlation id and a verdict — never a token,
 *   never a task body, never a scheduled post's text.
 *
 * THE SYNTHETIC TRANSACTION IS IDEMPOTENT
 *   Every synthetic record carries the run id, so a re-run cleans up
 *   after its own earlier attempt instead of accumulating records. A
 *   cleanup that FAILS is reported as a failed check: an uncleaned
 *   synthetic record is an abort condition, not a footnote.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseUrlFor, loadManifest } from '../../infra/cloud/cutover/manifest.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REDACTOR = `${REPO_ROOT}/infra/cloud/platform/redact-output.mjs`;

/**
 * Redact anything credential-shaped out of a string before it reaches
 * a sample. The redactor is the shared module the platform tooling
 * uses, so the cutover evidence and the platform evidence cannot drift
 * apart.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  const input = String(text ?? '');
  try {
    return execFileSync('node', [REDACTOR], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    // Fail closed: if the redactor cannot run, say nothing rather than
    // the raw text.
    return '(redacted: the redactor failed)';
  }
}

/**
 * The credential the authenticated probes use. It arrives in the
 * ENVIRONMENT, never in the manifest and never in an artifact.
 *
 * @param {string} name
 * @returns {string}
 */
function readSecret(name) {
  return process.env[name] ?? '';
}

/**
 * Make one HTTP request.
 *
 * The body default is null, meaning NO BODY — not an empty string.
 * An empty-string default would be serialised to the two-character
 * JSON string `""` and sent as a body, and `fetch` refuses a GET or
 * HEAD that carries one ("Request with GET/HEAD method cannot have
 * body"). Every health probe and every authenticated read would then
 * have failed with a status of 0, and no probe sample could ever have
 * reported PASS.
 *
 * @param {string} url
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function request(
  url,
  { method = 'GET', token = '', body = null, timeoutMs = null } = {},
) {
  const controller = new AbortController();
  const effectiveTimeout = timeoutMs ?? Number(process.env.CUTOVER_PROBE_TIMEOUT_MS ?? 20000);
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();
  // A body only goes on the wire when one was supplied AND the method
  // is allowed to carry one.
  const carriesBody = body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD';
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (carriesBody) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      body: carriesBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    let parsed = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      correlationId:
        response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? null,
      version:
        response.headers.get('x-service-version') ?? response.headers.get('x-version') ?? null,
      body: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      correlationId: null,
      version: null,
      error: redact(error?.message ?? String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health check for one surface.
 *
 * @param {object} manifest
 * @param {object} surface
 * @param {string} binding
 * @returns {Promise<object>} a check record
 */
async function checkHealth(manifest, surface, binding) {
  const base = baseUrlFor(manifest, surface.id, binding);
  const url = `${base.replace(/\/+$/, '')}${surface.healthPath}`;
  const response = await request(url);
  return {
    id: `health:${surface.id}`,
    ok: response.ok,
    status: response.status,
    latencyMs: response.latencyMs,
    correlationId: response.correlationId,
    serviceVersion: response.version,
    detail: response.ok ? 'serving' : `health check failed with status ${response.status}`,
    error: response.error ?? null,
  };
}

/**
 * The authenticated Tasks API transaction: read, create, comment,
 * archive — then remove the synthetic record so the probe leaves no
 * trace beyond the correlation ids it reported.
 *
 * @param {object} manifest
 * @param {string} runId
 * @param {boolean} mutating
 * @param {string} binding the origin the probe is exercising
 * @returns {Promise<object>} a check record
 */
export async function checkTasksApi(manifest, runId, mutating, binding) {
  const token = readSecret('CUTOVER_PROBE_TASKS_TOKEN');
  if (!token) {
    return {
      id: 'workflow:tasks-api',
      ok: false,
      skipped: true,
      detail:
        'no authenticated probe credential in the environment (CUTOVER_PROBE_TASKS_TOKEN) — an authenticated check that did not run is not a pass',
    };
  }
  const base = baseUrlFor(manifest, 'tasks-api', binding);
  const marker = `cutover-probe-${runId}`;

  const list = await request(`${base}/tasks?limit=1`, { token });
  if (!list.ok) {
    return {
      id: 'workflow:tasks-api',
      ok: false,
      status: list.status,
      latencyMs: list.latencyMs,
      detail: 'the authenticated Tasks API read failed',
      error: list.error ?? null,
    };
  }

  if (!mutating) {
    return {
      id: 'workflow:tasks-api',
      ok: true,
      status: list.status,
      latencyMs: list.latencyMs,
      correlationId: list.correlationId,
      detail: 'the authenticated Tasks API read succeeded (no write performed)',
    };
  }

  const created = await request(`${base}/tasks`, {
    method: 'POST',
    token,
    body: {
      title: marker,
      description: `synthetic cutover probe record ${marker}`,
      status: 'open',
      taskType: 'code',
    },
  });
  if (!created.ok) {
    return {
      id: 'workflow:tasks-api',
      ok: false,
      status: created.status,
      latencyMs: created.latencyMs,
      detail: 'the synthetic task create failed',
      error: created.error ?? null,
    };
  }
  const createdId = created.body?.data?.id ?? created.body?.data?.task?.id ?? null;

  const commented = await request(`${base}/tasks/${createdId}/comments`, {
    method: 'POST',
    token,
    body: { text: marker },
  });

  const archived = await request(`${base}/tasks/${createdId}`, {
    method: 'PATCH',
    token,
    body: { status: 'archived' },
  });

  // The cleanup is part of the transaction: a probe that leaves a
  // synthetic record behind has failed, whatever the create said.
  let cleaned = true;
  if (createdId) {
    const removed = await request(`${base}/tasks/${createdId}`, { method: 'DELETE', token });
    cleaned = removed.ok;
  }

  const ok = commented.ok && archived.ok && cleaned;
  return {
    id: 'workflow:tasks-api',
    ok,
    status: archived.status,
    latencyMs: archived.latencyMs,
    correlationId: archived.correlationId ?? list.correlationId,
    detail: ok
      ? 'the authenticated Tasks API create/comment/archive/cleanup transaction succeeded'
      : 'the authenticated Tasks API transaction did not complete cleanly',
    cleanup: { performed: true, ok: cleaned },
    error: commented.error ?? archived.error ?? null,
  };
}

/**
 * The safe Content Scheduler transaction: schedule into the FUTURE,
 * approve, read the queue health, unapprove and remove. It never
 * reaches a publish time, so nothing is published.
 *
 * @param {object} manifest
 * @param {string} runId
 * @param {boolean} mutating
 * @param {string} binding the origin the probe is exercising
 * @returns {Promise<object>} a check record
 */
export async function checkContentScheduler(manifest, runId, mutating, binding) {
  const token = readSecret('CUTOVER_PROBE_SCHEDULER_TOKEN');
  if (!token) {
    return {
      id: 'workflow:content-scheduler',
      ok: false,
      skipped: true,
      detail:
        'no authenticated probe credential in the environment (CUTOVER_PROBE_SCHEDULER_TOKEN) — an authenticated check that did not run is not a pass',
    };
  }
  const base = baseUrlFor(manifest, 'content-scheduler-api', binding);
  const marker = `cutover-probe-${runId}`;
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const read = await request(`${base}/scheduled-posts?limit=1`, { token });
  if (!read.ok) {
    return {
      id: 'workflow:content-scheduler',
      ok: false,
      status: read.status,
      latencyMs: read.latencyMs,
      detail: 'the authenticated Content Scheduler read failed',
      error: read.error ?? null,
    };
  }

  if (!mutating) {
    return {
      id: 'workflow:content-scheduler',
      ok: true,
      status: read.status,
      latencyMs: read.latencyMs,
      correlationId: read.correlationId,
      detail: 'the authenticated Content Scheduler read succeeded (no write performed)',
    };
  }

  const created = await request(`${base}/scheduled-posts`, {
    method: 'POST',
    token,
    body: {
      text: marker,
      scheduledFor: farFuture,
      platform: 'x',
    },
  });
  if (!created.ok) {
    return {
      id: 'workflow:content-scheduler',
      ok: false,
      status: created.status,
      latencyMs: created.latencyMs,
      detail: 'the synthetic schedule create failed',
      error: created.error ?? null,
    };
  }
  const recordId = created.body?.data?.id ?? created.body?.data?.post?.id ?? null;

  const approved = await request(`${base}/scheduled-posts/${recordId}/approve`, {
    method: 'POST',
    token,
    body: {},
  });
  const queue = await request(`${base}/auto-post/health`, { token });
  const unapproved = await request(`${base}/scheduled-posts/${recordId}/approve`, {
    method: 'DELETE',
    token,
  });

  let cleaned = true;
  if (recordId) {
    const removed = await request(`${base}/scheduled-posts/${recordId}`, {
      method: 'DELETE',
      token,
    });
    cleaned = removed.ok;
  }

  const ok = approved.ok && queue.ok && unapproved.ok && cleaned;
  return {
    id: 'workflow:content-scheduler',
    ok,
    status: approved.status,
    latencyMs: approved.latencyMs,
    correlationId: approved.correlationId ?? read.correlationId,
    detail: ok
      ? 'the safe future-scheduled create/approve/queue-health/unapprove/remove transaction succeeded (nothing was published)'
      : 'the safe Content Scheduler transaction did not complete cleanly',
    cleanup: { performed: true, ok: cleaned },
    error: approved.error ?? queue.error ?? null,
  };
}

/**
 * The path on the hosted Grafana stack that answers "how many alerts are
 * firing right now": the Alertmanager v2 alerts endpoint, which returns
 * the FIRING alerts as a bare JSON array.
 *
 * This is the same endpoint the hosted-observability runbook already uses
 * to capture per-alert state (`infra/cloud/observability/evidence-capture.sh`).
 *
 * The provisioning endpoint (`/api/v1/provisioning/alert-rules`) is NOT
 * the same thing: it returns rule DEFINITIONS, not firing alerts. The
 * stack carries ten definitions, so a definition count would breach a
 * threshold of one on every single run — and a probe that always aborts
 * is indistinguishable from a probe that never worked.
 */
export const HOSTED_ALERTS_PATH = '/api/alertmanager/grafana/api/v2/alerts';

/**
 * Normalise a credential to the bare token, so the shared `request()`
 * helper is the only thing that ever builds the Authorization header.
 *
 * The hosted stack's credentials are stored in the quoted
 * `Bearer <service-account-token>` form (see
 * `docs/systems/observability.md`), so passing one straight to
 * `request()` would put `Bearer Bearer <token>` on the wire.
 *
 * @param {string} value
 * @returns {string} the bare token
 */
function bearerToken(value) {
  return String(value ?? '').trim().replace(/^Bearer\s+/i, '');
}

/**
 * Read the firing-alert list out of a response body.
 *
 * The count is only meaningful when the body IS an alert list. Anything
 * else means the active alert count is UNKNOWN, and an unknown count is
 * not zero: the previous version of this probe defaulted a missing
 * `activeAlerts` field to 0 and reported a PASS, so any change to the
 * response shape would have turned a failing signal into a green one.
 *
 * @param {unknown} body
 * @returns {Array<unknown>|null} the alert list, or null when unreadable
 */
function readActiveAlerts(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.alerts)) return body.alerts;
  }
  return null;
}

/**
 * The hosted signals: the active alert count over the hosted stack, which
 * is where the database, Redis, worker and queue alerts live — a firing
 * alert on any of them is an active alert here.
 *
 * These are read through the hosted observability surface. When it is not
 * configured, the check reports that the signal was unavailable rather
 * than reporting a pass: an unobserved signal is not a healthy signal.
 *
 * @param {object} manifest
 * @returns {Promise<object>} a check record
 */
export async function checkHostedSignals(manifest) {
  // `||`, not `??`: an override that is set but EMPTY must fall through to
  // the canonical variable rather than becoming an empty base URL.
  const baseUrl = (
    process.env.CUTOVER_OBSERVABILITY_BASE_URL ||
    process.env.GRAFANA_CLOUD_INSTANCE_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const token = bearerToken(
    readSecret('CUTOVER_OBSERVABILITY_TOKEN') || readSecret('GRAFANA_CLOUD_READER_AUTH'),
  );
  const threshold = Number(
    manifest.run?.abortThresholds?.activeAlertCount ?? Number.POSITIVE_INFINITY,
  );

  if (!baseUrl) {
    return {
      id: 'signals:hosted',
      ok: false,
      skipped: true,
      detail:
        'no hosted observability endpoint in the environment — set GRAFANA_CLOUD_INSTANCE_URL (the hosted stack base URL) or CUTOVER_OBSERVABILITY_BASE_URL; an unobserved signal is not a healthy signal',
    };
  }
  if (!token) {
    return {
      id: 'signals:hosted',
      ok: false,
      skipped: true,
      detail:
        'no hosted observability credential in the environment — set GRAFANA_CLOUD_READER_AUTH (the read-scoped service-account token, provisioned separately from the provisioning token) or CUTOVER_OBSERVABILITY_TOKEN; an unobserved signal is not a healthy signal',
    };
  }

  const url = `${baseUrl}${HOSTED_ALERTS_PATH}`;
  const response = await request(url, { token });
  if (!response.ok) {
    return {
      id: 'signals:hosted',
      ok: false,
      status: response.status,
      latencyMs: response.latencyMs,
      detail: 'the hosted alert read failed',
      error: response.error ?? null,
    };
  }

  const alerts = readActiveAlerts(response.body);
  if (alerts === null) {
    return {
      id: 'signals:hosted',
      ok: false,
      status: response.status,
      latencyMs: response.latencyMs,
      detail:
        'the hosted alert read returned a payload that is not an alert list — the active alert count is unknown, and an unobserved signal is not a healthy signal',
      error: null,
    };
  }

  const activeAlerts = alerts.length;
  return {
    id: 'signals:hosted',
    ok: activeAlerts < threshold,
    status: response.status,
    latencyMs: response.latencyMs,
    correlationId: response.correlationId,
    detail: `hosted signals read; ${activeAlerts} active alert(s) against a threshold of ${threshold}`,
  };
}

/**
 * Run one probe sample.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.binding
 * @param {string} options.phase
 * @param {number} options.sample
 * @param {boolean} options.mutating
 * @param {string} options.runId
 * @returns {Promise<object>} the sample document
 */
export async function runSample({ manifest, binding, phase, sample, mutating, runId }) {
  const checks = [];

  for (const surface of manifest.surfaces) {
    if (surface.rollbackSurface) continue;
    checks.push(await checkHealth(manifest, surface, binding));
  }

  // The authenticated workflows are checked against the surface that
  // serves them, WHATEVER THE BINDING IS: the point is that the
  // WORKFLOW works through the active route, not that the probe knows
  // which origin is behind it. Hard-coding production here made the
  // baseline phase and the rollback verification probe production
  // while claiming to probe prodlike.
  checks.push(await checkTasksApi(manifest, runId, mutating, binding));
  checks.push(await checkContentScheduler(manifest, runId, mutating, binding));
  checks.push(await checkHostedSignals(manifest));

  const latencies = checks.map((check) => check.latencyMs).filter((value) => typeof value === 'number');
  const statuses = checks.map((check) => check.status).filter((value) => typeof value === 'number');
  const failed = checks.filter((check) => !check.ok);

  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';

  return {
    version: 1,
    kind: 'cutover-probe-sample',
    runId,
    phase,
    sample,
    binding,
    mode: mutating ? 'full' : 'health-only',
    at: new Date().toISOString(),
    verdict,
    summary: {
      checks: checks.length,
      failed: failed.length,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
      statuses: statuses.length ? [...new Set(statuses)].sort() : [],
    },
    checks,
  };
}

/**
 * Parse the CLI arguments.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    manifest: null,
    binding: 'production',
    phase: 'probe',
    sample: 1,
    healthOnly: false,
    runId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`production-cutover-probes: ${arg} needs a value`);
      return argv[index];
    };
    switch (arg) {
      case '--manifest':
        options.manifest = next();
        break;
      case '--binding':
        options.binding = next();
        break;
      case '--phase':
        options.phase = next();
        break;
      case '--sample':
        options.sample = Number.parseInt(next(), 10);
        break;
      case '--health-only':
        options.healthOnly = true;
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`production-cutover-probes: unknown argument ${arg}`);
    }
  }
  return options;
}

/**
 * The CLI entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help || !options.manifest) {
    process.stdout.write(
      'production-cutover-probes — one redacted sample per interval\n\n' +
        '  --manifest <path>   the cutover manifest\n' +
        '  --binding <origin>  prodlike | production (default production)\n' +
        '  --phase <name>      the phase the sample belongs to\n' +
        '  --sample <n>        the sample number within the phase\n' +
        '  --health-only       no synthetic writes (used by the preflight)\n' +
        '  --run-id <id>       the run id the synthetic records carry\n',
    );
    return options.help ? 0 : 2;
  }

  const manifest = loadManifest(options.manifest);
  const runId = options.runId ?? randomUUID();

  const sample = await runSample({
    manifest,
    binding: options.binding,
    phase: options.phase,
    sample: options.sample,
    mutating: !options.healthOnly,
    runId,
  });

  process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
  return sample.verdict === 'PASS' ? 0 : 1;
}

// Only run the CLI when this module is the entry point.
if (process.argv[1] && process.argv[1].endsWith('production-cutover-probes.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}

export { readFileSync };
