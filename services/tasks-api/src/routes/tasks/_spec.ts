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

// The `**Approved by Tom**` marker line that the lobster toggles during the
// fluid AC lifecycle. Toggling it does NOT change the AC checksum (it lives
// outside the acceptance criteria block).
const APPROVAL_MARKER_LINE = /^\s*-\s*\[[ xX]\]\s+\*\*Approved by Tom\*\*\s*$/;

function stripApprovalMarker(text) {
  return (text ?? '')
    .split('\n')
    .filter((line) => !APPROVAL_MARKER_LINE.test(line))
    .join('\n')
    .replace(/\n+$/, '')
    .trimEnd();
}

/**
 * Return `true` when the only textual difference between two descriptions is
 * the checkbox state of the `**Approved by Tom**` approval marker.
 *
 * Used to allow the lobster to PATCH the description to uncheck the marker
 * even after spec approval, without compromising the spec-checksum guard on
 * real AC drift.
 */
export function descriptionsDifferOnlyByApprovalMarker(oldDescription, newDescription) {
  return stripApprovalMarker(oldDescription ?? '') === stripApprovalMarker(newDescription ?? '');
}

export function rejectSpecDrift(res, task, description) {
  if (!task.specChecksum) return false;
  const current = specChecksumForDescription(description ?? task.description);
  if (current === task.specChecksum) return false;
  // Marker-only exception: the lobster is unchecking `**Approved by Tom**`
  // as part of the fluid AC lifecycle. The AC text is byte-identical so the
  // drift is intentional and the checksum guard must not fire.
  if (descriptionsDifferOnlyByApprovalMarker(task.description, description)) {
    return false;
  }
  sendError(res, 409, 'SPEC_CHECKSUM_MISMATCH', specDriftMessage(task.id, task.specChecksum, current));
  return true;
}
