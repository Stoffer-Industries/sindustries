import { createHash } from 'node:crypto';
import { sendError } from '../../lib/http.ts';
import { acceptanceCriteriaText } from './_validation.ts';

// Spec-checksum helpers extracted from tasks.ts. Encapsulates the canonical
// form used for AC drift detection and the 409 SPEC_CHECKSUM_MISMATCH path.

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function specChecksumForDescription(description) {
  const canonical = canonicalize({ acceptanceCriteria: acceptanceCriteriaText(description) });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function specDriftMessage(taskId, stored, current) {
  return `ACs modified after spec approval -- write a new spec to change scope. Task ${taskId} stored specChecksum \`${stored}\` but current AC checksum is \`${current}\`.`;
}

export function rejectSpecDrift(res, task, description) {
  if (!task.specChecksum) return false;
  const current = specChecksumForDescription(description ?? task.description);
  if (current === task.specChecksum) return false;
  sendError(res, 409, 'SPEC_CHECKSUM_MISMATCH', specDriftMessage(task.id, task.specChecksum, current));
  return true;
}
