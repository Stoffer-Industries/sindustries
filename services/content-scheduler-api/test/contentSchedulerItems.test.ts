// Tests for the manual_reply kind discriminator + PATCH /items/:id/posted-url
// endpoint (task 5279b310, AC1-AC6).
//
// These tests cover the new ContentSchedulerItem.kind field, the rejection
// rules on POST/PATCH /content-scheduler/items, the new PATCH
// /content-scheduler/items/:id/posted-url capture endpoint, and the
// publish-loop skip for kind=manual_reply rows.

import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardPublish } from '../src/routes/contentSchedulerPublish.ts';

// --- Prisma mock ---------------------------------------------------------

const prismaMock: any = {
  contentSchedulerItem: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn()
  },
  contentSchedulerThreadPart: {
    createMany: vi.fn(),
    deleteMany: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

function itemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    body: 'Hello world',
    source: 'manual',
    sourceRef: null,
    status: 'queued',
    scheduledFor: null,
    position: 0,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    publishedUrl: null,
    publishError: null,
    createdAt: new Date('2026-08-23T00:00:00.000Z'),
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
    removedAt: null,
    kind: 'scheduled',
    manualPostedUrl: null,
    manualPostedAt: null,
    linksToItemId: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cbOrOps: any) => {
    if (typeof cbOrOps === 'function') return cbOrOps(prismaMock);
    return Promise.all(cbOrOps);
  });
  prismaMock.contentSchedulerItem.aggregate.mockResolvedValue({ _max: { position: null } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- guardPublish: manual_reply skip -------------------------------------

describe('guardPublish — manual_reply handling (task 5279b310 AC4)', () => {
  const now = new Date('2026-08-23T08:00:00.000Z');

  it('refuses MANUAL_REPLY_NOT_PUBLISHABLE when kind === "manual_reply"', () => {
    const result = guardPublish(
      itemFixture({
        kind: 'manual_reply',
        status: 'approved',
        approvedAt: now,
        scheduledFor: null
      }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: false, code: 'MANUAL_REPLY_NOT_PUBLISHABLE' });
  });

  it('refuses MANUAL_REPLY_NOT_PUBLISHABLE even when approved with a future schedule', () => {
    const future = new Date(now.getTime() + 5 * 60_000);
    const result = guardPublish(
      itemFixture({
        kind: 'manual_reply',
        status: 'approved',
        approvedAt: now,
        scheduledFor: future
      }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: false, code: 'MANUAL_REPLY_NOT_PUBLISHABLE' });
  });

  it('defaults kind to "scheduled" when undefined (legacy fixture safety)', () => {
    // A test fixture that pre-dates the kind field should still be treated
    // as 'scheduled', not get a NaN comparison error.
    const result = guardPublish(
      // @ts-expect-error — intentionally omit kind
      itemFixture({ kind: undefined, status: 'approved', approvedAt: now }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: true });
  });
});

// --- POST /content-scheduler/items: kind discrimination -----------------

describe('POST /content-scheduler/items — kind discrimination', () => {
  it('accepts kind="manual_reply" with no scheduledFor', async () => {
    prismaMock.contentSchedulerItem.create.mockImplementation(async ({ data }: any) => ({
      id: ITEM_ID,
      ...data,
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        body: 'Manual reply draft',
        source: 'manual',
        kind: 'manual_reply',
        linksToItemId: '22222222-2222-2222-2222-222222222222'
      });

    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('manual_reply');
    expect(res.body.data.scheduledFor).toBeNull();
    expect(res.body.data.linksToItemId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('defaults kind to "scheduled" when omitted (backwards compat)', async () => {
    prismaMock.contentSchedulerItem.create.mockImplementation(async ({ data }: any) => ({
      id: ITEM_ID,
      ...data,
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({ body: 'A normal tweet' });

    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('scheduled');
  });

  it('rejects kind="manual_reply" with a scheduledFor (manual_reply is never auto-published)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        body: 'Cannot schedule a manual reply',
        kind: 'manual_reply',
        scheduledFor: new Date(Date.now() + 60_000).toISOString()
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SCHEDULED_FOR');
  });

  it('rejects manualPostedUrl on create (must use PATCH /posted-url)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        body: 'No posted URL on create',
        manualPostedUrl: 'https://x.com/sindustries/status/123'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MANUAL_POSTED_URL');
  });

  it('rejects linksToItemId on a scheduled item (must be kind=manual_reply)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        body: 'Scheduled with stray link',
        linksToItemId: '22222222-2222-2222-2222-222222222222'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LINKS_TO_ITEM_ID');
  });

  it('rejects an unknown kind value', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({ body: 'test', kind: 'unknown_kind' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_KIND');
  });
});

// --- PATCH /content-scheduler/items/:id/posted-url ------------------------

describe('PATCH /content-scheduler/items/:id/posted-url — AC5 capture', () => {
  it('captures manualPostedUrl + manualPostedAt on a manual_reply item', async () => {
    const before = itemFixture({ kind: 'manual_reply' });
    const capturedAt = new Date('2026-08-23T10:00:00.000Z');
    const after = {
      ...before,
      manualPostedUrl: 'https://x.com/sindustries/status/999',
      manualPostedAt: capturedAt
    };
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(before);
    prismaMock.contentSchedulerItem.update.mockResolvedValueOnce(after);

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({ manualPostedUrl: 'https://x.com/sindustries/status/999' });

    expect(res.status).toBe(200);
    expect(res.body.data.manualPostedUrl).toBe('https://x.com/sindustries/status/999');
    expect(res.body.data.manualPostedAt).toBeDefined();
    expect(res.body.manualPostedAtUpdated).toBe(true);
  });

  it('is idempotent on the same URL (returns 200, does not update manualPostedAt)', async () => {
    const url = 'https://x.com/sindustries/status/999';
    const firstCapture = new Date('2026-08-23T10:00:00.000Z');
    const before = itemFixture({
      kind: 'manual_reply',
      manualPostedUrl: url,
      manualPostedAt: firstCapture
    });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(before);

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({ manualPostedUrl: url });

    expect(res.status).toBe(200);
    expect(res.body.data.manualPostedAt).toBe(firstCapture.toISOString());
    expect(res.body.manualPostedAtUpdated).toBe(false);
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('rejects an item whose kind is scheduled (must use POST /publish)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(itemFixture({ kind: 'scheduled' }));

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({ manualPostedUrl: 'https://x.com/sindustries/status/999' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_MANUAL_REPLY');
  });

  it('rejects an invalid URL shape (must be x.com or twitter.com status URL)', async () => {
    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({ manualPostedUrl: 'https://example.com/not-a-tweet' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MANUAL_POSTED_URL');
  });

  it('rejects an empty / missing manualPostedUrl', async () => {
    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MANUAL_POSTED_URL');
  });

  it('returns 404 when the item does not exist', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(null);

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}/posted-url`)
      .send({ manualPostedUrl: 'https://x.com/sindustries/status/999' });

    expect(res.status).toBe(404);
  });
});

// --- PATCH /content-scheduler/items/:id: kind discrimination -------------

describe('PATCH /content-scheduler/items/:id — kind discrimination', () => {
  it('rejects scheduledFor change when kind=manual_reply', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(itemFixture({ kind: 'manual_reply' }));

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ scheduledFor: new Date(Date.now() + 60_000).toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SCHEDULED_FOR');
  });

  it('allows linksToItemId set on a manual_reply item', async () => {
    const before = itemFixture({ kind: 'manual_reply' });
    const after = { ...before, linksToItemId: '22222222-2222-2222-2222-222222222222' };
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(before);
    prismaMock.contentSchedulerItem.update.mockResolvedValueOnce(after);

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ linksToItemId: '22222222-2222-2222-2222-222222222222' });

    expect(res.status).toBe(200);
    expect(res.body.data.linksToItemId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('rejects linksToItemId set on a scheduled item', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(itemFixture({ kind: 'scheduled' }));

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ linksToItemId: '22222222-2222-2222-2222-222222222222' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LINKS_TO_ITEM_ID');
  });

  it('rejects PATCH kind: null as INVALID_KIND (cannot clear the discriminator)', async () => {
    // Quinn PR #515 follow-up: validateKind treats null as "not provided" so
    // the bare validateKind check would let it through and then updates.kind
    // = null would silently bypass the kind discriminator. Reject explicitly.
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(
      itemFixture({ kind: 'scheduled' })
    );

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ kind: null });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_KIND');
    // The DB must NOT be touched on a rejected PATCH.
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
  });

  it('allows PATCH kind: undefined (no change to discriminator)', async () => {
    // Mirrors the POST path: undefined is treated as "field omitted", so
    // the PATCH must still apply other updates (here: body) without
    // touching kind.
    const before = itemFixture({ kind: 'scheduled' });
    const after = { ...before, body: 'Updated body text' };
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(before);
    prismaMock.contentSchedulerItem.update.mockResolvedValueOnce(after);

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ body: 'Updated body text', kind: undefined });

    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('scheduled');
  });
});

// --- Thread kind: create/update (task 1016cbff PR B) -------------------
//
// These tests cover the new POST /content-scheduler/items and PATCH
// /content-scheduler/items/:id surface for kind=thread items:
//   - 2..7 ordered parts with <=280-char bodies each
//   - body + parts conflict (must use parts)
//   - editing an approved thread clears approval atomically
//   - PATCH without parts on a thread item is rejected
//   - GET /items includes parts in the response

describe('POST /content-scheduler/items — kind=thread (task 1016cbff PR B)', () => {
  function threadCreateMock(body: string, parts: Array<{ position: number; body: string }>) {
    return {
      id: ITEM_ID,
      body,
      source: 'manual',
      sourceRef: null,
      status: 'queued',
      scheduledFor: null,
      position: 0,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
      removedAt: null,
      kind: 'thread',
      manualPostedUrl: null,
      manualPostedAt: null,
      linksToItemId: null,
      parts
    };
  }

  it('creates a 2-part thread as one aggregate (AC1 surface)', async () => {
    const created = threadCreateMock('Root tweet', [
      { position: 1, body: 'Reply 1' }
    ]);
    prismaMock.contentSchedulerItem.create.mockResolvedValueOnce(created);

    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        kind: 'thread',
        parts: [{ body: 'Root tweet' }, { body: 'Reply 1' }]
      });

    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('thread');
    expect(res.body.data.body).toBe('Root tweet');
    expect(res.body.data.parts).toEqual([{ position: 1, body: 'Reply 1' }]);
    // Prisma create payload must include ordered reply parts (positions
    // 1..n) so the storage shape matches the public contract.
    const createArgs = prismaMock.contentSchedulerItem.create.mock.calls[0][0];
    expect(createArgs.data.parts.create).toEqual([
      { position: 1, body: 'Reply 1' }
    ]);
    expect(createArgs.data.body).toBe('Root tweet');
  });

  it('creates a 7-part thread (the upper bound)', async () => {
    const partsBodies = [
      'Root', 'Reply 1', 'Reply 2', 'Reply 3', 'Reply 4', 'Reply 5', 'Reply 6'
    ];
    const created = threadCreateMock('Root', partsBodies.slice(1).map((body, i) => ({ position: i + 1, body })));
    prismaMock.contentSchedulerItem.create.mockResolvedValueOnce(created);

    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({ kind: 'thread', parts: partsBodies.map((body) => ({ body })) });

    expect(res.status).toBe(201);
    expect(res.body.data.parts).toHaveLength(6);
  });

  it('rejects 1-part thread (too short)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({ kind: 'thread', parts: [{ body: 'Only one part' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects 8-part thread (too long)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        kind: 'thread',
        parts: Array.from({ length: 8 }, (_, i) => ({ body: `Part ${i}` }))
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects body+parts combination (one source of truth)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        kind: 'thread',
        body: 'Root text in body',
        parts: [{ body: 'Reply' }, { body: 'Reply 2' }]
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects thread part body > 280 chars', async () => {
    const longBody = 'x'.repeat(281);
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        kind: 'thread',
        parts: [{ body: 'Root' }, { body: longBody }]
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects parts on kind=scheduled (only kind=thread supports parts)', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({
        kind: 'scheduled',
        body: 'Single tweet',
        parts: [{ body: 'Should be ignored' }, { body: 'Not allowed' }]
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects kind=thread without parts', async () => {
    const res = await authedRequest(await createApp())
      .post('/api/v1/content-scheduler/items')
      .send({ kind: 'thread', body: 'No parts' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });
});

describe('PATCH /content-scheduler/items/:id — thread full replacement (task 1016cbff PR B)', () => {
  function threadExistingFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: ITEM_ID,
      body: 'Old root',
      source: 'manual',
      sourceRef: null,
      status: 'queued',
      scheduledFor: null,
      position: 0,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      publishedUrl: null,
      publishError: null,
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
      removedAt: null,
      kind: 'thread',
      manualPostedUrl: null,
      manualPostedAt: null,
      linksToItemId: null,
      autoPostJobId: null,
      autoPostScheduleVersion: 0,
      ...overrides
    };
  }

  it('replaces parts atomically and returns the updated aggregate with parts', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(threadExistingFixture());
    const txMock = {
      contentSchedulerItem: {
        update: vi.fn().mockResolvedValueOnce(threadExistingFixture()),
        findUnique: vi.fn().mockResolvedValueOnce(
          threadExistingFixture({
            body: 'New root',
            parts: [
              { position: 1, body: 'New reply 1' },
              { position: 2, body: 'New reply 2' }
            ]
          })
        )
      },
      contentSchedulerThreadPart: {
        deleteMany: vi.fn().mockResolvedValueOnce({ count: 2 }),
        createMany: vi.fn().mockResolvedValueOnce({ count: 2 })
      }
    };
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(txMock));

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({
        kind: 'thread',
        parts: [
          { body: 'New root' },
          { body: 'New reply 1' },
          { body: 'New reply 2' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.body).toBe('New root');
    expect(res.body.data.parts).toEqual([
      { position: 1, body: 'New reply 1' },
      { position: 2, body: 'New reply 2' }
    ]);
    expect(txMock.contentSchedulerThreadPart.deleteMany).toHaveBeenCalledWith({ where: { itemId: ITEM_ID } });
    expect(txMock.contentSchedulerThreadPart.createMany).toHaveBeenCalledWith({
      data: [
        { itemId: ITEM_ID, position: 1, body: 'New reply 1' },
        { itemId: ITEM_ID, position: 2, body: 'New reply 2' }
      ]
    });
  });

  it('clears approval when an approved thread is edited (tech design \u00a7PR B)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(
      threadExistingFixture({ status: 'approved', approvedAt: new Date(), approvedBy: 'Tom' })
    );
    const txMock = {
      contentSchedulerItem: {
        update: vi.fn().mockResolvedValueOnce({}),
        findUnique: vi.fn().mockResolvedValueOnce(
          threadExistingFixture({
            status: 'queued',
            approvedAt: null,
            approvedBy: null,
            parts: [{ position: 1, body: 'Updated reply' }]
          })
        )
      },
      contentSchedulerThreadPart: {
        deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        createMany: vi.fn().mockResolvedValueOnce({ count: 1 })
      }
    };
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(txMock));

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({
        kind: 'thread',
        parts: [{ body: 'Updated root' }, { body: 'Updated reply' }]
      });

    expect(res.status).toBe(200);
    const updateArgs = txMock.contentSchedulerItem.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('queued');
    expect(updateArgs.data.approvedAt).toBeNull();
    expect(updateArgs.data.approvedBy).toBeNull();
  });

  it('rejects parts on a non-thread item (kind=scheduled)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(
      threadExistingFixture({ kind: 'scheduled' })
    );

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ parts: [{ body: 'r' }, { body: 'r2' }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('rejects body on a thread item (must use parts)', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValueOnce(threadExistingFixture());

    const res = await authedRequest(await createApp())
      .patch(`/api/v1/content-scheduler/items/${ITEM_ID}`)
      .send({ body: 'Should not be allowed' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });
});

describe('GET /content-scheduler/items — parts in response (task 1016cbff PR B)', () => {
  it('includes ordered parts on each item', async () => {
    prismaMock.contentSchedulerItem.findMany.mockResolvedValueOnce([
      {
        id: ITEM_ID,
        body: 'Root',
        source: 'manual',
        sourceRef: null,
        status: 'queued',
        scheduledFor: null,
        position: 0,
        approvedAt: null,
        approvedBy: null,
        publishedAt: null,
        publishedUrl: null,
        publishError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        removedAt: null,
        kind: 'thread',
        manualPostedUrl: null,
        manualPostedAt: null,
        linksToItemId: null,
        parts: [{ position: 1, body: 'Reply 1' }, { position: 2, body: 'Reply 2' }]
      }
    ]);

    const res = await authedRequest(await createApp())
      .get('/api/v1/content-scheduler/items');

    expect(res.status).toBe(200);
    expect(res.body.data[0].parts).toEqual([
      { position: 1, body: 'Reply 1' },
      { position: 2, body: 'Reply 2' }
    ]);
    const findArgs = prismaMock.contentSchedulerItem.findMany.mock.calls[0][0];
    expect(findArgs.include).toEqual({ parts: { orderBy: { position: 'asc' } } });
  });
});
