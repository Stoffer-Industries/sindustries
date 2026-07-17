// Content Scheduler — provider-neutral scheduler adapter.
//
// This module is the only place in the route/publish code that talks to a
// delayed-job queue. The concrete provider (BullMQ + Redis locally, a
// managed queue service in the cloud) is selected at process boot by
// `setJobSchedulerAdapter()` in the API entrypoint and the rest of the
// codebase only sees the `JobSchedulerAdapter` interface below.
//
// The adapter is responsible for:
//   - `scheduleAutoPost` — enqueue (or replace) a delayed job that fires
//     `processAutoPostJob` for the given `itemId` at `scheduledFor`.
//   - `cancelAutoPost`  — best-effort cancellation; called when the item is
//     unapproved, removed, manually published, or has its `scheduledFor`
//     changed.
//
// The adapter does NOT decide what to publish or call the X client. The
// worker process consumes the queue and calls the shared publish service.
//
// See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md.

import type { ContentSchedulerItem } from '../../generated/prisma/index.js';

/**
 * A single delayed auto-post job. Carries the minimum payload needed for
 * the worker to load the latest item state and reconcile against the
 * stored `autoPostScheduleVersion`.
 */
export type ContentSchedulerJob = {
  itemId: string;
  scheduledFor: Date;
  scheduleVersion: number;
};

/**
 * Result of a successful enqueue. The provider-specific job id is stored on
 * the item so cancellation and debugging can target the right job.
 */
export type ScheduledJob = { jobId: string };

/**
 * Provider-neutral delayed-job adapter. Concrete implementations live in
 * `contentSchedulerJobs.bullmq.ts` (production) and
 * `contentSchedulerJobs.inProcess.ts` (tests / fallback when no Redis).
 */
export interface JobSchedulerAdapter {
  /**
   * Enqueue (or replace) the auto-post job for an approved item. Returns the
   * provider's job id so the route layer can store it on the item.
   *
   * Implementations must be idempotent for a given (itemId, scheduleVersion):
   * repeated calls with the same version replace rather than duplicate the
   * job. The worker uses `scheduleVersion` as a defense-in-depth check
   * against stale jobs in case cancellation fails.
   */
  scheduleAutoPost(job: ContentSchedulerJob): Promise<ScheduledJob>;

  /**
   * Best-effort cancellation. If the job is already running or already
   * complete, this is a no-op. Cancellation is also a no-op if the adapter
   * does not support it.
   */
  cancelAutoPost(jobId: string): Promise<void>;

  /**
   * Optional: close any underlying client/queue. Called on graceful
   * shutdown of the API process. Adapters that do not hold open
   * resources can no-op.
   */
  close?(): Promise<void>;
}

/**
 * Decision that the route layer asks the adapter to apply. Encapsulates
 * the "what to do next" call so the route logic stays declarative and so
 * the BullMQ + in-process adapters can keep the same call shape.
 */
export type AutoPostScheduleAction =
  | { kind: 'schedule'; job: ContentSchedulerJob }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'noop' };

/**
 * Compute the schedule action for an item given the prior and new state.
 * Pure function so the route can call it without holding an adapter
 * instance and so the test layer can assert the decision without touching
 * the queue provider.
 *
 * Rules:
 *  - Terminal states (`published`, `removed`) cancel any prior job and
 *    bump the version.
 *  - Non-approved states cancel any prior job.
 *  - Approved with no `scheduledFor` cancels any prior job.
 *  - Approved with `scheduledFor` schedules a new job (or replaces the
 *    existing one) with `scheduleVersion = priorVersion + 1`. The worker
 *    uses the version to detect stale jobs.
 */
export function decideAutoPostAction(args: {
  prior:
    | Pick<ContentSchedulerItem, 'id' | 'status' | 'scheduledFor' | 'autoPostJobId' | 'autoPostScheduleVersion'>
    | null;
  next: { status: ContentSchedulerItem['status']; scheduledFor: Date | null };
  now?: Date;
}): AutoPostScheduleAction {
  const prior = args.prior;
  const priorVersion = prior?.autoPostScheduleVersion ?? 0;

  // Terminal states — no auto-post.
  if (args.next.status === 'published' || args.next.status === 'removed') {
    if (prior?.autoPostJobId) {
      return { kind: 'cancel', jobId: prior.autoPostJobId };
    }
    return { kind: 'noop' };
  }

  // Non-approved, non-terminal — cancel any prior job.
  if (args.next.status !== 'approved') {
    if (prior?.autoPostJobId) {
      return { kind: 'cancel', jobId: prior.autoPostJobId };
    }
    return { kind: 'noop' };
  }

  // Approved but no schedule — cancel prior job, no new job.
  if (!args.next.scheduledFor) {
    if (prior?.autoPostJobId) {
      return { kind: 'cancel', jobId: prior.autoPostJobId };
    }
    return { kind: 'noop' };
  }

  // Approved with schedule. If the schedule has not moved and we already
  // have a job, this is a no-op.
  if (
    prior &&
    prior.status === 'approved' &&
    prior.scheduledFor &&
    prior.scheduledFor.getTime() === args.next.scheduledFor.getTime() &&
    prior.autoPostJobId &&
    priorVersion > 0
  ) {
    return { kind: 'noop' };
  }

  // Otherwise, schedule (or replace) the job with version+1 so any
  // already-delayed prior job becomes stale.
  const nextVersion = priorVersion + 1;
  return {
    kind: 'schedule',
    job: {
      itemId: prior?.id ?? 'pending',
      scheduledFor: args.next.scheduledFor,
      scheduleVersion: nextVersion
    }
  };
}

// --- Adapter registration -------------------------------------------------

let _adapter: JobSchedulerAdapter | null = null;
let _adapterKind: 'in-process' | 'bullmq' | null = null;

/**
 * Register the adapter to use for the rest of the process lifetime. The
 * API entrypoint calls this once at boot based on
 * `CONTENT_SCHEDULER_JOB_ADAPTER` env. Tests call it with a fake.
 */
export function setJobSchedulerAdapter(adapter: JobSchedulerAdapter, kind: 'in-process' | 'bullmq' = 'in-process'): void {
  _adapter = adapter;
  _adapterKind = kind;
}

/**
 * Returns the registered adapter. Throws when no adapter is registered —
 * the API entrypoint is responsible for installing one before any route
 * code runs.
 */
export function getJobSchedulerAdapter(): JobSchedulerAdapter {
  if (!_adapter) {
    throw new Error(
      'No JobSchedulerAdapter registered. The API entrypoint must call ' +
        'setJobSchedulerAdapter() at process boot. For tests, install a ' +
        'fake via setJobSchedulerAdapter() in your test setup.'
    );
  }
  return _adapter;
}

export function getJobSchedulerAdapterKind(): 'in-process' | 'bullmq' | null {
  return _adapterKind;
}

export function __resetJobSchedulerAdapterForTests(): void {
  _adapter = null;
  _adapterKind = null;
}
