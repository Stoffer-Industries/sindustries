// Content Scheduler — auto-post startup reconciliation.
//
// On worker startup, the database is the source of truth for which
// approved items need auto-posting. The queue may have lost entries
// during a Redis crash, a worker restart, or any network blip. This
// module re-enqueues approved items whose schedule is still in the
// future, publishes overdue items immediately (deterministic — the
// publish path is the same `publishContentSchedulerItem` the manual
// route uses), and returns a structured outcome the entrypoint can log
// and the diagnostics endpoint can return.
//
// Reconcile outcomes (per item):
//   - re-enqueued:    approved item with future scheduledFor, queue had
//                     no live job; a fresh job was added and the item
//                     bookkeeping updated. autoPostScheduleVersion bumps
//                     so any stale delayed job (if cancellation failed)
//                     becomes a no-op via the worker check.
//   - overdue-published: approved item whose scheduledFor is in the
//                     past. The worker calls the shared publish service
//                     so the item either publishes or writes a
//                     publishError without re-scheduling.
//   - overdue-capped: like `overdue-published` but the daily cap blocks
//                     the publish. The item stays approved so Tom can
//                     decide; no reschedule.
//   - already-published: terminal state — nothing to do.
//   - scheduled-active: approved item with a queue job that still
//                     exists. No-op (the worker will pick it up).
//   - stale-job: approved item whose autoPostJobId no longer exists in
//                     the queue. Reschedule if its `scheduledFor` is
//                     still in the future; otherwise treat as overdue.
//   - skipped: cancelled, terminal, or non-approved; no automation.
//
// Reconciliation is idempotent so it can run on every worker boot
// without producing duplicate publishes (the publish path is idempotent
// for already-published items, and the scheduleVersion bump + dedup
// jobId prevent duplicates from the queue side).
//
// See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md.

import { prisma } from '../lib/prisma.ts';
import {
  decideAutoPostAction,
  getJobSchedulerAdapter
} from './contentSchedulerJobs.ts';
import type { JobSchedulerAdapter } from './contentSchedulerJobs.ts';
import { publishContentSchedulerItem } from './contentSchedulerPublishService.ts';

export type ReconcileOutcome =
  | 're-enqueued'
  | 'overdue-published'
  | 'overdue-capped'
  | 'overdue-publish-failed'
  | 'already-published'
  | 'scheduled-active'
  | 'stale-job'
  | 'skipped';

export type ReconcileReport = {
  scanned: number;
  reEnqueued: number;
  overduePublished: number;
  overduePublishFailed: number;
  alreadyPublished: number;
  scheduledActive: number;
  staleJob: number;
  skipped: number;
  startedAt: Date;
  finishedAt: Date;
  /** Per-item traces for the diagnostics endpoint. */
  perItem: Array<{
    itemId: string;
    outcome: ReconcileOutcome;
    scheduledFor: Date | null;
    jobId: string | null;
    publishError: string | null;
  }>;
};

export type ReconcileDeps = {
  /** Override the clock for tests. */
  now?: () => Date;
  /** Override the adapter to read job state from a fake. */
  adapter?: JobSchedulerAdapter;
  /**
   * Optional cap on how many items to process per sweep. Defaults to
   * `Infinity`; the operator can set a small value through the
   * diagnostic endpoint to pace reconciliation if the queue is very
   * large.
   */
  limit?: number;
  /**
   * Optional bounded fetch size for the initial scan. Defaults to 500.
   * `reconcileAutoPostItems` pages through with this batch size so a
   * huge backlog does not pin the worker boot.
   */
  batchSize?: number;
};

const DEFAULT_BATCH_SIZE = 500;

/**
 * Sweep the database for approved items that need auto-posting and
 * reconcile each against the live queue state. Safe to call on every
 * worker boot. Returns a structured report.
 */
