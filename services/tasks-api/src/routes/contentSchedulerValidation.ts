const MAX_BODY = 1000;
export const MAX_TWEET_BODY = 280;

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

/**
 * Validate the request body for POST /content-scheduler/imports/cto-craft.
 *
 * Rules per docs/specs/cto-craft-tweet-pipeline-tech-design.md:
 *   - 1–5 items per batch
 *   - each body must be a non-empty string <= 280 characters (tweet cap)
 *   - each sourceRef must be a distinct canonical http(s) URL
 *   - issueRef and evidenceExcerpt are accepted but optional; used for
 *     structured logs and future provenance
 *
 * Returns null on success, or a short error message on failure.
 */
export type ImportItemInput = {
  body: unknown;
  sourceRef: unknown;
  issueRef?: unknown;
  evidenceExcerpt?: unknown;
};

export function validateImportItem(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'item must be an object';
  const item = input as ImportItemInput;

  if (typeof item.body !== 'string' || item.body.trim().length === 0) {
    return 'item.body must be a non-empty string';
  }
  if (item.body.length > MAX_TWEET_BODY) {
    return `item.body must be <= ${MAX_TWEET_BODY} characters`;
  }

  if (typeof item.sourceRef !== 'string' || item.sourceRef.length === 0) {
    return 'item.sourceRef must be a non-empty string';
  }
  if (!/^https?:\/\//i.test(item.sourceRef)) {
    return 'item.sourceRef must be an http(s) URL';
  }

  if (
    item.issueRef !== undefined &&
    item.issueRef !== null &&
    (typeof item.issueRef !== 'string' || !/^https?:\/\//i.test(item.issueRef))
  ) {
    return 'item.issueRef must be an http(s) URL when present';
  }

  if (
    item.evidenceExcerpt !== undefined &&
    item.evidenceExcerpt !== null &&
    typeof item.evidenceExcerpt !== 'string'
  ) {
    return 'item.evidenceExcerpt must be a string when present';
  }

  return null;
}

export function validateImportItems(items: unknown): string | null {
  if (!Array.isArray(items)) return 'items must be an array';
  if (items.length < 1 || items.length > 5) return 'items must contain 1–5 entries';

  const refs = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const err = validateImportItem(items[i]);
    if (err) return `items[${i}]: ${err}`;
    const ref = (items[i] as ImportItemInput).sourceRef as string;
    if (refs.has(ref)) return `items[${i}]: duplicate sourceRef ${ref}`;
    refs.add(ref);
  }
  return null;
}
