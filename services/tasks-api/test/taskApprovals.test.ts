import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  task: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  taskComment: {
    create: vi.fn()
  },
  taskTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  tag: {
    findMany: vi.fn(),
    upsert: vi.fn()
  },
  taskDependency: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  taskApproval: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TASK_ID = '99999999-9999-9999-9999-999999999999';

function approvalFixture(overrides = {}) {
  return {
    id: 'approval-1',
    taskId: TASK_ID,
    type: 'spec',
    owner: 'Tom',
    state: 'approved',
    approvedAt: new Date('2026-08-08T04:00:00.000Z'),
    revokedAt: null,
    note: null,
    createdAt: new Date('2026-08-08T04:00:00.000Z'),
    updatedAt: new Date('2026-08-08T04:00:00.000Z'),
    ...overrides
  };
}

describe('task approval routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
  });

  it('GET /api/v1/tasks/:id/approvals lists approvals for a task', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.findMany.mockResolvedValueOnce([
      approvalFixture({ type: 'spec' }),
      approvalFixture({ id: 'approval-2', type: 'tech_design', owner: 'Quinn' })
    ]);

    const app = createApp();
    const response = await request(app).get(`/api/v1/tasks/${TASK_ID}/approvals`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({
      id: 'approval-1',
      type: 'spec',
      owner: 'Tom',
      state: 'approved',
      revokedAt: null,
      note: null
    });
    expect(response.body.data[1]).toMatchObject({ type: 'tech_design', owner: 'Quinn' });
    expect(prismaMock.taskApproval.findMany).toHaveBeenCalledWith({
      where: { taskId: TASK_ID },
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }]
    });
  });

  it('GET /api/v1/tasks/:id/approvals returns empty list when task has no approvals', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.findMany.mockResolvedValueOnce([]);

    const app = createApp();
    const response = await request(app).get(`/api/v1/tasks/${TASK_ID}/approvals`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('GET /api/v1/tasks/:id/approvals returns 404 when task is missing', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app).get(`/api/v1/tasks/${OTHER_TASK_ID}/approvals`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
    });
    expect(prismaMock.taskApproval.findMany).not.toHaveBeenCalled();
  });

  it('GET /api/v1/tasks/:id/approvals rejects malformed task id', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/tasks/not-a-uuid/approvals');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TASK_ID');
    expect(prismaMock.task.findFirst).not.toHaveBeenCalled();
  });

  it('POST /api/v1/tasks/:id/approvals creates a new approval', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(
      approvalFixture({ id: 'approval-1', owner: 'Tom', note: 'Looks good' })
    );

    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom', note: 'Looks good' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      type: 'spec',
      owner: 'Tom',
      state: 'approved',
      note: 'Looks good'
    });
    expect(prismaMock.taskApproval.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.taskApproval.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ taskId_type: { taskId: TASK_ID, type: 'spec' } });
    expect(call.create).toMatchObject({ taskId: TASK_ID, type: 'spec', owner: 'Tom', note: 'Looks good' });
    expect(call.create.state).toBe('approved');
    expect(call.create.approvedAt).toBeInstanceOf(Date);
    expect(call.update).toMatchObject({ owner: 'Tom', note: 'Looks good', state: 'approved', revokedAt: null });
    expect(call.update.approvedAt).toBeInstanceOf(Date);
  });

  it('POST /api/v1/tasks/:id/approvals is idempotent — re-approving updates owner/note/approvedAt', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(
      approvalFixture({ owner: 'Quinn', approvedAt: new Date('2026-08-09T01:00:00.000Z') })
    );

    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Quinn' });

    expect(response.status).toBe(200);
    expect(response.body.data.owner).toBe('Quinn');
    const call = prismaMock.taskApproval.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ taskId_type: { taskId: TASK_ID, type: 'spec' } });
  });

  it('POST /api/v1/tasks/:id/approvals trims whitespace from owner and note', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(approvalFixture());

    const app = createApp();
    await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: '  Tom  ', note: '  ok  ' });

    const call = prismaMock.taskApproval.upsert.mock.calls[0][0];
    expect(call.create.owner).toBe('Tom');
    expect(call.create.note).toBe('ok');
  });

  it('POST /api/v1/tasks/:id/approvals treats absent note as null', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(approvalFixture());

    const app = createApp();
    await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom' });

    const call = prismaMock.taskApproval.upsert.mock.calls[0][0];
    expect(call.create.note).toBeNull();
  });

  it('POST /api/v1/tasks/:id/approvals rejects invalid approval type', async () => {
    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'invalid', owner: 'Tom' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_APPROVAL_TYPE', message: 'type must be one of: spec, tech_design, qa' }
    });
    expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
  });

  it('POST /api/v1/tasks/:id/approvals rejects missing owner', async () => {
    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('APPROVAL_OWNER_REQUIRED');
    expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
  });

  it('POST /api/v1/tasks/:id/approvals rejects whitespace-only owner', async () => {
    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('APPROVAL_OWNER_REQUIRED');
  });

  it('POST /api/v1/tasks/:id/approvals rejects non-string note', async () => {
    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom', note: 42 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_APPROVAL_NOTE');
  });

  it('POST /api/v1/tasks/:id/approvals returns 404 when task is missing', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${OTHER_TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom' });

    expect(response.status).toBe(404);
    expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
  });

  it('POST /api/v1/tasks/:id/approvals does not modify task description or create a comment', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(approvalFixture());

    const app = createApp();
    await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom' });

    expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/tasks/:id/approvals/:type revokes an existing approval', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.findUnique.mockResolvedValueOnce(approvalFixture());
    prismaMock.taskApproval.update.mockResolvedValueOnce(
      approvalFixture({
        state: 'revoked',
        revokedAt: new Date('2026-08-09T02:00:00.000Z')
      })
    );

    const app = createApp();
    const response = await request(app).delete(`/api/v1/tasks/${TASK_ID}/approvals/spec`);

    expect(response.status).toBe(200);
    expect(response.body.data.state).toBe('revoked');
    expect(response.body.data.revokedAt).toBe('2026-08-09T02:00:00.000Z');
    const updateCall = prismaMock.taskApproval.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ taskId_type: { taskId: TASK_ID, type: 'spec' } });
    expect(updateCall.data.state).toBe('revoked');
    expect(updateCall.data.revokedAt).toBeInstanceOf(Date);
  });

  it('DELETE /api/v1/tasks/:id/approvals/:type is a no-op when no approval row exists', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.findUnique.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app).delete(`/api/v1/tasks/${TASK_ID}/approvals/spec`);

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(prismaMock.taskApproval.update).not.toHaveBeenCalled();
    expect(prismaMock.taskApproval.upsert).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/tasks/:id/approvals/:type rejects invalid type', async () => {
    const app = createApp();
    const response = await request(app).delete(`/api/v1/tasks/${TASK_ID}/approvals/invalid`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_APPROVAL_TYPE');
    expect(prismaMock.taskApproval.findUnique).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/tasks/:id/approvals/:type returns 404 when task is missing', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await request(app).delete(`/api/v1/tasks/${OTHER_TASK_ID}/approvals/spec`);

    expect(response.status).toBe(404);
    expect(prismaMock.taskApproval.findUnique).not.toHaveBeenCalled();
  });

  it('GET /api/v1/tasks/:id embeds approvals in the response', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({
      id: TASK_ID,
      title: 'Task with approvals',
      description: null,
      status: 'ready',
      statusChangedAt: new Date('2026-08-08T04:00:00.000Z'),
      priority: 'urgent',
      dueAt: null,
      completedAt: null,
      assignee: null,
      archivedAt: null,
      blocked: false,
      specChecksum: null,
      createdAt: new Date('2026-08-08T04:00:00.000Z'),
      updatedAt: new Date('2026-08-08T04:00:00.000Z'),
      tags: [],
      dependencies: [],
      comments: [],
      approvals: [
        approvalFixture({ type: 'spec', owner: 'Tom' }),
        approvalFixture({ id: 'approval-2', type: 'tech_design', owner: 'Quinn' })
      ]
    });

    const app = createApp();
    const response = await request(app).get(`/api/v1/tasks/${TASK_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.data.approvals).toHaveLength(2);
    expect(response.body.data.approvals[0]).toMatchObject({ type: 'spec', owner: 'Tom' });
    expect(response.body.data.approvals[1]).toMatchObject({ type: 'tech_design', owner: 'Quinn' });
  });

  it('GET /api/v1/tasks list endpoint embeds approvals on each row', async () => {
    prismaMock.task.findMany.mockResolvedValueOnce([
      {
        id: TASK_ID,
        title: 'Task A',
        description: null,
        status: 'ready',
        statusChangedAt: new Date('2026-08-08T04:00:00.000Z'),
        priority: 'urgent',
        dueAt: null,
        completedAt: null,
        assignee: null,
        archivedAt: null,
        blocked: false,
        specChecksum: null,
        createdAt: new Date('2026-08-08T04:00:00.000Z'),
        updatedAt: new Date('2026-08-08T04:00:00.000Z'),
        tags: [],
        dependencies: [],
        approvals: [approvalFixture({ type: 'spec', owner: 'Tom' })]
      }
    ]);

    const app = createApp();
    const response = await request(app).get('/api/v1/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data[0].approvals).toHaveLength(1);
    expect(response.body.data[0].approvals[0]).toMatchObject({ type: 'spec', owner: 'Tom' });
  });

  it('POST /api/v1/tasks/:id/approvals path does not collide with PATCH /tasks/:id (different route shape)', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID });
    prismaMock.taskApproval.upsert.mockResolvedValueOnce(approvalFixture());

    const app = createApp();
    const response = await request(app)
      .post(`/api/v1/tasks/${TASK_ID}/approvals`)
      .send({ type: 'spec', owner: 'Tom' });

    expect(response.status).toBe(200);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });
});
