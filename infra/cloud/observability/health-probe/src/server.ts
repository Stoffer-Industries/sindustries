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

import { startOtel } from '@sindustries/otel-node/register';
import express, { type Request, type Response } from 'express';
import { collectDefaultMetrics, Registry, Gauge, Histogram } from 'prom-client';

import {
  configFromEnv,
  runProbe,
  type ProbeResult,
} from './probe.js';

startOtel({ serviceName: 'health-probe' });

const PORT = Number.parseInt(process.env.PORT ?? '9090', 10);
const INTERVAL_SECONDS = Number.parseInt(
  process.env.PROBE_INTERVAL_SECONDS ?? '30',
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

function applyResult(result: ProbeResult): void {
  for (const entry of result.db) {
    dbUp.set({ app: entry.app }, entry.up);
    if (entry.up === 1) {
      dbQueryDuration.observe({ app: entry.app }, entry.durationSeconds);
    }
  }
  for (const entry of result.fly) {
    flyAppHealth.set({ app: entry.app }, entry.up);
  }
  for (const entry of result.redis) {
    redisUp.set({ app: entry.app }, entry.up);
  }
}

async function runOnce(): Promise<void> {
  const config = configFromEnv();
  try {
    const result = await runProbe(config);
    applyResult(result);
    probeRuns.inc();
  } catch (err) {
    probeErrors.inc();
    // eslint-disable-next-line no-console
    console.error('probe pass failed', err);
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
  await runOnce();
  setInterval(() => {
    void runOnce();
  }, INTERVAL_SECONDS * 1000).unref();

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`health-probe listening on :${PORT} (interval=${INTERVAL_SECONDS}s)`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('health-probe failed to start', err);
  process.exit(1);
});
