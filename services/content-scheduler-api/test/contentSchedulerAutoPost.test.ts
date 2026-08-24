// Tests for the event-driven auto-post feature (task ac74e9bb).
//
// Covers:
//   - decideAutoPostAction (pure schedule decision logic)
//   - in-process JobSchedulerAdapter (schedule / cancel / fireNow)
//   - publishContentSchedulerItem (all result codes)
//   - processAutoPostJob (worker outcomes, including stale-version and
//     not-approved exits)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideAutoPostAction } from '../src/routes/contentSchedulerJobs.ts';
import { createInProcessJobSchedulerAdapter } from '../src/routes/contentSchedulerJobs.inProcess.ts';
import { setJobSchedulerAdapter } from '../src/routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from '../src/workers/autoPostWorker.ts';
import { publishContentSchedulerItem } from '../src/routes/contentSchedulerPublishService.ts';

// --- Prisma mock (hoisted so the autoPostWorker import does not blow up) -

const { prismaMock } = vi.hoisted(() => {
  const prismaMock: any = {
    contentSchedulerItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn()
    },
    $transaction: vi.fn()
  };
  return { prismaMock };
});

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

function itemFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date(Date.now() - 5_000); // 5s in the past so the auto-post grace window is past
  return {
    id: '11111111-1111-1111-1111-111111111111',
    body: 'Hello world',
    source: 'manual',
    sourceRef: null,
    status: 'approved',
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
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cbOrOps: any) => {
    if (typeof cbOrOps === 'function') return cbOrOps(prismaMock);
    return Promise.all(cbOrOps);
  });
  prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  setJobSchedulerAdapter(null as any, 'in-process');
});

// --- decideAutoPostAction -------------------------------------------------

describe('decideAutoPostAction', () => {
  it('cancels prior job when status transitions to published', () => {
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: new Date('2026-07-17T09:00:00Z'),
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'published', scheduledFor: null }
    });
    expect(decision).toEqual({ kind: 'cancel', jobId: 'in-process:i1:1' });
  });

  it('cancels prior job when status transitions to removed', () => {
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: new Date(),
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'removed', scheduledFor: null }
    });
    expect(decision.kind).toBe('cancel');
  });

  it('cancels prior job when unapproving', () => {
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: new Date(),
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'queued', scheduledFor: null }
    });
    expect(decision.kind).toBe('cancel');
  });

  it('cancels prior job when scheduledFor is cleared on an approved item', () => {
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: new Date(),
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'approved', scheduledFor: null }
    });
    expect(decision.kind).toBe('cancel');
  });

  it('noops when prior and next are both approved with the same schedule and a job', () => {
    const when = new Date('2026-07-17T09:00:00Z');
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: when,
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'approved', scheduledFor: when }
    });
    expect(decision).toEqual({ kind: 'noop' });
  });

  it('schedules a new job with version+1 when approving an item with scheduledFor', () => {
    const when = new Date('2026-07-17T09:00:00Z');
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'queued',
        scheduledFor: when,
        autoPostJobId: null,
        autoPostScheduleVersion: 0
      },
      next: { status: 'approved', scheduledFor: when }
    });
    expect(decision.kind).toBe('schedule');
    if (decision.kind === 'schedule') {
      expect(decision.job.itemId).toBe('i1');
      expect(decision.job.scheduleVersion).toBe(1);
    }
  });

  it('reschedules (version+1) when scheduledFor changes on an already-approved item', () => {
    const oldWhen = new Date('2026-07-17T09:00:00Z');
    const newWhen = new Date('2026-07-17T10:00:00Z');
    const decision = decideAutoPostAction({
      prior: {
        id: 'i1',
        status: 'approved',
        scheduledFor: oldWhen,
        autoPostJobId: 'in-process:i1:1',
        autoPostScheduleVersion: 1
      },
      next: { status: 'approved', scheduledFor: newWhen }
    });
    expect(decision.kind).toBe('schedule');
    if (decision.kind === 'schedule') {
      expect(decision.job.scheduledFor).toEqual(newWhen);
      expect(decision.job.scheduleVersion).toBe(2);
    }
  });
});

// --- in-process adapter --------------------------------------------------

describe('in-process JobSchedulerAdapter', () => {
  it('scheduleAutoPost returns a deterministic jobId and tracks pending jobs', async () => {
    const adapter = createInProcessJobSchedulerAdapter();
    const job = {
      itemId: 'i1',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    };
    const scheduled = await adapter.scheduleAutoPost(job);
    expect(scheduled.jobId).toBe('in-process:i1:1');
    expect(adapter.pendingJobs()).toHaveLength(1);
  });

  it('fireNow invokes the registered handler with the job payload', async () => {
    const adapter = createInProcessJobSchedulerAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.setHandler(handler);
    const job = {
      itemId: 'i1',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    };
    const { jobId } = await adapter.scheduleAutoPost(job);
    await adapter.fireNow(jobId);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(job);
    expect(adapter.pendingJobs()).toHaveLength(0);
  });

  it('cancelAutoPost removes a pending job', async () => {
    const adapter = createInProcessJobSchedulerAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.setHandler(handler);
    const { jobId } = await adapter.scheduleAutoPost({
      itemId: 'i1',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    });
    expect(adapter.pendingJobs()).toHaveLength(1);
    await adapter.cancelAutoPost(jobId);
    expect(adapter.pendingJobs()).toHaveLength(0);
  });

  it('cancelAutoPost is a no-op for unknown job ids', async () => {
    const adapter = createInProcessJobSchedulerAdapter();
    await expect(adapter.cancelAutoPost('unknown')).resolves.toBeUndefined();
  });

  it('close() removes all pending jobs', async () => {
    const adapter = createInProcessJobSchedulerAdapter();
    await adapter.scheduleAutoPost({
      itemId: 'a',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    });
    await adapter.scheduleAutoPost({
      itemId: 'b',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    });
    expect(adapter.pendingJobs()).toHaveLength(2);
    await adapter.close?.();
    expect(adapter.pendingJobs()).toHaveLength(0);
  });
});

