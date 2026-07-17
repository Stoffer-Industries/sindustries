// Content Scheduler — worker entrypoint.
//
// Boots a long-running process that consumes delayed auto-post jobs from
// the active JobSchedulerAdapter. Both the API process and this worker
// register the same adapter and the same job handler, so the API can
// enqueue and the worker can consume without sharing a runtime.
//
// v1 simplification: this worker uses the in-process adapter (no Redis).
// Production should set CONTENT_SCHEDULER_JOB_ADAPTER=bullmq and run
// Redis-backed BullMQ. The interface is identical so the worker code
// below does not need to change.
//
// Run: `npm run content-scheduler:worker` (in services/tasks-api).

import { createInProcessJobSchedulerAdapter } from './routes/contentSchedulerJobs.inProcess.ts';
import { setJobSchedulerAdapter } from './routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from './routes/autoPostWorker.ts';

async function main() {
  const adapter = createInProcessJobSchedulerAdapter();
  setJobSchedulerAdapter(adapter, 'in-process');
  adapter.setHandler(async (job) => {
    const outcome = await processAutoPostJob(job);
    // eslint-disable-next-line no-console
    console.log(`[content-scheduler-worker] job itemId=${job.itemId} v${job.scheduleVersion} -> ${outcome}`);
  });

  // eslint-disable-next-line no-console
  console.log('[content-scheduler-worker] started (in-process adapter)');

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[content-scheduler-worker] received ${signal}, shutting down`);
    if (adapter.close) await adapter.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[content-scheduler-worker] fatal', err);
  process.exit(1);
});
