/**
 * @vitest-environment node
 *
 * Unit tests for the browser telemetry Vercel relay.
 *
 * Task: e89db27f-6d78-418e-91c1-0759f8779d06 (AC1/AC2/AC3 — the relay is
 * the trust boundary between an untrusted browser and the hosted Grafana
 * credentials, so its token check, rate limit, redaction, and size caps
 * are asserted directly).
 *
 * These cover the server side only. `src/lib/browserTelemetry.test.js`
 * covers the browser producer.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { _testInternals } from './telemetry.js';

const RELAY_TOKEN = 'relay-token-under-test';
const LOKI_ENDPOINT = 'https://otlp-region.grafana.net/loki/api/v1/push';

const originalFetch = globalThis.fetch;

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    ended: false
  };
  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.ended = true;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

function makeReq({ method = 'POST', token = RELAY_TOKEN, raw } = {}) {
  const req = Readable.from([Buffer.from(raw ?? '', 'utf8')]);
  req.method = method;
  req.headers = token === null ? {} : { authorization: `Bearer ${token}` };
  return req;
}

const validPayload = {
  environment: 'production',
  release: 'relay-test',
  route: '/sign-in',
  operation: 'signin',
  provider: 'clerk',
  errorCode: 'form_password_incorrect',
  status: '400',
  message: 'Form password is incorrect. Try again',
  stack: 'Error: bad\n  at signIn (app.js:1:1)',
  userAgent: 'vitest',
  timestamp: '2026-10-20T00:00:00.000Z',
  source: 'browser'
};

async function post(overrides = {}, body = '') {
  const res = makeRes();
  await handler(makeReq({ ...overrides, raw: body }), res);
  return res;
}

describe('telemetry relay', () => {
  beforeEach(() => {
    _testInternals.tokenBuckets.clear();
    vi.stubEnv('TELEMETRY_RELAY_TOKEN', RELAY_TOKEN);
    vi.stubEnv('GRAFANA_CLOUD_OTLP_ENDPOINT', 'https://otlp-region.grafana.net/v1/');
    vi.stubEnv('GRAFANA_CLOUD_LOKI_ENDPOINT', '');
    vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', 'Basic dGVzdA==');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    _testInternals.tokenBuckets.clear();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  describe('method and auth', () => {
    it('rejects non-POST with 405 and an Allow header', async () => {
      const res = await post({ method: 'GET', raw: '' });
      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ error: 'method_not_allowed' });
      expect(res.headers.allow).toBe('POST');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects a missing Authorization header with 401', async () => {
      const res = await post({ token: null });
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects a wrong-length token with 401', async () => {
      const res = await post({ token: 'wrong-token', raw: JSON.stringify(validPayload) });
      expect(res.statusCode).toBe(401);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects a same-length wrong token with 401', async () => {
      // Same byte length as the real token so the timingSafeEqual path is
      // exercised rather than short-circuited by the length check.
      const res = await post({ token: 'X'.repeat(RELAY_TOKEN.length) });
      expect(res.statusCode).toBe(401);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects everything when the relay token is unconfigured', async () => {
      vi.stubEnv('TELEMETRY_RELAY_TOKEN', '');
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(401);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('request validation', () => {
    it('rejects malformed JSON with 400 invalid_json', async () => {
      const res = await post({}, '{not json');
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('invalid_json');
    });

    it('rejects a non-object body with 400 expected_object', async () => {
      const res = await post({}, '"just a string"');
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('expected_object');
    });

    it.each(['environment', 'release', 'route', 'operation', 'timestamp'])(
      'rejects a payload missing the required field %s',
      async (field) => {
        const payload = { ...validPayload };
        delete payload[field];
        const res = await post({}, JSON.stringify(payload));
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe(`missing_or_invalid_field:${field}`);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      }
    );

    it('rejects a body over the 32KB raw cap with 413', async () => {
      const res = await post({}, JSON.stringify({ ...validPayload, stack: 'x'.repeat(40 * 1024) }));
      expect(res.statusCode).toBe(413);
      expect(res.body).toEqual({ error: 'payload_too_large' });
    });
  });

  describe('rate limiting', () => {
    it('returns 429 once 60 events/minute are already through', async () => {
      for (let i = 0; i < 60; i += 1) {
        const ok = await post({}, JSON.stringify(validPayload));
        expect(ok.statusCode).toBe(204);
      }
      const limited = await post({}, JSON.stringify(validPayload));
      expect(limited.statusCode).toBe(429);
      expect(limited.body).toEqual({ error: 'rate_limited' });
      // The 61st request must not have reached Loki.
      expect(globalThis.fetch).toHaveBeenCalledTimes(60);
    });

    it('counts rate limits per token, not globally', async () => {
      const secondToken = 'second-relay-token-value';
      vi.stubEnv('TELEMETRY_RELAY_TOKEN', secondToken);
      for (let i = 0; i < 60; i += 1) {
        await post({ token: secondToken }, JSON.stringify(validPayload));
      }
      const limited = await post({ token: secondToken }, JSON.stringify(validPayload));
      expect(limited.statusCode).toBe(429);

      // A different valid token still has its own fresh bucket.
      vi.stubEnv('TELEMETRY_RELAY_TOKEN', RELAY_TOKEN);
      const other = await post({}, JSON.stringify(validPayload));
      expect(other.statusCode).toBe(204);
    });
  });

  describe('upstream forwarding', () => {
    it('forwards to the Loki push path derived from the documented /v1/ base', async () => {
      await post({}, JSON.stringify(validPayload));
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch.mock.calls[0][0]).toBe(LOKI_ENDPOINT);
    });

    it.each([
      ['https://otlp-region.grafana.net/v1/', 'https://otlp-region.grafana.net/loki/api/v1/push'],
      ['https://otlp-region.grafana.net/v1', 'https://otlp-region.grafana.net/loki/api/v1/push'],
      [
        'https://otlp-prod-1.grafana.net/otlp/v1/logs',
        'https://otlp-prod-1.grafana.net/otlp/loki/api/v1/push'
      ],
      [
        'https://logs-prod-1.grafana.net/loki/api/v1/push',
        'https://logs-prod-1.grafana.net/loki/api/v1/push'
      ]
    ])('rewrites %s to %s', (base, expected) => {
      expect(_testInternals.lokiPushUrl(base)).toBe(expected);
    });

    it('prefers an explicit GRAFANA_CLOUD_LOKI_ENDPOINT over the OTLP-derived URL', async () => {
      vi.stubEnv('GRAFANA_CLOUD_LOKI_ENDPOINT', 'https://logs-prod-abc.grafana.net/loki/api/v1/push');
      await post({}, JSON.stringify(validPayload));
      expect(globalThis.fetch.mock.calls[0][0]).toBe('https://logs-prod-abc.grafana.net/loki/api/v1/push');
    });

    it('falls back to the OTLP-derived URL when no explicit endpoint is set', async () => {
      await post({}, JSON.stringify(validPayload));
      expect(globalThis.fetch.mock.calls[0][0]).toBe(LOKI_ENDPOINT);
    });

    it('sends the server-held Grafana credentials, never a client-supplied header', async () => {
      await post({}, JSON.stringify(validPayload));
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.headers.Authorization).toBe('Basic dGVzdA==');
      expect(JSON.stringify(init.body)).not.toContain(RELAY_TOKEN);
    });

    it('labels the stream with the app, source, and retained context fields', async () => {
      await post({}, JSON.stringify(validPayload));
      const [, init] = globalThis.fetch.mock.calls[0];
      const [stream] = JSON.parse(init.body).streams;
      expect(stream.stream).toMatchObject({
        app: 'gymtrack',
        source: 'browser',
        environment: 'production',
        route: '/sign-in',
        operation: 'signin'
      });
    });

    it('returns 204 when the relay is not configured, without calling upstream', async () => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_ENDPOINT', '');
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(204);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('maps a non-2xx upstream response to 502 upstream_failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ error: 'upstream_failure', message: 'loki_404' });
    });

    it('maps an unreachable upstream to 502 without leaking the relay token', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(502);
      expect(res.body.error).toBe('upstream_failure');
      expect(JSON.stringify(res.body)).not.toContain(RELAY_TOKEN);
    });
  });

  describe('server-side redaction (defence in depth)', () => {
    it('redacts an email that slipped past the browser redactor', async () => {
      await post({}, JSON.stringify({ ...validPayload, message: 'Failed for foo@bar.com' }));
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.body).toContain('[redacted-email]');
      expect(init.body).not.toContain('foo@bar.com');
    });

    it('redacts a Bearer token and a password from the stack', async () => {
      await post(
        {},
        JSON.stringify({
          ...validPayload,
          stack: 'Authorization: Bearer abc.def.ghi password=hunter2'
        })
      );
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.body).toContain('Bearer [redacted]');
      expect(init.body).toContain('password=[redacted]');
      expect(init.body).not.toContain('abc.def.ghi');
      expect(init.body).not.toContain('hunter2');
    });

    it('drops fields outside the allow-list', async () => {
      await post({}, JSON.stringify({ ...validPayload, sessionToken: 'secret', email: 'foo@bar.com' }));
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.body).not.toContain('secret');
      expect(init.body).not.toContain('sessionToken');
    });

    it('rejects a structured payload over the 8KB cap', async () => {
      // Every field except `timestamp` is truncated, so an oversized
      // timestamp is what actually reaches the structured cap.
      const res = await post(
        {},
        JSON.stringify({ ...validPayload, timestamp: '2026-10-20T00:00:00.000Z'.repeat(500) })
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('payload_too_large_structured');
    });
  });
});