import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const originalMax = process.env.TASKS_API_RATE_LIMIT_MAX;
const originalWindow = process.env.TASKS_API_RATE_LIMIT_WINDOW_MS;
afterEach(() => {
  if (originalMax === undefined) delete process.env.TASKS_API_RATE_LIMIT_MAX;
  else process.env.TASKS_API_RATE_LIMIT_MAX = originalMax;
  if (originalWindow === undefined) delete process.env.TASKS_API_RATE_LIMIT_WINDOW_MS;
  else process.env.TASKS_API_RATE_LIMIT_WINDOW_MS = originalWindow;
});

describe('sensitive endpoint rate limit', () => {
  it('returns 429 with Retry-After after the configured maximum', async () => {
    process.env.TASKS_API_RATE_LIMIT_MAX = '1';
    process.env.TASKS_API_RATE_LIMIT_WINDOW_MS = '60000';
    const app = createApp();
    expect((await request(app).post('/api/v1/tasks').send({})).status).toBe(400);
    const blocked = await request(app).post('/api/v1/tasks').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
