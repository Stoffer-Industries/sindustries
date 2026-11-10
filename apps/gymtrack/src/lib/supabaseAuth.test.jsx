import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';

const mockSignInWithOAuth = vi.fn();

vi.mock('./supabase.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(() => ({ subscription: { unsubscribe: vi.fn() } })),
      signInWithOAuth: (...args) => mockSignInWithOAuth(...args)
    }
  },
  setSupabaseAccessTokenGetter: vi.fn()
}));

import { SupabaseAuthProvider } from './supabaseAuth.jsx';
import { AuthContext } from './authContext.jsx';

let auth;

function Harness() {
  auth = useContext(AuthContext);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth = undefined;
});

describe('SupabaseAuthProvider OAuth contract', () => {
  it('returns the provider URL and the redirecting signal on success', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/auth?client_id=fixture' },
      error: null
    });
    render(
      <SupabaseAuthProvider>
        <Harness />
      </SupabaseAuthProvider>
    );

    let result;
    await act(async () => {
      result = await auth.startOAuthRedirect('google', '/history');
    });

    expect(result.data.url).toBe('https://accounts.google.com/o/oauth2/auth?client_id=fixture');
    expect(result.data.redirecting).toBe(true);
    expect(result.error).toBeNull();
    expect(result.providerDisabled).toBe(false);
    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'http://localhost:3000/history' }
    });
  });

  it('flags a provider-disabled response', async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: null,
      error: { message: 'Provider is not enabled.' }
    });
    render(
      <SupabaseAuthProvider>
        <Harness />
      </SupabaseAuthProvider>
    );

    let result;
    await act(async () => {
      result = await auth.startOAuthRedirect('google', '/workout');
    });

    expect(result.providerDisabled).toBe(true);
    expect(result.data).toBeNull();
  });

  it('returns the provider error for a genuine failure', async () => {
    const providerError = { message: 'Invalid OAuth client.' };
    mockSignInWithOAuth.mockResolvedValue({ data: null, error: providerError });
    render(
      <SupabaseAuthProvider>
        <Harness />
      </SupabaseAuthProvider>
    );

    let result;
    await act(async () => {
      result = await auth.startOAuthRedirect('google', '/workout');
    });

    expect(result.error).toBe(providerError);
    expect(result.providerDisabled).toBe(false);
  });
});
