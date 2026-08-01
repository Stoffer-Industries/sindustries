import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const originalMax = process.env.BUDGET_API_RATE_LIMIT_MAX;
const originalWindow = process.env.BUDGET_API_RATE_LIMIT_WINDOW_MS;
afterEach(() => {
  if (originalMax === undefined) delete process.env.BUDGET_API_RATE_LIMIT_MAX;
  else process.env.BUDGET_API_RATE_LIMIT_MAX = originalMax;
  if (originalWindow === undefined) delete process.env.BUDGET_API_RATE_LIMIT_WINDOW_MS;
  else process.env.BUDGET_API_RATE_LIMIT_WINDOW_MS = originalWindow;
});

describe('sensitive endpoint rate limit', () => {
  it('returns 429 with Retry-After after the configured maximum', async () => {
    process.env.BUDGET_API_RATE_LIMIT_MAX = '1';
    process.env.BUDGET_API_RATE_LIMIT_WINDOW_MS = '60000';
    const app = createApp();
    expect((await request(app).post('/api/v1/akahu/exchange').send({})).status).not.toBe(429);
    const blocked = await request(app).post('/api/v1/akahu/exchange').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
