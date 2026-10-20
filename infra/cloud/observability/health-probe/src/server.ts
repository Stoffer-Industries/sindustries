/**
 * Health probe — HTTP server that exposes Prometheus metrics on /metrics
 * and a Fly http_check on /healthz. Runs a periodic probe pass on the
 * PROBE_INTERVAL_SECONDS cadence (default 30).
 *
 * The probe intentionally re-uses the @sindustries/otel-node SDK so its
 * own trace + metric export also flows through OTLP. That means the
 * probe is also visible in the hosted Grafana as a service called
 * "health-probe" — operators can confirm the probe is alive from the
 * cloud-overview dashboard.
 */

import express, { type Request, type Response } from 'express';
import { collectDefaultMetrics, Registry, Gauge, Histogram } from 'prom-client';
import { metrics } from '@opentelemetry/api';

import {
  configFromEnv,
  probeDbTargets,
  probeFlyTargets,
  probeRedisTargets,
  type ProbeResult,
} from './probe.js';

const PORT = Number.parseInt(process.env.PORT ?? '9090', 10);
const INTERVAL_SECONDS = Number.parseInt(
  process.env.PROBE_INTERVAL_SECONDS ?? '30',
  10,
);
// DB checks hold a live Postgres connection open on every pass, which
// keeps a Neon compute endpoint from scaling to zero (see the Oct 2026
// free-tier compute-hour incident: a 30s DB probe cadence against the
// staging branch kept it "active" around the clock and burned the
// whole org's free compute-hour allowance on a database nobody was
// otherwise using). DB probe cadence is intentionally decoupled from
// the Fly/Redis cadence above so it can be slowed down (e.g. daily on
// staging) without losing the more frequent liveness signal for Fly
// apps and Redis, which don't carry that cost. Defaults to
// PROBE_INTERVAL_SECONDS when unset, preserving prior behaviour.
const DB_INTERVAL_SECONDS = Number.parseInt(
  process.env.DB_PROBE_INTERVAL_SECONDS ?? String(INTERVAL_SECONDS),
  10,
);

const registry = new Registry();
registry.setDefaultLabels({
  app: 'health-probe',
  service: 'health-probe',
});
collectDefaultMetrics({ register: registry });

const dbUp = new Gauge({
  name: 'sindustries_db_up',
  help: '1 if the database responds to SELECT 1 within the probe timeout, 0 otherwise',
  labelNames: ['app'],
  registers: [registry],
});

