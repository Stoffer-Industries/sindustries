import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('health endpoint', () => {
  const originalEnv = process.env.GIT_COMMIT_SHA;

  beforeEach(() => {
    delete process.env.GIT_COMMIT_SHA;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GIT_COMMIT_SHA;
    } else {
      process.env.GIT_COMMIT_SHA = originalEnv;
    }
  });

  it('returns 200 with status + service + null version when GIT_COMMIT_SHA is unset', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'budget-api',
      version: null
    });
  });

  it('exposes the deployed commit SHA as version when GIT_COMMIT_SHA is set', async () => {
    process.env.GIT_COMMIT_SHA = '26e0492218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'budget-api',
      version: '26e0492218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
  });
});