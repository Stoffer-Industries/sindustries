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
