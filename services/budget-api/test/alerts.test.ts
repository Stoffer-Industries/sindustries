import { describe, expect, it, vi } from 'vitest';

const created: any[] = [];

vi.mock('../src/lib/prisma.ts', () => {
  return {
    prisma: {
      linkedCard: { findMany: vi.fn() },
      cardMonthlyBudget: { findUnique: vi.fn() },
      transaction: { findMany: vi.fn() },
      notificationEvent: { create: vi.fn(async ({ data }: any) => {
        const rec = { id: `e${created.length + 1}`, ...data };
        created.push(rec);
        return rec;
      }) }
    }
  };
});

import { prisma } from '../src/lib/prisma.ts';
import { evaluateAlertsForUser } from '../src/services/alerts.ts';

describe('evaluateAlertsForUser', () => {
  it('creates deduped events per stage crossed', async () => {
    created.length = 0;

    (prisma.linkedCard.findMany as any).mockResolvedValueOnce([
      { id: 'c1', userId: 'u1' }
    ]);

    (prisma.cardMonthlyBudget.findUnique as any).mockResolvedValue({
      monthlyLimitCents: 10_000
    });

    // spend = 10,000 cents => crosses 80/95/100
    (prisma.transaction.findMany as any).mockResolvedValueOnce([
      { amountCents: 4_000 },
      { amountCents: 6_000 }
    ]);

    const res = await evaluateAlertsForUser({ userId: 'u1', month: '2026-04' });
    expect(res.createdEventIds.length).toBe(3);
    expect(created.map((e) => e.stage)).toEqual(['warning80', 'warning95', 'breached100']);

    // If we run again and unique constraint triggers, service should not create duplicates.
    // Simulate Prisma unique error on create.
    (prisma.linkedCard.findMany as any).mockResolvedValueOnce([{ id: 'c1', userId: 'u1' }]);
    (prisma.cardMonthlyBudget.findUnique as any).mockResolvedValueOnce({ monthlyLimitCents: 10_000 });
    (prisma.transaction.findMany as any).mockResolvedValueOnce([{ amountCents: 10_000 }]);
    (prisma.notificationEvent.create as any).mockImplementationOnce(() => {
      const err: any = new Error('unique');
      err.code = 'P2002';
      throw err;
    });
    (prisma.notificationEvent.create as any).mockImplementationOnce(() => {
      const err: any = new Error('unique');
      err.code = 'P2002';
      throw err;
    });
    (prisma.notificationEvent.create as any).mockImplementationOnce(() => {
      const err: any = new Error('unique');
      err.code = 'P2002';
      throw err;
    });

    const res2 = await evaluateAlertsForUser({ userId: 'u1', month: '2026-04' });
    expect(res2.createdEventIds.length).toBe(0);
  });
});