export async function reconcileAutoPostItems(
  deps: ReconcileDeps = {}
): Promise<ReconcileReport> {
  const startedAt = deps.now ? deps.now() : new Date();
  const adapter = deps.adapter ?? getJobSchedulerAdapter();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const limit = deps.limit ?? Infinity;

  const report: ReconcileReport = {
    scanned: 0,
    reEnqueued: 0,
    overduePublished: 0,
    overduePublishFailed: 0,
    alreadyPublished: 0,
    scheduledActive: 0,
    staleJob: 0,
    skipped: 0,
    startedAt,
    finishedAt: startedAt,
    perItem: []
  };

  // We only care about approved items that have a scheduledFor. The
  // queue itself does not need to track unscheduled items; the
  // approve/patch/remove routes manage that explicitly.
  //
  // Cursor is a composite (scheduledFor, id) pair. A bare `scheduledFor`
  // cursor with `gt: cursor` skips items that share `scheduledFor` with
  // the last row of the previous batch — because reconciliation only
  // runs on worker boot, a missed item stays missed until the next boot.
  // Adding `id` as a tiebreaker makes the ordering deterministic so the
  // next page picks up exactly where the previous one left off.
  let cursor: { scheduledFor: Date; id: string } | null = null;
  let processed = 0;
  // Treat the sweep as a snapshot loop. We stop when either the page
  // returns 0 rows or we hit the caller-supplied limit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const items = await prisma.contentSchedulerItem.findMany({
      where: {
        status: 'approved',
        scheduledFor: { not: null },
        ...(cursor
          ? {
              OR: [
                { scheduledFor: { gt: cursor.scheduledFor } },
                {
                  scheduledFor: cursor.scheduledFor,
                  id: { gt: cursor.id }
                }
              ]
            }
          : {})
      },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: Math.min(batchSize, limit - processed)
    });
    if (items.length === 0) break;

    for (const item of items) {
      if (processed >= limit) break;
      processed += 1;
      report.scanned += 1;
      cursor = { scheduledFor: item.scheduledFor as Date, id: item.id };

      const outcome = await reconcileOne(item, adapter, startedAt);
      report.perItem.push({
        itemId: item.id,
        outcome: outcome.outcome,
        scheduledFor: item.scheduledFor,
        jobId: outcome.autoPostJobId,
        publishError: outcome.publishError
      });
      switch (outcome.outcome) {
        case 're-enqueued':
          report.reEnqueued += 1;
          break;
        case 'overdue-published':
          report.overduePublished += 1;
          break;
        case 'overdue-publish-failed':
        case 'overdue-capped':
          report.overduePublishFailed += 1;
          break;
        case 'already-published':
          report.alreadyPublished += 1;
          break;
        case 'scheduled-active':
          report.scheduledActive += 1;
          break;
        case 'stale-job':
          report.staleJob += 1;
          break;
        case 'skipped':
          report.skipped += 1;
          break;
      }
    }

    if (items.length < batchSize) break;
    if (processed >= limit) break;
  }

  report.finishedAt = deps.now ? deps.now() : new Date();
  return report;
}

type ReconcileOneResult = {
  outcome: ReconcileOutcome;
  autoPostJobId: string | null;
  publishError: string | null;
};

async function reconcileOne(
  item: any,
  adapter: JobSchedulerAdapter,
  now: Date
): Promise<ReconcileOneResult> {
  // Defensive: status could have flipped between the scan and the
  // reconcile. Re-read the freshest row when the outcome matters.
  const fresh = await prisma.contentSchedulerItem.findUnique({ where: { id: item.id } });
  if (!fresh) {
    return { outcome: 'skipped', autoPostJobId: null, publishError: null };
  }
  if (fresh.status === 'published' || fresh.status === 'removed') {
    return { outcome: 'already-published', autoPostJobId: fresh.autoPostJobId, publishError: null };
  }
  if (fresh.status !== 'approved' || !fresh.scheduledFor) {
    return { outcome: 'skipped', autoPostJobId: fresh.autoPostJobId, publishError: null };
  }

  // Future schedule: check whether the queue still has the job we
  // recorded. If so, leave it alone. If not, re-enqueue.
  if (fresh.scheduledFor.getTime() > now.getTime()) {
    const stillExists = fresh.autoPostJobId ? await hasJob(adapter, fresh.autoPostJobId) : false;
    if (stillExists) {
      return { outcome: 'scheduled-active', autoPostJobId: fresh.autoPostJobId, publishError: null };
    }
    const scheduled = await scheduleApprovedItem(fresh, adapter);
    return { outcome: 're-enqueued', autoPostJobId: scheduled.jobId, publishError: null };
  }

  // Overdue: publish deterministically through the shared service.
  // The service is idempotent for already-published items, so a
  // crash here cannot cause a duplicate X post. The publish path
  // writes `publishError` on failure and leaves status='approved',
  // which means Tom still sees the failure and can re-publish
  // manually.
  const result = await publishContentSchedulerItem(fresh.id, 'auto');
  if (result.ok) {
    return { outcome: 'overdue-published', autoPostJobId: null, publishError: null };
  }
  if (result.code === 'DAY_CAP_REACHED' || result.code === 'SCHEDULED_IN_FUTURE') {
    return { outcome: 'overdue-capped', autoPostJobId: fresh.autoPostJobId, publishError: null };
  }
  return {
    outcome: 'overdue-publish-failed',
    autoPostJobId: fresh.autoPostJobId,
    publishError: result.message ?? result.code
  };
}

