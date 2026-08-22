import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Set service credentials BEFORE the dynamic import of app.ts (which
// transitively imports requireAuth.ts) so the module-load-time parse
// captures the test credentials instead of an empty value. The shape
// matches TASKS_API_APPROVAL_SERVICE_CREDENTIALS — same shared credential
// store as the existing approval auth (task 0719a8e3).
process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  { token: 'quinn-service-token-long-enough', actor: 'Quinn', approvalTypes: ['tech_design'] },
  { token: 'bookmark-lobster-token-long-enough', actor: 'bookmark_lobster', approvalTypes: [] },
  { token: 'content-tasks-token-long-enough', actor: 'Lobster', approvalTypes: [] },
  { token: 'feature-task-lobster-token-long', actor: 'feature_task_lobster', approvalTypes: [] }
]);

const prismaMock: any = {
  task: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  taskComment: { create: vi.fn(), findMany: vi.fn() },
  taskTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  tag: { findMany: vi.fn(), upsert: vi.fn() },
  taskDependency: { findFirst: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  taskApproval: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  approvalSession: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  tag: { findMany: vi.fn(), upsert: vi.fn() },
  featureTaskAnalyticsEvent: { findMany: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({ prisma: prismaMock }));

const { createApp } = await import('../src/app.ts');

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const QUINN_TOKEN = 'quinn-service-token-long-enough';
const BOOKMARK_TOKEN = 'bookmark-lobster-token-long-enough';
const FEATURE_TASK_TOKEN = 'feature-task-lobster-token-long';
const TOM_SESSION = 'tom-browser-session-long-enough';

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }

describe('mutation auth gate (task 0719a8e3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.approvalSession.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (cbOrOps: any) => {
      if (typeof cbOrOps === 'function') return cbOrOps(prismaMock);
      return Promise.all(cbOrOps);
    });
  });

  // AC1 — every mutation route requires valid credentials.

  describe('AC1: POST /tasks requires credentials', () => {
    it('rejects an unauthenticated POST /tasks with 401 AUTH_REQUIRED', async () => {
      const res = await request(createApp()).post('/api/v1/tasks').send({ title: 'X' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
      expect(prismaMock.task.create).not.toHaveBeenCalled();
    });

    it('accepts POST /tasks with a valid Bearer service credential', async () => {
      prismaMock.tag.findMany.mockResolvedValue([]);
      prismaMock.task.create.mockResolvedValue({ id: TASK_ID, title: 'X' });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set(bearer(BOOKMARK_TOKEN))
        .send({ title: 'X', priority: 'medium', status: 'open' });
      expect(res.status).toBe(201);
      expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
    });

    it('accepts POST /tasks with a valid browser session cookie', async () => {
      prismaMock.approvalSession.findUnique.mockResolvedValue({
        actor: 'Quinn',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null
      });
      prismaMock.tag.findMany.mockResolvedValue([]);
      prismaMock.task.create.mockResolvedValue({ id: TASK_ID, title: 'X' });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Cookie', `tasks_api_session=${TOM_SESSION}`)
        .send({ title: 'X', priority: 'medium', status: 'open' });
      expect(res.status).toBe(201);
    });

    it('rejects POST /tasks with an expired session', async () => {
      prismaMock.approvalSession.findUnique.mockResolvedValue({
        actor: 'Quinn',
        expiresAt: new Date(Date.now() - 60_000),
        revokedAt: null
      });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Cookie', `tasks_api_session=${TOM_SESSION}`)
        .send({ title: 'X' });
      expect(res.status).toBe(401);
    });

    it('rejects POST /tasks with a revoked session', async () => {
      prismaMock.approvalSession.findUnique.mockResolvedValue({
        actor: 'Quinn',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date()
      });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Cookie', `tasks_api_session=${TOM_SESSION}`)
        .send({ title: 'X' });
      expect(res.status).toBe(401);
    });

    it('rejects POST /tasks with a malformed Authorization header', async () => {
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Authorization', 'NotBearer xyz')
        .send({ title: 'X' });
      expect(res.status).toBe(401);
    });
  });

  describe('AC1: PATCH /tasks/:id requires credentials', () => {
    it('rejects an unauthenticated PATCH', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/tasks/${TASK_ID}`)
        .send({ priority: 'high' });
      expect(res.status).toBe(401);
      expect(prismaMock.task.update).not.toHaveBeenCalled();
    });

    it('accepts PATCH with a valid Bearer credential', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: TASK_ID, archivedAt: null });
      prismaMock.task.update.mockResolvedValue({});
      prismaMock.task.findFirst.mockResolvedValueOnce({ id: TASK_ID, archivedAt: null });
      const res = await request(createApp())
        .patch(`/api/v1/tasks/${TASK_ID}`)
        .set(bearer(BOOKMARK_TOKEN))
        .send({ priority: 'high' });
      // 200 OK or 404 (depending on lookup order) — either way not 401
      expect([200, 404]).toContain(res.status);
      expect(res.status).not.toBe(401);
    });
  });

  describe('AC1: DELETE /tasks/:id requires credentials', () => {
    it('rejects an unauthenticated DELETE', async () => {
      const res = await request(createApp()).delete(`/api/v1/tasks/${TASK_ID}`);
      expect(res.status).toBe(401);
      expect(prismaMock.task.update).not.toHaveBeenCalled();
    });
  });

  describe('AC1: POST /tags requires credentials', () => {
    it('rejects an unauthenticated POST /tags', async () => {
      const res = await request(createApp()).post('/api/v1/tags').send({ name: 'foo' });
      expect(res.status).toBe(401);
    });

    it('accepts POST /tags with a Bearer credential', async () => {
      prismaMock.tag.upsert.mockResolvedValue({ id: 't1', name: 'foo' });
      const res = await request(createApp())
        .post('/api/v1/tags')
        .set(bearer(BOOKMARK_TOKEN))
        .send({ name: 'foo' });
      expect(res.status).toBe(201);
    });
  });

  describe('AC1: feature-task-analytics events require credentials', () => {
    it('rejects an unauthenticated POST /feature-task-analytics/events', async () => {
      const res = await request(createApp())
        .post('/api/v1/feature-task-analytics/events')
        .send({
          taskId: TASK_ID,
          eventKey: 'k1',
          eventType: 'gate_failure',
          gate: 'ready_checks',
          cause: 'quality',
          message: 'fail'
        });
      expect(res.status).toBe(401);
    });

    it('accepts POST /feature-task-analytics/events with a Bearer credential', async () => {
      prismaMock.featureTaskAnalyticsEvent.upsert.mockResolvedValue({
        id: 'e1',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      const res = await request(createApp())
        .post('/api/v1/feature-task-analytics/events')
        .set(bearer(FEATURE_TASK_TOKEN))
        .send({
          taskId: TASK_ID,
          eventKey: 'k1',
          eventType: 'gate_failure',
          gate: 'ready_checks',
          cause: 'quality',
          message: 'fail'
        });
      expect(res.status).toBe(201);
    });
  });

  describe('GET endpoints stay open', () => {
    it('GET /tasks is accessible without credentials', async () => {
      prismaMock.task.findMany.mockResolvedValue([]);
      const res = await request(createApp()).get('/api/v1/tasks?limit=5');
      expect(res.status).toBe(200);
    });

    it('GET /tags is accessible without credentials', async () => {
      prismaMock.tag.findMany.mockResolvedValue([]);
      const res = await request(createApp()).get('/api/v1/tags');
      expect(res.status).toBe(200);
    });
  });

  // Note: content-scheduler route auth tests moved to services/content-scheduler-api
  // when those routes were extracted from tasks-api (task 94d5e4fc PR #509).
  // Content Scheduler no longer mounts under /api/v1/content-scheduler in tasks-api,
  // so the equivalent auth coverage now lives in the scheduler service.

  // AC2 — comment author is derived from auth; body-supplied mismatch is 403.

  describe('AC2: comment author derivation', () => {
    const existingTask = { id: TASK_ID, archivedAt: null };

    it('derives comment author from the authenticated actor (no body.author)', async () => {
      prismaMock.task.findFirst.mockResolvedValue(existingTask);
      prismaMock.taskComment.create.mockResolvedValue({
        id: 'c1',
        taskId: TASK_ID,
        author: 'bookmark_lobster',
        body: 'hello',
        createdAt: new Date()
      });
      const res = await request(createApp())
        .post(`/api/v1/tasks/${TASK_ID}/comments`)
        .set(bearer(BOOKMARK_TOKEN))
        .send({ text: 'hello' });
      expect(res.status).toBe(201);
      expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
        data: { taskId: TASK_ID, author: 'bookmark_lobster', body: 'hello' }
      });
    });

    it('accepts body.author when it matches the authenticated actor', async () => {
      prismaMock.task.findFirst.mockResolvedValue(existingTask);
      prismaMock.taskComment.create.mockResolvedValue({
        id: 'c2',
        taskId: TASK_ID,
        author: 'feature_task_lobster',
        body: 'matched',
        createdAt: new Date()
      });
      const res = await request(createApp())
        .post(`/api/v1/tasks/${TASK_ID}/comments`)
        .set(bearer(FEATURE_TASK_TOKEN))
        .send({ author: 'feature_task_lobster', text: 'matched' });
      expect(res.status).toBe(201);
      expect(prismaMock.taskComment.create).toHaveBeenCalledWith({
        data: { taskId: TASK_ID, author: 'feature_task_lobster', body: 'matched' }
      });
    });

    it('rejects body.author that disagrees with the authenticated actor (403 COMMENT_AUTHOR_FORBIDDEN)', async () => {
      prismaMock.task.findFirst.mockResolvedValue(existingTask);
      const res = await request(createApp())
        .post(`/api/v1/tasks/${TASK_ID}/comments`)
        .set(bearer(BOOKMARK_TOKEN))
        .send({ author: 'Quinn', text: 'forged' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('COMMENT_AUTHOR_FORBIDDEN');
      expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated comment creation with 401 (no fallback to body.author)', async () => {
      const res = await request(createApp())
        .post(`/api/v1/tasks/${TASK_ID}/comments`)
        .send({ author: 'Tom', text: 'unauthenticated' });
      expect(res.status).toBe(401);
      expect(prismaMock.taskComment.create).not.toHaveBeenCalled();
    });

    it('still rejects missing text with 400 COMMENT_TEXT_REQUIRED when authenticated', async () => {
      prismaMock.task.findFirst.mockResolvedValue(existingTask);
      const res = await request(createApp())
        .post(`/api/v1/tasks/${TASK_ID}/comments`)
        .set(bearer(BOOKMARK_TOKEN))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('COMMENT_TEXT_REQUIRED');
    });
  });

  // AC4 — covers automated tests for the matrix above; this block asserts
  // that expired/revoked sessions are distinguished from missing credentials.

  describe('AC4: session lifetime enforcement', () => {
    it('rejects an expired session and tries the Bearer fallback', async () => {
      prismaMock.approvalSession.findUnique.mockResolvedValue({
        actor: 'Quinn',
        expiresAt: new Date(Date.now() - 1_000),
        revokedAt: null
      });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Cookie', `tasks_api_session=${TOM_SESSION}`)
        .set(bearer(QUINN_TOKEN))
        .send({ title: 'X' });
      expect(res.status).toBe(201);
      expect(prismaMock.task.create).toHaveBeenCalled();
    });

    it('rejects a revoked session even with a valid Bearer token afterwards? — Bearer wins', async () => {
      // Sanity: when both cookie and Bearer are present, the middleware
      // tries cookie first; on failure (revoked) it falls back to Bearer.
      prismaMock.approvalSession.findUnique.mockResolvedValue({
        actor: 'Quinn',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date()
      });
      prismaMock.tag.findMany.mockResolvedValue([]);
      prismaMock.task.create.mockResolvedValue({ id: TASK_ID, title: 'X' });
      const res = await request(createApp())
        .post('/api/v1/tasks')
        .set('Cookie', `tasks_api_session=${TOM_SESSION}`)
        .set(bearer(QUINN_TOKEN))
        .send({ title: 'X' });
      expect(res.status).toBe(201);
    });
  });
});
