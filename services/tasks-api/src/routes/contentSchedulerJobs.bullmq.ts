// Content Scheduler — BullMQ-backed JobSchedulerAdapter (production).
//
// v1 ships with the in-process adapter (`contentSchedulerJobs.inProcess.ts`)
// because the dev environment does not require Redis and the test surface
// stays free of external dependencies. Production should switch to this
// BullMQ adapter so delayed jobs survive API process restarts and can be
// swapped for a managed queue service later without touching the route or
// publish code.
//
// To enable:
//   1. Add `bullmq` and `ioredis` to services/tasks-api dependencies:
//        npm install bullmq ioredis
//   2. Set CONTENT_SCHEDULER_REDIS_URL (or REDIS_URL) in the API and
//      worker environments.
//   3. Set CONTENT_SCHEDULER_JOB_ADAPTER=bullmq in the API and worker
//      environments; the API entrypoint should detect this and call
//      `setJobSchedulerAdapter(createBullMqJobSchedulerAdapter(), 'bullmq')`
//      at boot.
//   4. Run the worker entrypoint (`content-scheduler:worker` script) and
//      any additional worker replicas against the same Redis.
//
// This file is intentionally not imported by the default code path so the
// `bullmq` package is only required when the production adapter is wired
// up. The import is dynamic so the bundle / test run does not pay the
// cost of loading BullMQ when the in-process adapter is selected.

import type {
  ContentSchedulerJob,
  JobSchedulerAdapter,
  ScheduledJob
} from './contentSchedulerJobs.ts';

const QUEUE_NAME = 'content-scheduler-auto-post';
const JOB_PREFIX = 'content-scheduler-auto-post:';

export type BullMqJobSchedulerAdapterDeps = {
  bullmq?: any; // BullMQ module (lazy-imported when this adapter is constructed)
  ioredis?: any; // ioredis module (lazy-imported when this adapter is constructed)
  redisUrl?: string;
  handler?: (job: ContentSchedulerJob) => Promise<void>;
};

function buildJobId(job: ContentSchedulerJob): string {
  return `${JOB_PREFIX}${job.itemId}:${job.scheduleVersion}`;
}

export function createBullMqJobSchedulerAdapter(
  deps: BullMqJobSchedulerAdapterDeps = {}
): JobSchedulerAdapter {
  // Dynamic require/import would normally go here. The adapter is a v1
  // placeholder that throws on use so an un-wired BullMQ adapter does not
  // silently enqueue into nowhere. Once `bullmq` and `ioredis` are added
  // to dependencies, replace the throw with:
  //
  //   const bullmq = deps.bullmq ?? (await import('bullmq'));
  //   const IORedis = deps.ioredis ?? (await import('ioredis'));
  //   const connection = new IORedis(deps.redisUrl ?? process.env.CONTENT_SCHEDULER_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379');
  //   const queue = new bullmq.Queue(QUEUE_NAME, { connection });
  //   const worker = new bullmq.Worker(QUEUE_NAME, async (job) => {
  //     if (!deps.handler) throw new Error('BullMQ worker has no handler registered');
  //     await deps.handler({ itemId: job.data.itemId, scheduledFor: new Date(job.data.scheduledFor), scheduleVersion: job.data.scheduleVersion });
  //   }, { connection, attempts: 1 });
  //   ...
  void QUEUE_NAME;
  void buildJobId;
  void deps;
  throw new Error(
    'BullMQ-backed JobSchedulerAdapter is not yet wired. Add `bullmq` and ' +
      '`ioredis` to services/tasks-api dependencies, set ' +
      'CONTENT_SCHEDULER_JOB_ADAPTER=bullmq, and replace this stub with the ' +
      'real adapter (see comment in contentSchedulerJobs.bullmq.ts).'
  );
}
