// Content Scheduler — BullMQ-backed JobSchedulerAdapter (production).
//
// The durable adapter used when CONTENT_SCHEDULER_JOB_ADAPTER=bullmq. The
// API entrypoint and the worker entrypoint both boot this adapter against
// the same Redis (CONTENT_SCHEDULER_REDIS_URL or REDIS_URL) so a delayed
// job enqueued by the API is consumed by the worker even across process
// restarts. Worker process code never imports this module directly — it
// registers the same job handler at the active adapter, so the routing
// is symmetric on both sides.
//
// `bullmq` and `ioredis` are dynamically imported so the in-process
// adapter (used by tests and by dev environments without Redis) does not
// pay the load cost and does not require these packages to be installed
// in a CI-only run.
//
// See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md.

import type {
  ContentSchedulerJob,
  JobSchedulerAdapter,
  ScheduledJob
} from './contentSchedulerJobs.ts';

const QUEUE_NAME = 'content-scheduler-auto-post';
const JOB_PREFIX = 'content-scheduler-auto-post:';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * Build the deterministic provider job id for a (itemId, scheduleVersion)
 * pair. The route layer passes `scheduleVersion = priorVersion + 1`, so
 * any prior delayed job for the same item is naturally superseded when
 * the version moves forward. The worker's stale-version check is
 * defense-in-depth for cases where cancellation is racy.
 */
export function buildBullMqJobId(job: ContentSchedulerJob): string {
  return `${JOB_PREFIX}${job.itemId}:${job.scheduleVersion}`;
}

/**
 * Resolve the Redis URL from env. Order:
 *   1. CONTENT_SCHEDULER_REDIS_URL (service-specific)
 *   2. REDIS_URL (shared infra)
 *   3. redis://localhost:6379 (dev default)
 */
export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromService = env.CONTENT_SCHEDULER_REDIS_URL;
  if (typeof fromService === 'string' && fromService.length > 0) return fromService;
  const fromShared = env.REDIS_URL;
  if (typeof fromShared === 'string' && fromShared.length > 0) return fromShared;
  return DEFAULT_REDIS_URL;
}

export type BullMqJobSchedulerAdapterDeps = {
  /**
   * Cache: the dynamically loaded `bullmq` module. Tests inject a fake.
   */
  bullmq?: any;
  /**
   * Cache: the dynamically loaded `ioredis` module. Tests inject a fake.
   */
  ioredis?: any;
  /**
   * Override for the Redis URL. Defaults to env resolution.
   */
  redisUrl?: string;
  /**
   * Override for the queue name. Defaults to the standard queue name.
   */
  queueName?: string;
  /**
   * Optional logger (used for startup diagnostics). Defaults to console.
   */
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
};

