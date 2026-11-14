/**
 * Unit tests for the browser error telemetry module.
 *
 * Task: e89db27f-6d78-418e-91c1-0759f8779d06 (AC2 — redaction contract,
 * AC3 — non-blocking + dedupe + volume, plus the install/reset contract).
 *
 * Validates:
 *   1. Redaction strips email addresses, `Bearer …` tokens, and
 *      `password=…` patterns from `message` and `stack`.
 *   2. `installBrowserTelemetry()` is a no-op when the env var is not
 *      the literal '1'.
 *   3. `installBrowserTelemetry()` is idempotent — second call returns
 *      false without re-registering listeners.
 *   4. 10 events with the same `errorCode + operation + route` produce
 *      one POST in 60s (dedupe).
 *   5. 10 distinct events in 60s produce at most MAX_EVENTS_PER_MINUTE
 *      POSTs (volume cap).
 *   6. A `fetch` rejection in the relay does not throw out of
 *      `reportAuthError` or the global listeners.
 *   7. The payload includes the retained fields only. Auth events are
 *      context-only (`message` and `stack` are null); the generic error path
 *      retains only the redacted message and stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetBrowserTelemetryForTests,
  installBrowserTelemetry,
  reportAuthError
} from './browserTelemetry.js';

const originalFetch = globalThis.fetch;

describe('browserTelemetry', () => {
  beforeEach(() => {
    _resetBrowserTelemetryForTests();
    vi.resetModules();
    vi.stubEnv('VITE_TELEMETRY_ENABLED', '1');
    vi.stubEnv('VITE_TELEMETRY_TOKEN', 'relay-test-token');
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', 'test-release');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    _resetBrowserTelemetryForTests();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('never lets a Clerk envelope reach the POST body (context-only auth contract)', () => {
    const fetchSpy = globalThis.fetch;

    const SENTINEL_EMAIL = 'sentinel.user@example.invalid';
    const SENTINEL_TOKEN = 'sentinel_session_token_9f3a';
    const SENTINEL_SESSION = 'sentinel_session_id_4b2c';
    const SENTINEL_STACK = 'sentinel_stack_frame_7d1e';

    // A representative Clerk envelope carrying every category the
    // browser-side redaction patterns do not reliably cover: an address,
    // a session token, a session id and a stack frame.
    const clerkEnvelope = {
      errors: [
        {
          code: 'identifier_not_found',
          message: `Identifier ${SENTINEL_EMAIL} is not registered`,
          longMessage: `Identifier ${SENTINEL_EMAIL} is not registered`,
          meta: { session_token: SENTINEL_TOKEN, session_id: SENTINEL_SESSION }
        }
      ],
      status: 404,
      message: `Identifier ${SENTINEL_EMAIL} is not registered`,
      stack: `Error: Clerk\n    at ${SENTINEL_STACK} (session=${SENTINEL_SESSION})`
    };

    // The Clerk call site reports only the safe code + status. Attach the
    // representative envelope to the context as defence in depth: even if
    // a future caller accidentally forwards it, the serializer must not
    // copy any of its fields or nested sentinels into the POST body.
    reportAuthError({
      provider: 'clerk',
      operation: 'signin_identify',
      errorCode: clerkEnvelope.errors[0].code,
      status: String(clerkEnvelope.status),
      errors: clerkEnvelope.errors,
      message: clerkEnvelope.message,
      stack: clerkEnvelope.stack,
      meta: clerkEnvelope.meta
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const serialized = JSON.stringify(body);

    for (const sentinel of [SENTINEL_EMAIL, SENTINEL_TOKEN, SENTINEL_SESSION, SENTINEL_STACK]) {
      expect(serialized).not.toContain(sentinel);
    }

    // The safe signal still reaches the operator.
    expect(body.errorCode).toBe('identifier_not_found');
    expect(body.status).toBe('404');
    expect(body.operation).toBe('signin_identify');
    expect(body.provider).toBe('clerk');

    // No message and no stack at all — not redacted, absent.
    expect(body.message).toBeNull();
    expect(body.stack).toBeNull();
  });

  it('pins the auth reporting API to a single context argument', () => {
    // Structural pin: if a second parameter is ever added, the envelope
    // could be handed to the serializer again and the contract above
    // would silently stop holding.
    expect(reportAuthError).toHaveLength(1);
  });

  it('sends only the allow-listed fields', () => {
    const fetchSpy = globalThis.fetch;
    reportAuthError({
      provider: 'supabase',
      operation: 'signin',
      errorCode: 'invalid_grant',
      status: '400'
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(
      [
        'environment',
        'errorCode',
        'message',
        'operation',
        'provider',
        'release',
        'route',
        'source',
        'stack',
        'status',
        'timestamp',
        'userAgent'
      ].sort()
    );
    expect(body.provider).toBe('supabase');
    expect(body.operation).toBe('signin');
    expect(body.errorCode).toBe('invalid_grant');
  });

  it('is a no-op when VITE_TELEMETRY_ENABLED is not the literal "1"', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENABLED', '');
    const addSpy = vi.spyOn(window, 'addEventListener');
    const installed = installBrowserTelemetry();
    expect(installed).toBe(false);
    const errorCalls = addSpy.mock.calls.filter(([name]) => name === 'error');
    expect(errorCalls).toHaveLength(0);
    addSpy.mockRestore();
  });

  it('registers exactly one error and one unhandledrejection listener when enabled', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    expect(installBrowserTelemetry()).toBe(true);
    expect(installBrowserTelemetry()).toBe(false);
    const errorListeners = addSpy.mock.calls.filter(([name]) => name === 'error');
    const rejectionListeners = addSpy.mock.calls.filter(
      ([name]) => name === 'unhandledrejection'
    );
    expect(errorListeners).toHaveLength(1);
    expect(rejectionListeners).toHaveLength(1);
    addSpy.mockRestore();
  });

  it('dedupes 10 events with the same errorCode + operation + route to one POST', () => {
    const fetchSpy = globalThis.fetch;
    const ctx = { provider: 'clerk', operation: 'signin', errorCode: 'invalid_credentials' };
    for (let i = 0; i < 10; i += 1) {
      reportAuthError(ctx);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps distinct events in 60s to MAX_EVENTS_PER_MINUTE', () => {
    const fetchSpy = globalThis.fetch;
    for (let i = 0; i < 10; i += 1) {
      reportAuthError({
        provider: 'clerk',
        operation: 'signin',
        errorCode: `code_${i}`,
        status: '401'
      });
    }
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('never throws when fetch rejects', () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    expect(() =>
      reportAuthError({
        provider: 'clerk',
        operation: 'signin',
        errorCode: 'invalid_credentials'
      })
    ).not.toThrow();
  });

  it('does not POST when VITE_TELEMETRY_TOKEN is missing', () => {
    vi.stubEnv('VITE_TELEMETRY_TOKEN', '');
    const fetchSpy = globalThis.fetch;
    reportAuthError({
      provider: 'clerk',
      operation: 'signin',
      errorCode: 'invalid_credentials'
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Release-identifier resolution (task e89db27f, AC1 — QA repair 2026-11-11).
 *
 * The QA verifier found that both live production rows in Grafana carried
 * `release=dev`: `VITE_RELEASE_TAG` was unset in the deployed build and the
 * module fell back to the literal `'dev'`, so a production event could not
 * be told apart from a local one. These cases pin the new contract:
 * an explicit tag wins, then the Vercel build metadata, and a production
 * build with no metadata is `unknown` — never `dev`.
 */