// --- publishContentSchedulerItem (auto path) -----------------------------

describe('publishContentSchedulerItem (auto actor)', () => {
  it('returns OK and persists publishedAt/Url for an approved item', async () => {
    const item = itemFixture({ status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);

    const result = await publishContentSchedulerItem(item.id, 'auto', {
      client: {
        createTweet: vi.fn().mockResolvedValue({
          url: 'https://x.com/sindustries/status/abc',
          postedAt: new Date('2026-07-17T09:00:00Z')
        })
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toBe('OK');
      expect(result.publishedUrl).toBe('https://x.com/sindustries/status/abc');
    }
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: item.id },
        data: expect.objectContaining({
          status: 'published',
          publishedUrl: 'https://x.com/sindustries/status/abc'
        })
      })
    );
  });

  it('returns PUBLISH_FAILED and writes publishError on X failure', async () => {
    const item = itemFixture({ status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);

    const result = await publishContentSchedulerItem(item.id, 'auto', {
      client: {
        createTweet: vi.fn().mockRejectedValue(new Error('X API 500'))
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PUBLISH_FAILED');
      expect(result.message).toContain('X API 500');
    }
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishError: 'X API 500' })
      })
    );
  });

  it('returns MISSING_CREDENTIALS when client is null and writes publishError', async () => {
    const item = itemFixture({ status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);

    const result = await publishContentSchedulerItem(item.id, 'auto', { client: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_CREDENTIALS');
    }
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishError: 'X credentials are not configured'
        })
      })
    );
  });

  it('returns OK without re-posting when item is already published (idempotent retry)', async () => {
    const published = itemFixture({
      status: 'published',
      publishedAt: new Date(),
      publishedUrl: 'https://x.com/sindustries/status/abc'
    });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(published);

    const result = await publishContentSchedulerItem(published.id, 'auto');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publishedUrl).toBe('https://x.com/sindustries/status/abc');
    }
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('returns NOT_APPROVED for queued items without writing publishError', async () => {
    const queued = itemFixture({ status: 'queued', approvedAt: null, scheduledFor: null });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(queued);

    const result = await publishContentSchedulerItem(queued.id, 'auto');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_APPROVED');
    }
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for removed items', async () => {
    const removed = itemFixture({ status: 'removed' });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(removed);

    const result = await publishContentSchedulerItem(removed.id, 'auto');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });
});

// --- processAutoPostJob --------------------------------------------------

describe('processAutoPostJob', () => {
  it('exits rejected-stale-version when the item has a newer scheduleVersion', async () => {
    const item = itemFixture({
      autoPostScheduleVersion: 5,
      autoPostJobId: 'in-process:i1:4'
    });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(item);

    const outcome = await processAutoPostJob(
      { itemId: item.id, scheduledFor: new Date(), scheduleVersion: 4 },
      { now: () => new Date() }
    );
    expect(outcome).toBe('rejected-stale-version');
  });

  it('exits rejected-removed for a removed item', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'removed' }));
    const outcome = await processAutoPostJob({
      itemId: 'i1',
      scheduledFor: new Date(),
      scheduleVersion: 1
    });
    expect(outcome).toBe('rejected-removed');
  });

  it('exits rejected-already-published for a published item', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      itemFixture({ status: 'published', publishedAt: new Date() })
    );
    const outcome = await processAutoPostJob({
      itemId: 'i1',
      scheduledFor: new Date(),
      scheduleVersion: 1
    });
    expect(outcome).toBe('rejected-already-published');
  });

  it('exits rejected-not-approved for a queued item', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'queued', approvedAt: null, scheduledFor: null }));
    const outcome = await processAutoPostJob({
      itemId: 'i1',
      scheduledFor: new Date(),
      scheduleVersion: 1
    });
    expect(outcome).toBe('rejected-not-approved');
  });

  it('exits rejected-day-cap when the daily publish cap is reached', async () => {
    const now = new Date('2026-07-17T09:00:00.000Z');
    const item = itemFixture({ id: 'i1', status: 'approved', scheduledFor: new Date(now.getTime() - 5_000) });
    prismaMock.contentSchedulerItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([{ id: 'already-published' }]);

    const outcome = await processAutoPostJob(
      { itemId: 'i1', scheduledFor: item.scheduledFor, scheduleVersion: 1 },
      { now: () => now }
    );

    expect(outcome).toBe('rejected-day-cap');
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('exits rejected-future-schedule when the publish guard refuses a future schedule', async () => {
    const now = new Date();
    const workerItem = itemFixture({ id: 'i1', status: 'approved', scheduledFor: new Date(now.getTime() - 5_000) });
    const publishItem = itemFixture({ id: 'i1', status: 'approved', scheduledFor: new Date(now.getTime() + 120_000) });
    prismaMock.contentSchedulerItem.findUnique
      .mockResolvedValueOnce(workerItem)
      .mockResolvedValueOnce(publishItem);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);

    const outcome = await processAutoPostJob(
      { itemId: 'i1', scheduledFor: workerItem.scheduledFor, scheduleVersion: 1 },
      { now: () => now }
    );

    expect(outcome).toBe('rejected-future-schedule');
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('exits rejected-not-found when the item does not exist', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(null);
    const outcome = await processAutoPostJob({
      itemId: 'missing',
      scheduledFor: new Date(),
      scheduleVersion: 1
    });
    expect(outcome).toBe('rejected-not-found');
  });
});
