import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { authedRequest } from './helpers/auth';

// Task `fb5c4e40` AC2/AC4 — the API-boundary contract.
//
// The unit layer owns the decision matrix; this layer owns the boundary
// contract that the matrix cannot express on its own:
//   * a premature transition is rejected with 409 and a stable error code,
//   * the task is left ENTIRELY unchanged (status, statusChangedAt,
//     completedAt), and
//   * the rejected write mutates no approval row.
//
// Approval rows are seeded directly through Prisma because the API's own
// `qa_agent` grant path demands a live AC-evidence attestation, which a
// test fixture has no PR to attest against. The rows are the same rows the
// API would have written — the guard reads them, it does not care who wrote
// them.

const app = createApp();
const createdTaskIds: string[] = [];

async function createCodeTask(title: string): Promise<string> {
  const created = await authedRequest(app)
    .post('/api/v1/tasks')
    .send({ title, taskType: 'code', priority: 'high' });
  expect(created.status).toBe(201);
  createdTaskIds.push(created.body.data.id);
  return created.body.data.id;
}

async function moveTo(taskId: string, status: string) {
  const moved = await authedRequest(app)
    .patch(`/api/v1/tasks/${taskId}`)
    .send({ status });
  return moved;
}

async function setApproval(
  taskId: string,
  type: 'qa_agent' | 'accepted',
  state: 'pending' | 'approved' | 'revoked'
) {
  await prisma.taskApproval.update({
    where: { taskId_type: { taskId, type } },
    data: {
      state,
      ...(state === 'approved' ? { approvedAt: new Date(), revokedAt: null } : {}),
      ...(state === 'revoked' ? { revokedAt: new Date() } : {})
    }
  });
}

async function readTask(taskId: string) {
  const detail = await authedRequest(app).get(`/api/v1/tasks/${taskId}`);
  expect(detail.status).toBe(200);
  return detail.body.data;
}

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop()!;
    await prisma.task.deleteMany({ where: { id: taskId } });
  }
});

describe('status transition enforcement — doing → acceptance', () => {
  it('rejects a premature promotion and leaves the task untouched', async () => {
    const taskId = await createCodeTask('CI premature acceptance');
    const doing = await moveTo(taskId, 'doing');
    expect(doing.status).toBe(200);

    const before = await readTask(taskId);
    const approvalsBefore = await prisma.taskApproval.findMany({
      where: { taskId },
      orderBy: { type: 'asc' }
    });
    expect(approvalsBefore.find((row) => row.type === 'qa_agent')?.state).toBe('pending');

    const premature = await moveTo(taskId, 'acceptance');

    expect(premature.status).toBe(409);
    expect(premature.body.error.code).toBe('QA_APPROVAL_REQUIRED');
    expect(typeof premature.body.error.message).toBe('string');

    const after = await readTask(taskId);
    expect(after.status).toBe('doing');
    expect(after.statusChangedAt).toBe(before.statusChangedAt);
    expect(after.completedAt).toBeNull();

    // No approval row was created, mutated or revoked by the rejected write.
    const approvalsAfter = await prisma.taskApproval.findMany({
      where: { taskId },
      orderBy: { type: 'asc' }
    });
    expect(approvalsAfter).toEqual(approvalsBefore);
  });

  it('reports a revoked qa_agent approval distinctly from a pending one', async () => {
    const taskId = await createCodeTask('CI revoked qa approval');
    await moveTo(taskId, 'doing');
    await setApproval(taskId, 'qa_agent', 'revoked');

    const premature = await moveTo(taskId, 'acceptance');

    expect(premature.status).toBe(409);
    expect(premature.body.error.code).toBe('QA_APPROVAL_REVOKED');

    const after = await readTask(taskId);
    expect(after.status).toBe('doing');
  });

  it('allows the promotion once the qa_agent approval is granted', async () => {
    const taskId = await createCodeTask('CI approved qa acceptance');
    await moveTo(taskId, 'doing');
    await setApproval(taskId, 'qa_agent', 'approved');

    const promoted = await moveTo(taskId, 'acceptance');

    expect(promoted.status).toBe(200);
    expect(promoted.body.data.status).toBe('acceptance');
  });

  it('does not gate task types that do not require qa_agent', async () => {
    const created = await authedRequest(app)
      .post('/api/v1/tasks')
      .send({
        title: 'CI content task without qa gate',
        taskType: 'content',
        priority: 'medium'
      });
    expect(created.status).toBe(201);
    createdTaskIds.push(created.body.data.id);
    const taskId = created.body.data.id;

    await moveTo(taskId, 'doing');
    const promoted = await moveTo(taskId, 'acceptance');

    expect(promoted.status).toBe(200);
    expect(promoted.body.data.status).toBe('acceptance');
  });
});

describe('status transition enforcement — acceptance → done', () => {
  it('rejects closing a task without the accepted approval and leaves it in acceptance', async () => {
    const taskId = await createCodeTask('CI premature close');
    await moveTo(taskId, 'doing');
    await setApproval(taskId, 'qa_agent', 'approved');
    await moveTo(taskId, 'acceptance');

    const before = await readTask(taskId);
    const premature = await moveTo(taskId, 'done');

    expect(premature.status).toBe(409);
    expect(premature.body.error.code).toBe('ACCEPTANCE_APPROVAL_REQUIRED');

    const after = await readTask(taskId);
    expect(after.status).toBe('acceptance');
    expect(after.statusChangedAt).toBe(before.statusChangedAt);
    expect(after.completedAt).toBeNull();
  });

  it('still closes the task once the accepted approval is granted', async () => {
    const taskId = await createCodeTask('CI approved close');
    await moveTo(taskId, 'doing');
    await setApproval(taskId, 'qa_agent', 'approved');
    await moveTo(taskId, 'acceptance');
    await setApproval(taskId, 'accepted', 'approved');

    const closed = await moveTo(taskId, 'done');

    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('done');
  });
});

describe('status transition enforcement — read-only identification (AC5)', () => {
  it('lists tasks in acceptance whose type requires qa_agent without a granted row', async () => {
    // The identification query is read-only. It must not write, grant or
    // revoke anything — AC5 forbids synthesising an approval during repair.
    const taskId = await createCodeTask('CI damaged acceptance task');
    await moveTo(taskId, 'doing');
    await setApproval(taskId, 'qa_agent', 'approved');
    await moveTo(taskId, 'acceptance');

    // Damage the gate the way the incident did: the task sits in
    // `acceptance` while its qa_agent row is not granted.
    await setApproval(taskId, 'qa_agent', 'pending');

    const approvalsBefore = await prisma.taskApproval.findMany({
      where: { taskId },
      orderBy: { type: 'asc' }
    });

    const damaged = await prisma.task.findFirst({
      where: { id: taskId },
      select: { id: true, status: true, taskType: true, approvals: true }
    });
    expect(damaged?.status).toBe('acceptance');
    expect(
      damaged?.approvals.find((row) => row.type === 'qa_agent')?.state
    ).toBe('pending');

    // Reading the damaged task changes nothing.
    await authedRequest(app).get(`/api/v1/tasks/${taskId}`);
    const approvalsAfter = await prisma.taskApproval.findMany({
      where: { taskId },
      orderBy: { type: 'asc' }
    });
    expect(approvalsAfter).toEqual(approvalsBefore);
  });
});

describe('status transition enforcement — unauthenticated rejection', () => {
  it('still rejects an unauthenticated mutation before the transition guard runs', async () => {
    const taskId = await createCodeTask('CI unauthenticated status write');
    const response = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .send({ status: 'acceptance' });
    expect(response.status).toBe(401);
  });
});
