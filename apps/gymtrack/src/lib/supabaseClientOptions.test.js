import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Provider → supabase-js client-options contract (task ca999d95).
 *
 * supabase-js (2.x) does NOT build its own auth client when the
 * `accessToken` option is present — it installs a proxy over `client.auth`
 * that throws on every property access. The app used to pass `accessToken`
 * unconditionally, so the Supabase provider path was handed a client whose
 * `auth` surface exploded on contact and the provider could not mount.
 *
 * This file pins the two halves of the contract:
 *
 *   - Supabase provider: NO `accessToken` option at all, and the session
 *     options (`persistSession` / `autoRefreshToken` / `detectSessionInUrl`)
 *     stay enabled.
 *   - Clerk provider: the `accessToken` option IS present, and its callback
 *     body is unchanged — it still resolves the registered Clerk session
 *     token, still falls back to `null` for an anon request, and still
 *     swallows a throwing getter.
 *
 * The real-SDK counterpart lives in `supabaseAuthMount.test.jsx`.
 */

const { createClientSpy } = vi.hoisted(() => ({
  createClientSpy: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => createClientSpy(...args)
}));

function capturedOptions() {
  expect(createClientSpy).toHaveBeenCalledTimes(1);
  return createClientSpy.mock.calls[0][2];
}

beforeEach(() => {
  vi.resetModules();
  createClientSpy.mockReset();
  createClientSpy.mockImplementation(() => ({ auth: {} }));
  vi.stubEnv('VITE_SUPABASE_URL', 'https://stub-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'stub-anon-key');
  vi.stubEnv('VITE_AUTH_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('supabase client options — Supabase provider path (default)', () => {
  it('omits the accessToken option entirely', async () => {
    await import('./supabase.js');

    const options = capturedOptions();
    expect('accessToken' in options).toBe(false);
  });

  it('keeps the Supabase session options enabled', async () => {
    await import('./supabase.js');

    const options = capturedOptions();
    expect(options.auth.persistSession).toBe(true);
    expect(options.auth.autoRefreshToken).toBe(true);
    expect(options.auth.detectSessionInUrl).toBe(true);
    expect(options.auth.storage).toBe(window.localStorage);
  });

  it('never reads the registered Clerk token getter', async () => {
    const getter = vi.fn(() => 'clerk-jwt');
    const { setSupabaseAccessTokenGetter } = await import('./supabase.js');
    setSupabaseAccessTokenGetter(getter);

    // No `accessToken` option means no callback to read the getter — the
    // Supabase path cannot leak a Clerk token into a Supabase request.
    expect('accessToken' in capturedOptions()).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('supabase client options — Clerk provider path', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'clerk');
  });

  it('carries the accessToken option', async () => {
    await import('./supabase.js');

    const options = capturedOptions();
    expect(typeof options.accessToken).toBe('function');
  });

  it('keeps the Supabase session options disabled', async () => {
    await import('./supabase.js');

    const options = capturedOptions();
    expect(options.auth.persistSession).toBe(false);
    expect(options.auth.autoRefreshToken).toBe(false);
    expect(options.auth.detectSessionInUrl).toBe(false);
  });

  it('returns null for an anon request when no getter is registered', async () => {
    await import('./supabase.js');

    const options = capturedOptions();
    await expect(options.accessToken()).resolves.toBeNull();
  });

  it('returns the registered Clerk session token', async () => {
    const { setSupabaseAccessTokenGetter } = await import('./supabase.js');
    setSupabaseAccessTokenGetter(() => 'clerk-jwt');

    const options = capturedOptions();
    await expect(options.accessToken()).resolves.toBe('clerk-jwt');
  });

  it('returns null when the getter throws instead of propagating', async () => {
    const { setSupabaseAccessTokenGetter } = await import('./supabase.js');
    setSupabaseAccessTokenGetter(() => {
      throw new Error('clerk session is torn down');
    });

    const options = capturedOptions();
    await expect(options.accessToken()).resolves.toBeNull();
  });

  it('returns null for an empty or non-string token', async () => {
    const { setSupabaseAccessTokenGetter } = await import('./supabase.js');
    const options = capturedOptions();

    setSupabaseAccessTokenGetter(() => '');
    await expect(options.accessToken()).resolves.toBeNull();

    setSupabaseAccessTokenGetter(() => undefined);
    await expect(options.accessToken()).resolves.toBeNull();
  });
});
