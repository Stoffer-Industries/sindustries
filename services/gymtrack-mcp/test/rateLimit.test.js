import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

class FakeRepo {
  async getOAuthClient(_clientId) {
    return null;
  }
  async createDynamicOAuthClient() {
    return null;
  }
  async verifySupabaseUserAccessToken(_token) {
    return null;
  }
  async getConsent(_id) {
    return null;
  }
  async upsertConsent() {
    return null;
  }
  async createAuthorizationCode() {
    return null;
  }
  async consumeAuthorizationCode() {
    return null;
  }
  async findTokenByAccessHash() {
    return null;
  }
  async findTokenByRefreshHash() {
    return null;
  }
  async createToken() {
    return null;
  }
  async rotateRefreshToken() {
    return { status: 'invalid' };
  }
  async revokeConsentFamily() {
    return null;
  }
  async touchTokenUsage() {
    return null;
  }
}

const VALID_REGISTER_BODY = {
  redirect_uris: ['https://example.test/callback'],
  client_name: 'rate-limit-test'
};

// Mutable clock used by both app.js (via injected `now`) and the rate
// limiter (via `createRateLimit({ now })`). Starts at a fixed wall-clock
// instant so tests are deterministic regardless of when they actually run.
let clockMs = Date.parse('2026-09-09T00:00:00.000Z');

function makeApp({
  windowMs = 60_000,
  max = 10,
  now: nowOverride
} = {}) {
  clockMs = Date.parse('2026-09-09T00:00:00.000Z');
  const fixedNow = nowOverride ?? (() => new Date(clockMs));
  const config = {
    issuer: 'https://mcp.example',
    appUrl: 'https://gymtrack.example',
    webOrigin: 'https://gymtrack.example',
    port: 8787,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
    authorizationCodeTtlSeconds: 600,
    oauthRateLimitWindowMs: windowMs,
    oauthRateLimitMax: max
  };
  const app = createApp({
    repo: new FakeRepo(),
    gymtrackClient: {},
    now: fixedNow,
    config
  });
  return { app, config };
}

describe('gymtrack-mcp OAuth rate limit', () => {
  let consoleWarnSpy;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('AC1 — POST /oauth/register throttling', () => {
    it('lets the first request through and 429s once the per-IP window is exceeded', async () => {
      const { app } = makeApp({ max: 3, windowMs: 60_000 });

      for (let i = 0; i < 3; i += 1) {
        const res = await request(app)
          .post('/oauth/register')
          .send(VALID_REGISTER_BODY);
        // First 3 must NOT be 429 — the FakeRepo.createDynamicOAuthClient
        // returns null so the handler will fail downstream, but the rate
        // limiter should still pass them through (non-429 status).
        expect(res.status).not.toBe(429);
        expect(res.headers['x-ratelimit-limit']).toBe('3');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(3 - (i + 1)));
      }

      const blocked = await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests; try again later'
        }
      });
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe('AC2 — POST /oauth/token throttling', () => {
    it('throttles /oauth/token with the same envelope shape as /oauth/register', async () => {
      const { app } = makeApp({ max: 2, windowMs: 60_000 });

      // First 2 requests pass the rate limiter (handler returns 400 because
      // no client_id supplied — that is fine, we are asserting the limiter
      // did not 429 them).
      for (let i = 0; i < 2; i += 1) {
        const res = await request(app)
          .post('/oauth/token')
          .send({});
        expect(res.status).not.toBe(429);
      }

      const blocked = await request(app)
        .post('/oauth/token')
        .send({});
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('AC3 — GET /oauth/authorize throttling', () => {
    it('throttles /oauth/authorize with the same envelope', async () => {
      const { app } = makeApp({ max: 2, windowMs: 60_000 });

      for (let i = 0; i < 2; i += 1) {
        const res = await request(app).get('/oauth/authorize').query({
          response_type: 'code',
          client_id: 'whatever',
          redirect_uri: 'https://example.test/callback',
          state: 'x',
          code_challenge: 'abc',
          code_challenge_method: 'S256'
        });
        expect(res.status).not.toBe(429);
      }

      const blocked = await request(app).get('/oauth/authorize').query({
        response_type: 'code',
        client_id: 'whatever',
        redirect_uri: 'https://example.test/callback',
        state: 'x',
        code_challenge: 'abc',
        code_challenge_method: 'S256'
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('AC4 — health and discovery GETs are exempt', () => {
    it('never throttles /health even after the OAuth window is exceeded', async () => {
      const { app } = makeApp({ max: 1, windowMs: 60_000 });

      // Trip the rate limit on /oauth/register.
      await request(app).post('/oauth/register').send(VALID_REGISTER_BODY);
      const blocked = await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY);
      expect(blocked.status).toBe(429);

      // /health must still answer 200.
      for (let i = 0; i < 5; i += 1) {
        const health = await request(app).get('/health');
        expect(health.status).toBe(200);
        expect(health.headers['x-ratelimit-limit']).toBeUndefined();
      }
    });

    it('never throttles /.well-known/oauth-authorization-server', async () => {
      const { app } = makeApp({ max: 1, windowMs: 60_000 });

      // Trip the rate limit on /oauth/register.
      await request(app).post('/oauth/register').send(VALID_REGISTER_BODY);
      await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY)
        .expect(429);

      for (let i = 0; i < 5; i += 1) {
        const discovery = await request(app).get(
          '/.well-known/oauth-authorization-server'
        );
        expect(discovery.status).toBe(200);
        expect(discovery.headers['x-ratelimit-limit']).toBeUndefined();
      }
    });

    it('never throttles /.well-known/oauth-protected-resource', async () => {
      const { app } = makeApp({ max: 1, windowMs: 60_000 });

      await request(app).post('/oauth/register').send(VALID_REGISTER_BODY);
      await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY)
        .expect(429);

      const res = await request(app).get(
        '/.well-known/oauth-protected-resource'
      );
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });

  describe('AC5 — window reset', () => {
    it('allows new requests once the fixed window has elapsed', async () => {
      const { app } = makeApp({ max: 1, windowMs: 1000 });

      // First request inside window — passes the limiter.
      const first = await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY);
      expect(first.status).not.toBe(429);

      // Second request inside window — over limit, 429.
      const blocked = await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY);
      expect(blocked.status).toBe(429);

      // Advance the clock past the window.
      clockMs += 1500;

      // New window — first request must pass again.
      const afterReset = await request(app)
        .post('/oauth/register')
        .send(VALID_REGISTER_BODY);
      expect(afterReset.status).not.toBe(429);
      expect(afterReset.headers['x-ratelimit-remaining']).toBe('0');
    });
  });

  describe('per-IP isolation', () => {
    it('counts each forwarded client IP separately', async () => {
      const { app } = makeApp({ max: 1, windowMs: 60_000 });

      const ipA = await request(app)
        .post('/oauth/register')
        .set('X-Forwarded-For', '203.0.113.1')
        .send(VALID_REGISTER_BODY);
      expect(ipA.status).not.toBe(429);

      const ipABlocked = await request(app)
        .post('/oauth/register')
        .set('X-Forwarded-For', '203.0.113.1')
        .send(VALID_REGISTER_BODY);
      expect(ipABlocked.status).toBe(429);

      const ipBOk = await request(app)
        .post('/oauth/register')
        .set('X-Forwarded-For', '203.0.113.2')
        .send(VALID_REGISTER_BODY);
      expect(ipBOk.status).not.toBe(429);
    });
  });
});
