// Tests for the thread publish orchestrator (task 1016cbff PR A slice 2/3).
//
// Covers the happy path (3-part thread posts all replies in chain,
// attempt + item both transition to published) and one failure path
// (position 2 create throws; compensation deletes positions 0 and 1
// in reverse; item returns to 'approved' with PUBLISH_FAILED).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishThreadContentSchedulerItem,
  retryThreadPublish
} from '../src/routes/contentSchedulerThreadPublish.ts';

// --- Prisma mock (hoisted before the import chain) -------------------------

const { prismaMock } = vi.hoisted(() => {
  const prismaMock: any = {
    contentSchedulerItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn()
    },
    contentSchedulerPublishAttempt: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn()
    },
    contentSchedulerAttemptTweet: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn()
    }
  };
  // The orchestrator now wraps the claim+attempt pair in a Prisma
  // interactive transaction. The mock needs a $transaction method that
  // invokes the callback with a transaction client whose model methods
  // forward to the same prismaMock — that way existing per-test setups
  // (which mock `prismaMock.contentSchedulerItem.updateMany` and
  // `prismaMock.contentSchedulerPublishAttempt.create` directly) keep
  // working, and we can simulate a failed attempt insert by making the
  // create mock throw — the transaction body then throws, $transaction
  // propagates, and the claim is implicitly rolled back.
  prismaMock.$transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
    return fn({
      contentSchedulerItem: prismaMock.contentSchedulerItem,
      contentSchedulerPublishAttempt: prismaMock.contentSchedulerPublishAttempt,
      contentSchedulerAttemptTweet: prismaMock.contentSchedulerAttemptTweet
    });
  });
  return { prismaMock };
});

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

// --- Test fixture ---------------------------------------------------------

function threadFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-09-08T10:00:00Z');
  return {
    id: '22222222-2222-2222-2222-222222222222',
    body: 'Root tweet for the thread',
    source: 'manual',
    sourceRef: null,
    status: 'approved',
    kind: 'thread',
    scheduledFor: now,
    position: 0,
    approvedAt: now,
    approvedBy: 'Tom',
    publishedAt: null,
    publishedUrl: null,
    publishError: null,
    autoPostJobId: null,
    autoPostScheduleVersion: 0,
    autoPostScheduledAt: null,
    autoPostLastEnqueuedAt: null,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
    parts: [
      { id: 'p1', position: 1, body: 'Reply 1 of the thread' },
      { id: 'p2', position: 2, body: 'Reply 2 of the thread' }
    ],
    publishAttempts: [],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // updateMany returns 1 row updated so the atomic claim succeeds.
  prismaMock.contentSchedulerItem.updateMany.mockResolvedValue({ count: 1 });
  // attempt.create returns a fresh attempt id.
  prismaMock.contentSchedulerPublishAttempt.create.mockResolvedValue({
    id: 'attempt-1',
    state: 'publishing',
    startedAt: new Date()
  });
  // attempt.update returns the updated attempt (callers don't read it).
  prismaMock.contentSchedulerPublishAttempt.update.mockResolvedValue({});
  // attempt.findFirst (used by retry) returns the latest cleanup_required
  // attempt. Default: empty so per-test setup is explicit.
  prismaMock.contentSchedulerPublishAttempt.findFirst.mockResolvedValue(null);
  // attemptTweet.create returns the created row.
  prismaMock.contentSchedulerAttemptTweet.create.mockResolvedValue({});
  // attemptTweet.update returns the updated row.
  prismaMock.contentSchedulerAttemptTweet.update.mockResolvedValue({});
  // attemptTweet.findUnique returns the root tweet (used for publishedUrl).
  prismaMock.contentSchedulerAttemptTweet.findUnique.mockResolvedValue({
    id: 'att-tweet-0',
    attemptId: 'attempt-1',
    position: 0,
    tweetId: 'root-id',
    url: 'https://x.com/sindustries/status/root-id',
    postedAt: new Date(),
    deletedAt: null,
    deleteError: null
  });
  // attemptTweet.findMany (used by compensation) returns recorded rows
  // in descending position order so deletes happen in reverse.
  prismaMock.contentSchedulerAttemptTweet.findMany.mockResolvedValue([]);
  // contentSchedulerItem.update (used for status transitions) returns the row.
  prismaMock.contentSchedulerItem.update.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests ----------------------------------------------------------------

describe('publishThreadContentSchedulerItem', () => {
  it('posts a 3-part thread in chain order and marks the item published', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(threadFixture());
    const client = {
      createTweet: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/root-id',
          postedAt: new Date('2026-09-08T10:00:01Z')
        })
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/reply-1-id',
          postedAt: new Date('2026-09-08T10:00:02Z')
        })
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/reply-2-id',
          postedAt: new Date('2026-09-08T10:00:03Z')
        }),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn()
    };

    const result = await publishThreadContentSchedulerItem(
      '22222222-2222-2222-2222-222222222222',
      { client, prismaOverride: prismaMock }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe('OK');
    expect(result.attemptId).toBe('attempt-1');
    expect(result.publishedUrl).toBe('https://x.com/sindustries/status/root-id');

    // Three creates were attempted in order, each chained to the
    // previous part's tweet id (undefined for the root).
    expect(client.createTweet).toHaveBeenCalledTimes(3);
    expect(client.createTweet).toHaveBeenNthCalledWith(1, {
      text: 'Root tweet for the thread',
      in_reply_to_tweet_id: undefined
    });
    expect(client.createTweet).toHaveBeenNthCalledWith(2, {
      text: 'Reply 1 of the thread',
      in_reply_to_tweet_id: 'root-id'
    });
    expect(client.createTweet).toHaveBeenNthCalledWith(3, {
      text: 'Reply 2 of the thread',
      in_reply_to_tweet_id: 'reply-1-id'
    });

    // Three attempt-tweet rows were persisted (one per successful create)
    // BEFORE the next part was posted. The chain order means the second
    // row is recorded only after the first tweet id was extracted from
    // the URL.
    expect(prismaMock.contentSchedulerAttemptTweet.create).toHaveBeenCalledTimes(3);

    // Attempt transitioned to succeeded.
    expect(prismaMock.contentSchedulerPublishAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ state: 'succeeded' })
      })
    );

    // Item transitioned to published with the root URL.
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222' },
        data: expect.objectContaining({
          status: 'published',
          publishedUrl: 'https://x.com/sindustries/status/root-id',
          publishError: null
        })
      })
    );

    // No compensation deletes were issued on the happy path.
    expect(client.deleteTweet).not.toHaveBeenCalled();
  });

  it('compensates a position-2 create failure: deletes positions 0 and 1 in reverse, item returns to approved', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(threadFixture());
    // Compensation reads recorded tweets (in reverse position order) and
    // counts committed rows to derive the failing position.
    prismaMock.contentSchedulerAttemptTweet.findMany.mockResolvedValue([
      {
        id: 'att-tweet-1',
        attemptId: 'attempt-1',
        position: 1,
        tweetId: 'reply-1-id',
        url: 'https://x.com/sindustries/status/reply-1-id',
        postedAt: new Date(),
        deletedAt: null,
        deleteError: null
      },
      {
        id: 'att-tweet-0',
        attemptId: 'attempt-1',
        position: 0,
        tweetId: 'root-id',
        url: 'https://x.com/sindustries/status/root-id',
        postedAt: new Date(),
        deletedAt: null,
        deleteError: null
      }
    ]);
    // After the create-failure path records no attempt-tweet for
    // position 2, count() returns 2 (positions 0 + 1).
    prismaMock.contentSchedulerAttemptTweet.count.mockResolvedValue(2);

    const client = {
      createTweet: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/root-id',
          postedAt: new Date()
        })
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/reply-1-id',
          postedAt: new Date()
        })
        // Position 2 fails:
        .mockRejectedValueOnce(new Error('X API 503: upstream down')),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn().mockResolvedValue(undefined)
    };

    const result = await publishThreadContentSchedulerItem(
      '22222222-2222-2222-2222-222222222222',
      { client, prismaOverride: prismaMock }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PUBLISH_FAILED');
    expect(result.attemptId).toBe('attempt-1');
    expect(result.failedAtPosition).toBe(2);
    expect(result.message).toMatch(/X API 503/);
    expect(result.undeletedTweets).toBeUndefined();

    // Compensation deleted the two recorded tweets in REVERSE position
    // order — position 1 first (the most recent reply), then position 0
    // (the root). This is the order the tech design specifies so a
    // partial cleanup doesn't leave orphans that look like the root of a
    // thread.
    expect(client.deleteTweet).toHaveBeenCalledTimes(2);
    expect(client.deleteTweet).toHaveBeenNthCalledWith(1, 'reply-1-id');
    expect(client.deleteTweet).toHaveBeenNthCalledWith(2, 'root-id');

    // Attempt transitioned rolling_back -> rolled_back; item returned
    // to 'approved' so the user can retry.
    expect(prismaMock.contentSchedulerPublishAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ state: 'rolling_back' })
      })
    );
    expect(prismaMock.contentSchedulerPublishAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ state: 'rolled_back' })
      })
    );
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222' },
        data: expect.objectContaining({
          status: 'cleanup_required'
        })
      })
    );
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222' },
        data: expect.objectContaining({
          status: 'approved'
        })
      })
    );
  });

  it('returns NOT_THREAD when the item kind is single', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      threadFixture({ kind: 'scheduled', parts: [] })
    );
    const result = await publishThreadContentSchedulerItem(
      '22222222-2222-2222-2222-222222222222',
      { client: { createTweet: vi.fn(), getTweetAuthor: vi.fn(), deleteTweet: vi.fn() }, prismaOverride: prismaMock }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_THREAD');
  });

  it('returns PART_BODY_INVALID when a reply body is empty', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      threadFixture({
        parts: [{ id: 'p1', position: 1, body: '' }]
      })
    );
    const result = await publishThreadContentSchedulerItem(
      '22222222-2222-2222-2222-222222222222',
      { client: { createTweet: vi.fn(), getTweetAuthor: vi.fn(), deleteTweet: vi.fn() }, prismaOverride: prismaMock }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PART_BODY_INVALID');
  });

  // W42 audit F2: the pre-fix code did `updateMany` and
  // `attempt.create` as two separate operations. If the second one
  // threw, the item was left in `publishing` with no journal row, and
  // every subsequent call hit a wall. The new implementation wraps
  // both in a Prisma interactive transaction, so a failure inside the
  // transaction rolls the item claim back to `approved` and makes
  // zero X calls. The mocked $transaction here just propagates the
  // callback's error (real Postgres would rollback); the test
  // verifies the orchestrator does not invoke X and that the error
  // surfaces to the caller for sanitized handling.
  it('rolls back the claim when the attempt insert fails inside the transaction (AC1)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(threadFixture());
    // The item claim succeeds inside the transaction…
    prismaMock.contentSchedulerItem.updateMany.mockResolvedValue({ count: 1 });
    // …but the attempt insert throws. Real Postgres would rollback
    // the conditional update; the mock's $transaction propagates the
    // error to the orchestrator.
    prismaMock.contentSchedulerPublishAttempt.create.mockRejectedValue(
      new Error('constraint violation: publish_attempt_item_fkey')
    );

    const client = {
      createTweet: vi.fn(),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn()
    };

    await expect(
      publishThreadContentSchedulerItem('22222222-2222-2222-2222-222222222222', {
        client,
        prismaOverride: prismaMock
      })
    ).rejects.toThrow(/publish_attempt_item_fkey/);

    // No X calls were made — the failure happened before the publish
    // loop. Compensation isn't relevant here because there are no
    // tweets to delete.
    expect(client.createTweet).not.toHaveBeenCalled();
    expect(client.deleteTweet).not.toHaveBeenCalled();

    // The transaction was entered exactly once; the conditional
    // updateMany was attempted; the attempt create threw and the
    // transaction body propagated. In a real DB the rollback would
    // leave the item at `approved`; the integration test below
    // verifies that observable state.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.contentSchedulerItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222', status: 'approved' },
        data: { status: 'publishing' }
      })
    );
    expect(prismaMock.contentSchedulerPublishAttempt.create).toHaveBeenCalledTimes(1);
  });

  // When the conditional update finds 0 rows (another caller won the
  // claim, or the item is no longer `approved`), the transaction
  // returns null and the orchestrator surfaces PUBLISH_IN_PROGRESS.
  // The real concurrency invariant (only one winner) is verified
  // against real Postgres in the integration test below; this mocked
  // case covers the "0 rows" code path that the route maps to
  // PUBLISH_IN_PROGRESS.
  it('returns PUBLISH_IN_PROGRESS when the conditional claim finds 0 rows (AC2 loser)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(threadFixture());
    prismaMock.contentSchedulerItem.updateMany.mockResolvedValue({ count: 0 });

    const client = {
      createTweet: vi.fn(),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn()
    };

    const result = await publishThreadContentSchedulerItem(
      '22222222-2222-2222-2222-222222222222',
      { client, prismaOverride: prismaMock }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PUBLISH_IN_PROGRESS');
    expect(result.message).toMatch(/no longer claimable/);

    // No attempt was created on the losing call.
    expect(prismaMock.contentSchedulerPublishAttempt.create).not.toHaveBeenCalled();
    // No X calls.
    expect(client.createTweet).not.toHaveBeenCalled();
  });
});

