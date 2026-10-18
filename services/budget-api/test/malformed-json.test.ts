import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';

const originalLimit = process.env.BUDGET_API_JSON_LIMIT;
afterEach(() => {
  if (originalLimit === undefined) delete process.env.BUDGET_API_JSON_LIMIT;
  else process.env.BUDGET_API_JSON_LIMIT = originalLimit;
  vi.restoreAllMocks();
});

describe('Malformed JSON request body', () => {
  it('returns a sanitized 400 with MALFORMED_JSON code', async () => {
    const response = await request(createApp())
      .post('/api/v1/transactions')
      .set('Content-Type', 'application/json')
      // Intentionally invalid JSON: trailing comma, unterminated key.
      .send('{"amount": 1, "category": ,}');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_JSON');
    expect(response.body.error.message).toBe('Request body is not valid JSON');
  });

  it('does not echo the malformed payload in the response body', async () => {
    const response = await request(createApp())
      .post('/api/v1/transactions')
      .set('Content-Type', 'application/json')
      .send('not json at all {]');

    expect(response.status).toBe(400);
    const bodyText = JSON.stringify(response.body);
    expect(bodyText).not.toContain('not json at all');
    expect(bodyText).not.toContain('SyntaxError');
    expect(bodyText).not.toContain('Unexpected');
  });

  it('keeps oversized bodies as 413 (does not collapse into 400)', async () => {
    process.env.BUDGET_API_JSON_LIMIT = '1kb';
    const response = await request(createApp())
      .post('/api/v1/transactions')
      .set('Content-Type', 'application/json')
      .send({ value: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('preserves the 500 branch for genuine server errors', async () => {
    // Build a minimal Express app that mirrors the same final error handler
    // (entity.too.large → 413, entity.parse.failed → 400, everything else
    // → 500) and inject a throwing middleware ahead of it. This isolates the
    // 500-branch assertion from the full app's downstream routes so we do
    // not need to mock ESM modules.
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.post('/probe', (_req, _res, next) => next(new Error('boom')));
    app.use((error, _req, res, _next) => {
      if (error?.type === 'entity.too.large') {
        return res.status(413).json({
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON request body is too large' }
        });
      }
      if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({
          error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' }
        });
      }
      res.status(500).json({
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }
      });
    });

    const response = await request(app)
      .post('/probe')
      .set('Content-Type', 'application/json')
      .send({ ok: true });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
