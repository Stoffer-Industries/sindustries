import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Set service credentials BEFORE the dynamic import of app.ts (which
// transitively imports approvalAuth.ts) so the module-load-time parse
// in approvalAuth captures the test credentials instead of an empty value.
process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  { token: 'tom-service-token-long-enough', actor: 'Tom', approvalTypes: ['spec', 'accepted'] },
  { token: 'quinn-service-token-long-enough', actor: 'Quinn', approvalTypes: ['tech_design'] },
  { token: 'lobster-service-token-long-enough', actor: 'feature_task_lobster', approvalTypes: ['qa_agent'] }
]);

const prismaMock = {
  task: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  taskComment: { create: vi.fn() },
  taskTag: { deleteMany: vi.fn(), createMany: vi.fn() }, tag: { findMany: vi.fn(), upsert: vi.fn() },
  taskDependency: { findFirst: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  taskApproval: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  approvalSession: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn()
};
vi.mock('../src/lib/prisma.ts', () => ({ prisma: prismaMock }));
const { createApp } = await import('../src/app.ts');
// `attentionOwnersForApproval` is a pure helper exported from taskApprovals.ts
// for direct AC3 unit coverage. Dynamic-imported alongside `createApp` above
// so the top-level `prismaMock` binding has been initialised by the time
// taskApprovals.ts transitively pulls the mocked prisma module.
const { attentionOwnersForApproval } = await import('../src/routes/taskApprovals.ts');

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const TOM_TOKEN = 'tom-service-token-long-enough';
const QUINN_TOKEN = 'quinn-service-token-long-enough';
const LOBSTER_TOKEN = 'lobster-service-token-long-enough';
const TOM_SESSION = 'tom-browser-session-long-enough';
const activeTask = {
  id: TASK_ID,
  status: 'ready',
  archivedAt: null,
  taskType: 'feature',
  workflowHandoffRoleId: null,
  workflowHandoffGate: null,
  workflowHandoffReason: null
};
function approval(overrides = {}) { return { id: 'a1', taskId: TASK_ID, type: 'spec', owner: 'Tom', state: 'approved', approvedAt: new Date('2026-08-08T04:00:00Z'), revokedAt: null, note: null, createdAt: new Date(), updatedAt: new Date(), ...overrides }; }
function auth(token = TOM_TOKEN) { return { Authorization: `Bearer ${token}` }; }

describe('task approval boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.approvalSession.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });

  it('keeps reads public', async () => {
    prismaMock.task.findFirst.mockResolvedValue({ id: TASK_ID, approvals: [approval()] });
    const res = await request(createApp()).get(`/api/v1/tasks/${TASK_ID}/approvals`);
    expect(res.status).toBe(200); expect(res.body.data[0].owner).toBe('Tom');
  });

  it('rejects an unauthenticated mutation before database access', async () => {
    // The general-mutation auth gate (task 0719a8e3) runs ahead of the
    // approval-specific gate; an unauthenticated request now returns 401
    // AUTH_REQUIRED before reaching the approval-route handler. The intent
    // (rejected before any DB access) is preserved — see
    // requireAuthenticatedUser in src/middleware/requireAuth.ts.
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).send({ type: 'spec' });
    expect(res.status).toBe(401); expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a durable unexpired browser session cookie', async () => {
    prismaMock.approvalSession.findUnique.mockResolvedValue({ actor: 'Tom', expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval()); prismaMock.taskComment.create.mockResolvedValue({});
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set('Cookie', `tasks_api_session=${TOM_SESSION}`).send({ type: 'spec' });
    expect(res.status).toBe(200); expect(prismaMock.taskApproval.upsert).toHaveBeenCalled();
  });

  it('enforces Tom-only spec/accepted and Quinn-only tech_design', async () => {
    const app = createApp();
    const tomTech = await request(app).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'tech_design' });
    const quinnSpec = await request(app).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(QUINN_TOKEN)).send({ type: 'spec' });
    expect(tomTech.status).toBe(403); expect(quinnSpec.status).toBe(403); expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a body owner and derives owner from the credential', async () => {
    const forged = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec', owner: 'Quinn' });
    expect(forged.status).toBe(400); expect(forged.body.error.code).toBe('FORGEABLE_APPROVAL_OWNER');
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval()); prismaMock.taskComment.create.mockResolvedValue({});
    await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });
    expect(prismaMock.taskApproval.upsert.mock.calls[0][0].create.owner).toBe('Tom');
  });

  it.each([{ ...activeTask, status: 'done' }, { ...activeTask, archivedAt: new Date() }])('makes done/archived tasks immutable', async (task) => {
    prismaMock.task.findUnique.mockResolvedValue(task);
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });
    expect(res.status).toBe(409); expect(res.body.error.code).toBe('TASK_IMMUTABLE'); expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
  });

  it('writes approval and exact ordinary audit comment in one transaction', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval()); prismaMock.taskComment.create.mockResolvedValue({});
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });
    expect(res.status).toBe(200); expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith({ data: { taskId: TASK_ID, author: 'Tom', body: 'Approval spec approved by Tom.' } });
  });

  it('clears a matching workflow handoff in the approval transaction', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      workflowHandoffRoleId: 'product_spec_approver',
      workflowHandoffGate: 'spec',
      workflowHandoffReason: 'Product spec approval is required'
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval());
    prismaMock.task.update.mockResolvedValue({});
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });

    expect(res.status).toBe(200);
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: {
        workflowHandoffRoleId: null,
        workflowHandoffGate: null,
        workflowHandoffReason: null
      }
    });
  });

  it('does not clear an unrelated workflow handoff when approving another gate', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      workflowHandoffRoleId: 'qa_verifier',
      workflowHandoffGate: 'qa',
      workflowHandoffReason: 'QA approval is required'
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval());
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });

    expect(res.status).toBe(200);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('rolls back/surfaces failure when the audit insert fails', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('audit failed'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });
    expect(res.status).toBe(500); expect(prismaMock.$transaction).toHaveBeenCalledTimes(1); spy.mockRestore();
  });

  it('POST of the identical approved state is a no-op without restamping or commenting', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(approval());
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'spec' });
    expect(res.status).toBe(200); expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled(); expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
  });

  it('DELETE revokes atomically and audits the server-derived actor', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(approval());
    prismaMock.taskApproval.update.mockResolvedValue(approval({ state: 'revoked', revokedAt: new Date() })); prismaMock.taskComment.create.mockResolvedValue({});
    const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}/approvals/spec`).set(auth());
    expect(res.status).toBe(200); expect(prismaMock.taskComment.create).toHaveBeenCalledWith({ data: { taskId: TASK_ID, author: 'Tom', body: 'Approval spec revoked by Tom.' } });
  });

  it('restores the required workflow handoff in the revocation transaction', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask);
    prismaMock.taskApproval.findUnique.mockResolvedValue(approval());
    prismaMock.taskApproval.update.mockResolvedValue(approval({ state: 'revoked', revokedAt: new Date() }));
    prismaMock.task.update.mockResolvedValue({});
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}/approvals/spec`).set(auth());

    expect(res.status).toBe(200);
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: {
        workflowHandoffRoleId: 'product_spec_approver',
        workflowHandoffGate: 'spec',
        workflowHandoffReason: 'Product spec approval is required'
      }
    });
  });

  it.each([null, approval({ state: 'revoked', revokedAt: new Date() })])('DELETE is an idempotent no-op with no comment', async (existing) => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask); prismaMock.taskApproval.findUnique.mockResolvedValue(existing);
    const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}/approvals/spec`).set(auth());
    expect(res.status).toBe(200); expect(prismaMock.taskApproval.update).not.toHaveBeenCalled(); expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
  });

  it('lists the canonical approval-type vocabulary in the 400 error message', async () => {
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_APPROVAL_TYPE');
    expect(res.body.error.message).toContain('accepted');
    expect(res.body.error.message).toContain('qa_agent');
    expect(res.body.error.message).toContain('spec');
    expect(res.body.error.message).toContain('tech_design');
  });
});

describe('attentionOwners reconciliation on structured approval (task 45a759ac)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.approvalSession.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });

  // Helpers to keep the test fixtures compact and readable.
  function attentionOwnersFromList(owners: string[]) {
    return owners.map((owner, position) => ({
      id: `ao-${position}`,
      taskId: TASK_ID,
      owner,
      position,
      addedBy: null,
      note: null,
      createdAt: new Date('2026-08-08T04:00:00Z')
    }));
  }
  function updateArgs() {
    expect(prismaMock.task.update).toHaveBeenCalledTimes(1);
    return prismaMock.task.update.mock.calls[0][0];
  }

  it('approved gate whose owner matches the head removes only the head and preserves the tail (AC1 positive)', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      workflowHandoffRoleId: 'tech_design_approver',
      workflowHandoffGate: 'tech_design',
      workflowHandoffReason: 'Tech design approval is required',
      attentionOwners: attentionOwnersFromList(['Quinn', 'Rowan', 'Tom'])
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn' }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(QUINN_TOKEN)).send({ type: 'tech_design' });
    expect(res.status).toBe(200);

    const args = updateArgs();
    expect(args.data.workflowHandoffRoleId).toBeNull();
    expect(args.data.workflowHandoffGate).toBeNull();
    expect(args.data.workflowHandoffReason).toBeNull();
    expect(args.data).not.toHaveProperty('status');
    expect(args.data.attentionOwners).toEqual({
      deleteMany: {},
      createMany: {
        data: [
          { owner: 'Rowan', position: 0 },
          { owner: 'Tom', position: 1 }
        ]
      }
    });
  });

  it('approved gate whose owner does NOT match the head leaves attentionOwners alone (AC1 negative / AC3 other-types)', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      // No active handoff gate (so workflowHandoffFields are null), and the
      // head is Rowan (the assignee) — not Quinn — so the attentionOwners
      // head-slot pop must NOT fire. The next lobster sweep will reconcile.
      attentionOwners: attentionOwnersFromList(['Rowan', 'Quinn'])
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn' }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(QUINN_TOKEN)).send({ type: 'tech_design' });
    expect(res.status).toBe(200);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('accepted approval by Tom in acceptance removes Tom from the head and does not change task.status (AC2)', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      status: 'acceptance',
      workflowHandoffRoleId: 'product_spec_approver', // accepted gate uses the same roleId as spec per APPROVAL_WORKFLOW_HANDOFFS — but here we're testing the attentionOwners path
      workflowHandoffGate: 'accepted',
      workflowHandoffReason: 'Final acceptance is required',
      attentionOwners: attentionOwnersFromList(['Tom', 'Lox'])
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval({ type: 'accepted', owner: 'Tom' }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth()).send({ type: 'accepted' });
    expect(res.status).toBe(200);

    const args = updateArgs();
    // The no-premature-done guarantee: the API write MUST NOT include a
    // `status` field. The lobster's acceptance-to-done gate still owns the
    // status transition on its next sweep.
    expect(args.data).not.toHaveProperty('status');
    expect(args.data.attentionOwners).toEqual({
      deleteMany: {},
      createMany: {
        data: [{ owner: 'Lox', position: 0 }]
      }
    });
  });

  it('POST of the identical approved state is idempotent and still writes the attentionOwners delta on the first call (AC3 idempotency)', async () => {
    const withAttention = {
      ...activeTask,
      workflowHandoffRoleId: 'tech_design_approver',
      workflowHandoffGate: 'tech_design',
      workflowHandoffReason: 'Tech design approval is required',
      attentionOwners: attentionOwnersFromList(['Quinn', 'Rowan'])
    };
    const existingApproval = approval({ type: 'tech_design', owner: 'Quinn' });
    prismaMock.task.findUnique.mockResolvedValue(withAttention);
    prismaMock.taskApproval.findUnique.mockResolvedValue(existingApproval);

    // First (idempotent) call: no upsert, no audit comment, but the
    // handoff + attentionOwners delta still applies because the existing
    // approval satisfies the gate and the head still matches.
    const res = await request(createApp()).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(QUINN_TOKEN)).send({ type: 'tech_design' });
    expect(res.status).toBe(200);
    expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
    expect(prismaMock.taskComment.create).not.toHaveBeenCalled();

    const args = updateArgs();
    expect(args.data.attentionOwners).toEqual({
      deleteMany: {},
      createMany: { data: [{ owner: 'Rowan', position: 0 }] }
    });
  });

  it('revoking a gate re-prepends the owner when the head does NOT match and the owner is absent (AC1 symmetric / AC3 atomicity)', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      // Head is Rowan (the assignee) — not Quinn — so revoking tech_design
      // must prepend Quinn back onto the routing stack while the gate is
      // open again. The handoff field is also restored because tech_design
      // is required for feature tasks.
      attentionOwners: attentionOwnersFromList(['Rowan'])
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn' }));
    prismaMock.taskApproval.update.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn', state: 'revoked', revokedAt: new Date() }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}/approvals/tech_design`).set(auth(QUINN_TOKEN));
    expect(res.status).toBe(200);

    const args = updateArgs();
    expect(args.data.workflowHandoffRoleId).toBe('tech_design_approver');
    expect(args.data.workflowHandoffGate).toBe('tech_design');
    expect(args.data.workflowHandoffReason).toBe('Tech design approval is required');
    expect(args.data.attentionOwners).toEqual({
      deleteMany: {},
      createMany: { data: [{ owner: 'Quinn', position: 0 }, { owner: 'Rowan', position: 1 }] }
    });
  });

  it('revoking a gate whose owner is already at the head is a no-op for attentionOwners (AC3 idempotency)', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      workflowHandoffRoleId: 'tech_design_approver',
      workflowHandoffGate: 'tech_design',
      workflowHandoffReason: 'Tech design approval is required',
      // Quinn is already at the head — revoking must NOT prepend a
      // duplicate Quinn. The handoff field still re-sets because revoking
      // always restores the required gate.
      attentionOwners: attentionOwnersFromList(['Quinn', 'Rowan'])
    });
    prismaMock.taskApproval.findUnique.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn' }));
    prismaMock.taskApproval.update.mockResolvedValue(approval({ type: 'tech_design', owner: 'Quinn', state: 'revoked', revokedAt: new Date() }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}/approvals/tech_design`).set(auth(QUINN_TOKEN));
    expect(res.status).toBe(200);

    const args = updateArgs();
    expect(args.data.workflowHandoffRoleId).toBe('tech_design_approver');
    expect(args.data.attentionOwners).toBeUndefined();
  });
});

describe('attentionOwnersForApproval pure helper (task 45a759ac AC3 other-types)', () => {
  // The `qa_agent` row is materialised by `POST /tasks` and the lobster, not
  // by the approval route, so there's no end-to-end route flow to assert the
  // "head != owner → no-op" behaviour through. The pure-helper cases below
  // pin down the matrix the route handler relies on; they make the contract
  // explicit and protect the qa_agent mapping from accidental fan-out.
  it('returns null when current attentionOwners is empty (avoid colliding with the lobster initial-population sweep)', () => {
    expect(attentionOwnersForApproval([], 'qa_agent', 'approved')).toBeNull();
    expect(attentionOwnersForApproval([], 'qa_agent', 'revoked')).toBeNull();
    expect(attentionOwnersForApproval([], 'tech_design', 'revoked')).toBeNull();
    expect(attentionOwnersForApproval([], 'accepted', 'revoked')).toBeNull();
  });

  it('pops the head case-insensitively on approval when it matches the type owner and preserves tail entries', () => {
    expect(attentionOwnersForApproval(['quinn', 'Rowan', 'Tom'], 'tech_design', 'approved')).toEqual(['Rowan', 'Tom']);
    expect(attentionOwnersForApproval(['ASH', 'Quinn'], 'qa_agent', 'approved')).toEqual(['Quinn']);
    expect(attentionOwnersForApproval(['Tom', 'Lox'], 'accepted', 'approved')).toEqual(['Lox']);
  });

  it('returns null on approval when the head does NOT match the type owner', () => {
    // Covers qa_agent (Ash), tech_design (Quinn), spec (Tom), and accepted
    // (Tom) against heads that don't line up — all must remain a no-op so
    // the lobster's next sweep is the only writer that touches them.
    expect(attentionOwnersForApproval(['Rowan', 'Quinn'], 'qa_agent', 'approved')).toBeNull();
    expect(attentionOwnersForApproval(['Rowan', 'Quinn'], 'tech_design', 'approved')).toBeNull();
    expect(attentionOwnersForApproval(['Quinn', 'Ash'], 'spec', 'approved')).toBeNull();
    expect(attentionOwnersForApproval(['Rowan', 'Quinn'], 'accepted', 'approved')).toBeNull();
  });

  it('re-prepends the owner on revoke when the owner is absent from the stack and the head does not match', () => {
    expect(attentionOwnersForApproval(['Rowan'], 'tech_design', 'revoked')).toEqual(['Quinn', 'Rowan']);
    expect(attentionOwnersForApproval(['Rowan', 'Tom'], 'spec', 'revoked')).toEqual(['Tom', 'Rowan', 'Tom']);
  });

  it('returns null on revoke when the owner is already at the head', () => {
    // Position 0 is the sole routing signal; the head-match guard above
    // already covers the idempotent-revoke case. Any earlier presence lower
    // in the stack must NOT suppress the prepend — see the next test.
    expect(attentionOwnersForApproval(['Quinn', 'Rowan'], 'tech_design', 'revoked')).toBeNull();
    expect(attentionOwnersForApproval(['Ash', 'Rowan', 'Tom'], 'qa_agent', 'revoked')).toBeNull();
  });

  it('re-prepends the owner on revoke even when the owner is present elsewhere in the stack', () => {
    // Mirrors the lobster's head-only routing invariant: only position 0
    // routes actionably, so the gate-owner must sit at the head while their
    // gate is open even if a stale tail entry already names them. Duplicate
    // tail entries are tolerated by the lobster's reconciled sweep.
    expect(attentionOwnersForApproval(['Rowan', 'Ash', 'Tom'], 'qa_agent', 'revoked')).toEqual([
      'Ash',
      'Rowan',
      'Ash',
      'Tom'
    ]);
    expect(attentionOwnersForApproval(['Rowan', 'Tom'], 'spec', 'revoked')).toEqual(['Tom', 'Rowan', 'Tom']);
  });
});

describe('TASKS_API_APPROVAL_SERVICE_CREDENTIALS module-load validation', () => {
  // Re-import approvalAuth.ts with a controlled env value, capturing any
  // thrown error from the module-load-time IIFE. Restores the previous env
  // and resets the module cache so subsequent tests reuse the original
  // (good) module captured at file load.
  async function importApprovalAuthWith(envValue: string | undefined) {
    vi.resetModules();
    const prev = process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
    if (envValue === undefined) delete process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
    else process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = envValue;
    try {
      return await import('../src/middleware/approvalAuth.ts');
    } finally {
      if (prev === undefined) delete process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
      else process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = prev;
      vi.resetModules();
    }
  }

  it('throws at module load when credentials env is not valid JSON', async () => {
    await expect(importApprovalAuthWith('{not-json')).rejects.toThrow(/must be valid JSON/);
  });

  it('throws at module load when credentials env is not a JSON array', async () => {
    const object = JSON.stringify({ token: 'a'.repeat(20), actor: 'Tom', approvalTypes: ['spec'] });
    await expect(importApprovalAuthWith(object)).rejects.toThrow(/must be a JSON array/);
  });

  it('throws at module load when an entry is invalid', async () => {
    const badEntry = JSON.stringify([{ token: 'short', actor: 'Tom', approvalTypes: ['spec'] }]);
    await expect(importApprovalAuthWith(badEntry)).rejects.toThrow(/TASKS_API_APPROVAL_SERVICE_CREDENTIALS\[0\] is invalid/);
  });

  it('loads cleanly when credentials env is a valid array', async () => {
    const valid = JSON.stringify([{ token: 'a'.repeat(20), actor: 'Tom', approvalTypes: ['spec', 'accepted'] }]);
    await expect(importApprovalAuthWith(valid)).resolves.toBeDefined();
  });
});
