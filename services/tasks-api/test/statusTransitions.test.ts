import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_APPROVAL_REQUIRED,
  QA_APPROVAL_REQUIRED,
  QA_APPROVAL_REVOKED,
  statusTransitionError,
  type StatusTransitionCheck
} from '../src/routes/tasks/_statusTransitions.ts';

// Task `fb5c4e40` AC1/AC4 — unit coverage for the transition guard.
//
// The unit layer owns the decision matrix (which approval state permits
// which transition, and which error code names it). The integration layer
// owns the API-boundary contract (409, task left unchanged).

const CODE_REQUIRED = ['tech_design', 'qa_agent', 'accepted'];
const CONTENT_REQUIRED: string[] = [];

const gateOwners: Record<string, string | null> = {
  spec: 'Tom',
  tech_design: 'Quinn',
  qa_agent: 'Ash',
  accepted: 'Tom'
};

function check(overrides: Partial<StatusTransitionCheck> = {}): StatusTransitionCheck {
  return {
    fromStatus: 'doing',
    toStatus: 'acceptance',
    requiredApprovals: CODE_REQUIRED,
    approvals: [],
    gateOwners,
    ...overrides
  };
}

function approvalRow(type: string, state: string, revokedAt: string | null = null) {
  return { type, state, revokedAt };
}

describe('statusTransitionError — doing → acceptance (qa_agent gate)', () => {
  it('allows the transition when qa_agent is approved and not revoked', () => {
    const error = statusTransitionError(
      check({ approvals: [approvalRow('qa_agent', 'approved')] })
    );
    expect(error).toBeNull();
  });

  it('rejects a pending qa_agent approval with QA_APPROVAL_REQUIRED', () => {
    const error = statusTransitionError(
      check({ approvals: [approvalRow('qa_agent', 'pending')] })
    );
    expect(error?.code).toBe(QA_APPROVAL_REQUIRED);
    expect(error?.status).toBe(409);
  });

  it('rejects a missing qa_agent approval with QA_APPROVAL_REQUIRED', () => {
    const error = statusTransitionError(check({ approvals: [] }));
    expect(error?.code).toBe(QA_APPROVAL_REQUIRED);
    expect(error?.status).toBe(409);
  });

  it('rejects a revoked qa_agent approval with QA_APPROVAL_REVOKED', () => {
    const error = statusTransitionError(
      check({
        approvals: [approvalRow('qa_agent', 'revoked', '2026-11-19T09:00:00.000Z')]
      })
    );
    expect(error?.code).toBe(QA_APPROVAL_REVOKED);
    expect(error?.status).toBe(409);
  });

  it('rejects an approved qa_agent approval that carries a revocation timestamp', () => {
    const error = statusTransitionError(
      check({
        approvals: [approvalRow('qa_agent', 'approved', '2026-11-19T09:00:00.000Z')]
      })
    );
    expect(error?.code).toBe(QA_APPROVAL_REVOKED);
  });

  it('ignores approvals of other types', () => {
    const error = statusTransitionError(
      check({ approvals: [approvalRow('tech_design', 'approved'), approvalRow('accepted', 'approved')] })
    );
    expect(error?.code).toBe(QA_APPROVAL_REQUIRED);
  });

  it('leaves task types that do not require qa_agent unaffected', () => {
    const error = statusTransitionError(
      check({ requiredApprovals: CONTENT_REQUIRED, approvals: [] })
    );
    expect(error).toBeNull();
  });

  it('names the gate owner and the missing approval type in the message', () => {
    const error = statusTransitionError(check({ approvals: [] }));
    expect(error?.message).toContain('qa_agent');
    expect(error?.message).toContain('Ash');
    expect(error?.message).toContain('doing');
    expect(error?.message).toContain('acceptance');
  });
});

describe('statusTransitionError — acceptance → done (accepted gate)', () => {
  it('allows the transition when accepted is approved', () => {
    const error = statusTransitionError(
      check({
        fromStatus: 'acceptance',
        toStatus: 'done',
        approvals: [approvalRow('accepted', 'approved')]
      })
    );
    expect(error).toBeNull();
  });

  it('rejects a pending accepted approval with ACCEPTANCE_APPROVAL_REQUIRED', () => {
    const error = statusTransitionError(
      check({
        fromStatus: 'acceptance',
        toStatus: 'done',
        approvals: [approvalRow('accepted', 'pending')]
      })
    );
    expect(error?.code).toBe(ACCEPTANCE_APPROVAL_REQUIRED);
    expect(error?.status).toBe(409);
  });

  it('rejects a missing accepted approval with ACCEPTANCE_APPROVAL_REQUIRED', () => {
    const error = statusTransitionError(
      check({ fromStatus: 'acceptance', toStatus: 'done', approvals: [] })
    );
    expect(error?.code).toBe(ACCEPTANCE_APPROVAL_REQUIRED);
  });

  it('rejects a revoked accepted approval', () => {
    const error = statusTransitionError(
      check({
        fromStatus: 'acceptance',
        toStatus: 'done',
        approvals: [approvalRow('accepted', 'revoked', '2026-11-19T09:00:00.000Z')]
      })
    );
    expect(error?.code).toBe(ACCEPTANCE_APPROVAL_REQUIRED);
  });

  it('leaves task types that do not require an accepted approval unaffected', () => {
    const error = statusTransitionError(
      check({
        fromStatus: 'acceptance',
        toStatus: 'done',
        requiredApprovals: CONTENT_REQUIRED,
        approvals: []
      })
    );
    expect(error).toBeNull();
  });
});

describe('statusTransitionError — transitions that stay allowed', () => {
  it('allows the acceptance → doing rollback', () => {
    const error = statusTransitionError(
      check({
        fromStatus: 'acceptance',
        toStatus: 'doing',
        approvals: [approvalRow('qa_agent', 'pending')]
      })
    );
    expect(error).toBeNull();
  });

  it('allows open → acceptance', () => {
    const error = statusTransitionError(
      check({ fromStatus: 'open', toStatus: 'acceptance', approvals: [] })
    );
    expect(error).toBeNull();
  });

  it('allows doing → done without touching the qa_agent gate', () => {
    const error = statusTransitionError(
      check({ fromStatus: 'doing', toStatus: 'done', approvals: [] })
    );
    expect(error).toBeNull();
  });

  it('allows a status write that does not change the status', () => {
    const error = statusTransitionError(
      check({ fromStatus: 'doing', toStatus: 'doing', approvals: [] })
    );
    expect(error).toBeNull();
  });
});