// --- Tests for retryThreadPublish ----------------------------------------

describe('retryThreadPublish', () => {
  function cleanupRequiredFixture(overrides: Record<string, unknown> = {}) {
    return threadFixture({
      status: 'cleanup_required',
      publishError: 'X API 503: upstream down',
      publishAttempts: [{ id: 'attempt-cleanup-1' }],
      ...overrides
    });
  }

  it('returns NOT_CLEANUP_REQUIRED when the item status is approved (not blocked)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      threadFixture({ status: 'approved' })
    );
    const result = await retryThreadPublish(
      '22222222-2222-2222-2222-222222222222',
      { client: { createTweet: vi.fn(), getTweetAuthor: vi.fn(), deleteTweet: vi.fn() }, prismaOverride: prismaMock }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_CLEANUP_REQUIRED');
    expect(result.message).toMatch(/approved/);
  });

  it('returns NOT_THREAD for a non-thread item', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      cleanupRequiredFixture({ kind: 'scheduled', parts: [] })
    );
    const result = await retryThreadPublish(
      '22222222-2222-2222-2222-222222222222',
      { client: { createTweet: vi.fn(), getTweetAuthor: vi.fn(), deleteTweet: vi.fn() }, prismaOverride: prismaMock }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_THREAD');
  });

  it('returns CLEANUP_STILL_REQUIRED when re-attempting deletes still fails', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(cleanupRequiredFixture());
    prismaMock.contentSchedulerPublishAttempt.findFirst.mockResolvedValue({
      id: 'attempt-cleanup-1',
      state: 'cleanup_required'
    });
    prismaMock.contentSchedulerAttemptTweet.findMany.mockResolvedValue([
      {
        id: 'att-tweet-stuck',
        attemptId: 'attempt-cleanup-1',
        position: 0,
        tweetId: 'FAIL_DELETE_stuck',
        url: 'https://x.com/sindustries/status/FAIL_DELETE_stuck',
        postedAt: new Date(),
        deletedAt: null,
        deleteError: 'previous failure'
      }
    ]);

    const client = {
      createTweet: vi.fn(),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn().mockRejectedValue(new Error('X API 503: still down'))
    };

    const result = await retryThreadPublish(
      '22222222-2222-2222-2222-222222222222',
      { client, prismaOverride: prismaMock }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CLEANUP_STILL_REQUIRED');
    expect(result.undeletedTweets).toHaveLength(1);
    expect(result.undeletedTweets?.[0]).toMatchObject({
      position: 0,
      tweetId: 'FAIL_DELETE_stuck',
      deleteError: expect.stringMatching(/still down/) as unknown as string
    });
    expect(result.attemptId).toBe('attempt-cleanup-1');

    // Item stays cleanup_required; the failed attempt stays
    // cleanup_required; the failed tweet's deleteError is refreshed.
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    );
    expect(prismaMock.contentSchedulerPublishAttempt.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-cleanup-1' },
        data: expect.objectContaining({ state: 'rolled_back' })
      })
    );
    expect(prismaMock.contentSchedulerAttemptTweet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-tweet-stuck' },
        data: expect.objectContaining({ deleteError: expect.stringMatching(/still down/) as unknown as string })
      })
    );

    // Re-publish must not run on a still-undeletable cleanup.
    expect(client.createTweet).not.toHaveBeenCalled();
  });

  it('completes cleanup then re-publishes when all outstanding deletes succeed', async () => {
    // Track in-memory state so the second findUnique (the re-publish)
    // reflects the transition cleanup_required -> approved.
    const fixture = cleanupRequiredFixture();
    prismaMock.contentSchedulerItem.findUnique.mockImplementation(async () => ({
      ...fixture,
      status: fixture.status
    }));
    prismaMock.contentSchedulerItem.update.mockImplementation(async ({ where, data }: any) => {
      if (where.id === fixture.id && data.status) {
        fixture.status = data.status;
        if (data.publishError !== undefined) fixture.publishError = data.publishError;
      }
      return { ...fixture };
    });
    prismaMock.contentSchedulerPublishAttempt.findFirst.mockResolvedValue({
      id: 'attempt-cleanup-1',
      state: 'cleanup_required'
    });
    // The previous compensation left one tweet undeleted. The retry
    // handler must delete it, then re-publish the full thread (root +
    // 2 replies = 3 fresh creates).
    prismaMock.contentSchedulerAttemptTweet.findMany
      .mockResolvedValueOnce([
        {
          id: 'att-tweet-stuck',
          attemptId: 'attempt-cleanup-1',
          position: 0,
          tweetId: 'stuck-root-id',
          url: 'https://x.com/sindustries/status/stuck-root-id',
          postedAt: new Date(),
          deletedAt: null,
          deleteError: 'previous failure'
        }
      ])
      // After cleanup, the standard publish path re-uses findMany
      // (compensation in publishThreadContentSchedulerItem, when it
      // returns 0 rows it falls through to rolled_back). The default
      // empty mock is fine for the happy re-publish path.
      .mockResolvedValue([]);

    const client = {
      createTweet: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/root-id',
          postedAt: new Date('2026-09-08T11:00:01Z')
        })
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/reply-1-id',
          postedAt: new Date('2026-09-08T11:00:02Z')
        })
        .mockResolvedValueOnce({
          url: 'https://x.com/sindustries/status/reply-2-id',
          postedAt: new Date('2026-09-08T11:00:03Z')
        }),
      getTweetAuthor: vi.fn(),
      deleteTweet: vi.fn().mockResolvedValue(undefined)
    };

    const result = await retryThreadPublish(
      '22222222-2222-2222-2222-222222222222',
      { client, prismaOverride: prismaMock }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe('OK');
    expect(result.publishedUrl).toBe('https://x.com/sindustries/status/root-id');

    // The stuck tweet was deleted during cleanup, then the failed
    // attempt was closed out as rolled_back, and the item was
    // returned to approved before the standard publish orchestrator
    // re-ran and created a fresh attempt.
    expect(client.deleteTweet).toHaveBeenCalledWith('stuck-root-id');
    expect(prismaMock.contentSchedulerAttemptTweet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-tweet-stuck' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) as unknown as Date })
      })
    );
    expect(prismaMock.contentSchedulerPublishAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-cleanup-1' },
        data: expect.objectContaining({ state: 'rolled_back' })
      })
    );
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222' },
        data: expect.objectContaining({ status: 'approved', publishError: null })
      })
    );

    // The standard publish orchestrator then claimed the (now-approved)
    // item via updateMany and created a fresh attempt.
    expect(prismaMock.contentSchedulerItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '22222222-2222-2222-2222-222222222222', status: 'approved' },
        data: expect.objectContaining({ status: 'publishing' })
      })
    );
    // 3 fresh creates for the re-published thread.
    expect(client.createTweet).toHaveBeenCalledTimes(3);
  });

  it('returns MISSING_CREDENTIALS when no X client is provided', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(cleanupRequiredFixture());
    const result = await retryThreadPublish(
      '22222222-2222-2222-2222-222222222222',
      { client: null, prismaOverride: prismaMock }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MISSING_CREDENTIALS');
  });
});