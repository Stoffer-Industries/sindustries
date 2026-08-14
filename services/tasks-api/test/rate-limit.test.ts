import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalMax = process.env.TASKS_API_RATE_LIMIT_MAX;
const originalWindow = process.env.TASKS_API_RATE_LIMIT_WINDOW_MS;
afterEach(() => {
  if (originalMax === undefined) delete process.env.TASKS_API_RATE_LIMIT_MAX;
  else process.env.TASKS_API_RATE_LIMIT_MAX = originalMax;
  if (originalWindow === undefined) delete process.env.TASKS_API_RATE_LIMIT_WINDOW_MS;
  else process.env.TASKS_API_RATE_LIMIT_WINDOW_MS = originalWindow;
  vi.restoreAllMocks();
});

// env.ts parses process.env once at module load and freezes the result,
// so the boot-time snapshot won't see per-test mutations of
// TASKS_API_RATE_LIMIT_MAX / TASKS_API_RATE_LIMIT_WINDOW_MS. vi.resetModules()
// drops the module cache so the next import re-parses env with whatever
// we just set.
beforeEach(() => {
  vi.resetModules();
});

describe('sensitive endpoint rate limit', () => {
  it('returns 429 with Retry-After after the configured maximum', async () => {
    process.env.TASKS_API_RATE_LIMIT_MAX = '1';
    process.env.TASKS_API_RATE_LIMIT_WINDOW_MS = '60000';
    const { createApp } = await import('../src/app.ts');
    const app = createApp();
    expect((await authedRequest(app).post('/api/v1/tasks').send({})).status).toBe(400);
    const blocked = await authedRequest(app).post('/api/v1/tasks').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
