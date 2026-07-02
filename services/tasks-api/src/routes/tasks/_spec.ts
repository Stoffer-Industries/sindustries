import { createHash } from 'node:crypto';
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

// The `**Approved by Tom**` marker line is owned by the Tasks API. When Tom
// edits ACs after approval, the API accepts the edit but unchecks the marker
// so the lobster can block until Tom re-checks it.
const CHECKED_APPROVAL_MARKER_LINE = /^(\s*-\s*)\[[xX]\](\s+\*\*Approved by Tom\*\*\s*)$/m;
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

export function uncheckApprovalMarker(description) {
  if (!description) return description;
  return description.replace(CHECKED_APPROVAL_MARKER_LINE, '$1[ ]$2');
}

export function descriptionWithSpecDriftApprovalState(task, description) {
  const nextDescription = description ?? task.description;
  if (!task.specChecksum) return nextDescription;
  const current = specChecksumForDescription(nextDescription);
  if (current === task.specChecksum) return nextDescription;
  return uncheckApprovalMarker(nextDescription);
}