describe('browserTelemetry — release identifier', () => {
  beforeEach(() => {
    _resetBrowserTelemetryForTests();
    vi.resetModules();
    vi.stubEnv('VITE_TELEMETRY_ENABLED', '1');
    vi.stubEnv('VITE_TELEMETRY_TOKEN', 'relay-test-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    _resetBrowserTelemetryForTests();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  function capturedRelease() {
    const fetchSpy = globalThis.fetch;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchSpy.mock.calls[0][1].body).release;
  }

  it('uses the explicit VITE_RELEASE_TAG when one is configured', () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', 'gymtrack-v2026.11.11');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'a'.repeat(40));
    reportAuthError({ provider: 'clerk', operation: 'signin' });
    expect(capturedRelease()).toBe('gymtrack-v2026.11.11');
  });

  it('falls back to the Vercel commit sha when no explicit tag is set', () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', '');
    const sha = 'b'.repeat(40);
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha);
    reportAuthError({ provider: 'clerk', operation: 'signin' });
    expect(capturedRelease()).toBe(sha);
  });

  it('falls back to the Vercel deployment id when no tag or commit is set', () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_abc123');
    reportAuthError({ provider: 'clerk', operation: 'signin' });
    expect(capturedRelease()).toBe('dpl_abc123');
  });

  it('never labels a production build as dev', () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', '');
    reportAuthError({ provider: 'clerk', operation: 'signin' });
    expect(capturedRelease()).toBe('unknown');
    expect(capturedRelease()).not.toBe('dev');
  });

  it('keeps dev for a development build with no release metadata', () => {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('VITE_RELEASE_TAG', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', '');
    reportAuthError({ provider: 'clerk', operation: 'signin' });
    expect(capturedRelease()).toBe('dev');
  });
});

/**
 * Redaction on the generic error path (task e89db27f).
 *
 * The auth surface is context-only — `reportAuthError` takes a context
 * object and has no parameter that could carry an error envelope — so the
 * browser-side redaction patterns can no longer be exercised through it.
 * The generic path still receives raw error objects (uncaught exceptions
 * and unhandled rejections), so that is where the browser redaction layer
 * is pinned.
 */
describe('browserTelemetry — generic error path redaction', () => {
  beforeEach(() => {
    _resetBrowserTelemetryForTests();
    vi.stubEnv('VITE_TELEMETRY_ENABLED', '1');
    vi.stubEnv('VITE_TELEMETRY_TOKEN', 'relay-test-token');
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_RELEASE_TAG', 'test-release');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    _resetBrowserTelemetryForTests();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  function emitWindowError(error) {
    installBrowserTelemetry();
    window.dispatchEvent(new ErrorEvent('error', { error }));
  }

  it('redacts email addresses from error messages', () => {
    const fetchSpy = globalThis.fetch;
    const error = new Error('Failed to sign in user foo@bar.com');
    emitWindowError(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).not.toContain('[email protected]');
    expect(body.message).toContain('[redacted-email]');
  });

  it('redacts Bearer tokens and password=… from stacks', () => {
    const fetchSpy = globalThis.fetch;
    const error = new Error('Sign-in failed');
    error.stack = 'Error: Sign-in failed\n  at https://api.example.com (Authorization: Bearer abc.def.ghi)\n  at caller (password=hunter2)';
    emitWindowError(error);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.stack).not.toContain('abc.def.ghi');
    expect(body.stack).not.toContain('hunter2');
    expect(body.stack).toContain('Bearer [redacted]');
    expect(body.stack).toContain('password=[redacted]');
  });
});