export type BullMqJobSchedulerAdapter = JobSchedulerAdapter & {
  /**
   * Connection health for the operational diagnostics endpoint. Returns
   * `{ ok: true, latencyMs }` when the Redis client responds to a PING,
   * otherwise `{ ok: false, error }`.
   */
  ping(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }>;
  /**
   * Approximate number of jobs in the queue (delayed + waiting + active).
   * Used by the diagnostics endpoint. Bounds the call to a small count
   * (`getJobCountByTypes`) so a giant queue does not stall the API.
   */
  queueStats(): Promise<{
    waiting: number;
    delayed: number;
    active: number;
    failed: number;
    completed: number;
  }>;
  /**
   * Check whether a given job id currently exists in the queue. Used by
   * the startup reconciliation sweep to detect stale or missing jobs.
   */
  hasJob(jobId: string): Promise<boolean>;
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

/**
 * Build a BullMQ-backed adapter. The returned object lazily imports
 * `bullmq` and `ioredis` on first use so callers that select the
 * in-process adapter never load these packages.
 */
export function createBullMqJobSchedulerAdapter(
  deps: BullMqJobSchedulerAdapterDeps = {}
): BullMqJobSchedulerAdapter {
  const logger = deps.logger ?? noopLogger;
  const queueName = deps.queueName ?? QUEUE_NAME;

  let queueInstance: any | null = null;
  let connectionInstance: any | null = null;

  async function loadBullmq() {
    if (deps.bullmq) return deps.bullmq;
    return (await import('bullmq')).default ?? (await import('bullmq'));
  }

  async function loadIoredis() {
    if (deps.ioredis) return deps.ioredis;
    return (await import('ioredis')).default ?? (await import('ioredis'));
  }

  async function getQueue(): Promise<any> {
    if (queueInstance) return queueInstance;
    const bullmq = await loadBullmq();
    const IORedis = await loadIoredis();
    const url = deps.redisUrl ?? resolveRedisUrl();
    connectionInstance = new IORedis(url, {
      // BullMQ recommends a long-lived blocking connection and a short
      // maximumRetriesPerRequest for the worker side. The queue side
      // (the API process) is not blocking, so we leave the user defaults
      // for the queue client.
      maxRetriesPerRequest: null,
      enableReadyCheck: true
    });
    queueInstance = new bullmq.Queue(queueName, { connection: connectionInstance });
    return queueInstance;
  }

  const adapter: BullMqJobSchedulerAdapter = {
    async scheduleAutoPost(job: ContentSchedulerJob): Promise<ScheduledJob> {
      const queue = await getQueue();
      const jobId = buildBullMqJobId(job);
      const delay = Math.max(0, job.scheduledFor.getTime() - Date.now());
      // BullMQ's `add(id, data, opts)` with a deterministic `jobId`
      // replaces an existing job with the same id, giving us the
      // replace-on-reschedule semantics we need. attempts: 1 + removeOnComplete
      // keeps the queue from retrying domain failures (the worker writes
      // `publishError` and acks the job).
      await queue.add(
        'content-scheduler-auto-post',
        {
          itemId: job.itemId,
          scheduledFor: job.scheduledFor.toISOString(),
          scheduleVersion: job.scheduleVersion
        },
        {
          jobId,
          delay,
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 }
        }
      );
      return { jobId };
    },

    async cancelAutoPost(jobId: string): Promise<void> {
      const queue = await getQueue();
      const job = await queue.getJob(jobId);
      if (!job) return;
      try {
        await job.remove();
      } catch (err: any) {
        // BullMQ throws when the job is already active/completed; treat
        // that as a successful no-op (the worker stale-version check is
        // the safety net).
        const message = err instanceof Error ? err.message : String(err);
        if (!/not.found|already|completed|running|active/i.test(message)) {
          logger.warn('contentSchedulerJobs.bullmq.cancelAutoPost failed', { jobId, error: message });
        }
      }
    },

    async close(): Promise<void> {
      if (queueInstance) {
        try {
          await queueInstance.close();
        } catch (err: any) {
          logger.warn('contentSchedulerJobs.bullmq.close queue failed', { error: err?.message ?? String(err) });
        }
        queueInstance = null;
      }
      if (connectionInstance) {
        try {
          await connectionInstance.quit();
        } catch (err: any) {
          logger.warn('contentSchedulerJobs.bullmq.close connection failed', { error: err?.message ?? String(err) });
        }
        connectionInstance = null;
      }
    },

    async ping(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
      try {
        const connection = connectionInstance ?? (await getQueue()).client;
        const start = Date.now();
        await connection.ping();
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    async queueStats() {
      const queue = await getQueue();
      const counts = await queue.getJobCounts();
      return {
        waiting: Number(counts.waiting ?? 0),
        delayed: Number(counts.delayed ?? 0),
        active: Number(counts.active ?? 0),
        failed: Number(counts.failed ?? 0),
        completed: Number(counts.completed ?? 0)
      };
    },

    async hasJob(jobId: string): Promise<boolean> {
      const queue = await getQueue();
      const job = await queue.getJob(jobId);
      return Boolean(job);
    }
  };

  return adapter;
}