/**
 * Re-enqueue an approved item. Bumps the schedule version so any
 * duplicate provider-side job is treated as stale by the worker.
 * Returns the new job id so the caller can update the report.
 */
async function scheduleApprovedItem(
  fresh: { id: string; scheduledFor: Date; autoPostScheduleVersion: number },
  adapter: JobSchedulerAdapter
): Promise<{ jobId: string }> {
  const nextVersion = (fresh.autoPostScheduleVersion ?? 0) + 1;
  const scheduled = await adapter.scheduleAutoPost({
    itemId: fresh.id,
    scheduledFor: fresh.scheduledFor,
    scheduleVersion: nextVersion
  });
  await prisma.contentSchedulerItem.update({
    where: { id: fresh.id },
    data: {
      autoPostJobId: scheduled.jobId,
      autoPostScheduleVersion: nextVersion,
      autoPostScheduledAt: fresh.scheduledFor,
      autoPostLastEnqueuedAt: new Date()
    }
  });
  return scheduled;
}

export async function hasJob(adapter: JobSchedulerAdapter, jobId: string): Promise<boolean> {
  const anyAdapter = adapter as JobSchedulerAdapter & { hasJob?: (id: string) => Promise<boolean> };
  if (typeof anyAdapter.hasJob === 'function') {
    return anyAdapter.hasJob(jobId);
  }
  // Fallback: the in-process adapter exposes `pendingJobs()`. Match the
  // full deterministic jobId (`in-process:<itemId>:<scheduleVersion>`)
  // exactly. Substring matching on `itemId` is wrong because an itemId
  // like `abc` would match `in-process:abc-def:1` even though that
  // refers to a different item.
  const anyAdapterWithPending = adapter as JobSchedulerAdapter & {
    pendingJobs?: () => Array<{ itemId: string; scheduleVersion: number }>;
  };
  if (typeof anyAdapterWithPending.pendingJobs === 'function') {
    return anyAdapterWithPending.pendingJobs().some(
      (j) => j.itemId && jobId === `in-process:${j.itemId}:${j.scheduleVersion}`
    );
  }
  return true;
}

/**
 * Convenience: decide whether a single item needs attention. Pure-ish
 * helper used by the diagnostics endpoint to report per-item status
 * without mutating the queue. The full `reconcileAutoPostItems` is
 * what actually touches the queue.
 */
export function describeItemForReconcile(
  item: {
    status: string;
    scheduledFor: Date | null;
    autoPostJobId: string | null;
  },
  now: Date = new Date()
): {
  needsReconcile: boolean;
  reason: 'overdue' | 'job-missing' | 'scheduled' | 'terminal' | 'non-approved';
} {
  if (item.status === 'published' || item.status === 'removed') return { needsReconcile: false, reason: 'terminal' };
  if (item.status !== 'approved') return { needsReconcile: false, reason: 'non-approved' };
  if (!item.scheduledFor) return { needsReconcile: false, reason: 'non-approved' };
  if (item.scheduledFor.getTime() <= now.getTime()) return { needsReconcile: true, reason: 'overdue' };
  if (!item.autoPostJobId) return { needsReconcile: true, reason: 'job-missing' };
  return { needsReconcile: false, reason: 'scheduled' };
}

void decideAutoPostAction; // re-exported tree shaker; not used directly here
