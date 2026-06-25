import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pagination cursor / sort semantics — documenting current behavior.
 *
 * Known issue (audit 2026-W26, finding "GET /tasks pages by cursor then sorts in memory"):
 * - findMany always uses orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
 * - Results are then re-sorted in JavaScript by the requested `?sort=` field
 * - nextCursor is encoded from the JS-sorted slice, but anchored to (createdAt, id)
 *
 * These tests document the current (buggy) behavior so the future fix in
 * Milestone 1-C of the 2026-W26 audit can flip them. They MUST pass against
 * main today. If any of these fail, either the bug was fixed (good — update
 * the test to assert the corrected behavior) or something else regressed.
 */

const prismaMock = {
  task: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  }
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Task',
    description: null,
    status: 'open',
    statusChangedAt: new Date('2026-03-01T00:00:00.000Z'),
    priority: 'medium',
    dueAt: null,
    completedAt: null,
    assignee: null,
    archivedAt: null,
    blocked: false,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    tags: [],
    ...overrides
  };
}

describe('pagination cursor / sort semantics (audit 2026-W26 0-B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findMany always orders by createdAt desc, regardless of ?sort=priority', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({ id: 'aaaaaaaa-1111-1111-1111-111111111111', priority: 'urgent' }),
      task({ id: 'bbbbbbbb-1111-1111-1111-111111111111', priority: 'low' })
    ]);

    const app = createApp();
    await request(app).get('/api/v1/tasks').query({ sort: 'priority' });

    expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1);
    // BUG (to be fixed in Milestone 1-C): orderBy ignores `sort` param.
    expect(prismaMock.task.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' }
    ]);
  });

  it('findMany always orders by createdAt desc, regardless of ?sort=dueAt', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);

    const app = createApp();
    await request(app).get('/api/v1/tasks').query({ sort: 'dueAt' });

    expect(prismaMock.task.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' }
    ]);
  });

  it('response body is re-sorted in JS by priority, even though DB returned createdAt order', async () => {
    // DB returned them in createdAt order (a is newer than b)
    // But sort=priority re-sorts in JS so urgent (a) comes before low (b)
    prismaMock.task.findMany.mockResolvedValue([
      task({
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        createdAt: new Date('2026-03-02T00:00:00.000Z'),
        priority: 'urgent'
      }),
      task({
        id: 'bbbbbbbb-1111-1111-1111-111111111111',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        priority: 'low'
      })
    ]);

    const app = createApp();
    const response = await request(app).get('/api/v1/tasks').query({ sort: 'priority' });

    expect(response.status).toBe(200);
    // The data array is the result of JS sort (urgent first), not the DB order.
    // (DB returned [urgent, low] in createdAt order anyway in this case, so
    // this assertion is brittle; the next test asserts the JS sort more
    // explicitly by reversing the DB order.)
    expect(response.body.data.map((t: { id: string }) => t.id)).toEqual([
      'aaaaaaaa-1111-1111-1111-111111111111',
      'bbbbbbbb-1111-1111-1111-111111111111'
    ]);
  });

  it('JS sort reorders DB result so the urgent task appears first even when DB returned it last', async () => {
    // DB returned LOW first (newer createdAt) then URGENT (older createdAt)
    prismaMock.task.findMany.mockResolvedValue([
      task({
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        createdAt: new Date('2026-03-02T00:00:00.000Z'),
        priority: 'low'
      }),
      task({
        id: 'bbbbbbbb-1111-1111-1111-111111111111',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        priority: 'urgent'
      })
    ]);

    const app = createApp();
    const response = await request(app).get('/api/v1/tasks').query({ sort: 'priority' });

    expect(response.status).toBe(200);
    // JS sort flips them so urgent (b) is first.
    expect(response.body.data.map((t: { id: string }) => t.id)).toEqual([
      'bbbbbbbb-1111-1111-1111-111111111111',
      'aaaaaaaa-1111-1111-1111-111111111111'
    ]);
  });

  it('nextCursor encodes the createdAt of the last task in the JS-sorted slice', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        priority: 'low'
      }),
      task({
        id: 'bbbbbbbb-1111-1111-1111-111111111111',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        priority: 'urgent'
      })
    ]);

    const app = createApp();
    const response = await request(app)
      .get('/api/v1/tasks')
      .query({ sort: 'priority', limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.page.hasNextPage).toBe(true);
    const cursor = response.body.page.nextCursor as string;
    expect(cursor).toBeTruthy();

    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    // BUG (to be fixed in Milestone 1-C): cursor is anchored to createdAt, not
    // the JS sort key. After JS sort, the page is just the first task
    // (urgent `b`, createdAt 2026-02-01). The cursor encodes that record's
    // createdAt + id — so the next page query (createdAt < 2026-02-01) will
    // miss the `low` priority task `a` even though it was page-2 in the
    // priority order.
    expect(decoded).toContain('2026-02-01');
    expect(decoded).toContain('bbbbbbbb-1111-1111-1111-111111111111');
  });
});