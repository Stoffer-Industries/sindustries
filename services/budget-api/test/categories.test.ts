import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    session: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() }
  }
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';

const SESSION = { id: 'session_categories_1', userId: 'user_categories_1' };
const TOKEN = 'categories-test-token';
const TOKEN_HASH = hashSessionToken(TOKEN);

function isoDay(d: string): Date {
  // Treat the test's category day as a real ISO timestamp at 00:00 UTC so
  // the route's toISOString().slice(0, 10) returns the same YYYY-MM-DD.
  return new Date(`${d}T00:00:00.000Z`);
}

describe('GET /api/v1/categories/timeseries — category key handling (task 0a803329)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: token resolves to user_categories_1's session.
    mocks.prisma.session.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash && args.where.tokenHash === TOKEN_HASH) {
        return SESSION;
      }
      if (args?.where?.id && args.where.id === SESSION.id) {
        return { ...SESSION, user: { id: SESSION.userId, email: 'user@example.com' } };
      }
      return null;
    });
  });

  it('AC1: special category names (constructor, __proto__, toString) round-trip exactly without throwing', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-12'), category: 'constructor', amountCents: 100 },
      { occurredAt: isoDay('2026-10-12'), category: '__proto__', amountCents: 200 },
      { occurredAt: isoDay('2026-10-12'), category: 'toString', amountCents: 300 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    // The exact-string category names must appear as their own keys, and each
    // must hold the single-day total. The bug previously threw on
    // `series[category].push is not a function` for the 'constructor' slot and
    // would have surfaced as a 500. The fix uses Object.create(null) so the
    // inherited Object.prototype keys no longer collide.
    // Bracket notation for `__proto__` — an object literal's `__proto__:`
    // would set the prototype, not an own property, and confuse toEqual.
    const series = res.body.series as Record<string, Array<{ day: string; amountCents: number }>>;
    expect(Object.keys(series).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(series.constructor).toEqual([{ day: '2026-10-12', amountCents: 100 }]);
    expect(series['__proto__']).toEqual([{ day: '2026-10-12', amountCents: 200 }]);
    expect(series.toString).toEqual([{ day: '2026-10-12', amountCents: 300 }]);
  });

  it('AC1: a category whose name contains `|` round-trips exactly (split on first `|` only)', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-12'), category: 'a|b', amountCents: 425 },
      { occurredAt: isoDay('2026-10-12'), category: 'food', amountCents: 1500 },
      { occurredAt: isoDay('2026-10-12'), category: 'a|b|c', amountCents: 77 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    // The bug used `key.split('|')` which truncated 'a|b' to 'a' and 'a|b|c'
    // to 'a' (collapsing the two distinct categories into one bucket). The
    // fix splits on the first `|` only, so the category name round-trips.
    expect(res.body.series).toEqual({
      'a|b': [{ day: '2026-10-12', amountCents: 425 }],
      food: [{ day: '2026-10-12', amountCents: 1500 }],
      'a|b|c': [{ day: '2026-10-12', amountCents: 77 }]
    });
  });

  it('AC2: multi-day, multi-category response preserves per-day totals in day order', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-10'), category: 'food', amountCents: 1000 },
      { occurredAt: isoDay('2026-10-11'), category: 'food', amountCents: 2000 },
      { occurredAt: isoDay('2026-10-10'), category: 'transport', amountCents: 500 },
      { occurredAt: isoDay('2026-10-11'), category: 'transport', amountCents: 600 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({
      food: [
        { day: '2026-10-10', amountCents: 1000 },
        { day: '2026-10-11', amountCents: 2000 }
      ],
      transport: [
        { day: '2026-10-10', amountCents: 500 },
        { day: '2026-10-11', amountCents: 600 }
      ]
    });
  });

  it('AC2: empty data returns an empty series object (no per-day bucket, no error)', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({});
    expect(res.body.from).toBe('2026-10-01T00:00:00.000Z');
    expect(res.body.to).toBe('2026-11-01T00:00:00.000Z');
  });

  it('AC2: a category with multiple same-day transactions aggregates to a single day bucket', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-10'), category: 'food', amountCents: 100 },
      { occurredAt: isoDay('2026-10-10'), category: 'food', amountCents: 250 },
      { occurredAt: isoDay('2026-10-10'), category: 'food', amountCents: 75 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({
      food: [{ day: '2026-10-10', amountCents: 425 }]
    });
  });

  it('AC3: a category originally written through PATCH (constructor, __proto__, toString, a|b) round-trips unchanged through timeseries', async () => {
    // Simulates the PATCH round-trip AC: the rows below are exactly what
    // `transaction.findMany` would return after a PATCH that wrote these
    // exact category names. The response must keep each name intact, with
    // the per-day total, and must not throw.
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-12'), category: 'constructor', amountCents: 100 },
      { occurredAt: isoDay('2026-10-12'), category: '__proto__', amountCents: 200 },
      { occurredAt: isoDay('2026-10-12'), category: 'toString', amountCents: 300 },
      { occurredAt: isoDay('2026-10-12'), category: 'a|b', amountCents: 425 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    // The response shape uses the raw category strings as keys; this is
    // the "round-trips unchanged" guarantee — no truncation, no inherited
    // key collision, no thrown error.
    const series = res.body.series as Record<string, Array<{ day: string; amountCents: number }>>;
    expect(Object.keys(series).sort()).toEqual(['__proto__', 'a|b', 'constructor', 'toString']);
    expect(series.constructor).toEqual([{ day: '2026-10-12', amountCents: 100 }]);
    expect(series.__proto__).toEqual([{ day: '2026-10-12', amountCents: 200 }]);
    expect(series.toString).toEqual([{ day: '2026-10-12', amountCents: 300 }]);
    expect(series['a|b']).toEqual([{ day: '2026-10-12', amountCents: 425 }]);
  });

  it('AC3: null category on a row falls back to "other" (regression — preserved behaviour)', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValueOnce([
      { occurredAt: isoDay('2026-10-12'), category: null, amountCents: 999 }
    ]);

    const res = await request(createApp())
      .get('/api/v1/categories/timeseries?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({
      other: [{ day: '2026-10-12', amountCents: 999 }]
    });
  });
});
