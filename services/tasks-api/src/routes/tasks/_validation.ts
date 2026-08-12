import { DEFAULT_LIMIT, MAX_LIMIT, uuidPattern } from './_constants.ts';
import { WORKFLOW_HANDOFF_ROLE_IDS } from '../../config/workflowHandoffs.ts';

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

export function normalizeWorkflowHandoff(value) {
  if (value === null) return { roleId: null, gate: null, reason: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['roleId', 'gate', 'reason'].includes(key))) return null;
  const roleId = normalizeString(value.roleId);
  if (typeof roleId !== 'string' || !WORKFLOW_HANDOFF_ROLE_IDS.has(roleId)) return null;
  const normalizeOptional = (field) => {
    if (field === undefined || field === null) return null;
    if (typeof field !== 'string') return undefined;
    const normalized = field.trim();
    return normalized.length > 0 && normalized.length <= 500 ? normalized : undefined;
  };
  const gate = normalizeOptional(value.gate);
  const reason = normalizeOptional(value.reason);
  if (gate === undefined || reason === undefined) return null;
  return { roleId, gate, reason };
}

/**
 * Maximum number of attention-owner rows retained per task. The cap keeps
 * the stacked-avatar surface legible (16 distinct people in a stack is the
 * edge of useful) and bounds PATCH payload size without surprising
 * callers. Mirrored in the system spec for the API contract.
 */
export const MAX_ATTENTION_OWNERS = 16;

/**
 * Maximum length of an attention-owner name. Free-form strings mirror
 * `Task.assignee`, which is also free-form on the persistence layer; the
 * cap prevents UI breaks from pathological inputs. The PATCH layer also
 * uses this for `addedBy`.
 */
export const MAX_ATTENTION_OWNER_LENGTH = 64;

/**
 * Validate and normalize an `attentionOwners` PATCH body. Returns:
 *   - `null` when the body shape is invalid (not an array, or contains a
 *     non-string / empty / over-cap entry) so the caller can return 400;
 *   - `{ owners: string[] }` on success, with case-insensitive duplicates
 *     collapsed and original insertion order preserved.
 *
 * Caps and dedup rules match the system spec: max 16 entries, max 64 chars
 * per name, no empty strings. The returned array replaces the existing set
 * verbatim on success (full-replacement semantics — see the tech design).
 */
export function normalizeAttentionOwners(value) {
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_ATTENTION_OWNER_LENGTH) return null;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
    if (normalized.length > MAX_ATTENTION_OWNERS) return null;
  }

  return { owners: normalized };
}

/**
 * Validate a task id from a route param. Returns the trimmed id when it
 * matches the canonical 36-char dashed UUID shape, otherwise null. Routes
 * should map null → 400 INVALID_TASK_ID so a malformed identifier surfaces
 * as a clear client error instead of leaking Prisma's "Inconsistent column
 * data: invalid UUID length" P2023 as a generic 500. The trim is defensive:
 * URL-encoded path segments can carry stray whitespace.
 */
export function parseTaskId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return uuidPattern.test(trimmed) ? trimmed : null;
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
