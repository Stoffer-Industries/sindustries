// Content Scheduler — auto-post worker.
//
// `processAutoPostJob` is the single function that runs when a delayed
// auto-post job fires. It is the in-process job handler registered with
// whichever JobSchedulerAdapter is active (BullMQ or in-process).
//
// The worker is responsible for:
//   - Reconciling against the current item state (AC3 stale-job safety).
//   - Rescheduling if the queue fired before `scheduledFor` (clock skew).
//   - Calling the shared publish service (AC1, AC4).
//   - Logging structured outcomes for observability.
//
// See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md.

import { prisma } from '../lib/prisma.ts';
import type { ContentSchedulerJob } from '../routes/contentSchedulerJobs.ts';
import {
  decideAutoPostAction,
  getJobSchedulerAdapter
} from '../routes/contentSchedulerJobs.ts';
import { publishContentSchedulerItem } from '../routes/contentSchedulerPublishService.ts';

export type AutoPostJobOutcome =
  | 'published'
  | 'rejected-not-approved'
  | 'rejected-not-found'
  | 'rejected-removed'
  | 'rejected-already-published'
  | 'rejected-stale-version'
  | 'rejected-future-schedule'
  | 'rejected-day-cap'
  | 'rescheduled-early-fire'
  | 'failed-missing-credentials'
  | 'failed-publish-error';

/**
 * Process a single auto-post job. Designed to be called from the
 * registered job handler of the active JobSchedulerAdapter. Returns the
 * outcome so the worker entrypoint (and tests) can log/assert.
 *
 * Throws only on programming errors (DB unreachable, etc.). All known
 * domain reasons for a job to exit without publishing are mapped to a
 * distinct outcome string and returned as a normal value so the queue
 * provider can ack the job without retry.
 */
export async function processAutoPostJob(
  job: ContentSchedulerJob,
  deps: { now?: () => Date; adapterFactory?: () => ReturnType<typeof getJobSchedulerAdapter> } = {}
): Promise<AutoPostJobOutcome> {
  const now = deps.now ? deps.now() : new Date();

  const item = await prisma.contentSchedulerItem.findUnique({ where: { id: job.itemId } });

  if (!item) {
    return 'rejected-not-found';
  }
  if (item.status === 'removed') {
    return 'rejected-removed';
  }
  if (item.status === 'published') {
    return 'rejected-already-published';
  }

  // Stale-version defense. If the item's current autoPostScheduleVersion
  // is greater than the job's version, the schedule has changed since
  // this job was enqueued. Cancel any prior job and exit.
  if (item.autoPostScheduleVersion > job.scheduleVersion) {
    return 'rejected-stale-version';
  }

  // Clock-skew guard: if the job fired before scheduledFor, reschedule
  // for the remaining delay and exit this run.
  if (item.scheduledFor && item.scheduledFor.getTime() > now.getTime() + 1000) {
    const adapter = deps.adapterFactory ? deps.adapterFactory() : getJobSchedulerAdapter();
    const decision = decideAutoPostAction({
      prior: {
        id: item.id,
        status: item.status,
        scheduledFor: item.scheduledFor,
        autoPostJobId: item.autoPostJobId,
        autoPostScheduleVersion: item.autoPostScheduleVersion
      },
      next: { status: item.status, scheduledFor: item.scheduledFor },
      now
    });
    if (decision.kind === 'schedule') {
      const replacement = await adapter.scheduleAutoPost({
        itemId: item.id,
        scheduledFor: item.scheduledFor,
        scheduleVersion: item.autoPostScheduleVersion + 1
      });
      await prisma.contentSchedulerItem.update({
        where: { id: item.id },
        data: {
          autoPostJobId: replacement.jobId,
          autoPostScheduleVersion: item.autoPostScheduleVersion + 1,
          autoPostScheduledAt: item.scheduledFor,
          autoPostLastEnqueuedAt: new Date()
        }
      });
    }
    return 'rescheduled-early-fire';
  }

  // Call the shared publish service.
  const result = await publishContentSchedulerItem(item.id, 'auto');

  if (result.ok) {
    // On success, clear the job id (so a future schedule change does not
    // try to cancel a published item) and bump the version.
    await prisma.contentSchedulerItem.update({
      where: { id: item.id },
      data: {
        autoPostJobId: null,
        autoPostScheduleVersion: item.autoPostScheduleVersion + 1,
        autoPostLastEnqueuedAt: new Date()
      }
    });
    return 'published';
  }

  switch (result.code) {
    case 'NOT_FOUND':
    case 'NOT_APPROVED':
    case 'ALREADY_PUBLISHED':
      return `rejected-${result.code.toLowerCase().replaceAll('_', '-')}` as AutoPostJobOutcome;
    case 'DAY_CAP_REACHED':
      return 'rejected-day-cap';
    case 'SCHEDULED_IN_FUTURE':
      return 'rejected-future-schedule';
    case 'MISSING_CREDENTIALS':
      return 'failed-missing-credentials';
    case 'PUBLISH_FAILED':
      return 'failed-publish-error';
    default:
      return 'failed-publish-error';
  }
}
