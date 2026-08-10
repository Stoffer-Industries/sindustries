// Tests for the durable auto-post layer (task 6492813a):
//   - `resolveRedisUrl` env precedence
//   - `buildBullMqJobId` determinism
//   - `createBullMqJobSchedulerAdapter` interacts with BullMQ + ioredis
//     through the dynamic-import seam so the in-process code path does
//     not require these packages at test time
//   - `reconcileAutoPostItems` reads approved items, re-enqueues missing
//     jobs, publishes overdue items, and reports the structured outcome
//   - `describeItemForReconcile` classifies per-item state
//
// The BullMQ tests inject a fake `bullmq` and `ioredis` through the
// `BullMqJobSchedulerAdapterDeps` seam so the test never imports the
// real packages.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBullMqJobId,
  createBullMqJobSchedulerAdapter,
  resolveRedisUrl
} from '../src/routes/contentSchedulerJobs.bullmq.ts';
import {
  describeItemForReconcile,
  reconcileAutoPostItems
} from '../src/routes/autoPostReconciliation.ts';
import { setJobSchedulerAdapter } from '../src/routes/contentSchedulerJobs.ts';

// --- Prisma mock ----------------------------------------------------------

const { prismaMock } = vi.hoisted(() => {
  const prismaMock: any = {
    contentSchedulerItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn()
    },
    $transaction: vi.fn()
  };
  return { prismaMock };
});

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

// --- BullMQ fake ----------------------------------------------------------

function makeBullMqFake() {
  const jobs = new Map<string, any>();
  const queue = {
    add: vi.fn(async (name: string, data: any, opts: any) => {
      jobs.set(opts.jobId, { id: opts.jobId, name, data, opts });
      return { id: opts.jobId, data, opts };
    }),
    getJob: vi.fn(async (id: string) => {
      const found = jobs.get(id);
      if (!found) return null;
      // Mirror BullMQ: the returned Job object has its own remove() method.
      return {
        ...found,
        remove: vi.fn(async () => {
          jobs.delete(id);
        })
      };
    }),
    remove: vi.fn(async (id: string) => {
      jobs.delete(id);
    }),
    getJobCounts: vi.fn(async () => {
      let waiting = 0;
      let delayed = 0;
      let active = 0;
      let failed = 0;
      let completed = 0;
      for (const job of jobs.values()) {
        if (job.opts.delay && job.opts.delay > 0) delayed += 1;
        else waiting += 1;
      }
      return { waiting, delayed, active, failed, completed };
    }),
    close: vi.fn(async () => {}),
    client: pingOk()
  };
  return { queue, jobs };
}

function pingOk() {
  return {
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => {})
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
  prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(null);
  prismaMock.contentSchedulerItem.update.mockImplementation(async ({ where, data }: any) => ({
    id: where.id,
    ...data
  }));
  prismaMock.contentSchedulerItem.count.mockResolvedValue(0);
});

// --- resolveRedisUrl ------------------------------------------------------

describe('resolveRedisUrl', () => {
  it('prefers CONTENT_SCHEDULER_REDIS_URL over REDIS_URL and default', () => {
    expect(
      resolveRedisUrl({
        CONTENT_SCHEDULER_REDIS_URL: 'redis://cs:6379',
        REDIS_URL: 'redis://shared:6379'
      })
    ).toBe('redis://cs:6379');
  });

  it('falls back to REDIS_URL when CONTENT_SCHEDULER_REDIS_URL is unset', () => {
    expect(resolveRedisUrl({ REDIS_URL: 'redis://shared:6379' })).toBe('redis://shared:6379');
  });

  it('falls back to redis://localhost:6379 when neither env is set', () => {
    expect(resolveRedisUrl({})).toBe('redis://localhost:6379');
  });
});

// --- buildBullMqJobId -----------------------------------------------------

describe('buildBullMqJobId', () => {
  it('is deterministic for the same (itemId, scheduleVersion) pair', () => {
    const job = {
      itemId: 'i1',
      scheduledFor: new Date('2026-07-17T09:00:00Z'),
      scheduleVersion: 3
    };
    expect(buildBullMqJobId(job)).toBe('content-scheduler-auto-post:i1:3');
    expect(buildBullMqJobId(job)).toBe('content-scheduler-auto-post:i1:3');
  });

  it('changes when scheduleVersion changes (reschedule / cancel path)', () => {
    const a = buildBullMqJobId({
      itemId: 'i1',
      scheduledFor: new Date('2026-07-17T09:00:00Z'),
      scheduleVersion: 3
    });
    const b = buildBullMqJobId({
      itemId: 'i1',
      scheduledFor: new Date('2026-07-17T09:00:00Z'),
      scheduleVersion: 4
    });
    expect(a).not.toBe(b);
  });
});

