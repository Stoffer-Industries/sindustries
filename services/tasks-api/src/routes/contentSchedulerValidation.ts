const MAX_BODY = 1000;

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validSources = new Set(['ops_notes', 'cto_craft', 'manual', 'other']);
export const validStatuses = new Set(['draft', 'queued', 'approved', 'published', 'removed']);

export function parseId(raw: string): string | null {
  return uuidPattern.test(raw) ? raw : null;
}

export function parseDate(value: unknown): Date | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value as string);
  return Number.isNaN(d.valueOf()) ? 'invalid' : d;
}

export function validateBody(body: unknown): string | null {
  if (typeof body !== 'string') return 'body must be a string';
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'body must not be empty';
  if (body.length > MAX_BODY) return `body must be <= ${MAX_BODY} characters`;
  return null;
}
