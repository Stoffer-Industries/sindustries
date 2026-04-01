import { describe, expect, it } from 'vitest';

import { evaluateMonthlyCardBudget } from './budgets';

describe('evaluateMonthlyCardBudget', () => {
  it('returns no stages when under 80%', () => {
    const r = evaluateMonthlyCardBudget({ spendCents: 79, limitCents: 100 });
    expect(r.stagesCrossed).toEqual([]);
  });

  it('returns warning stages at 80% and 95%', () => {
    const r = evaluateMonthlyCardBudget({ spendCents: 95, limitCents: 100 });
    expect(r.stagesCrossed).toEqual(['warning80', 'warning95']);
  });

  it('returns breached at 100%', () => {
    const r = evaluateMonthlyCardBudget({ spendCents: 100, limitCents: 100 });
    expect(r.stagesCrossed).toEqual(['warning80', 'warning95', 'breached100']);
  });
});

