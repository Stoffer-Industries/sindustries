import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Prisma mock ---------------------------------------------------------

const prismaMock: any = {
  contentSchedulerItem: {
    findMany: vi.fn(),
    createMany: vi.fn()
  }
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

const ARCHIVE_REF = 'https://www.techmanagerweekly.com/issue/2026-08-04';
const STRONG_REF = 'https://staysaasy.com/p/slow-iteration';
const BOUNDARY_REF = 'https://lethain.com/boundaries/';
const HIRING_REF = 'https://lethain.com/hiring-receiving-role/';

function itemBody(body: string, sourceRef: string) {
  return {
    body,
    sourceRef,
    issueRef: ARCHIVE_REF,
    evidenceExcerpt: 'evidence excerpt'
  };
}

function asPersisted(ref: string, id?: string) {
  return { id: id ?? `${ref}-id`, sourceRef: ref };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every requested sourceRef already exists → 0 created.
  prismaMock.contentSchedulerItem.createMany.mockImplementation(async ({ data }: any) => {
    const rows = Array.isArray(data) ? data : [];
    return { count: 0 };
  });
  prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.CONTENT_SCHEDULER_INGEST_SECRET;
});

describe('POST /content-scheduler/imports/cto-craft', () => {
  describe('happy path', () => {
    it('imports 3 new items with source=cto_craft, status=draft', async () => {
      const items = [
        itemBody('Slow iteration is paid for by the team closest to the user.', STRONG_REF),
        itemBody('Information architecture decides who owns the failure.', BOUNDARY_REF),
        itemBody('Hire for the receiver, not the broadcaster.', HIRING_REF)
      ];
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 3 });
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([
        asPersisted(STRONG_REF, 'id-1'),
        asPersisted(BOUNDARY_REF, 'id-2'),
        asPersisted(HIRING_REF, 'id-3')
      ]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });

      expect(res.status).toBe(201);
      expect(res.body.data.createdCount).toBe(3);
      expect(res.body.data.skippedDuplicateCount).toBe(0);
      expect(res.body.data.createdIds).toHaveLength(3);
      expect(res.body.data.sourceRefs).toEqual([STRONG_REF, BOUNDARY_REF, HIRING_REF]);

      // Verify the rows sent to Prisma are always draft/cto_craft/null/0
      const createCall = prismaMock.contentSchedulerItem.createMany.mock.calls[0][0];
      for (const row of createCall.data) {
        expect(row.source).toBe('cto_craft');
        expect(row.status).toBe('draft');
        expect(row.scheduledFor).toBeNull();
        expect(row.position).toBe(0);
      }
      expect(createCall.skipDuplicates).toBe(true);
    });

    it('returns 1–5 items (boundary)', async () => {
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });

    it('rejects more than 5 items', async () => {
      const items = Array.from({ length: 6 }, (_, i) =>
        itemBody(`item ${i}`, `https://example.com/${i}`)
      );
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });
  });

  describe('idempotency', () => {
    it('returns createdCount=0 when all sourceRefs already exist', async () => {
      const items = [
        itemBody('Slow iteration is paid for by the team closest to the user.', STRONG_REF),
        itemBody('Information architecture decides who owns the failure.', BOUNDARY_REF)
      ];
      // createMany({ skipDuplicates: true }) on a partial unique index
      // returns count = 0 when no new rows were inserted.
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 0 });
      // The re-read still finds the pre-existing rows.
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([
        asPersisted(STRONG_REF, 'pre-existing-1'),
        asPersisted(BOUNDARY_REF, 'pre-existing-2')
      ]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });

      expect(res.status).toBe(201);
      expect(res.body.data.createdCount).toBe(0);
      expect(res.body.data.skippedDuplicateCount).toBe(2);
    });

    it('partially duplicates: createdCount=2, skippedDuplicateCount=1', async () => {
      const items = [
        itemBody('Fresh angle.', STRONG_REF),
        itemBody('Fresh angle 2.', BOUNDARY_REF),
        itemBody('Already there.', HIRING_REF)
      ];
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 2 });
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([
        asPersisted(STRONG_REF, 'new-1'),
        asPersisted(BOUNDARY_REF, 'new-2'),
        asPersisted(HIRING_REF, 'pre-existing')
      ]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });

      expect(res.status).toBe(201);
      expect(res.body.data.createdCount).toBe(2);
      expect(res.body.data.skippedDuplicateCount).toBe(1);
    });
  });

  describe('validation', () => {
    it('rejects body longer than 280 characters', async () => {
      const items = [itemBody('x'.repeat(281), STRONG_REF)];
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
      expect(res.body.error.message).toContain('280');
    });

    it('rejects non-http sourceRef', async () => {
      const items = [itemBody('a body', 'javascript:alert(1)')];
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });

    it('rejects duplicate sourceRef within the same request', async () => {
      const items = [
        itemBody('first', STRONG_REF),
        itemBody('second', STRONG_REF)
      ];
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });

    it('rejects empty body', async () => {
      const items = [itemBody('   ', STRONG_REF)];
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });

    it('rejects items that are not an array', async () => {
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ITEMS');
    });
  });

  describe('ingest secret gate', () => {
    it('rejects with 401 when secret is configured and header is missing', async () => {
      process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'a'.repeat(64);
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items: [itemBody('body', STRONG_REF)] });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toContain('x-content-ingest-secret');
    });

    it('rejects with 401 when secret is configured and header mismatches', async () => {
      process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'a'.repeat(64);
      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .set('x-content-ingest-secret', 'b'.repeat(64))
        .send({ items: [itemBody('body', STRONG_REF)] });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('accepts when secret is configured and header matches', async () => {
      const secret = 'a'.repeat(64);
      process.env.CONTENT_SCHEDULER_INGEST_SECRET = secret;
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 1 });
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([asPersisted(STRONG_REF, 'id-1')]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .set('x-content-ingest-secret', secret)
        .send({ items: [itemBody('body', STRONG_REF)] });
      expect(res.status).toBe(201);
    });

    it('passes through when secret is not configured', async () => {
      // CONTENT_SCHEDULER_INGEST_SECRET unset
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 1 });
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([asPersisted(STRONG_REF, 'id-1')]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items: [itemBody('body', STRONG_REF)] });
      expect(res.status).toBe(201);
    });
  });

  describe('body is always normalised', () => {
    it('trims whitespace from item.body', async () => {
      const items = [itemBody('  trimmed body  ', STRONG_REF)];
      prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 1 });
      prismaMock.contentSchedulerItem.findMany.mockResolvedValue([asPersisted(STRONG_REF, 'id-1')]);

      const app = await createApp();
      const res = await request(app)
        .post('/api/v1/content-scheduler/imports/cto-craft')
        .send({ items });

      expect(res.status).toBe(201);
      const createCall = prismaMock.contentSchedulerItem.createMany.mock.calls[0][0];
      expect(createCall.data[0].body).toBe('trimmed body');
    });
  });
});