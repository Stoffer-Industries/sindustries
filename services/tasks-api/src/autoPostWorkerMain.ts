// Content Scheduler — worker entrypoint.
//
// Boots a long-running process that consumes delayed auto-post jobs from
// the active JobSchedulerAdapter. Both the API process and this worker
// register the same adapter and the same job handler, so the API can
// enqueue and the worker can consume without sharing a runtime.
//
// Adapter selection (mirrors services/tasks-api/src/app.ts):
//   - CONTENT_SCHEDULER_JOB_ADAPTER=bullmq → BullMQ + Redis (durable across
//     restarts; required for production and cloud).
//   - CONTENT_SCHEDULER_JOB_ADAPTER=in-process (default for dev / tests) →
//     in-memory setTimeout queue. Survives the worker's lifetime but not
//     restart. Suitable for local dev and unit tests.
//
// On startup the worker runs a reconciliation sweep against the database
// to re-enqueue approved items whose delayed jobs are missing and to
// publish overdue items deterministically. The sweep is idempotent and
// runs on every boot — a Redis restart or a worker restart never leaves
// approved items silently unscheduled.
//
// Run: `npm run content-scheduler:worker` (in services/tasks-api).

import { dotenvConfig } from 'dotenv';
dotenvConfig();

import { createInProcessJobSchedulerAdapter } from './routes/contentSchedulerJobs.inProcess.ts';
import { createBullMqJobSchedulerAdapter } from './routes/contentSchedulerJobs.bullmq.ts';
import { setJobSchedulerAdapter } from './routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from './routes/autoPostWorker.ts';
import { reconcileAutoPostItems } from './routes/autoPostReconciliation.ts';

type AdapterKind = 'in-process' | 'bullmq';

function resolveAdapterKind(): AdapterKind {
  const raw = (process.env.CONTENT_SCHEDULER_JOB_ADAPTER ?? 'in-process').toLowerCase();
  if (raw === 'bullmq') return 'bullmq';
  if (raw === 'in-process') return 'in-process';
  // eslint-disable-next-line no-console
  console.warn(`[content-scheduler-worker] unknown CONTENT_SCHEDULER_JOB_ADAPTER=${raw}, defaulting to in-process`);
  return 'in-process';
}

async function main() {
  const kind = resolveAdapterKind();
  // eslint-disable-next-line no-console
  console.log(`[content-scheduler-worker] starting (adapter=${kind})`);

  if (kind === 'bullmq') {
    const adapter = createBullMqJobSchedulerAdapter();
    setJobSchedulerAdapter(adapter, 'bullmq');
    // The BullMQ adapter exposes a plain Queue here; the worker
    // registers the same job handler at the in-process adapter below
    // so route code and worker code go through the same code path.
    // We additionally wire a BullMQ Worker that consumes jobs and
    // calls `processAutoPostJob` directly — see the BullMQ Worker
    // bootstrap at the bottom of this file.
    await bootstrapBullMqWorker(adapter);
  } else {
    const adapter = createInProcessJobSchedulerAdapter();
    setJobSchedulerAdapter(adapter, 'in-process');
    adapter.setHandler(async (job) => {
      const outcome = await processAutoPostJob(job);
      // eslint-disable-next-line no-console
      console.log(`[content-scheduler-worker] job itemId=${job.itemId} v${job.scheduleVersion} -> ${outcome}`);
    });
  }

  // Reconciliation: rebuild queue state from the database. Idempotent
  // and safe to run on every boot. Logs the structured report so the
  // operator can verify that approved items are covered.
  const report = await reconcileAutoPostItems();
  // eslint-disable-next-line no-console
  console.log(
    `[content-scheduler-worker] reconciliation scanned=${report.scanned} ` +
      `reEnqueued=${report.reEnqueued} overduePublished=${report.overduePublished} ` +
      `overduePublishFailed=${report.overduePublishFailed} ` +
      `scheduledActive=${report.scheduledActive} staleJob=${report.staleJob} ` +
      `skipped=${report.skipped}`
  );

  // eslint-disable-next-line no-console
  console.log(`[content-scheduler-worker] ready`);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[content-scheduler-worker] received ${signal}, shutting down`);
    const adapter = (await import('./routes/contentSchedulerJobs.ts')).getJobSchedulerAdapter();
    if (adapter.close) await adapter.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Boot the BullMQ-side worker. The adapter exposes `scheduleAutoPost` /
 * `cancelAutoPost` but the worker also needs a `Worker` instance that
 * pulls jobs out of the queue and calls `processAutoPostJob`. We
 * lazily import BullMQ here so the in-process path never loads it.
 */
async function bootstrapBullMqWorker(adapter: ReturnType<typeof createBullMqJobSchedulerAdapter>) {
  // BullMQ is dynamically required by the adapter for the queue side;
  // we still need a Worker on the consumer side. Pull the same module
  // via dynamic import so the package is only loaded when the adapter
  // is bullmq.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bullmq = (await import('bullmq')).default ?? (await import('bullmq'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = (await import('ioredis')).default ?? (await import('ioredis'));
  const url = process.env.CONTENT_SCHEDULER_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new bullmq.Worker(
    'content-scheduler-auto-post',
    async (job: any) => {
      const payload = {
        itemId: String(job.data.itemId),
        scheduledFor: new Date(job.data.scheduledFor),
        scheduleVersion: Number(job.data.scheduleVersion)
      };
      const outcome = await processAutoPostJob(payload);
      // eslint-disable-next-line no-console
      console.log(`[content-scheduler-worker] job itemId=${payload.itemId} v${payload.scheduleVersion} -> ${outcome}`);
      return { outcome };
    },
    { connection, attempts: 1 }
  );
  worker.on('failed', (job: any, err: any) => {
    // eslint-disable-next-line no-console
    console.warn(`[content-scheduler-worker] job failed itemId=${job?.data?.itemId} error=${err?.message ?? String(err)}`);
  });
  worker.on('error', (err: any) => {
    // eslint-disable-next-line no-console
    console.error(`[content-scheduler-worker] worker error ${err?.message ?? String(err)}`);
  });
  // Close the worker on adapter close so the long-lived Redis connection
  // does not leak.
  const originalClose = adapter.close?.bind(adapter);
  if (originalClose) {
    adapter.close = async () => {
      await worker.close();
      await originalClose();
    };
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[content-scheduler-worker] fatal', err);
  process.exit(1);
});
