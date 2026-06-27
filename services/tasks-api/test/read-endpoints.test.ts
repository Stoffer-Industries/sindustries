import request from 'supertest';
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
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    tags: [],
    dependencies: [],
    ...overrides
  };
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
    const response = await request(app)
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
    const response = await request(app).get('/api/v1/tasks');

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
    const response = await request(app)
      .get('/api/v1/tasks')
      .query({ includeArchived: 'true' });

    expect(response.status).toBe(200);
    expect(response.body.data[0].archivedAt).toBeDefined();
    expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.task.findMany.mock.calls[0][0].where).not.toHaveProperty('archivedAt');
  });

  it('GET /api/v1/tasks validates bad status filter', async () => {
    const app = createApp();

    const response = await request(app).get('/api/v1/tasks').query({ status: 'blocked' });

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
    const response = await request(app).get('/api/v1/tasks/22222222-2222-2222-2222-222222222222');

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
      author: 'Rowan',
      body: 'Investigated API contract',
      createdAt: new Date('2026-03-12T00:00:00.000Z'),
      updatedAt: new Date('2026-03-12T00:00:00.000Z')
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
      .send({ author: '  Rowan  ', text: '  Investigated API contract  ' });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({
      id: 'comment-1',
      author: 'Rowan',
      text: 'Investigated API contract',
      createdAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:00:00.000Z'
    });
    expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
      data: {
        taskId: '11111111-1111-1111-1111-111111111111',
        author: 'Rowan',
        body: 'Investigated API contract'
      }
    });
  });

  it('POST /api/v1/tasks/:id/comments validates required fields and missing task', async () => {
    const app = createApp();

    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    const missingAuthor = await request(app)
      .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
      .send({ text: 'hello' });
    expect(missingAuthor.status).toBe(400);
    expect(missingAuthor.body).toEqual({
      error: { code: 'COMMENT_AUTHOR_REQUIRED', message: 'author is required' }
    });

    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    const missingText = await request(app)
      .post('/api/v1/tasks/11111111-1111-1111-1111-111111111111/comments')
      .send({ author: 'Rowan', text: '   ' });
    expect(missingText.status).toBe(400);
    expect(missingText.body).toEqual({
      error: { code: 'COMMENT_TEXT_REQUIRED', message: 'text is required' }
    });

    prismaMock.task.findFirst.mockResolvedValueOnce(null);
    const missingTask = await request(app)
      .post('/api/v1/tasks/missing/comments')
      .send({ author: 'Rowan', text: 'hello' });
    expect(missingTask.status).toBe(404);
    expect(missingTask.body).toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' }
    });
  });

  it('POST /api/v1/tasks creates a task', async () => {
    prismaMock.tag.upsert.mockResolvedValue({ id: 'tag-1', name: 'backend' });
    prismaMock.task.create.mockResolvedValue(task({ title: 'Created task', tags: [{ tag: { name: 'backend' } }] }));

    const app = createApp();
    const response = await request(app).post('/api/v1/tasks').send({
      title: 'Created task',
      priority: 'high',
      tags: ['backend']
    });

    expect(response.status).toBe(201);
    expect(response.body.data.title).toBe('Created task');
    expect(response.body.data.tags).toEqual(['backend']);
    expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
  });

  it('PATCH /api/v1/tasks/:id updates task fields', async () => {
    prismaMock.task.findFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ title: 'Updated title', status: 'doing' }));
    prismaMock.task.update.mockResolvedValue(task({ title: 'Updated title', status: 'doing' }));

    const app = createApp();
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
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
    const response = await request(app)
      .patch('/api/v1/tasks/11111111-1111-1111-1111-111111111111')
      .send({ dependsOnIds: [dependencyId] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CIRCULAR_DEPENDENCY_NOT_ALLOWED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/tasks/:id archives task', async () => {
    prismaMock.task.findFirst.mockResolvedValueOnce(task());
    prismaMock.task.update.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      archivedAt: new Date('2026-03-04T00:00:00.000Z')
    });

    const app = createApp();
    const response = await request(app).delete('/api/v1/tasks/11111111-1111-1111-1111-111111111111');

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(response.body.data.archivedAt).toBeDefined();
  });

  it('GET /api/v1/tasks/:id returns 404 when missing', async () => {
    prismaMock.task.findFirst.mockResolvedValue(null);

    const app = createApp();
    const response = await request(app).get('/api/v1/tasks/missing');

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
    const response = await request(app).get('/api/v1/tags');

    expect(response.status).toBe(200);
    expect(response.body.data.map((tag) => tag.name)).toEqual(['backend', 'frontend']);
    expect(prismaMock.tag.findMany).toHaveBeenCalledWith({ orderBy: [{ name: 'asc' }] });
  });

  it('POST /api/v1/tags upserts tag', async () => {
    prismaMock.tag.upsert.mockResolvedValue({ id: 'tag-1', name: 'backend', createdAt: new Date() });

    const app = createApp();
    const response = await request(app).post('/api/v1/tags').send({ name: 'Backend' });

    expect(response.status).toBe(201);
    expect(response.body.data.name).toBe('backend');
    expect(prismaMock.tag.upsert).toHaveBeenCalledTimes(1);
  });
});
