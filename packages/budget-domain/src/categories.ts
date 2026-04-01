export const Categories = [
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
] as const;

export type Category = (typeof Categories)[number];

export function isCategory(value: string): value is Category {
  return (Categories as readonly string[]).includes(value);
}

export function normalizeMerchantKey(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .slice(0, 80);
}

