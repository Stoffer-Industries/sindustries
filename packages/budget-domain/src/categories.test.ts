import { describe, expect, it } from 'vitest';

import { Categories, isCategory } from './categories';

describe('Categories taxonomy', () => {
  it('exposes the documented public list', () => {
    // Snapshot of the public taxonomy exported from @sindustries/budget-domain.
    // Consumed by services/budget-api (categories router + categorization) and
    // apps/budget-mobile (picker UI). Any change here is a contract change
    // visible to both consumers.
    expect(Categories).toEqual([
      'groceries',
      'dining',
      'transport',
      'shopping',
      'utilities',
      'entertainment',
      'health',
      'travel',
      'subscriptions',
      'fees',
      'transfers',
      'other'
    ]);
  });

  it('round-trips every value through isCategory', () => {
    for (const value of Categories) {
      expect(isCategory(value)).toBe(true);
    }
  });

  it('rejects non-Category strings', () => {
    expect(isCategory('not-a-category')).toBe(false);
    expect(isCategory('')).toBe(false);
    expect(isCategory('GROCERIES')).toBe(false);
  });
});
