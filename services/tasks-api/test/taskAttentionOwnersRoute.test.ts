import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for the per-row attention-owner endpoints
 * (`taskAttentionOwnersRouter`) — closes AC1-AC5 of task `91864257`.
 *
 * Mirrors the route-layer prisma mock pattern from taskApprovals.test.ts.
 * Authentication comes from service credentials defined in this file
 * (the setup.ts default only ships IntegrationTest + Quinn).
 */

process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  {
    token: 'integration-test-token-long-enough',
    actor: 'IntegrationTest',
    approvalTypes: []
  },
  {
    token: 'quinn-test-token-long-enough',
    actor: 'Quinn',
    approvalTypes: ['tech_design']
  },
  {
    token: 'tom-test-token-long-enough',
    actor: 'Tom',
    approvalTypes: ['spec', 'accepted']
  },
  {
    token: 'rowan-test-token-long-enough',
    actor: 'Rowan',
    approvalTypes: []
  },
  {
    token: 'anonymous-test-token',
    actor: '',
    approvalTypes: []
  }
]);

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const prismaMock = {
  task: {
    findFirst: vi.fn(),
    findUnique: vi.fn()
  },
  taskAttentionOwner: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn()
  },
  taskComment: {
    create: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

const QUINN_TOKEN = 'quinn-test-token-long-enough';
const TOM_TOKEN = 'tom-test-token-long-enough';
const ROWAN_TOKEN = 'rowan-test-token-long-enough';
function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function attentionRowFixture(overrides = {}) {
  return {
    id: 'ao-1',
    taskId: TASK_ID,
    owner: 'Quinn',
    position: 0,
    addedBy: 'Quinn',
    note: 'needs eyes on the spec revision',
    createdAt: new Date('2026-09-24T00:00:00Z'),
    ...overrides
  };
}

function taskFixture(overrides = {}) {
  return {
    id: TASK_ID,
    title: 'Sample task',
    description: null,
    status: 'doing',
    statusChangedAt: new Date('2026-09-24T00:00:00.000Z'),
    priority: 'medium',
    assignee: 'Rowan',
    dueAt: null,
    completedAt: null,
    archivedAt: null,
    blocked: false,
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    updatedAt: new Date('2026-09-24T00:00:00.000Z'),
    taskType: 'feature',
    specChecksum: null,
    workflowHandoffRoleId: null,
    workflowHandoffGate: null,
    workflowHandoffReason: null,
    tags: [],
    approvals: [],
    dependsOn: [],
    dependencies: [],
    attentionOwners: [attentionRowFixture()],
    ...overrides
  };
}

describe('POST /tasks/:id/attention-owners (task 91864257 AC2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires an authenticated session', async () => {
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners`)
      .set(auth('bogus-token'))
      .send({ owner: 'Quinn', note: 'reason' });
    expect(response.status).toBe(401);
  });

  it('returns 400 when note is missing', async () => {
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners`)
      .set(auth(QUINN_TOKEN))
      .send({ owner: 'Quinn' });
    expect(response.status).toBe(400);
    expect(response.body?.error?.code).toBe('INVALID_ATTENTION_OWNER_NOTE');
  });

  it('returns 400 when note is empty / whitespace', async () => {
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners`)
      .set(auth(QUINN_TOKEN))
      .send({ owner: 'Quinn', note: '   ' });
    expect(response.status).toBe(400);
  });

  it('rejects case-insensitive duplicates (AC2 — note required, no silent dedupe on per-row path)', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({ attentionOwners: [attentionRowFixture()] }));
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([attentionRowFixture()]);
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners`)
      .set(auth(QUINN_TOKEN))
      .send({ owner: 'quinn', note: 'second reason' });
    expect(response.status).toBe(400);
    expect(response.body?.error?.code).toBe('DUPLICATE_ATTENTION_OWNER');
  });

  it('inserts at position 0 by default and emits an audit comment', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [attentionRowFixture()] }))
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [attentionRowFixture()] }));
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([attentionRowFixture()]);
    prismaMock.taskAttentionOwner.create.mockResolvedValue(attentionRowFixture({
      id: 'ao-new',
      owner: 'Tom',
      position: 0
    }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners`)
      .set(auth(TOM_TOKEN))
      .send({ owner: 'Tom', note: 'tom needs context' });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ owner: 'Tom', position: 0, addedBy: 'Tom', note: 'tom needs context' })
    }));
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ body: expect.stringContaining('added at position 0 by Tom: tom needs context') })
    }));
  });
});

describe('POST /tasks/:id/attention-owners/self-resolve (task 91864257 AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller is not the top-of-stack owner', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({
      attentionOwners: [attentionRowFixture({ owner: 'Quinn', position: 0 })]
    }));
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners/self-resolve`)
      .set(auth(ROWAN_TOKEN))
      .send({});
    expect(response.status).toBe(403);
    expect(response.body?.error?.code).toBe('NOT_TOP_OWNER');
  });

  it('returns 403 when the attention stack is empty', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({ attentionOwners: [] }));
    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners/self-resolve`)
      .set(auth(QUINN_TOKEN))
      .send({});
    expect(response.status).toBe(403);
    expect(response.body?.error?.code).toBe('NO_ACTIVE_BLOCKER');
  });

  it('removes only the top slot and preserves later rows (AC5)', async () => {
    const top = attentionRowFixture({ id: 'ao-top', owner: 'Quinn', position: 0 });
    const second = attentionRowFixture({ id: 'ao-2', owner: 'Rowan', position: 1 });
    const third = attentionRowFixture({ id: 'ao-3', owner: 'Tom', position: 2 });
    prismaMock.task.findFirst
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [top, second, third] }))
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [second, third] }));
    // findMany is called twice: once for the post-delete `remaining` snapshot,
    // and the implementation reads remaining[0]?.owner for nextTopOwner. We
    // hand the implementation the post-delete list directly so the assertion
    // on nextTopOwner matches what the response body actually reports.
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([second, third]);
    prismaMock.taskAttentionOwner.delete.mockResolvedValue(top);
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners/self-resolve`)
      .set(auth(QUINN_TOKEN))
      .send({ note: 'unblocked' });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.delete).toHaveBeenCalledWith({ where: { id: 'ao-top' } });
    expect(response.body?.resolved).toBe('Quinn');
    expect(response.body?.nextTopOwner).toBe('Rowan');
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ body: expect.stringContaining('Attention blocker for Quinn resolved') })
    }));
  });

  it('Tom can resolve on behalf of any top (override path)', async () => {
    const top = attentionRowFixture({ id: 'ao-top', owner: 'Quinn', position: 0 });
    prismaMock.task.findFirst
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [top] }))
      .mockResolvedValueOnce(taskFixture({ attentionOwners: [] }));
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([]);
    prismaMock.taskAttentionOwner.delete.mockResolvedValue(top);
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .post(`/api/v1/tasks/${TASK_ID}/attention-owners/self-resolve`)
      .set(auth(TOM_TOKEN))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body?.resolved).toBe('Quinn');
  });
});