// --- BullMQ adapter (with injected fake) ----------------------------------

describe('createBullMqJobSchedulerAdapter', () => {
  it('scheduleAutoPost writes a deterministic jobId with delay and attempts=1', async () => {
    const { queue, jobs } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    const scheduledFor = new Date(Date.now() + 60_000);
    const result = await adapter.scheduleAutoPost({
      itemId: 'i1',
      scheduledFor,
      scheduleVersion: 5
    });
    expect(result.jobId).toBe('content-scheduler-auto-post:i1:5');
    expect(queue.add).toHaveBeenCalledOnce();
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('content-scheduler-auto-post');
    expect(data).toEqual({
      itemId: 'i1',
      scheduledFor: scheduledFor.toISOString(),
      scheduleVersion: 5
    });
    expect(opts.jobId).toBe('content-scheduler-auto-post:i1:5');
    expect(opts.attempts).toBe(1);
    expect(opts.delay).toBeGreaterThan(0);
    expect(jobs.has('content-scheduler-auto-post:i1:5')).toBe(true);
  });

  it('scheduleAutoPost uses delay=0 for past or immediate schedules', async () => {
    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    await adapter.scheduleAutoPost({
      itemId: 'i1',
      scheduledFor: new Date(Date.now() - 60_000),
      scheduleVersion: 1
    });
    const opts = queue.add.mock.calls[0][2];
    expect(opts.delay).toBe(0);
  });

  it('cancelAutoPost removes the job if it exists', async () => {
    const { queue, jobs } = makeBullMqFake();
    jobs.set('content-scheduler-auto-post:i1:1', { id: 'content-scheduler-auto-post:i1:1' });
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    await adapter.cancelAutoPost('content-scheduler-auto-post:i1:1');
    expect(jobs.has('content-scheduler-auto-post:i1:1')).toBe(false);
  });

  it('cancelAutoPost is a no-op when the job is missing', async () => {
    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    await expect(adapter.cancelAutoPost('content-scheduler-auto-post:missing:9')).resolves.toBeUndefined();
  });

  it('hasJob returns true when the job exists in the queue', async () => {
    const { queue, jobs } = makeBullMqFake();
    jobs.set('content-scheduler-auto-post:i1:1', { id: 'content-scheduler-auto-post:i1:1' });
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    await expect(adapter.hasJob('content-scheduler-auto-post:i1:1')).resolves.toBe(true);
    await expect(adapter.hasJob('content-scheduler-auto-post:missing:9')).resolves.toBe(false);
  });

  it('ping returns ok with latencyMs when the Redis client responds', async () => {
    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    const result = await adapter.ping();
    expect(result.ok).toBe(true);
    expect((result as any).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('queueStats returns the queue counters', async () => {
    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    await adapter.scheduleAutoPost({
      itemId: 'i1',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    });
    const stats = await adapter.queueStats();
    expect(stats.delayed).toBe(1);
    expect(stats.waiting + stats.delayed).toBe(1);
  });

  it('close shuts the queue and the connection cleanly', async () => {
    const { queue } = makeBullMqFake();
    let connQuit: any;
    const fakeRedis = {
      ping: vi.fn(async () => 'PONG'),
      quit: vi.fn(async () => {
        connQuit = true;
      })
    };
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return fakeRedis; } }
    });
    await adapter.scheduleAutoPost({
      itemId: 'i1',
      scheduledFor: new Date(Date.now() + 60_000),
      scheduleVersion: 1
    });
    await adapter.close!();
    expect(queue.close).toHaveBeenCalled();
    expect(connQuit).toBe(true);
  });
});

// --- Reconciliation -------------------------------------------------------

