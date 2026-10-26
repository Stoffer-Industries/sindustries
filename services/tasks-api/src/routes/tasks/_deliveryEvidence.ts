// Delivery-evidence rule shared by the list and detail projections.
//
// The `qa_agent` gate is dormant while Lobster's latest delivery-evidence
// sweep still carries an unresolved failure. That rule used to live only in
// `_mapper.ts` and read the task's full comment list. The list route never
// loaded comments, so the rule saw an empty list there, found no
// `[lobster-state]` marker, and reported the gate as outstanding on tasks
// whose gate was actually dormant (task 7db08a30).
//
// This module owns the rule *and* the marker vocabulary it reads, so the
// database query that selects comments and the rule that interprets them
// cannot drift apart. The rule is driven by the marker constants below, so
// every marker the rule can read is by construction also in
// `DELIVERY_EVIDENCE_MARKERS` — the list query's filter therefore selects a
// superset of the comments the rule reads, which is what makes the list and
// detail projections agree (see `deliveryEvidence.test.ts`).

const LOBSTER_STATE_MARKER = '[lobster-state]';
const IMPLEMENTER_PRS_MARKER = '[implementer-prs]';
const IMPLEMENTER_PRS_MARKER_ALT = '[rowan-prs]';
const CHECKLIST_MARKERS = [
  '[feature-task-progress-checklist]',
  '[code-task-progress-checklist]'
] as const;
const BLOCKED_MARKERS = [
  '[feature-task-blocked]',
  '[code-task-blocked]'
] as const;
const QA_SUPPRESSION_MARKERS = [
  '[qa-agent-blocked]',
  '[qa-agent-deferred]'
] as const;

/**
 * Every comment marker the delivery-evidence rule reads.
 *
 * The list route selects comments with `deliveryEvidenceCommentWhere()`,
 * which matches any comment whose body *contains* one of these markers. The
 * rule itself matches some markers at line level, so `contains` is the
 * superset that preserves the rule's semantics exactly.
 */
export const DELIVERY_EVIDENCE_MARKERS: readonly string[] = [
  LOBSTER_STATE_MARKER,
  IMPLEMENTER_PRS_MARKER,
  IMPLEMENTER_PRS_MARKER_ALT,
  ...CHECKLIST_MARKERS,
  ...BLOCKED_MARKERS,
  ...QA_SUPPRESSION_MARKERS
];

/**
 * JS mirror of the Prisma marker filter: does this comment carry any
 * delivery-evidence marker? Used to derive the marker subset in tests and by
 * any caller that filters comments in memory.
 */
export function isDeliveryEvidenceComment(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return DELIVERY_EVIDENCE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Prisma `where` fragment selecting only the comments the delivery-evidence
 * rule can read. This is the bounded comment access the list route uses: the
 * full comment history of every listed task is never loaded (task 7db08a30,
 * AC4).
 */
export function deliveryEvidenceCommentWhere() {
  return {
    OR: DELIVERY_EVIDENCE_MARKERS.map((marker) => ({ body: { contains: marker } }))
  };
}

function commentText(comment): string {
  const text = comment?.body ?? comment?.text ?? '';
  return typeof text === 'string' ? text : '';
}

function hasMarkerAtLineStart(text: string, marker: string): boolean {
  return text.split('\n').some((line) => line.trimStart().startsWith(marker));
}

/**
 * The QA gate is normal next-stage work only after Lobster has accepted the
 * current delivery evidence. A failed delivery checklist is authoritative
 * for actionability until a later Lobster state clears it; exposing Ash from
 * status alone makes the verifier appear actionable while the implementer is
 * still being asked for evidence.
 *
 * Takes the comment list (raw Prisma rows or mapped comment objects) and
 * returns whether delivery evidence currently blocks the `qa_agent` gate.
 */
export function deliveryEvidenceBlocksQa(comments): boolean {
  const list = Array.isArray(comments) ? comments : [];
  let stateIndex = -1;
  let stateHasFailure = false;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const text = commentText(list[index]);
    if (!text.startsWith(LOBSTER_STATE_MARKER)) continue;
    stateIndex = index;
    const jsonText = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1];
    if (!jsonText) return false;
    try {
      const state = JSON.parse(jsonText);
      stateHasFailure = typeof state.failureFingerprint === 'string'
        && state.failureFingerprint.trim().length > 0;
    } catch {
      return false;
    }
    break;
  }
  if (stateIndex < 0 || !stateHasFailure) return false;

  // A fresh delivery marker after a failed state also needs a new Lobster
  // evidence pass before Ash can become actionable.
  if (list.slice(stateIndex + 1).some((comment) => {
    const text = commentText(comment);
    return hasMarkerAtLineStart(text, IMPLEMENTER_PRS_MARKER)
      || hasMarkerAtLineStart(text, IMPLEMENTER_PRS_MARKER_ALT);
  })) return true;

  for (let index = stateIndex; index >= 0; index -= 1) {
    const text = commentText(list[index]);
    if (QA_SUPPRESSION_MARKERS.some((marker) => hasMarkerAtLineStart(text, marker))) return false;
    if (CHECKLIST_MARKERS.some((marker) => hasMarkerAtLineStart(text, marker))) return true;
    if (BLOCKED_MARKERS.some((marker) => hasMarkerAtLineStart(text, marker))) return true;
  }
  return false;
}