const dbQueryDuration = new Histogram({
  name: 'sindustries_db_query_duration_seconds',
  help: 'SELECT 1 round-trip duration in seconds',
  labelNames: ['app'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const flyAppHealth = new Gauge({
  name: 'sindustries_fly_app_health',
  help: '1 if the Fly app health endpoint returns 2xx, 0 otherwise',
  labelNames: ['app'],
  registers: [registry],
});

const redisUp = new Gauge({
  name: 'sindustries_redis_up',
  help: '1 if Redis PING returns PONG, 0 otherwise',
  labelNames: ['app'],
  registers: [registry],
});

const probeRuns = new Gauge({
  name: 'sindustries_health_probe_runs_total',
  help: 'Cumulative count of probe passes run by this service',
  registers: [registry],
});

const probeErrors = new Gauge({
  name: 'sindustries_health_probe_errors_total',
  help: 'Cumulative count of probe pass errors (target failures are not errors; this counts probe-loop faults)',
  registers: [registry],
});

// prom-client serves the compatibility /metrics endpoint, but it is not
// connected to the OTLP pipeline. Mirror the values into OTel instruments so
// Grafana Cloud receives the health metrics through the SDK preload.
const meter = metrics.getMeter('health-probe');
const dbUpOtel = meter.createObservableGauge('sindustries_db_up', {
  description: '1 if the database responds to SELECT 1 within the probe timeout, 0 otherwise',
});
const flyAppHealthOtel = meter.createObservableGauge('sindustries_fly_app_health', {
  description: '1 if the Fly app health endpoint returns 2xx, 0 otherwise',
});
const redisUpOtel = meter.createObservableGauge('sindustries_redis_up', {
  description: '1 if Redis PING returns PONG, 0 otherwise',
});
const probeRunsOtel = meter.createObservableGauge('sindustries_health_probe_runs_total', {
  description: 'Cumulative count of probe passes run by this service',
});
const probeErrorsOtel = meter.createObservableGauge('sindustries_health_probe_errors_total', {
  description: 'Cumulative count of probe pass errors',
});

const dbValues = new Map<string, number>();
const flyValues = new Map<string, number>();
const redisValues = new Map<string, number>();
let probeRunsValue = 0;
let probeErrorsValue = 0;

dbUpOtel.addCallback((result) => {
  for (const [app, value] of dbValues) result.observe(value, { app });
});
flyAppHealthOtel.addCallback((result) => {
  for (const [app, value] of flyValues) result.observe(value, { app });
});
redisUpOtel.addCallback((result) => {
  for (const [app, value] of redisValues) result.observe(value, { app });
});
probeRunsOtel.addCallback((result) => result.observe(probeRunsValue));
probeErrorsOtel.addCallback((result) => result.observe(probeErrorsValue));

function applyResult(result: ProbeResult): void {
  for (const entry of result.db) {
    dbUp.set({ app: entry.app }, entry.up);
    dbValues.set(entry.app, entry.up);
    if (entry.up === 1) {
      dbQueryDuration.observe({ app: entry.app }, entry.durationSeconds);
    }
  }
  for (const entry of result.fly) {
    flyAppHealth.set({ app: entry.app }, entry.up);
    flyValues.set(entry.app, entry.up);
  }
  for (const entry of result.redis) {
    redisUp.set({ app: entry.app }, entry.up);
    redisValues.set(entry.app, entry.up);
  }
}

// Fly app + Redis checks run on the fast (INTERVAL_SECONDS) cadence —
// they're free, so there's no reason to slow them down.
async function runNonDbOnce(): Promise<void> {
  const config = configFromEnv();
  const timeoutMs = config.timeoutMs ?? 5000;
  try {
    const [fly, redis] = await Promise.all([
      probeFlyTargets(config.flyApps, timeoutMs),
      probeRedisTargets(config.redis, timeoutMs),
    ]);
    applyResult({ timestamp: Date.now(), db: [], fly, redis });
    probeRuns.inc();
    probeRunsValue += 1;
  } catch (err) {
    probeErrors.inc();
    probeErrorsValue += 1;
    // eslint-disable-next-line no-console
    console.error('probe pass failed (fly/redis)', err);
  }
}

// DB checks run on their own (potentially much slower) cadence — see
// the DB_INTERVAL_SECONDS comment above for why.
async function runDbOnce(): Promise<void> {
  const config = configFromEnv();
  const timeoutMs = config.timeoutMs ?? 5000;
  try {
    const db = await probeDbTargets(config.dbs, timeoutMs);
    applyResult({ timestamp: Date.now(), db, fly: [], redis: [] });
    probeRuns.inc();
    probeRunsValue += 1;
  } catch (err) {
    probeErrors.inc();
    probeErrorsValue += 1;
    // eslint-disable-next-line no-console
    console.error('probe pass failed (db)', err);
  }
}

const app = express();

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'health-probe' });
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

async function main(): Promise<void> {
  await runNonDbOnce();
  await runDbOnce();
  setInterval(() => {
    void runNonDbOnce();
  }, INTERVAL_SECONDS * 1000).unref();
  setInterval(() => {
    void runDbOnce();
  }, DB_INTERVAL_SECONDS * 1000).unref();

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `health-probe listening on :${PORT} (interval=${INTERVAL_SECONDS}s, db-interval=${DB_INTERVAL_SECONDS}s)`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('health-probe failed to start', err);
  process.exit(1);
});
