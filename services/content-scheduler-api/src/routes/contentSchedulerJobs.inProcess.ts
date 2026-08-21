// Content Scheduler — in-process JobSchedulerAdapter.
//
// The default adapter used by tests and by the API when no Redis-backed
// BullMQ is available. Holds a small in-memory map of scheduled jobs and
// fires them on the requested `scheduledFor` time using a single
// `setTimeout` per job. The worker still runs in a separate process and
// still consumes jobs through the same queue name (`in-process`); for the
// in-process adapter the queue is the registered callback set, not a
// Redis list. The semantics match BullMQ for the cases that matter:
//   - deterministic job ids (`in-process:<itemId>:<scheduleVersion>`)
//   - replace-on-reschedule (same id cancels the old timer)
//   - graceful shutdown via `close()`
//
// This adapter is NOT a sleep-loop and NOT a cron. It is event-driven
// (timer fires once per job) and survives for the lifetime of the
// process. It exists so tests do not need Redis and so dev can run
// `make up` without docker-compose changes for the queue.

import type {
  ContentSchedulerJob,
  JobSchedulerAdapter,
  ScheduledJob
} from './contentSchedulerJobs.ts';

export type InProcessJobHandler = (job: ContentSchedulerJob) => Promise<void>;

type Entry = {
  job: ContentSchedulerJob;
  handle: NodeJS.Timeout;
  handler: InProcessJobHandler;
};

/**
 * Pure builder. Returns an adapter plus a `setHandler()` so the API or
 * test layer can register what should happen when a delayed job fires.
 * In production the API calls `setHandler` to point at the worker's
 * `processAutoPostJob` function. In tests, the test passes its own
 * recorder.
 */
export function createInProcessJobSchedulerAdapter(): JobSchedulerAdapter & {
  setHandler(handler: InProcessJobHandler): void;
  pendingJobs(): ContentSchedulerJob[];
  fireNow(jobId: string): Promise<void>;
  clearAll(): void;
} {
  const entries = new Map<string, Entry>();
  let handler: InProcessJobHandler | null = null;

  function buildJobId(job: ContentSchedulerJob): string {
    return `in-process:${job.itemId}:${job.scheduleVersion}`;
  }

  function clearTimer(handle: NodeJS.Timeout): void {
    clearTimeout(handle);
  }

  const adapter: JobSchedulerAdapter & {
    setHandler(handler: InProcessJobHandler): void;
    pendingJobs(): ContentSchedulerJob[];
    fireNow(jobId: string): Promise<void>;
    clearAll(): void;
  } = {
    setHandler(next: InProcessJobHandler): void {
      handler = next;
    },

    pendingJobs(): ContentSchedulerJob[] {
      return Array.from(entries.values()).map((e) => e.job);
    },

    async fireNow(jobId: string): Promise<void> {
      const entry = entries.get(jobId);
      if (!entry) return;
      clearTimer(entry.handle);
      entries.delete(jobId);
      if (!handler) {
        throw new Error('in-process adapter fired before a handler was registered');
      }
      await handler(entry.job);
    },

    clearAll(): void {
      for (const entry of entries.values()) clearTimer(entry.handle);
      entries.clear();
    },

    async scheduleAutoPost(job: ContentSchedulerJob): Promise<ScheduledJob> {
      const jobId = buildJobId(job);
      const existing = entries.get(jobId);
      if (existing) clearTimer(existing.handle);

      // Same id, different version means the prior id may still be in
      // entries (because the version is part of the id). The route layer
      // bumps the version on every state change, so prior entries fall
      // out naturally.
      const delayMs = Math.max(0, job.scheduledFor.getTime() - Date.now());
      const handle = setTimeout(() => {
        const current = entries.get(jobId);
        if (!current) return;
        entries.delete(jobId);
        if (!handler) return;
        // Swallow handler errors so an unhandled rejection does not crash
        // the timer; the worker is expected to log and continue.
        Promise.resolve()
          .then(() => handler(current.job))
          .catch(() => {
            /* the handler is expected to log; nothing else to do here */
          });
      }, delayMs);
      // unref() so a pending timer never blocks process exit. Tests that
      // need to wait for a job should use `fireNow()` directly.
      if (typeof (handle as any).unref === 'function') (handle as any).unref();
      entries.set(jobId, { job, handle, handler: handler ?? (async () => {}) });
      return { jobId };
    },

    async cancelAutoPost(jobId: string): Promise<void> {
      const entry = entries.get(jobId);
      if (!entry) return;
      clearTimer(entry.handle);
      entries.delete(jobId);
    },

    async close(): Promise<void> {
      for (const entry of entries.values()) clearTimer(entry.handle);
      entries.clear();
    }
  };

  return adapter;
}
