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
 *   7. The payload includes the retained fields only and never the raw
 *      `error.message` (the safe message is what gets sent).
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

  it('redacts email addresses from error messages', () => {
    const fetchSpy = globalThis.fetch;
    const error = new Error('Failed to sign in user foo@bar.com');
    reportAuthError(error, {
      provider: 'clerk',
      operation: 'signin',
      errorCode: 'invalid_credentials',
      status: '401'
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).not.toContain('[email protected]');
    expect(body.message).toContain('[redacted-email]');
  });

  it('redacts Bearer tokens and password=… from stacks', () => {
    const fetchSpy = globalThis.fetch;
    const error = new Error('Sign-in failed');
    error.stack = 'Error: Sign-in failed\n  at https://api.example.com (Authorization: Bearer abc.def.ghi)\n  at caller (password=hunter2)';
    reportAuthError(error, {
      provider: 'clerk',
      operation: 'signin',
      errorCode: 'invalid_credentials'
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.stack).not.toContain('abc.def.ghi');
    expect(body.stack).not.toContain('hunter2');
    expect(body.stack).toContain('Bearer [redacted]');
    expect(body.stack).toContain('password=[redacted]');
  });

  it('sends only the allow-listed fields', () => {
    const fetchSpy = globalThis.fetch;
    const error = new Error('Some auth failure');
    reportAuthError(error, {
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
      reportAuthError(new Error(`fail ${i}`), ctx);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps distinct events in 60s to MAX_EVENTS_PER_MINUTE', () => {
    const fetchSpy = globalThis.fetch;
    for (let i = 0; i < 10; i += 1) {
      reportAuthError(new Error(`fail ${i}`), {
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
      reportAuthError(new Error('whatever'), {
        provider: 'clerk',
        operation: 'signin',
        errorCode: 'invalid_credentials'
      })
    ).not.toThrow();
  });

  it('does not POST when VITE_TELEMETRY_TOKEN is missing', () => {
    vi.stubEnv('VITE_TELEMETRY_TOKEN', '');
    const fetchSpy = globalThis.fetch;
    reportAuthError(new Error('x'), {
      provider: 'clerk',
      operation: 'signin',
      errorCode: 'invalid_credentials'
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