describe('DELETE /tasks/:id/attention-owners/:rowId (task 91864257 AC6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller is not the top-of-stack owner', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({
      attentionOwners: [attentionRowFixture({ owner: 'Quinn', position: 0 })]
    }));
    const response = await request(createApp())
      .delete(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-2`)
      .set(auth(ROWAN_TOKEN))
      .send({});
    expect(response.status).toBe(403);
  });

  it('removes the targeted row and renumbers positions contiguously', async () => {
    const rows = [
      attentionRowFixture({ id: 'ao-1', owner: 'Quinn', position: 0 }),
      attentionRowFixture({ id: 'ao-2', owner: 'Rowan', position: 1 }),
      attentionRowFixture({ id: 'ao-3', owner: 'Tom', position: 2 })
    ];
    prismaMock.task.findFirst
      .mockResolvedValueOnce(taskFixture({ attentionOwners: rows }))
      .mockResolvedValueOnce(taskFixture({
        attentionOwners: [rows[0], rows[2]]
      }));
    prismaMock.taskAttentionOwner.findUnique.mockResolvedValue(rows[1]);
    // findMany is called once for the post-delete `remaining` snapshot.
    // Hand back the list as if the delete already happened (without ao-2).
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([rows[0], rows[2]]);
    prismaMock.taskAttentionOwner.delete.mockResolvedValue(rows[1]);
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .delete(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-2`)
      .set(auth(QUINN_TOKEN))
      .send({ reason: 'no longer relevant' });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.delete).toHaveBeenCalledWith({ where: { id: 'ao-2' } });
    // The remaining rows get renumbered to positions [0, 1]. ao-3 was at
    // position 2 and must shift down to 1.
    const updateCalls = prismaMock.taskAttentionOwner.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const renumbered = updateCalls.find((call) => call[0]?.where?.id === 'ao-3');
    expect(renumbered).toBeDefined();
    expect(renumbered[0].data.position).toBe(1);
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ body: expect.stringContaining('removed by Quinn') })
    }));
  });

  it('returns 404 when the row is not on this task', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({ attentionOwners: [attentionRowFixture()] }));
    prismaMock.taskAttentionOwner.findUnique.mockResolvedValue(null);
    const response = await request(createApp())
      .delete(`/api/v1/tasks/${TASK_ID}/attention-owners/missing-row`)
      .set(auth(QUINN_TOKEN))
      .send({});
    expect(response.status).toBe(404);
  });
});

