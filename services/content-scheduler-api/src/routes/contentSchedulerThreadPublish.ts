// Content Scheduler — thread publish orchestrator (task 1016cbff).
//
// The aggregate-aware publish path for `kind === 'thread'` items. A
// thread is posted as a root tweet (position 0, item.body) followed by
// reply positions 1..n (ContentSchedulerThreadPart rows), each chained
// via `in_reply_to_tweet_id` to the immediately-preceding part's tweet
// id. Each successful create is persisted in the
// ContentSchedulerPublishAttempt journal before the next part is
// posted, so a partial failure can be compensated by reverse-order
// deletion and a cleanup failure can preserve the possibly-live URLs
// without risking duplicate posts on retry.
//
// See docs/specs/content-scheduler-tweet-threads-2026-08-20-tech-design.md
// (Publishing flow / Failure compensation and retry / Atomicity
// limitation) for the full design — including the unavoidable crash
// window after X accepts a tweet but before the local journal
// persistence, which is why the state machine has a `cleanup_required`
// terminal.
//
// The single-tweet publish path is intentionally untouched — see
// contentSchedulerPublishService.ts. Threads go through this module
// exclusively; the route layer dispatches by `kind`.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.ts';
import type { XClient } from './contentSchedulerPublish.ts';

export type ThreadPublishCode =
  | 'OK'
  | 'NOT_FOUND'
  | 'NOT_APPROVED'
  | 'NOT_THREAD'
  | 'NO_PARTS'
  | 'PART_BODY_INVALID'
  | 'PUBLISH_IN_PROGRESS'
  | 'MISSING_CREDENTIALS'
  | 'PUBLISH_FAILED'
  | 'CLEANUP_REQUIRED';

export type ThreadPublishActor = 'manual' | 'auto';

export type ThreadPublishResult =
  | {
      ok: true;
      code: 'OK';
      itemId: string;
      attemptId: string;
      publishedUrl: string;
      publishedAt: Date;
    }
  | {
      ok: false;
      code: Exclude<ThreadPublishCode, 'OK'>;
      message: string;
      attemptId?: string;
      failedAtPosition?: number;
      /**
       * For `CLEANUP_REQUIRED`: tweets that X refused to delete, retained
       * so the user can see the possibly-live URLs and retry. Empty for
       * `rolled_back` outcomes (all tweets deleted cleanly).
       */
      undeletedTweets?: Array<{
        position: number;
        tweetId: string;
        url: string;
        deleteError: string;
      }>;
    };

export type ThreadPublishDeps = {
  client?: XClient | null;
  now?: () => Date;
  /** Override prisma (test seam). */
  prismaOverride?: PrismaClient;
};

// Lower bound for a thread (1 root + 1 reply = 2 normalised parts).
// The tech design specifies 2..7; the upper bound is enforced by the
// create/update route validation, not here.
const MIN_THREAD_PARTS = 2;

// Maximum X text length. The route-level validation already enforces
// this on the way in; we re-check here defensively in case the
// orchestrator is called from a code path that bypasses the route.
const MAX_PART_LENGTH = 280;

type LoadedItem = NonNullable<
  Awaited<ReturnType<PrismaClient['contentSchedulerItem']['findUnique']>>
> & {
  parts: Array<{ id: string; position: number; body: string }>;
  publishAttempts: Array<{ id: string }>;
};

async function loadItemWithParts(itemId: string, db: PrismaClient): Promise<LoadedItem | null> {
  const item = await db.contentSchedulerItem.findUnique({
    where: { id: itemId },
    include: {
      parts: { orderBy: { position: 'asc' } },
      publishAttempts: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true } }
    }
  });
  return item as unknown as LoadedItem | null;
}

/**
 * Build the ordered list of parts for publish. Position 0 is the
 * aggregate body (the root tweet); positions 1..n are the child rows.
 *
 * Validates the contiguous, no-gap invariant the tech design requires
 * (parts[0..n-1].position must equal its index) and rejects empty or
 * over-long bodies.
 */
function normaliseParts(
  item: Pick<LoadedItem, 'body' | 'parts'>
):
  | { ok: true; parts: Array<{ position: number; body: string }> }
  | { ok: false; code: 'NO_PARTS' | 'PART_BODY_INVALID'; message: string } {
  const normalised: Array<{ position: number; body: string }> = [
    { position: 0, body: item.body }
  ];
  for (const part of item.parts) {
    normalised.push({ position: part.position, body: part.body });
  }
  // Reject empty/over-long bodies before we touch X.
  for (const p of normalised) {
    const body = p.body ?? '';
    if (body.length === 0 || body.length > MAX_PART_LENGTH) {
      return {
        ok: false,
        code: 'PART_BODY_INVALID',
        message: `Part ${p.position} body length ${body.length} is outside the 1..${MAX_PART_LENGTH} range`
      };
    }
  }
  // Contiguity check: positions must be 0,1,2,...,n-1 with no gaps and
  // no duplicates. The schema's @@unique([itemId, position]) catches
  // duplicates at write time; this guards the gap case.
  for (let i = 0; i < normalised.length; i++) {
    if (normalised[i].position !== i) {
      return {
        ok: false,
        code: 'PART_BODY_INVALID',
        message: `Part at index ${i} has position ${normalised[i].position}; thread parts must be contiguous starting at 0`
      };
    }
  }
  if (normalised.length < MIN_THREAD_PARTS) {
    return {
      ok: false,
      code: 'NO_PARTS',
      message: `Thread has ${normalised.length} normalised parts; minimum is ${MIN_THREAD_PARTS}`
    };
  }
  return { ok: true, parts: normalised };
}

