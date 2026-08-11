import { createHash } from 'node:crypto';
import { acceptanceCriteriaText } from './_validation.ts';

// Spec-checksum helpers extracted from tasks.ts. Encapsulates the canonical
// form used for AC drift detection and the 409 SPEC_CHECKSUM_MISMATCH path.
//
// The legacy `- [x] **Approved by Tom**` approval checkbox in task descriptions
// is no longer preserved, auto-unchecked, or rewritten by this surface (per
// task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574`). Approval state is structured
// via `TaskApproval` rows; the lobster reads that structured state, not this
// markdown. Brain-spec and bookmark-spec file-level markers are preserved in
// their own workflows (`agents/workflows/bookmarks` etc.) — this file never
// touched those.

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

/**
 * Return whether a proposed description changes the AC checksum already stored
 * on the task.
 *
 * Note: marker-only approval edits (e.g. Tom toggling `- [x] **Approved by Tom**`)
 * are intentionally detected as drift here. Approval state is now structured
 * via `TaskApproval` rows; this function compares the canonical AC text only,
 * so a marker-only edit produces a different checksum and will be caught by
 * the SPEC_CHECKSUM_MISMATCH guard. Tom must re-issue the spec approval via
 * the structured endpoint after editing ACs, not by toggling the marker.
 */
export function descriptionHasSpecDrift(task, description) {
  if (!task.specChecksum) return false;
  return specChecksumForDescription(description ?? '') !== task.specChecksum;
}