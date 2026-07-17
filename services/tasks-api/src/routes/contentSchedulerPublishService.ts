// Content Scheduler — shared publish service.
//
// The single write path used by both the manual `POST /items/:id/publish`
// route and the auto-post worker. Keeps the guard, X client call, and
// status/error persistence in one place so manual and auto paths cannot
// drift.
//
// Returns a structured result code that the route layer maps to HTTP
// responses; the worker treats any non-OK result as a soft failure (write
// `publishError`, leave `status='approved'`, no retry).
//
// See docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md.

import { prisma } from '../lib/prisma.ts';
import {
  guardPublish,
  getAucklandTodayParts,
  getXClient,
  type XClient
} from './contentSchedulerPublish.ts';

export type PublishServiceCode =
  | 'OK'
  | 'NOT_FOUND'
  | 'NOT_APPROVED'
  | 'ALREADY_PUBLISHED'
  | 'DAY_CAP_REACHED'
  | 'SCHEDULED_IN_FUTURE'
  | 'MISSING_CREDENTIALS'
  | 'PUBLISH_FAILED';

export type PublishServiceResult =
  | { ok: true; code: 'OK'; item: Awaited<ReturnType<typeof loadItem>>; publishedUrl: string; publishedAt: Date }
  | { ok: false; code: Exclude<PublishServiceCode, 'OK'>; message: string };

export type PublishActor = 'manual' | 'auto';

async function loadItem(itemId: string) {
  return prisma.contentSchedulerItem.findUnique({ where: { id: itemId } });
}

async function loadToday(itemId: string) {
  const { startUtc, endUtc } = getAucklandTodayParts();
  const todays = await prisma.contentSchedulerItem.findMany({
    where: {
      status: 'published',
      publishedAt: { gte: startUtc, lt: endUtc }
    },
    select: { id: true }
  });
  const publishedCount = todays.length;
  // If today's published item is the one we're publishing, that is not a
  // cap violation (it's the same item being re-published, e.g. retry). The
  // guard handles this via the publishedItemId check.
  const publishedItemId = publishedCount > 0 ? todays[0].id : null;
  return { publishedCount, publishedItemId };
}

export type PublishServiceDeps = {
  client?: XClient | null;
  now?: () => Date;
};

/**
 * Publish (or re-publish on retry) the given item. Returns a structured
 * result that the caller can map to HTTP status or log. On failure the
 * item's `publishError` is written and `status` remains `approved` (or
 * the existing terminal status, which the caller can interpret).
 *
 * This function is intentionally idempotent for the `OK` case: if the
 * item is already `published` with the same body, it returns OK without
 * re-posting to X. That makes the worker safe to re-run after a queue
 * delivery retry without producing duplicate tweets.
 */
export async function publishContentSchedulerItem(
  itemId: string,
  actor: PublishActor,
  deps: PublishServiceDeps = {}
): Promise<PublishServiceResult> {
  const item = await loadItem(itemId);
  if (!item) {
    return { ok: false, code: 'NOT_FOUND', message: `Item ${itemId} not found` };
  }

  // If already published, no-op. The worker's stale-job path and the
  // manual route's idempotent retry both rely on this.
  if (item.status === 'published') {
    return {
      ok: true,
      code: 'OK',
      item,
      publishedUrl: item.publishedUrl ?? '',
      publishedAt: item.publishedAt ?? new Date()
    };
  }

  // Refuse non-approved / terminal states cleanly (AC3).
  if (item.status === 'removed') {
    return { ok: false, code: 'NOT_FOUND', message: 'Item has been removed' };
  }
  if (item.status !== 'approved') {
    return { ok: false, code: 'NOT_APPROVED', message: `Item status is ${item.status}` };
  }

  // Daily cap + schedule grace checks.
  const today = await loadToday(itemId);
  const now = deps.now ? deps.now() : new Date();
  const guard = guardPublish(item, today, now);
  if (!guard.ok) {
    // ALREADY_PUBLISHED and DAY_CAP_REACHED: leave status, write no error.
    // SCHEDULED_IN_FUTURE: same.
    return { ok: false, code: guard.code, message: `Publish refused: ${guard.code}` };
  }

  // Resolve X client.
  const client = deps.client !== undefined ? deps.client : getXClient();
  if (!client) {
    const updated = await prisma.contentSchedulerItem.update({
      where: { id: itemId },
      data: { publishError: 'X credentials are not configured' }
    });
    return { ok: false, code: 'MISSING_CREDENTIALS', message: 'X credentials are not configured', ...{ item: updated } } as PublishServiceResult;
  }

  // Post to X.
  let result: { url: string; postedAt: Date };
  try {
    result = await client.createTweet({ text: item.body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await prisma.contentSchedulerItem.update({
      where: { id: itemId },
      data: { publishError: message }
    });
    return { ok: false, code: 'PUBLISH_FAILED', message, ...{ item: updated } } as PublishServiceResult;
  }

  // Persist the published state. Clear `publishError` on success.
  const updated = await prisma.contentSchedulerItem.update({
    where: { id: itemId },
    data: {
      status: 'published',
      publishedAt: result.postedAt,
      publishedUrl: result.url,
      publishError: null
    }
  });

  return {
    ok: true,
    code: 'OK',
    item: updated,
    publishedUrl: result.url,
    publishedAt: result.postedAt
  };
}
