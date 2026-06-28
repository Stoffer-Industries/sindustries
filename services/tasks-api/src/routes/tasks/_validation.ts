import { DEFAULT_LIMIT, MAX_LIMIT, uuidPattern } from './_constants.ts';

// Validation helpers extracted from tasks.ts. Pure functions — no side
// effects; all errors are returned to the caller via return values so the
// caller decides how to respond.

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function parseLimit(value) {
  const n = Number.parseInt(value ?? `${DEFAULT_LIMIT}`, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return null;
  const normalized = tags
    .map((tag) => normalizeString(tag))
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());

  return [...new Set(normalized)];
}

export function normalizeDependsOnIds(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const seen = new Set();

  for (const id of value) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) return null;
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  return normalized;
}

export function acceptanceCriteriaText(description) {
  if (!description) return [];
  const criteria = [];
  const re = /^\s*-\s*\[[ xX]\]\s+(.+)$/gm;
  let match;
  while ((match = re.exec(description)) !== null) {
    criteria.push(match[1].trim());
  }
  return criteria;
}
