import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';

/**
 * Real-SDK mount regression (task ca999d95).
 *
 * This file deliberately does NOT mock `@supabase/supabase-js`. The defect it
 * guards is an SDK-behaviour regression: when the `accessToken` option is
 * present, supabase-js (2.x) replaces `client.auth` with a proxy that throws
 * on every property access. A test double would only assert the app's idea of
 * that behaviour; this file exercises the installed SDK itself.
 *
 * With the fix, the Supabase provider path is constructed WITHOUT the
 * `accessToken` option, so `supabase.auth.getSession()` resolves and the
 * provider reaches `loading === false`.
 */

let auth;
// The context module is imported dynamically alongside the provider module so
// both resolve to the SAME instance: `vi.resetModules()` gives each test a
// fresh registry, and a statically imported context would be a different
// instance from the one the provider renders.
let AuthContextRef;

function Harness() {
  auth = useContext(AuthContextRef);
  return null;
}

beforeEach(() => {
  vi.resetModules();
  auth = undefined;
  vi.stubEnv('VITE_SUPABASE_URL', 'https://stub-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'stub-anon-key');
  vi.stubEnv('VITE_AUTH_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Supabase provider path — real supabase-js client', () => {
  it('resolves getSession() instead of throwing on the auth proxy', async () => {
    const { supabase } = await import('./supabase.js');

    // The exact call the mount effect makes. Before the fix this threw
    // "accessing supabase.auth.getSession is not possible".
    const result = await supabase.auth.getSession();
    expect(result.data.session).toBeNull();
  });

  it('exposes onAuthStateChange as a callable surface', async () => {
    const { supabase } = await import('./supabase.js');

    expect(typeof supabase.auth.onAuthStateChange).toBe('function');
  });

  it('mounts SupabaseAuthProvider and resolves the auth gate', async () => {
    const [{ SupabaseAuthProvider }, { AuthContext }] = await Promise.all([
      import('./supabaseAuth.jsx'),
      import('./authContext.jsx')
    ]);
    AuthContextRef = AuthContext;

    render(
      <SupabaseAuthProvider>
        <Harness />
      </SupabaseAuthProvider>
    );

    // The mount effect calls supabase.auth.getSession() and only then sets
    // loading=false. If the proxy throws, the provider never gets there.
    await waitFor(() => expect(auth?.loading).toBe(false));
    expect(auth.session).toBeNull();
    expect(auth.user).toBeNull();
  });
});

describe('Clerk provider path — real supabase-js client', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'clerk');
  });

  it('keeps the SDK auth proxy in place (known Clerk-path hazard, design risk R1)', async () => {
    const { supabase } = await import('./supabase.js');

    // Negative control: it proves the mount assertions above are
    // discriminating — on the Clerk path the same access throws, which is
    // exactly why the Supabase path must not carry the option. Fixing the
    // three unguarded Clerk call sites is a separate change (R1).
    expect(() => supabase.auth.getSession()).toThrow(/accessToken option/);
  });
});
