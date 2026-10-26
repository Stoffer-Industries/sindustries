import { describe, expect, it } from 'vitest';

const {
  DELIVERY_EVIDENCE_MARKERS,
  deliveryEvidenceBlocksQa,
  deliveryEvidenceCommentWhere,
  isDeliveryEvidenceComment
} = await import('../src/routes/tasks/_deliveryEvidence.ts');

function comment(body: string, createdAt = '2026-10-27T00:00:00.000Z') {
  return {
    id: `comment-${createdAt}-${body.slice(0, 8)}`,
    body,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt)
  };
}

function failedState(fingerprint: string | null) {
  return comment(
    `[lobster-state]\n\`\`\`json\n{"version":1,"failureFingerprint":${fingerprint === null ? 'null' : JSON.stringify(fingerprint)}}\n\`\`\``
  );
}

/**
 * The fixture corpus mirrors the delivery-evidence states the Lobster
 * produces. Each entry must keep its expected verdict so the parity
 * assertion below cannot pass by both sides being wrong.
 */
const CORPUS: Array<{ name: string; comments: Array<ReturnType<typeof comment>>; blocked: boolean }> = [
  {
    name: 'failed state plus a delivery checklist',
    comments: [
      comment('[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/1'),
      comment('[code-task-progress-checklist]\nMissing `[implementer-prs]` comment.'),
      failedState('Missing `[implementer-prs]` comment.')
    ],
    blocked: true
  },
  {
    name: 'failed state plus a fresh implementer-prs marker',
    comments: [
      failedState('delivery evidence missing'),
      comment('[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/2')
    ],
    blocked: true
  },
  {
    name: 'failed state with an explicit qa-agent-blocked marker',
    comments: [
      comment('[qa-agent-blocked]\nStructured qa_agent approval is outstanding.'),
      failedState('qa approval missing')
    ],
    blocked: false
  },
  {
    name: 'clean state with no failure fingerprint',
    comments: [
      comment('[implementer-prs] https://github.com/Stoffer-Industries/sindustries/pull/3'),
      failedState(null)
    ],
    blocked: false
  },
  {
    name: 'no lobster state at all',
    comments: [
      comment('Just a human note about the task.'),
      comment('[code-task-progress-checklist]\nNothing delivered yet.')
    ],
    blocked: false
  },
  {
    name: 'failed state with only non-marker comments around it',
    comments: [
      comment('Human chatter before the state.'),
      failedState('delivery evidence missing'),
      comment('Human chatter after the state.')
    ],
    blocked: false
  }
];

describe('deliveryEvidenceBlocksQa — verdict per fixture', () => {
  it.each(CORPUS)('$name', ({ comments, blocked }) => {
    expect(deliveryEvidenceBlocksQa(comments)).toBe(blocked);
  });

  it('treats a missing comment list as unblocked', () => {
    expect(deliveryEvidenceBlocksQa(undefined)).toBe(false);
    expect(deliveryEvidenceBlocksQa([])).toBe(false);
  });
});

describe('delivery evidence marker subset — list/detail parity invariant', () => {
  /**
   * The list route loads only marker-bearing comments. The rule must reach
   * the same verdict on that subset as on the full comment history — that is
   * what makes the list and detail projections agree (task 7db08a30, AC1).
   */
  it.each(CORPUS)('marker subset matches the full list: $name', ({ comments, blocked }) => {
    const subset = comments.filter((entry) => isDeliveryEvidenceComment(entry.body));
    expect(deliveryEvidenceBlocksQa(subset)).toBe(blocked);
  });

  it('drops comments without a marker from the subset', () => {
    const comments = [comment('Human chatter.'), failedState('delivery evidence missing')];
    const subset = comments.filter((entry) => isDeliveryEvidenceComment(entry.body));
    expect(subset).toHaveLength(1);
    expect(subset[0].body).toContain('[lobster-state]');
  });

  it('keeps every marker the rule reads inside the shared marker vocabulary', () => {
    // The rule and the Prisma filter are two readers of one vocabulary. A
    // marker used by the rule but missing from the vocabulary would silently
    // break list/detail parity, so the vocabulary is asserted explicitly.
    expect([...DELIVERY_EVIDENCE_MARKERS].sort()).toEqual([
      '[code-task-blocked]',
      '[code-task-progress-checklist]',
      '[feature-task-blocked]',
      '[feature-task-progress-checklist]',
      '[implementer-prs]',
      '[lobster-state]',
      '[qa-agent-blocked]',
      '[qa-agent-deferred]',
      '[rowan-prs]'
    ]);
  });
});

describe('deliveryEvidenceCommentWhere — bounded comment access', () => {
  it('selects comments whose body contains any delivery-evidence marker', () => {
    expect(deliveryEvidenceCommentWhere()).toEqual({
      OR: DELIVERY_EVIDENCE_MARKERS.map((marker) => ({ body: { contains: marker } }))
    });
  });

  it('matches the same comments in memory as the query matches in the database', () => {
    const bodies = [
      '[lobster-state]\n```json\n{}\n```',
      '[code-task-progress-checklist]\nmissing evidence',
      '[qa-agent-blocked]\napproval outstanding',
      '[implementer-prs] https://example.test/pr/1',
      'plain human note',
      'mentions [implementer-prs] in prose'
    ];
    for (const body of bodies) {
      const matchedInMemory = isDeliveryEvidenceComment(body);
      const matchedInQuery = DELIVERY_EVIDENCE_MARKERS.some((marker) => body.includes(marker));
      expect(matchedInMemory).toBe(matchedInQuery);
    }
  });
});