describe('PATCH /tasks/:id/attention-owners/:rowId (task 91864257 AC6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a body with no mutable fields', async () => {
    const response = await request(createApp())
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-1`)
      .set(auth(QUINN_TOKEN))
      .send({});
    expect(response.status).toBe(400);
    expect(response.body?.error?.code).toBe('NO_FIELDS');
  });

  it('updates the note on a row owned by the top-of-stack actor', async () => {
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({
      attentionOwners: [attentionRowFixture({ owner: 'Quinn', position: 0, note: 'old reason' })]
    }));
    prismaMock.taskAttentionOwner.findUnique.mockResolvedValue(attentionRowFixture({ owner: 'Quinn', position: 0, note: 'old reason' }));
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue([attentionRowFixture({ owner: 'Quinn', position: 0, note: 'old reason' })]);
    prismaMock.taskAttentionOwner.update.mockResolvedValue(attentionRowFixture({ owner: 'Quinn', position: 0, note: 'new reason' }));
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-1`)
      .set(auth(QUINN_TOKEN))
      .send({ note: 'new reason' });

    expect(response.status).toBe(200);
    expect(prismaMock.taskAttentionOwner.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ao-1' },
      data: expect.objectContaining({ note: 'new reason' })
    }));
  });

  it('moves a row down through a 5-row stack using the temp-position dance (Quinn review AC2)', async () => {
    // Real-DB parity test for the temp-position renumbering path (Quinn's
    // PR #751 critical review). The prismaMock lets this test exercise the
    // same update order the route emits, and the position move-dance test
    // (`taskAttentionOwners-position-move.test.ts`) drives the real
    // Postgres to confirm the constraint never trips end-to-end.
    const rows = [
      attentionRowFixture({ id: 'ao-a', owner: 'Quinn', position: 0 }),
      attentionRowFixture({ id: 'ao-b', owner: 'Rowan', position: 1 }),
      attentionRowFixture({ id: 'ao-c', owner: 'Tom', position: 2 }),
      attentionRowFixture({ id: 'ao-d', owner: 'Lox', position: 3, note: 'target row' }),
      attentionRowFixture({ id: 'ao-e', owner: 'Ivy', position: 4 })
    ];
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({
      attentionOwners: rows,
      assignee: 'Rowan'
    }));
    prismaMock.taskAttentionOwner.findUnique.mockResolvedValue(rows[3]);
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue(rows);
    prismaMock.taskAttentionOwner.update.mockResolvedValue(rows[3]);
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-d`)
      .set(auth(TOM_TOKEN))
      .send({ position: 1 });

    expect(response.status).toBe(200);

    // Step 1: target moves to temp position (max(0..4) + 1 = 5).
    const updateCalls = prismaMock.taskAttentionOwner.update.mock.calls.map((call) => call[0]);
    const tempWrite = updateCalls.find((call) => call.where?.id === 'ao-d' && call.data?.position === 5);
    expect(tempWrite).toBeDefined();

    // Step 2: siblings strictly between currentIndex(3) and targetIndex(1)
    // shift UP by one. ao-b (1→2) and ao-c (2→3) get bumped.
    const sibWrites = updateCalls.filter(
      (call) => call.where?.id !== 'ao-d' && (call.data?.position === 2 || call.data?.position === 3)
    );
    const bumpedById = new Map(sibWrites.map((call) => [call.where.id, call.data.position]));
    expect(bumpedById.get('ao-b')).toBe(2);
    expect(bumpedById.get('ao-c')).toBe(3);

    // Step 3: target lands at the requested slot (1).
    const finalWrite = updateCalls.find((call) => call.where?.id === 'ao-d' && call.data?.position === 1);
    expect(finalWrite).toBeDefined();

    // The earlier logic used the *first* position-emitted UPDATE order to
    // detect the bug; verify the new logic emits temp→shift→final in that
    // exact order so the route can never violate @@unique([taskId, position]).
    const orderedWrites = prismaMock.taskAttentionOwner.update.mock.calls
      .map((call, idx) => ({ idx, ...call[0] }))
      .filter((call) => call.data?.position !== undefined);
    const tempIdx = orderedWrites.findIndex((call) => call.where?.id === 'ao-d' && call.data.position === 5);
    const finalIdx = orderedWrites.findIndex(
      (call, idx) => idx > tempIdx && call.where?.id === 'ao-d' && call.data.position === 1
    );
    expect(tempIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(tempIdx);
  });

  it('moves a row up through a 4-row stack using the temp-position dance (Quinn review AC2)', async () => {
    // Mirror of the move-down test for the upward direction (targetIndex
    // < currentIndex). Verifies siblings strictly between targetIndex and
    // currentIndex shift DOWN by one so the slot at targetIndex opens.
    const rows = [
      attentionRowFixture({ id: 'ao-a', owner: 'Quinn', position: 0 }),
      attentionRowFixture({ id: 'ao-b', owner: 'Rowan', position: 1, note: 'target row' }),
      attentionRowFixture({ id: 'ao-c', owner: 'Tom', position: 2 }),
      attentionRowFixture({ id: 'ao-d', owner: 'Lox', position: 3 })
    ];
    prismaMock.task.findFirst.mockResolvedValue(taskFixture({
      attentionOwners: rows,
      assignee: 'Rowan'
    }));
    prismaMock.taskAttentionOwner.findUnique.mockResolvedValue(rows[1]);
    prismaMock.taskAttentionOwner.findMany.mockResolvedValue(rows);
    prismaMock.taskAttentionOwner.update.mockResolvedValue(rows[1]);
    prismaMock.taskComment.create.mockResolvedValue({});

    const response = await request(createApp())
      .patch(`/api/v1/tasks/${TASK_ID}/attention-owners/ao-b`)
      .set(auth(QUINN_TOKEN))
      .send({ position: 3 });

    expect(response.status).toBe(200);

    const updateCalls = prismaMock.taskAttentionOwner.update.mock.calls.map((call) => call[0]);
    // Step 1: target moves to temp position (max(0..3) + 1 = 4).
    const tempWrite = updateCalls.find((call) => call.where?.id === 'ao-b' && call.data?.position === 4);
    expect(tempWrite).toBeDefined();

    // Step 2: siblings strictly between targetIndex(3) and currentIndex(1)
    // shift DOWN by one. ao-c (2→1) gets bumped. ao-a is at 0 < targetIndex
    // and is left alone.
    const sibWrites = updateCalls.filter(
      (call) => call.where?.id !== 'ao-b' && (call.data?.position === 1)
    );
    expect(sibWrites.find((call) => call.where?.id === 'ao-c')).toBeDefined();
    // ao-a must NOT be bumped (out of the shifted range).
    expect(updateCalls.find((call) => call.where?.id === 'ao-a')).toBeUndefined();

    // Step 3: target lands at the requested slot (3).
    const finalWrite = updateCalls.find((call) => call.where?.id === 'ao-b' && call.data?.position === 3);
    expect(finalWrite).toBeDefined();
  });
});