/**
 * Atomically claim the item for publish. Uses a conditional update so
 * concurrent callers (manual click + auto-post worker firing at the
 * same minute) cannot both transition the item out of `approved`.
 * Returns the new attempt id, or null if the item is no longer in a
 * claimable state.
 */
async function claimItem(
  itemId: string,
  db: PrismaClient,
  now: Date
): Promise<{ attemptId: string } | null> {
  // Conditional update: only the caller that wins the
  // approved -> publishing transition creates an attempt. Other callers
  // see 0 rows updated and bail with PUBLISH_IN_PROGRESS at the route
  // level.
  const claimed = await db.contentSchedulerItem.updateMany({
    where: { id: itemId, status: 'approved' },
    data: { status: 'publishing' }
  });
  if (claimed.count !== 1) {
    return null;
  }
  const attempt = await db.contentSchedulerPublishAttempt.create({
    data: {
      itemId,
      state: 'publishing',
      startedAt: now
    }
  });
  return { attemptId: attempt.id };
}

/**
 * Post a single part. Wraps the X client call so the orchestrator can
 * persist the result in the attempt journal before returning.
 */
async function postPart(
  client: XClient,
  position: number,
  body: string,
  previousTweetId: string | undefined
): Promise<{ tweetId: string; url: string; postedAt: Date }> {
  const result = await client.createTweet({
    text: body,
    in_reply_to_tweet_id: previousTweetId
  });
  // The fake client doesn't expose the synthetic tweet id — derive a
  // stable id from the URL path so the journal row is still meaningful.
  const tweetId = extractTweetId(result.url) ?? result.url;
  return { tweetId, url: result.url, postedAt: result.postedAt };
}

