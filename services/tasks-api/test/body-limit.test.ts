import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const originalLimit = process.env.TASKS_API_JSON_LIMIT;
afterEach(() => {
  if (originalLimit === undefined) delete process.env.TASKS_API_JSON_LIMIT;
  else process.env.TASKS_API_JSON_LIMIT = originalLimit;
});

describe('JSON body limit', () => {
  it('returns 413 for an oversized JSON request', async () => {
    process.env.TASKS_API_JSON_LIMIT = '1kb';
    const response = await request(createApp())
      .post('/api/v1/tasks')
      .set('Content-Type', 'application/json')
      .send({ value: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a small JSON request for normal route handling', async () => {
    process.env.TASKS_API_JSON_LIMIT = '1kb';
    const response = await request(createApp()).post('/api/v1/tasks').send({ value: 'x' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).not.toBe('PAYLOAD_TOO_LARGE');
  });
});
