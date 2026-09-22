/**
 * Health probe — emits SIndustries observability metrics by polling
 * database, Fly-app, and Redis targets.
 *
 * Designed to run as a single Fly.io app (its own process, not a sidecar)
 * that runs every PROBE_INTERVAL_SECONDS (default 30). The probe exposes
 * its own /healthz and is allowed to be unavailable — it is the canary,
 * not the path. If the probe itself is down, operators see a global
 * "everything is 0" condition; that is a known and acceptable failure
 * mode for staging (see docs/specs/hosted-observability-migration-alerts-tech-design.md
 * Open Question 5).
 *
 * Metric contract (matches the tech design §4):
 *   sindustries_db_up{app=<name>}                            gauge (0|1)
 *   sindustries_db_query_duration_seconds{app=<name>}        histogram (seconds)
 *   sindustries_fly_app_health{app=<name>}                   gauge (0|1)
 *   sindustries_redis_up{app=<name>}                         gauge (0|1)
 *   sindustries_queue_ready{queue=<name>}                    gauge (count)
 *
 * Target lists are environment-driven (see README §"Env var contract")
 * so Quinn can reconfigure without redeploying the probe image.
 */

import pg from 'pg';
import IORedis, { type Redis } from 'ioredis';

export type DbTarget = { app: string; connectionString: string };
export type HttpTarget = { app: string; url: string };
export type RedisTarget = { app: string; url: string };
export type QueueTarget = { queue: string; /** Returns current queue depth, or null if unknown. */ readDepth: () => Promise<number | null> };

export type ProbeConfig = {
  dbs: DbTarget[];
  flyApps: HttpTarget[];
  redis: RedisTarget[];
  /** Per-probe timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
};

export type ProbeResult = {
  timestamp: number;
  db: Array<{ app: string; up: 0 | 1; durationSeconds: number; error?: string }>;
  fly: Array<{ app: string; up: 0 | 1; error?: string }>;
  redis: Array<{ app: string; up: 0 | 1; error?: string }>;
};

/** Format a JSON-safe error message without leaking the connection string. */
function safeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
  }
  return 'unknown error';
}

/** Probe a single Postgres target with a SELECT 1 + timing. */
export async function probeDb(
  target: DbTarget,
  timeoutMs: number,
): Promise<ProbeResult['db'][number]> {
  const start = process.hrtime.bigint();
  const client = new pg.Client({
    connectionString: target.connectionString,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1e9;
    return { app: target.app, up: 1, durationSeconds };
  } catch (err) {
    return { app: target.app, up: 0, durationSeconds: 0, error: safeError(err) };
  } finally {
    await client.end().catch(() => {
      // best-effort close; the connection is already errored or done
    });
  }
}

/** Probe a single Fly app health endpoint. */
export async function probeFlyApp(
  target: HttpTarget,
  timeoutMs: number,
): Promise<ProbeResult['fly'][number]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target.url, { signal: controller.signal });
    if (res.status >= 200 && res.status < 300) {
      return { app: target.app, up: 1 };
    }
    return { app: target.app, up: 0, error: `HTTP ${res.status}` };
  } catch (err) {
    return { app: target.app, up: 0, error: safeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a single Redis target with PING. */
export async function probeRedis(
  target: RedisTarget,
  timeoutMs: number,
): Promise<ProbeResult['redis'][number]> {
  let redis: Redis | null = null;
  try {
    redis = new IORedis(target.url, {
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Swallow ioredis's internal "connection error" event so a probe-time
    // failure does not surface as an Unhandled error event in the host
    // process logs (we already capture the error via the connect/ping
    // rejection below).
    redis.on('error', () => {});
    await redis.connect();
    const reply = await redis.ping();
    if (reply === 'PONG') {
      return { app: target.app, up: 1 };
    }
    return { app: target.app, up: 0, error: `unexpected PING reply: ${reply}` };
  } catch (err) {
    return { app: target.app, up: 0, error: safeError(err) };
  } finally {
    if (redis) {
      redis.disconnect();
    }
  }
}

/**
 * Run a single probe pass against all configured targets. Failures on
 * one target do not abort the rest — partial results are still useful
 * for diagnosis.
 */
export async function runProbe(config: ProbeConfig): Promise<ProbeResult> {
  const timeoutMs = config.timeoutMs ?? 5000;
  const [db, fly, redis] = await Promise.all([
    Promise.all(config.dbs.map((t) => probeDb(t, timeoutMs))),
    Promise.all(config.flyApps.map((t) => probeFlyApp(t, timeoutMs))),
    Promise.all(config.redis.map((t) => probeRedis(t, timeoutMs))),
  ]);
  return { timestamp: Date.now(), db, fly, redis };
}

/**
 * Parse the comma-separated env vars into typed target lists. Empty
 * entries and entries missing required fields are skipped silently —
 * the operator sees the missing target as `up=0` rather than a deploy
 * failure.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProbeConfig {
  const dbs = parseDbTargets(env.HEALTH_PROBE_DATABASES ?? '');
  const flyApps = parseHttpTargets(env.HEALTH_PROBE_FLY_APPS ?? '');
  const redis = parseRedisTargets(env.HEALTH_PROBE_REDIS ?? '');
  const timeoutMs = env.HEALTH_PROBE_TIMEOUT_MS
    ? Number.parseInt(env.HEALTH_PROBE_TIMEOUT_MS, 10)
    : undefined;
  return { dbs, flyApps, redis, timeoutMs };
}

export function parseDbTargets(raw: string): DbTarget[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return null;
      const app = entry.slice(0, eq).trim();
      const connectionString = entry.slice(eq + 1).trim();
      if (!app || !connectionString) return null;
      return { app, connectionString };
    })
    .filter((t): t is DbTarget => t !== null);
}

export function parseHttpTargets(raw: string): HttpTarget[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return null;
      const app = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      if (!app || !url) return null;
      return { app, url };
    })
    .filter((t): t is HttpTarget => t !== null);
}

export function parseRedisTargets(raw: string): RedisTarget[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return null;
      const app = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      if (!app || !url) return null;
      return { app, url };
    })
    .filter((t): t is RedisTarget => t !== null);
}