function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/([^/?#]+)/);
  return match ? match[1] : null;
}

/**
 * Compensation: delete recorded tweets in reverse order and transition
 * the attempt to `rolled_back` (all deletes OK) or `cleanup_required`
 * (any delete failed). The item status mirrors the attempt state:
 *
 *   rolled_back       -> 'approved' (item is retryable)
 *   cleanup_required  -> 'cleanup_required' (manual cleanup + retry)
 *
 * For each undeleted tweet the attempt journal row is updated with
 * `deletedAt = null` (still live) and `deleteError = <message>` so the
 * UI / retry handler can show the live URLs and the underlying reason.
 */
async function compensate(
  attemptId: string,
  itemId: string,
  client: XClient,
  db: PrismaClient,
  failedAtPosition: number,
  originalError: string,
  now: Date
): Promise<{
  state: 'rolled_back' | 'cleanup_required';
  undeletedTweets: Array<{ position: number; tweetId: string; url: string; deleteError: string }>;
}> {
  await db.contentSchedulerPublishAttempt.update({
    where: { id: attemptId },
    data: {
      state: 'rolling_back',
      failedAtPosition,
      error: originalError
    }
  });
  await db.contentSchedulerItem.update({
    where: { id: itemId },
    data: { status: 'cleanup_required', publishError: originalError }
  });

  const recorded = await db.contentSchedulerAttemptTweet.findMany({
    where: { attemptId },
    orderBy: { position: 'desc' }
  });

  const undeleted: Array<{ position: number; tweetId: string; url: string; deleteError: string }> = [];
  for (const row of recorded) {
    try {
      await client.deleteTweet(row.tweetId);
      await db.contentSchedulerAttemptTweet.update({
        where: { id: row.id },
        data: { deletedAt: now }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.contentSchedulerAttemptTweet.update({
        where: { id: row.id },
        data: { deleteError: message }
      });
      undeleted.push({
        position: row.position,
        tweetId: row.tweetId,
        url: row.url,
        deleteError: message
      });
    }
  }

  if (undeleted.length === 0) {
    await db.contentSchedulerPublishAttempt.update({
      where: { id: attemptId },
      data: { state: 'rolled_back', completedAt: now }
    });
    await db.contentSchedulerItem.update({
      where: { id: itemId },
      data: { status: 'approved', publishError: originalError }
    });
    return { state: 'rolled_back', undeletedTweets: [] };
  }

  await db.contentSchedulerPublishAttempt.update({
    where: { id: attemptId },
    data: { state: 'cleanup_required', completedAt: now }
  });
  // Item is already 'cleanup_required' from the rolling_back transition.
  return { state: 'cleanup_required', undeletedTweets: undeleted };
}

/**
 * Publish (or retry) a thread-aggregate item. Returns a structured
 * result the route layer can map to HTTP responses.
 *
 * Idempotent for the `OK` case: a thread with `status = 'published'`
 * returns OK without re-posting.
 */
export async function publishThreadContentSchedulerItem(
  itemId: string,
  actor: ThreadPublishActor,
  deps: ThreadPublishDeps = {}
): Promise<ThreadPublishResult> {
  const db = deps.prismaOverride ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const client = deps.client !== undefined ? deps.client : null;

  const item = await loadItemWithParts(itemId, db);
  if (!item) {
    return { ok: false, code: 'NOT_FOUND', message: `Item ${itemId} not found` };
  }
  if (item.kind !== 'thread') {
    return {
      ok: false,
      code: 'NOT_THREAD',
      message: `Item ${itemId} is kind=${item.kind}, expected 'thread'`
    };
  }
  if (item.status === 'published') {
    const publishedAttemptId = item.publishAttempts[0]?.id ?? '';
    return {
      ok: true,
      code: 'OK',
      itemId,
      attemptId: publishedAttemptId,
      publishedUrl: item.publishedUrl ?? '',
      publishedAt: item.publishedAt ?? now
    };
  }
  if (item.status === 'publishing') {
    return {
      ok: false,
      code: 'PUBLISH_IN_PROGRESS',
      message: `Item ${itemId} is already publishing`
    };
  }
  if (item.status !== 'approved' && item.status !== 'cleanup_required') {
    return {
      ok: false,
      code: 'NOT_APPROVED',
      message: `Item status is ${item.status}`
    };
  }

  const normalised = normaliseParts(item);
  if (normalised.ok === false) {
    return { ok: false, code: normalised.code, message: normalised.message } as ThreadPublishResult;
  }

  if (!client) {
    return {
      ok: false,
      code: 'MISSING_CREDENTIALS',
      message: 'X credentials are not configured'
    };
  }

  // Atomic claim + attempt creation. `cleanup_required` items must not
  // re-enter the publish path until the partial attempts have been
  // cleaned up via the retry handler — see POST /items/:id/retry-publish.
  if (item.status !== 'approved') {
    return {
      ok: false,
      code: 'NOT_APPROVED',
      message: `Cannot start a new publish from status ${item.status}; retry-cleanup first`
    };
  }

  const claim = await claimItem(itemId, db, now);
  if (!claim) {
    return {
      ok: false,
      code: 'PUBLISH_IN_PROGRESS',
      message: `Item ${itemId} is no longer claimable (status changed concurrently)`
    };
  }
  const { attemptId } = claim;

  // Chain posts. Persist each successful create in the attempt journal
  // before attempting the next position. A crash between a tweet being
  // accepted by X and the journal row being committed is the
  // unavoidable window called out in the tech design; compensation handles
  // it on retry by deleting the recorded tweets in reverse order.
  let previousTweetId: string | undefined;
  let postedPosition = -1; // number of parts successfully posted (-1 = none)
  try {
    for (const part of normalised.parts) {
      const result = await postPart(client, part.position, part.body, previousTweetId);
      await db.contentSchedulerAttemptTweet.create({
        data: {
          attemptId,
          position: part.position,
          tweetId: result.tweetId,
          url: result.url,
          postedAt: result.postedAt
        }
      });
      previousTweetId = result.tweetId;
      postedPosition = part.position;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The failing position is the one immediately after the last
    // successfully-posted position. If postedPosition === -1, no part
    // succeeded and the failing position is 0 (the root).
    const failedPosition = postedPosition + 1;
    const compensation = await compensate(
      attemptId,
      itemId,
      client,
      db,
      failedPosition,
      message,
      now
    );
    if (compensation.state === 'cleanup_required') {
      return {
        ok: false,
        code: 'CLEANUP_REQUIRED',
        message,
        attemptId,
        failedAtPosition: failedPosition,
        undeletedTweets: compensation.undeletedTweets
      };
    }
    return {
      ok: false,
      code: 'PUBLISH_FAILED',
      message,
      attemptId,
      failedAtPosition: failedPosition
    };
  }

  // All parts posted. Mark the attempt succeeded and the item published.
  const rootTweet = await db.contentSchedulerAttemptTweet.findUnique({
    where: { attemptId_position: { attemptId, position: 0 } }
  });
  if (!rootTweet) {
    // Should be impossible given the loop above committed position 0.
    return {
      ok: false,
      code: 'PUBLISH_FAILED',
      message: 'Root tweet journal row missing after successful chain',
      attemptId
    };
  }
  await db.contentSchedulerPublishAttempt.update({
    where: { id: attemptId },
    data: { state: 'succeeded', completedAt: now }
  });
  await db.contentSchedulerItem.update({
    where: { id: itemId },
    data: {
      status: 'published',
      publishedAt: now,
      publishedUrl: rootTweet.url,
      publishError: null
    }
  });
  // `actor` is unused for now — reserved for future per-actor
  // instrumentation (manual vs auto-post worker). Acknowledge the
  // parameter so TypeScript doesn't flag it.
  void actor;
  return {
    ok: true,
    code: 'OK',
    itemId,
    attemptId,
    publishedUrl: rootTweet.url,
    publishedAt: now
  };
}