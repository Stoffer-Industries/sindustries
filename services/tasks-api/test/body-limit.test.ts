import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalLimit = process.env.TASKS_API_JSON_LIMIT;
afterEach(() => {
  if (originalLimit === undefined) delete process.env.TASKS_API_JSON_LIMIT;
  else process.env.TASKS_API_JSON_LIMIT = originalLimit;
  vi.restoreAllMocks();
});

// env.ts parses process.env once at module load and freezes the result,
// so the boot-time snapshot won't see per-test mutations of
// TASKS_API_JSON_LIMIT. vi.resetModules() drops the module cache so the
// next import re-parses env with whatever we just set.
beforeEach(() => {
  vi.resetModules();
});

describe('JSON body limit', () => {
  it('returns 413 for an oversized JSON request', async () => {
    process.env.TASKS_API_JSON_LIMIT = '1kb';
    const { createApp } = await import('../src/app.ts');
    const response = await authedRequest(createApp())
      .post('/api/v1/tasks')
      .set('Content-Type', 'application/json')
      .send({ value: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a small JSON request for normal route handling', async () => {
    process.env.TASKS_API_JSON_LIMIT = '1kb';
    const { createApp } = await import('../src/app.ts');
    const response = await authedRequest(createApp()).post('/api/v1/tasks').send({ value: 'x' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).not.toBe('PAYLOAD_TOO_LARGE');
  });
});
