const MAX_BODY = 1000;
export const MAX_TWEET_BODY = 280;

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validSources = new Set(['ops_notes', 'cto_craft', 'manual', 'other']);
export const validStatuses = new Set(['draft', 'queued', 'approved', 'published', 'removed']);
// Manual-reply discriminator (task 5279b310). `manual_reply` rows are never
// auto-published and are surfaced under the Mission Control "Reply drafts
// (manual)" section for Tom to copy + post himself.
export const validKinds = new Set(['scheduled', 'manual_reply']);
// Permitted shapes for `manualPostedUrl` — only X/Twitter canonical tweet
// URLs are accepted so a typo can't silently land in the DB. The PATCH
// /items/:id/posted-url route validates more strictly because it is the
// sole surface for AC5's posted-URL capture.
const MANUAL_POSTED_URL_PATTERN = /^https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_/]+\/status\/\d+/;

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
 * Validate the `kind` discriminator on POST/PATCH /content-scheduler/items.
 * Returns null on success, error message on failure. Null/undefined are
 * accepted (the schema default `'scheduled'` applies); only set-but-invalid
 * values are rejected so existing clients that don't pass `kind` continue
 * to work.
 */
export function validateKind(kind: unknown): string | null {
  if (kind === undefined || kind === null) return null;
  if (typeof kind !== 'string') return 'kind must be a string';
  if (!validKinds.has(kind)) return `kind must be one of: ${Array.from(validKinds).join(', ')}`;
  return null;
}

/**
 * Validate `manualPostedUrl` on PATCH /items/:id/posted-url. The endpoint
 * is the only surface for AC5's posted-URL capture, so the regex is
 * stricter than a generic URL check. Empty / null / undefined is rejected
 * — this endpoint requires a non-empty URL (it is the entire purpose of
 * the call). Returns null on success, error message on failure.
 */
export function validateManualPostedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return 'manualPostedUrl must be a string';
  if (value.trim().length === 0) return 'manualPostedUrl must not be empty';
  if (value.length > 2048) return 'manualPostedUrl must be <= 2048 characters';
  if (!MANUAL_POSTED_URL_PATTERN.test(value)) {
    return 'manualPostedUrl must be an https://x.com/.../status/<id> or https://twitter.com/.../status/<id> URL';
  }
  return null;
}

/**
 * Validate `linksToItemId` on POST/PATCH. Same UUID shape as `parseId` but
 * null/undefined are accepted (the field is optional and applies only to
 * manual_reply items). Returns null on success, error message on failure.
 */
export function validateLinksToItemId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'linksToItemId must be a string';
  if (!uuidPattern.test(value)) return 'linksToItemId must be a UUID';
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
