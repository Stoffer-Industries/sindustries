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
import handler, {
  _testInternals,
  lokiAuthHeaders,
  lokiMisconfiguredReason,
  parseOtlpHeaderString
} from './telemetry.js';

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
    vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', 'Authorization=Basic dGVzdA==');
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

  // PR #836, Quinn's review 2026-10-21 22:20Z, constraints #1 and #3.
  // The OTLP/logs transport is ADDITIVE: `lokiPushUrl()` is untouched and
  // its refusal cases below still assert the same nulls.
  describe('OTLP/logs transport', () => {
    beforeEach(() => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_LOGS_ENDPOINT', '');
    });

    // Live probe against otlp-gateway-prod-au-southeast-1.grafana.net
    // (2026-10-22, unauthenticated POST):
    //   /v1/logs      -> 404   path absent
    //   /otlp/v1/logs -> 401   path exists, auth required
    // Mapping a bare host to <host>/v1/logs would therefore 404 and read
    // as "the telemetry relay is broken".
    it.each([
      [
        'https://otlp-gateway-prod-au-southeast-1.grafana.net',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      ],
      [
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      ],
      [
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      ],
      [
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      ],
      [
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      ]
    ])('derives the probe-verified logs endpoint from %s', (base, expected) => {
      expect(_testInternals.otlpLogsUrl(base)).toBe(expected);
    });

    // The canonical single-host collector form stays with the Loki
    // transport. Claiming it here would silently move existing
    // single-host deployments off the tested Loki path.
    it('leaves the single-host /v1 shapes to the Loki rewriter', () => {
      expect(_testInternals.otlpLogsUrl('https://otlp-region.grafana.net/v1/')).toBeNull();
      expect(_testInternals.otlpLogsUrl('https://otlp-region.grafana.net/v1')).toBeNull();
      expect(_testInternals.lokiPushUrl('https://otlp-region.grafana.net/v1/')).toBe(
        'https://otlp-region.grafana.net/loki/api/v1/push'
      );
    });

    it('forwards a bare Grafana Cloud OTLP gateway to the /otlp/v1/logs endpoint', async () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(204);
      expect(globalThis.fetch.mock.calls[0][0]).toBe(
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1/logs'
      );
    });

    it('prefers an explicit GRAFANA_CLOUD_OTLP_LOGS_ENDPOINT over the derived URL', async () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      vi.stubEnv('GRAFANA_CLOUD_OTLP_LOGS_ENDPOINT', 'https://collector.example/otlp/v1/logs');
      await post({}, JSON.stringify(validPayload));
      expect(globalThis.fetch.mock.calls[0][0]).toBe('https://collector.example/otlp/v1/logs');
    });

    it('still prefers an explicit Loki endpoint over the OTLP transport', async () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      vi.stubEnv(
        'GRAFANA_CLOUD_LOKI_ENDPOINT',
        'https://logs-prod-41-prod-au-southeast-1.grafana.net/loki/api/v1/push'
      );
      await post({}, JSON.stringify(validPayload));
      expect(globalThis.fetch.mock.calls[0][0]).toBe(
        'https://logs-prod-41-prod-au-southeast-1.grafana.net/loki/api/v1/push'
      );
      expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).streams).toBeDefined();
    });

    // Constraint #3: the operator query {app="gymtrack", source="browser"}
    // only matches INDEXED stream labels. Loki's OTLP ingestion promotes
    // resource attributes; log-record attributes become structured
    // metadata, which a stream selector cannot match. Pin the shape.
    it('emits app and source as RESOURCE attributes, not log-record attributes', () => {
      const payload = _testInternals.buildOtlpLogsPayload({
        ...validPayload,
        environment: 'production',
        release: 'relay-test',
        route: '/sign-in',
        operation: 'signin'
      });
      const [resourceLog] = payload.resourceLogs;
      const keys = resourceLog.resource.attributes.map((a) => a.key);
      expect(keys).toEqual(expect.arrayContaining(['app', 'source']));
      const byKey = Object.fromEntries(
        resourceLog.resource.attributes.map((a) => [a.key, a.value.stringValue])
      );
      expect(byKey.app).toBe('gymtrack');
      expect(byKey.source).toBe('browser');
      // Pin it in the negative direction too: nothing on the log record
      // itself may shadow the labels.
      const [record] = resourceLog.scopeLogs[0].logRecords;
      expect(record.attributes ?? []).toEqual([]);
    });

    // The dashboard's `sum by (errorCode)`, `sum by (operation)` and
    // `by (route)` panels require those to be indexed labels too.
    // Emitting only app+source would forward cleanly, land the events,
    // and then return empty aggregations.
    it('emits the full Loki label set as resource attributes for dashboard parity', () => {
      const payload = _testInternals.buildOtlpLogsPayload({
        ...validPayload,
        environment: 'production',
        release: 'relay-test',
        route: '/sign-in',
        operation: 'signin',
        provider: 'clerk',
        errorCode: 'form_password_incorrect',
        status: '400'
      });
      const byKey = Object.fromEntries(
        payload.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
      );
      expect(byKey).toMatchObject({
        app: 'gymtrack',
        source: 'browser',
        environment: 'production',
        release: 'relay-test',
        route: '/sign-in',
        operation: 'signin',
        provider: 'clerk',
        errorCode: 'form_password_incorrect',
        status: '400'
      });
    });

    // AC4 needs BOTH halves: the window error listener
    // (source: 'window.error') and the auth reporter (source: 'auth').
    // Hardcoding 'browser' would silently collapse the auth half.
    it('carries the real event source through instead of hardcoding browser', () => {
      const payload = _testInternals.buildOtlpLogsPayload({
        ...validPayload,
        source: 'auth',
        environment: 'production',
        release: 'relay-test',
        route: '/sign-in',
        operation: 'signin'
      });
      const byKey = Object.fromEntries(
        payload.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue])
      );
      expect(byKey.source).toBe('auth');
    });

    it('keeps the sanitized event in the log record body', () => {
      const payload = _testInternals.buildOtlpLogsPayload({
        ...validPayload,
        source: 'browser',
        environment: 'production',
        release: 'relay-test',
        route: '/sign-in',
        operation: 'signin'
      });
      const [record] = payload.resourceLogs[0].scopeLogs[0].logRecords;
      const body = JSON.parse(record.body.stringValue);
      expect(body.message).not.toContain('@');
      expect(body.operation).toBe('signin');
      expect(record.severityText).toBe('ERROR');
    });

    it('reports the OTLP transport in the upstream_failure message', async () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.body).toEqual({ error: 'upstream_failure', message: 'otlp_401' });
    });

    it('returns null from resolveForwardEndpoint when nothing is configured', () => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_ENDPOINT', '');
      vi.stubEnv('GRAFANA_CLOUD_LOKI_ENDPOINT', '');
      expect(_testInternals.resolveForwardEndpoint()).toBeNull();
    });

    // The 502 now names BOTH transports it tried, so an operator can
    // pick the right env var instead of guessing.
    it('names both transports in the unresolvable-endpoint reason', () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp'
      );
      const resolved = _testInternals.resolveForwardEndpoint();
      expect(resolved.transport).toBeNull();
      expect(resolved.reason).toMatch(/GRAFANA_CLOUD_LOKI_ENDPOINT/);
      expect(resolved.reason).toMatch(/GRAFANA_CLOUD_OTLP_LOGS_ENDPOINT/);
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
        'https://otlp-region.grafana.net/v1/traces',
        'https://otlp-region.grafana.net/loki/api/v1/push'
      ],
      [
        'https://otlp-region.grafana.net/v1/logs/',
        'https://otlp-region.grafana.net/loki/api/v1/push'
      ],
      [
        'https://logs-prod-1.grafana.net/loki/api/v1/push',
        'https://logs-prod-1.grafana.net/loki/api/v1/push'
      ]
    ])('rewrites %s to %s', (base, expected) => {
      expect(_testInternals.lokiPushUrl(base)).toBe(expected);
    });

    // Multi-host Grafana Cloud tenants serve OTLP and the Loki push API
    // on different hosts (otlp-prod-* vs. logs-prod-*). The single-host
    // rewriter cannot produce a working Loki URL from these shapes, so
    // it must refuse rather than append `/loki/api/v1/push` to a bare
    // host (which answers 404). Production probe evidence from Quinn
    // (PR #836 review, 2026-10-20 14:50Z) established that the live
    // OTLP shape on this tenant is the bare host or an `/otlp/v1` style
    // path, neither of which is safe to rewrite. The earlier rewriter
    // table case `/otlp/v1/logs` was a single-host assumption that fell
    // out of production-shape probing — it now expects null alongside
    // the bare-host cases.
    it.each([
      ['https://otlp-gateway-prod-au-southeast-1.grafana.net'],
      ['https://otlp-gateway-prod-au-southeast-1.grafana.net/'],
      ['https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp/v1'],
      ['https://otlp-gateway-prod-au-southeast-1.grafana.net/otlp'],
      ['https://otlp-prod-1.grafana.net/otlp/v1/logs']
    ])('refuses to rewrite %s on multi-host shapes (returns null)', (base) => {
      expect(_testInternals.lokiPushUrl(base)).toBeNull();
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

    it('sends the documented OTLP exporter header string as real HTTP headers', async () => {
      // The exact shape `infra/cloud/observability/env/.env.example`,
      // docs/systems/observability.md, and bootstrap-observability.sh all
      // document. Passing this through verbatim as the header VALUE
      // produced `Authorization: Authorization=Basic <b64>`, which Grafana
      // Cloud rejects with 401 -> 502 -> "no browser events arrived".
      vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', 'Authorization=Basic aW5zdGFuY2U6dG9rZW4=');
      await post({}, JSON.stringify(validPayload));
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.headers.Authorization).toBe('Basic aW5zdGFuY2U6dG9rZW4=');
      expect(init.headers.Authorization).not.toContain('Authorization=');
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

    // When the operator attempted to configure the relay but the OTLP
    // base does not serve the Loki push API on this tenant (Grafana
    // Cloud multi-host shape), the relay must surface a clear,
    // actionable 502 instead of silently no-oping. Silently no-oping
    // here masked the config gap: the browser event would be dropped
    // without any operator-visible signal. Quinn's PR #836 review at
    // 2026-10-20 14:50Z flagged this as defect 5 in the same class as
    // four previous defects — the failure mode reads as "the telemetry
    // relay is broken" rather than "you need to set
    // GRAFANA_CLOUD_LOKI_ENDPOINT".
    it('returns 502 misconfigured_loki_endpoint when the OTLP base has no /v1[-suffix] and no override', async () => {
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(502);
      expect(res.body.error).toBe('misconfigured_loki_endpoint');
      expect(res.body.message).toMatch(/GRAFANA_CLOUD_LOKI_ENDPOINT/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('treats the same shape as a graceful 204 when no credential AND no OTLP endpoint are set', async () => {
      // Half-armed intermediate state, where the operator set neither
      // OTLP nor override, must continue to no-op silently (existing
      // behaviour). A 502 here would generate alert spam during staged
      // rollouts.
      vi.stubEnv('GRAFANA_CLOUD_OTLP_ENDPOINT', '');
      vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', '');
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(204);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('lokiMisconfiguredReason returns null on a derivable base and an actionable message on an unrecognised base', () => {
      // Empty configuration → operator has not started, no error.
      expect(lokiMisconfiguredReason()).toBeNull();
      vi.stubEnv('GRAFANA_CLOUD_LOKI_ENDPOINT', '');
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-region.grafana.net/v1/'
      );
      expect(lokiMisconfiguredReason()).toBeNull();
      // Bare host with no override → actionable: explicit LOKI required.
      vi.stubEnv(
        'GRAFANA_CLOUD_OTLP_ENDPOINT',
        'https://otlp-gateway-prod-au-southeast-1.grafana.net'
      );
      expect(lokiMisconfiguredReason()).toMatch(/GRAFANA_CLOUD_LOKI_ENDPOINT/);
      // Explicit override wins — operator pointed at the right host,
      // the OTLP base no longer matters.
      vi.stubEnv(
        'GRAFANA_CLOUD_LOKI_ENDPOINT',
        'https://logs-prod-41-prod-au-southeast-1.grafana.net/loki/api/v1/push'
      );
      expect(lokiMisconfiguredReason()).toBeNull();
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

  describe('OTLP exporter header parsing', () => {
    it.each([
      ['Authorization=Basic dGVzdA==', { Authorization: 'Basic dGVzdA==' }],
      ['Basic dGVzdA==', { Authorization: 'Basic dGVzdA==' }],
      ['  Basic dGVzdA==  ', { Authorization: 'Basic dGVzdA==' }],
      [
        'Authorization=Basic dGVzdA==,X-Scope-OrgID=42',
        { Authorization: 'Basic dGVzdA==', 'X-Scope-OrgID': '42' }
      ],
      ['X-Scope-OrgID=42', { 'X-Scope-OrgID': '42' }],
      // Base64 padding must survive: only the FIRST `=` splits.
      ['Authorization=Basic aGVsbG8gd29ybGQhIQ==', { Authorization: 'Basic aGVsbG8gd29ybGQhIQ==' }],
      // A space before the `=` means it is not a header pair.
      ['Basic aGVsbG8=', { Authorization: 'Basic aGVsbG8=' }],
      ['Authorization=Basic abc%2Fdef%3D', { Authorization: 'Basic abc/def=' }],
      ['', {}],
      ['   ', {}]
    ])('parses %j', (raw, expected) => {
      expect(parseOtlpHeaderString(raw)).toEqual(expected);
    });

    it('returns null from lokiAuthHeaders when no credential is configured', () => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', '');
      expect(lokiAuthHeaders()).toBeNull();
    });

    it('returns the parsed headers from lokiAuthHeaders when configured', () => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', 'Authorization=Basic dGVzdA==');
      expect(lokiAuthHeaders()).toEqual({ Authorization: 'Basic dGVzdA==' });
    });

    it('no-ops without calling upstream when the credential is blank', async () => {
      vi.stubEnv('GRAFANA_CLOUD_OTLP_HEADERS', '   ');
      const res = await post({}, JSON.stringify(validPayload));
      expect(res.statusCode).toBe(204);
      expect(globalThis.fetch).not.toHaveBeenCalled();
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