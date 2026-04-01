import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.ts', () => {
  return {
    prisma: {
      categorizationFeedback: {
        findFirst: vi.fn()
      }
    }
  };
});

import { categorizeTransaction } from '../src/services/categorizer.ts';
import { prisma } from '../src/lib/prisma.ts';

describe('categorizeTransaction', () => {
  it('uses feedback rule when available', async () => {
    (prisma.categorizationFeedback.findFirst as any).mockResolvedValueOnce({
      correctedCategory: 'groceries'
    });

    const res = await categorizeTransaction({
      userId: 'u1',
      merchant: 'New World',
      description: 'Groceries'
    });

    expect(res.source).toBe('rule');
    expect(res.category).toBe('groceries');
    expect(res.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to model heuristic when no feedback', async () => {
    (prisma.categorizationFeedback.findFirst as any).mockResolvedValueOnce(null);

    const res = await categorizeTransaction({
      userId: 'u1',
      merchant: 'Uber',
      description: 'Trip'
    });

    expect(res.source).toBe('model');
    expect(res.category).toBe('transport');
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

