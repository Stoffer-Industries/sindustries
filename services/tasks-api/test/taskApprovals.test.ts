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

  it('lets feature_task_lobster create/revoke the qa_agent bootstrap row but nothing else', async () => {
    const app = createApp();
    prismaMock.task.findUnique.mockResolvedValue(activeTask);
    prismaMock.taskApproval.findUnique.mockResolvedValue(null);
    prismaMock.taskApproval.upsert.mockResolvedValue(approval({ type: 'qa_agent', owner: 'feature_task_lobster' }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const created = await request(app).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(LOBSTER_TOKEN)).send({ type: 'qa_agent' });
    expect(created.status).toBe(200);
    expect(prismaMock.taskApproval.upsert.mock.calls[0][0].create.owner).toBe('feature_task_lobster');

    prismaMock.taskApproval.findUnique.mockResolvedValue(approval({ type: 'qa_agent', owner: 'feature_task_lobster' }));
    prismaMock.taskApproval.update.mockResolvedValue(approval({ type: 'qa_agent', owner: 'feature_task_lobster', state: 'revoked' }));
    const revoked = await request(app).delete(`/api/v1/tasks/${TASK_ID}/approvals/qa_agent`).set(auth(LOBSTER_TOKEN));
    expect(revoked.status).toBe(200);

    const spec = await request(app).post(`/api/v1/tasks/${TASK_ID}/approvals`).set(auth(LOBSTER_TOKEN)).send({ type: 'spec' });
    expect(spec.status).toBe(403);
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
