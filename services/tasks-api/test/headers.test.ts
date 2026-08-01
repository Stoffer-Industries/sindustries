import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('security headers', () => {
  it('adds the baseline Helmet headers', async () => {
    const response = await request(createApp()).get('/health');
    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
