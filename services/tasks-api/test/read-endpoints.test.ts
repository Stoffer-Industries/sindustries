import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  task: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  taskDependency: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  taskComment: {
    create: vi.fn()
  },
  taskApproval: {
    findUnique: vi.fn(),
    update: vi.fn()
  },
  taskTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn()
  },
  tag: {
    findMany: vi.fn(),
    upsert: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

function task(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Task',
    description: null,
    status: 'open',
    statusChangedAt: new Date('2026-03-01T00:00:00.000Z'),
    priority: 'medium',
    dueAt: null,
    completedAt: null,
    assignee: null,
    archivedAt: null,
    blocked: false,
    specChecksum: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    tags: [],
    dependencies: [],
    ...overrides
  };
}

function checksumForAcceptanceCriteria(criteria) {
  return createHash('sha256')
    .update(JSON.stringify({ acceptanceCriteria: criteria }))
    .digest('hex');
}

describe('tasks api endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
  });

  it('GET /api/v1/tasks returns paginated task list', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({ id: 'a1111111-1111-1111-1111-111111111111', title: 'Urgent task', priority: 'urgent' }),
      task({ id: 'b1111111-1111-1111-1111-111111111111', title: 'Low task', priority: 'low' })
    ]);

    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/tasks')
      .query({ status: 'open', limit: 2, q: 'task' });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({
      dependsOn: [],
      dependsOnIds: [],
      dependencyBlocked: false
    });
    expect(response.body.page).toEqual({
      limit: 2,
      nextCursor: null,
      hasNextPage: false
    });
    expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1);
  });

  it('GET /api/v1/tasks maps dependency references and blocked state', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({
        id: '11111111-1111-1111-1111-111111111111',
        dependencies: [
          {
            dependsOn: {
              id: '22222222-2222-2222-2222-222222222222',
              title: 'Dependency',
              status: 'doing',
              completedAt: null
            }
          }
        ]
      })
    ]);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data[0].dependsOn).toEqual([
      {
        id: '22222222-2222-2222-2222-222222222222',
        title: 'Dependency',
        status: 'doing',
        completedAt: null
      }
    ]);
    expect(response.body.data[0].dependsOnIds).toEqual(['22222222-2222-2222-2222-222222222222']);
    expect(response.body.data[0].dependencyBlocked).toBe(true);
    expect(prismaMock.task.findMany.mock.calls[0][0].include.dependencies).toBeDefined();
  });

  it('GET /api/v1/tasks includes archived tasks when requested', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({ id: 'archived-task', title: 'Archived task', archivedAt: new Date('2026-03-03T00:00:00.000Z') })
    ]);

    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/tasks')
      .query({ includeArchived: 'true' });

    expect(response.status).toBe(200);
    expect(response.body.data[0].archivedAt).toBeDefined();
    expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.task.findMany.mock.calls[0][0].where).not.toHaveProperty('archivedAt');
  });

  it('GET /api/v1/tasks filters by taskType', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({ id: 'feature-task', title: 'Build task type UI', taskType: 'feature' })
    ]);

    const app = createApp();
    const response = await authedRequest(app)
      .get('/api/v1/tasks')
      .query({ taskType: 'feature' });

    expect(response.status).toBe(200);
    expect(response.body.data[0].taskType).toBe('feature');
    expect(prismaMock.task.findMany.mock.calls[0][0].where).toMatchObject({
      taskType: 'feature'
    });
  });

  it('GET /api/v1/tasks rejects invalid taskType filters', async () => {
    const app = createApp();

    const response = await authedRequest(app).get('/api/v1/tasks').query({ taskType: 'invalid' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_TASK_TYPE_FILTER', message: 'Invalid taskType filter' }
    });
    expect(prismaMock.task.findMany).not.toHaveBeenCalled();
  });

  it('GET /api/v1/tasks validates bad status filter', async () => {
    const app = createApp();

    const response = await authedRequest(app).get('/api/v1/tasks').query({ status: 'blocked' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_STATUS_FILTER', message: 'Invalid status filter' }
    });
    expect(prismaMock.task.findMany).not.toHaveBeenCalled();
  });

  it('GET /api/v1/tasks/:id returns a single task with comments oldest-first', async () => {
    prismaMock.task.findFirst.mockResolvedValue(
      task({
        id: '22222222-2222-2222-2222-222222222222',
        title: 'Task detail',
        tags: [{ tag: { name: 'backend' } }],
        dependencies: [
          {
            dependsOn: {
              id: '33333333-3333-3333-3333-333333333333',
              title: 'Done dependency',
              status: 'done',
              completedAt: new Date('2026-03-10T00:00:00.000Z')
            }
          }
        ],
        comments: [
          {
            id: 'comment-1',
            author: 'Rowan',
            body: 'First note',
            createdAt: new Date('2026-03-11T00:00:00.000Z'),
            updatedAt: new Date('2026-03-11T00:00:00.000Z')
          },
          {
            id: 'comment-2',
            author: 'Tom',
            body: 'Second note',
            createdAt: new Date('2026-03-12T00:00:00.000Z'),
            updatedAt: new Date('2026-03-12T00:00:00.000Z')
          }
        ]
      })
    );

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tasks/22222222-2222-2222-2222-222222222222');

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(response.body.data.tags).toEqual(['backend']);
    expect(response.body.data.dependsOnIds).toEqual(['33333333-3333-3333-3333-333333333333']);
    expect(response.body.data.dependencyBlocked).toBe(false);
    expect(response.body.data.comments).toEqual([
      {
        id: 'comment-1',
        author: 'Rowan',
        text: 'First note',
        createdAt: '2026-03-11T00:00:00.000Z',
        updatedAt: '2026-03-11T00:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Tom',
        text: 'Second note',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z'
      }
    ]);
    expect(prismaMock.task.findFirst.mock.calls.at(-1)?.[0]?.include?.comments).toEqual({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
  });

  it('POST /api/v1/tasks/:id/comments creates a comment', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    prismaMock.taskComment.create.mockResolvedValue({
      id: 'comment-1',
      taskId: '11111111-1111-1111-1111-111111111111',
      author: 'IntegrationTest',
      body: 'Investigated API contract',
      createdAt: new Date('2026-03-12T00:00:00.000Z'),
      updatedAt: new Date('2026-03-12T00:00:00.000Z')
    });

    const app = createApp();
    // Per task 0719a8e3 AC2: comment author is derived from the authenticated
    // user. authedRequest() authenticates as 'IntegrationTest', so the body
    // omits author entirely (the route uses req.user.actor as the author).
    const response = await authedRequest(app)
      .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
      .send({ text: '  Investigated API contract  ' });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({
      id: 'comment-1',
      author: 'IntegrationTest',
      text: 'Investigated API contract',
      createdAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:00:00.000Z'
    });
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
      data: {
        taskId: '11111111-1111-1111-1111-111111111111',
        author: 'IntegrationTest',
        body: 'Investigated API contract'
      }
    });
  });

  it('POST /api/v1/tasks/:id/comments validates required fields and missing task', async () => {
    const app = createApp();

    // Per task 0719a8e3 AC2: comment author is derived from the authenticated
    // user, so a missing body.author is no longer a validation error — the
    // route uses req.user.actor as the author. We assert missing-text and
    // missing-task paths here; forged-author and missing-auth coverage lives
    // in mutationAuthIntegration.test.ts.

    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    const missingText = await authedRequest(app)
      .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
      .send({ text: '   ' });
    expect(missingText.status).toBe(400);
    expect(missingText.body).toEqual({
      error: { code: 'COMMENT_TEXT_REQUIRED', message: 'text is required' }
    });

    prismaMock.task.findFirst.mockResolvedValueOnce(null);
    const missingTask = await authedRequest(app)
      .post('/api/v1/tasks/99999999-9999-9999-9999-999999999999/comments')
      .send({ text: 'hello' });
    expect(missingTask.status).toBe(404);
    expect(missingTask.body).toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
    });
  });

  it.each([
    {
      method: 'get',
      path: '/api/v1/tasks/95e65d06',
      label: 'GET /api/v1/tasks/:id rejects 8-char hex prefix',
    },
    {
      method: 'patch',
      path: '/api/v1/tasks/95e65d06',
      label: 'PATCH /api/v1/tasks/:id rejects 8-char hex prefix',
      body: { status: 'doing' },
    },
    {
      method: 'post',
      path: '/api/v1/tasks/95e65d06/comments',
      label: 'POST /api/v1/tasks/:id/comments rejects 8-char hex prefix',
      body: { author: 'Rowan', text: 'hello' },
    },
    {
      method: 'delete',
      path: '/api/v1/tasks/95e65d06',
      label: 'DELETE /api/v1/tasks/:id rejects 8-char hex prefix',
    },
    {
      method: 'get',
      path: '/api/v1/tasks/not-a-uuid-at-all',
      label: 'GET /api/v1/tasks/:id rejects arbitrary non-UUID string',
    },
    {
      method: 'patch',
      path: '/api/v1/tasks/11111111-1111-1111-1111-11111111111', // truncated by one char
      label: 'PATCH /api/v1/tasks/:id rejects short-truncated UUID',
      body: { status: 'doing' },
    }
  ])('$label with 400 INVALID_TASK_ID and skips the prisma lookup', async ({ method, path, body }) => {
    const app = createApp();

    const req = authedRequest(app)[method](path);
    const response = body ? await req.send(body) : await req;

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'INVALID_TASK_ID',
        message: 'Task id must be a 36-char UUID'
      }
    });
    expect(prismaMock.task.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
  });

  it('GET /api/v1/tasks/:id with valid-shape UUID but missing row returns 404 TASK_NOT_FOUND', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tasks/99999999-9999-9999-9999-999999999999');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
    });
    expect(prismaMock.task.findFirst).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/tasks creates a feature task', async () => {
    prismaMock.tag.upsert.mockResolvedValue({ id: 'tag-1', name: 'backend' });
    prismaMock.task.create.mockResolvedValue(
      task({ title: '🔧 Created task', taskType: 'feature', tags: [{ tag: { name: 'backend' } }] })
    );

    const app = createApp();
    const response = await authedRequest(app).post('/api/v1/tasks').send({
      title: 'Created task',
      priority: 'high',
      taskType: 'feature',
      tags: ['backend']
    });

    expect(response.status).toBe(201);
    expect(response.body.data.title).toBe('🔧 Created task');
    expect(response.body.data.taskType).toBe('feature');
    expect(response.body.data.tags).toEqual(['backend']);
    expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.task.create.mock.calls[0][0].data.title).toBe('🔧 Created task');
    expect(prismaMock.task.create.mock.calls[0][0].data.taskType).toBe('feature');
  });

  it('PATCH /api/v1/tasks/:id stores specChecksum', async () => {
    const checksum = checksumForAcceptanceCriteria(['AC1: Build it']);
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: 'ready', specChecksum: checksum }));
    prismaMock.task.update.mockResolvedValue(task({ status: 'ready', specChecksum: checksum }));

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ status: 'ready', specChecksum: checksum });

    expect(response.status).toBe(200);
    expect(response.body.data.specChecksum).toBe(checksum);
    expect(prismaMock.task.update.mock.calls[0][0].data.specChecksum).toBe(checksum);
  });

  it('PATCH /api/v1/tasks/:id atomically revises description and relocks specChecksum for Quinn', async () => {
    const storedDescription = '## Acceptance Criteria\n- [ ] AC1: Build it';
    const revisedDescription = `${storedDescription}\n- [ ] AC2: Revise it`;
    const revisedChecksum = checksumForAcceptanceCriteria(['AC1: Build it', 'AC2: Revise it']);
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task({ description: storedDescription, specChecksum: checksumForAcceptanceCriteria(['AC1: Build it']) }))
      .mockResolvedValueOnce(task({ description: revisedDescription, specChecksum: revisedChecksum }));
    prismaMock.task.update.mockResolvedValue(task({ description: revisedDescription, specChecksum: revisedChecksum }));

    const response = await authedRequest(createApp())
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .set('Authorization', 'Bearer quinn-test-token-long-enough')
      .send({ description: revisedDescription, resyncSpecChecksum: true });

    expect(response.status).toBe(200);
    expect(prismaMock.task.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ description: revisedDescription, specChecksum: revisedChecksum })
    }));
    expect(prismaMock.taskApproval.update).not.toHaveBeenCalled();
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
      data: {
        taskId: '11111111-1111-1111-1111-111111111111',
        author: 'Quinn',
        body: 'Acceptance criteria intentionally revised and specChecksum atomically relocked by Quinn.'
      }
    });
  });

  it('rejects checksum relock from an unauthorised actor', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(task({ specChecksum: 'a'.repeat(64) }));
    const response = await authedRequest(createApp())
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ description: '## Acceptance Criteria\n- [ ] AC1: Revised', resyncSpecChecksum: true });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('SPEC_CHECKSUM_RESYNC_FORBIDDEN');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id passes description through verbatim and revokes structured approval on AC drift', async () => {
    // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` WS1: the Tasks API no
    // longer auto-unchecks the legacy `- [x] **Approved by Tom**` marker on
    // AC drift. The description is persisted verbatim, and approval state is
    // revoked through the structured `TaskApproval` row instead.
    //
    // The `acceptanceCriteriaText` regex captures the marker line as an AC
    // entry (`**Approved by Tom**`), so the stored checksum must be computed
    // from the full AC list of the stored description — not just the AC
    // section — for the drift guard to behave correctly.
    const storedDescription = '- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it';
    const driftedDescription = `${storedDescription}\n- [ ] AC2: Drift`;
    const checksum = checksumForAcceptanceCriteria(['**Approved by Tom**', 'AC1: Build it']);
    prismaMock.task.findFirst
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: storedDescription,
          specChecksum: checksum
        })
      )
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: driftedDescription,
          specChecksum: checksum
        })
      );
    prismaMock.task.update.mockResolvedValue(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: driftedDescription,
        specChecksum: checksum
      })
    );
    prismaMock.taskApproval.findUnique.mockResolvedValue({
      id: 'approval-1',
      taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
      type: 'spec',
      owner: 'Tom',
      state: 'approved',
      approvedAt: new Date('2026-07-01T00:00:00.000Z'),
      revokedAt: null
    });
    prismaMock.taskApproval.update.mockResolvedValue({
      id: 'approval-1',
      taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
      type: 'spec',
      owner: 'Tasks API',
      state: 'revoked',
      approvedAt: new Date('2026-07-01T00:00:00.000Z'),
      revokedAt: new Date('2026-07-02T00:00:00.000Z')
    });

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70')
      .send({ description: driftedDescription });

    expect(response.status).toBe(200);
    // Description passes through verbatim — the marker is NOT auto-unchecked.
    expect(response.body.data.description).toBe(driftedDescription);
    expect(prismaMock.task.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.task.update.mock.calls[0][0].data.description).toBe(driftedDescription);
    // Structured TaskApproval is revoked.
    expect(prismaMock.taskApproval.findUnique).toHaveBeenCalledWith({
      where: {
        taskId_type: {
          taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          type: 'spec'
        }
      }
    });
    expect(prismaMock.taskApproval.update).toHaveBeenCalledWith({
      where: {
        taskId_type: {
          taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          type: 'spec'
        }
      },
      data: { state: 'revoked', revokedAt: expect.any(Date) }
    });
  });

  it('PATCH /api/v1/tasks/:id revokes structured spec approval when ACs drift', async () => {
    const approvedDescription = '- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it';
    const driftedDescription = `${approvedDescription}\n- [ ] AC2: Drift`;
    const expectedDescription = '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift';
    const checksum = checksumForAcceptanceCriteria(['AC1: Build it']);
    prismaMock.task.findFirst
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: approvedDescription,
          specChecksum: checksum
        })
      )
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: expectedDescription,
          specChecksum: checksum,
          approvals: [{
            id: 'approval-1',
            type: 'spec',
            owner: 'Tom',
            state: 'revoked',
            approvedAt: new Date('2026-07-01T00:00:00.000Z'),
            revokedAt: new Date('2026-07-02T00:00:00.000Z')
          }]
        })
      );
    prismaMock.task.update.mockResolvedValue(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: expectedDescription,
        specChecksum: checksum
      })
    );
    prismaMock.taskApproval.findUnique.mockResolvedValue({
      id: 'approval-1',
      taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
      type: 'spec',
      owner: 'Tom',
      state: 'approved',
      approvedAt: new Date('2026-07-01T00:00:00.000Z'),
      revokedAt: null
    });
    prismaMock.taskApproval.update.mockResolvedValue({
      id: 'approval-1',
      taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
      type: 'spec',
      owner: 'Tasks API',
      state: 'revoked',
      approvedAt: new Date('2026-07-01T00:00:00.000Z'),
      revokedAt: new Date('2026-07-02T00:00:00.000Z')
    });

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70')
      .send({ description: driftedDescription });

    expect(response.status).toBe(200);
    expect(prismaMock.taskApproval.findUnique).toHaveBeenCalledWith({
      where: {
        taskId_type: {
          taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          type: 'spec'
        }
      }
    });
    expect(prismaMock.taskApproval.update).toHaveBeenCalledWith({
      where: {
        taskId_type: {
          taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          type: 'spec'
        }
      },
      data: { state: 'revoked', revokedAt: expect.any(Date) }
    });
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
      data: {
        taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        author: 'Tasks API',
        body: 'Approval spec revoked by Tasks API after acceptance criteria changed.'
      }
    });
  });

  it('PATCH /api/v1/tasks/:id does not revoke spec approval for marker-only edits', async () => {
    // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` WS1: the marker is inert.
    // Toggling `- [x] **Approved by Tom**` → `- [ ] **Approved by Tom**` does
    // not change the AC text because the retired marker is excluded from the
    // canonical AC list in both states.
    const storedDescription = '- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it';
    const updatedDescription = '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it';
    const checksum = checksumForAcceptanceCriteria(['AC1: Build it']);
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task({ description: storedDescription, specChecksum: checksum }))
      .mockResolvedValueOnce(task({ description: updatedDescription, specChecksum: checksum }));
    prismaMock.task.update.mockResolvedValue(task({ description: updatedDescription, specChecksum: checksum }));

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ description: updatedDescription });

    expect(response.status).toBe(200);
    expect(prismaMock.taskApproval.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.taskApproval.update).not.toHaveBeenCalled();
  });

  it('POST /api/v1/tasks/:id/comments succeeds even when current ACs drifted after spec approval', async () => {
    const checksum = checksumForAcceptanceCriteria(['AC1: Build it']);
    prismaMock.task.findFirst.mockResolvedValueOnce(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: '## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Drift',
        specChecksum: checksum
      })
    );
    prismaMock.taskComment.create.mockResolvedValueOnce({
      id: 'c1000000-0000-0000-0000-000000000000',
      taskId: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
      author: 'IntegrationTest',
      body: 'trying to comment',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z')
    });

    const app = createApp();
    // Per task 0719a8e3 AC2: comment author comes from the authenticated user
    // (authedRequest() → 'IntegrationTest'). Body author omitted because a
    // mismatched body.author would 403 instead of succeeding.
    const response = await authedRequest(app)
      .post('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70/comments')
      .send({ text: 'trying to comment' });

    expect(response.status).toBe(201);
    expect(response.body.data.author).toBe('IntegrationTest');
    expect(response.body.data.text).toBe('trying to comment');
    expect(prismaMock.taskComment.create).toHaveBeenCalledTimes(1);
  });

  it('PATCH /api/v1/tasks/:id allows marker-only approval-marker uncheck after spec approval', async () => {
    // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` WS1: marker-only edits
    // preserve the unchecked marker verbatim. The checksum is computed from
    // the full AC list (including the marker line captured by the regex).
    const checksum = checksumForAcceptanceCriteria(['**Approved by Tom**', 'AC1: Build it']);
    const storedDescription = '- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n';
    const updatedDescription = '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n';
    prismaMock.task.findFirst
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: storedDescription,
          specChecksum: checksum
        })
      )
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: updatedDescription,
          specChecksum: checksum
        })
      );
    prismaMock.task.update.mockResolvedValue(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: updatedDescription,
        specChecksum: checksum
      })
    );

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70')
      .send({ description: updatedDescription });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe(updatedDescription);
    expect(prismaMock.task.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH /api/v1/tasks/:id preserves an already-unchecked approval marker during AC drift', async () => {
    // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` WS1: the unchecked
    // marker is preserved verbatim even when ACs drift. The marker is no
    // longer auto-toggled. The checksum must match the actual AC text
    // produced by the regex (marker line + AC1).
    const checksum = checksumForAcceptanceCriteria(['**Approved by Tom**', 'AC1: Build it']);
    const storedDescription = '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n';
    const updatedDescription =
      '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n- [ ] AC2: Sneaky drift\n';
    prismaMock.task.findFirst
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: storedDescription,
          specChecksum: checksum
        })
      )
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: updatedDescription,
          specChecksum: checksum
        })
      );
    prismaMock.task.update.mockResolvedValue(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: updatedDescription,
        specChecksum: checksum
      })
    );

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70')
      .send({ description: updatedDescription });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe(updatedDescription);
    expect(prismaMock.task.update.mock.calls[0][0].data.description).toBe(updatedDescription.trim());
  });

  it('PATCH /api/v1/tasks/:id allows Tom to check the approval marker (marker-only toggle)', async () => {
    // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` WS1: Tom can toggle the
    // legacy marker freely. The marker is inert markdown — a `- [ ]` → `- [x]`
    // toggle does not change the AC text (the regex captures
    // `**Approved by Tom**` from both checkbox states), so no drift is
    // detected and the description passes through verbatim. The checksum must
    // match the actual AC text produced by the regex.
    const checksum = checksumForAcceptanceCriteria(['**Approved by Tom**', 'AC1: Build it']);
    const storedDescription = '- [ ] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n';
    const checkedDescription = '- [x] **Approved by Tom**\n\n## Acceptance Criteria\n- [ ] AC1: Build it\n';
    prismaMock.task.findFirst
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: storedDescription,
          specChecksum: checksum
        })
      )
      .mockResolvedValueOnce(
        task({
          id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
          description: checkedDescription,
          specChecksum: checksum
        })
      );
    prismaMock.task.update.mockResolvedValue(
      task({
        id: '2527ff9d-4369-444f-995d-4d4bb0ac7b70',
        description: checkedDescription,
        specChecksum: checksum
      })
    );

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/2527ff9d-4369-444f-995d-4d4bb0ac7b70')
      .send({ description: checkedDescription });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe(checkedDescription);
    expect(prismaMock.task.update.mock.calls[0][0].data.description).toBe(checkedDescription.trim());
  });

  it('GET /api/v1/tasks formats task titles with taskType emoji without duplication', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      task({ id: 'feature', title: 'Build factory', taskType: 'feature' }),
      task({ id: 'content', title: '✍️ Publish update', taskType: 'content' }),
      task({ id: 'code', title: 'Fix worker', taskType: 'code' }),
      task({ id: 'research', title: 'Explore options', taskType: 'research' })
    ]);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data.map((item) => item.title)).toEqual(
      expect.arrayContaining(['🔧 Build factory', '✍️ Publish update', '💻 Fix worker', '🔎 Explore options'])
    );
  });

  it('POST /api/v1/tasks rejects invalid taskType values', async () => {
    const app = createApp();
    const response = await authedRequest(app).post('/api/v1/tasks').send({
      title: 'Created task',
      taskType: 'invalid'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_TASK_TYPE', message: 'taskType must be content, code, research, or feature' }
    });
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id updates task fields', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ title: 'Updated title', status: 'doing' }));
    prismaMock.task.update.mockResolvedValue(task({ title: 'Updated title', status: 'doing' }));

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ title: 'Updated title', status: 'doing' });

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Updated title');
    expect(response.body.data.status).toBe('doing');
    expect(prismaMock.task.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH /api/v1/tasks/:id replaces dependencies', async () => {
    const dependencyId = '22222222-2222-2222-2222-222222222222';
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({
        dependencies: [
          {
            dependsOn: {
              id: dependencyId,
              title: 'Dependency',
              status: 'ready',
              completedAt: null
            }
          }
        ]
      }));
    prismaMock.task.findMany.mockResolvedValue([{ id: dependencyId, archivedAt: null }]);
    prismaMock.taskDependency.findFirst.mockResolvedValue(null);
    prismaMock.task.update.mockResolvedValue(task());

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [dependencyId, dependencyId] });

    expect(response.status).toBe(200);
    expect(response.body.data.dependsOnIds).toEqual([dependencyId]);
    expect(response.body.data.dependencyBlocked).toBe(true);
    expect(prismaMock.taskDependency.deleteMany).toHaveBeenCalledWith({
      where: { taskId: '11111111-1111-1111-1111-111111111111' }
    });
    expect(prismaMock.taskDependency.createMany).toHaveBeenCalledWith({
      data: [{ taskId: '11111111-1111-1111-1111-111111111111', dependsOnId: dependencyId }],
      skipDuplicates: true
    });
  });

  it('PATCH /api/v1/tasks/:id clears dependencies', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task());
    prismaMock.task.update.mockResolvedValue(task());

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [] });

    expect(response.status).toBe(200);
    expect(prismaMock.taskDependency.deleteMany).toHaveBeenCalledWith({
      where: { taskId: '11111111-1111-1111-1111-111111111111' }
    });
    expect(prismaMock.taskDependency.createMany).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id rejects invalid dependency payloads', async () => {
    prismaMock.task.findFirst.mockResolvedValue(task());

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: ['not-a-uuid'] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_DEPENDS_ON_IDS', message: 'dependsOnIds must be an array of UUID strings' }
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id rejects self dependencies', async () => {
    prismaMock.task.findFirst.mockResolvedValue(task());

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: ['11111111-1111-1111-1111-111111111111'] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('SELF_DEPENDENCY_NOT_ALLOWED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id rejects unknown dependencies', async () => {
    const dependencyId = '22222222-2222-2222-2222-222222222222';
    prismaMock.task.findFirst.mockResolvedValue(task());
    prismaMock.task.findMany.mockResolvedValue([]);

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [dependencyId] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('DEPENDENCY_TASK_NOT_FOUND');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id rejects archived dependencies', async () => {
    const dependencyId = '22222222-2222-2222-2222-222222222222';
    prismaMock.task.findFirst.mockResolvedValue(task());
    prismaMock.task.findMany.mockResolvedValue([{ id: dependencyId, archivedAt: new Date('2026-03-01T00:00:00.000Z') }]);

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [dependencyId] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ARCHIVED_DEPENDENCY_NOT_ALLOWED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id rejects direct circular dependencies', async () => {
    const dependencyId = '22222222-2222-2222-2222-222222222222';
    prismaMock.task.findFirst.mockResolvedValue(task());
    prismaMock.task.findMany.mockResolvedValue([{ id: dependencyId, archivedAt: null }]);
    prismaMock.taskDependency.findFirst.mockResolvedValue({ taskId: dependencyId });

    const app = createApp();
    const response = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [dependencyId] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CIRCULAR_DEPENDENCY_NOT_ALLOWED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH /api/v1/tasks/:id accepts feature and rejects invalid taskType values', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ taskType: 'feature' }))
      .mockResolvedValueOnce(task());
    prismaMock.task.update.mockResolvedValue(task({ taskType: 'feature' }));

    const app = createApp();
    const feature = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ taskType: 'feature' });

    expect(feature.status).toBe(200);
    expect(feature.body.data.taskType).toBe('feature');
    expect(prismaMock.task.update.mock.calls[0][0].data.taskType).toBe('feature');

    const invalid = await authedRequest(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ taskType: 'invalid' });

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: { code: 'INVALID_TASK_TYPE', message: 'taskType must be content, code, research, or feature' }
    });
    expect(prismaMock.task.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE /api/v1/tasks/:id archives task', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    prismaMock.task.update.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      archivedAt: new Date('2026-03-04T00:00:00.000Z')
    });

    const app = createApp();
    const response = await authedRequest(app).delete('/api/v1/tasks/11111111-1111-1111-1111-111111111111');

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(response.body.data.archivedAt).toBeDefined();
  });

  it('GET /api/v1/tasks/:id returns 404 when missing', async () => {
    prismaMock.task.findFirst.mockResolvedValue(null);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tasks/99999999-9999-9999-9999-999999999999');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
    });
  });

  it('GET /api/v1/tags returns tags in name order', async () => {
    prismaMock.tag.findMany.mockResolvedValue([
      { id: '1', name: 'backend', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      { id: '2', name: 'frontend', createdAt: new Date('2026-03-01T00:00:00.000Z') }
    ]);

    const app = createApp();
    const response = await authedRequest(app).get('/api/v1/tags');

    expect(response.status).toBe(200);
    expect(response.body.data.map((tag) => tag.name)).toEqual(['backend', 'frontend']);
    expect(prismaMock.tag.findMany).toHaveBeenCalledWith({ orderBy: [{ name: 'asc' }] });
  });

  it('POST /api/v1/tags upserts tag', async () => {
    prismaMock.tag.upsert.mockResolvedValue({ id: 'tag-1', name: 'backend', createdAt: new Date() });

    const app = createApp();
    const response = await authedRequest(app).post('/api/v1/tags').send({ name: 'Backend' });

    expect(response.status).toBe(201);
    expect(response.body.data.name).toBe('backend');
    expect(prismaMock.tag.upsert).toHaveBeenCalledTimes(1);
  });
});