describe('describeItemForReconcile', () => {
  it('marks overdue items (scheduledFor before now) as needing reconcile', () => {
    const result = describeItemForReconcile({
      status: 'approved',
      scheduledFor: new Date(Date.now() - 60_000),
      autoPostJobId: 'job:1'
    });
    expect(result.needsReconcile).toBe(true);
    expect(result.reason).toBe('overdue');
  });

  it('marks approved items with no jobId as needing reconcile', () => {
    const result = describeItemForReconcile({
      status: 'approved',
      scheduledFor: new Date(Date.now() + 60_000),
      autoPostJobId: null
    });
    expect(result.needsReconcile).toBe(true);
    expect(result.reason).toBe('job-missing');
  });

  it('marks scheduled active approved items as not needing reconcile', () => {
    const result = describeItemForReconcile({
      status: 'approved',
      scheduledFor: new Date(Date.now() + 60_000),
      autoPostJobId: 'job:1'
    });
    expect(result.needsReconcile).toBe(false);
    expect(result.reason).toBe('scheduled');
  });

  it('marks terminal states as not needing reconcile', () => {
    expect(
      describeItemForReconcile({
        status: 'published',
        scheduledFor: null,
        autoPostJobId: null
      }).reason
    ).toBe('terminal');
    expect(
      describeItemForReconcile({
        status: 'removed',
        scheduledFor: null,
        autoPostJobId: null
      }).reason
    ).toBe('terminal');
  });

  it('marks non-approved items as non-actionable', () => {
    expect(
      describeItemForReconcile({
        status: 'queued',
        scheduledFor: null,
        autoPostJobId: null
      }).reason
    ).toBe('non-approved');
  });
});

describe('reconcileAutoPostItems', () => {
  it('returns an empty report when there are no approved items', async () => {
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    setJobSchedulerAdapter(adapter, 'bullmq');
    const report = await reconcileAutoPostItems({ now: () => new Date('2026-07-17T09:00:00Z') });
    expect(report.scanned).toBe(0);
    expect(report.reEnqueued).toBe(0);
    expect(report.overduePublished).toBe(0);
    expect(report.scheduledActive).toBe(0);
  });

  it('re-enqueues approved items whose queue job is missing', async () => {
    const future = new Date(Date.now() + 60_000);
    const item = {
      id: 'i1',
      status: 'approved',
      scheduledFor: future,
      autoPostJobId: 'content-scheduler-auto-post:i1:1',
      autoPostScheduleVersion: 1,
      autoPostScheduledAt: future,
      autoPostLastEnqueuedAt: null,
      publishError: null
    };
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([item]);
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);

    const { queue, jobs } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    setJobSchedulerAdapter(adapter, 'bullmq');

    const report = await reconcileAutoPostItems();
    expect(report.scanned).toBe(1);
    expect(report.reEnqueued).toBe(1);
    expect(report.scheduledActive).toBe(0);
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalled();
    expect(jobs.size).toBe(1);
  });

  it('marks already-enqueued items as scheduled-active', async () => {
    const future = new Date(Date.now() + 60_000);
    const item = {
      id: 'i2',
      status: 'approved',
      scheduledFor: future,
      autoPostJobId: 'content-scheduler-auto-post:i2:1',
      autoPostScheduleVersion: 1,
      autoPostScheduledAt: future,
      autoPostLastEnqueuedAt: null,
      publishError: null
    };
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([item]);
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);

    const { queue, jobs } = makeBullMqFake();
    jobs.set('content-scheduler-auto-post:i2:1', { id: 'content-scheduler-auto-post:i2:1' });
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    setJobSchedulerAdapter(adapter, 'bullmq');

    const report = await reconcileAutoPostItems();
    expect(report.scanned).toBe(1);
    expect(report.scheduledActive).toBe(1);
    expect(report.reEnqueued).toBe(0);
  });

  it('skips items in terminal states', async () => {
    const item = {
      id: 'i3',
      status: 'published',
      scheduledFor: null,
      autoPostJobId: null,
      autoPostScheduleVersion: 0,
      autoPostScheduledAt: null,
      autoPostLastEnqueuedAt: null,
      publishError: null
    };
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(null);

    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    setJobSchedulerAdapter(adapter, 'bullmq');

    const report = await reconcileAutoPostItems();
    expect(report.scanned).toBe(0);
    expect(report.skipped).toBe(0);
  });

  it('respects the limit option to bound the sweep size', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      status: 'approved',
      scheduledFor: new Date(Date.now() + 60_000),
      autoPostJobId: null,
      autoPostScheduleVersion: 0,
      autoPostScheduledAt: null,
      autoPostLastEnqueuedAt: null,
      publishError: null
    }));
    prismaMock.contentSchedulerItem.findMany.mockResolvedValueOnce(items);
    prismaMock.contentSchedulerItem.findUnique.mockImplementation(async ({ where }: any) =>
      items.find((i) => i.id === where.id) ?? null
    );

    const { queue } = makeBullMqFake();
    const adapter = createBullMqJobSchedulerAdapter({
      bullmq: { Queue: class { constructor() { return queue; } } },
      ioredis: class { constructor() { return pingOk(); } }
    });
    setJobSchedulerAdapter(adapter, 'bullmq');

    const report = await reconcileAutoPostItems({ limit: 2 });
    expect(report.scanned).toBe(2);
    expect(report.reEnqueued).toBe(2);
  });
});
