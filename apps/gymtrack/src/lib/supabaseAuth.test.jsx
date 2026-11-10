import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';

const mockSignInWithOAuth = vi.fn();
const mockSignUp = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('./supabase.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(() => ({ subscription: { unsubscribe: vi.fn() } })),
      signInWithOAuth: (...args) => mockSignInWithOAuth(...args),
      signUp: (...args) => mockSignUp(...args),
      verifyOtp: (...args) => mockVerifyOtp(...args)
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

/**
 * The sign-up verification contract (task 6e9410d5).
 *
 * The Supabase provider is the one-env-var rollback path for the Clerk
 * cutover, so it must implement the same contract. A project with email
 * confirmation enabled returns a user but no session — the case the page
 * renders a code field for.
 */
describe('SupabaseAuthProvider sign-up verification contract (task 6e9410d5)', () => {
  function renderProvider() {
    render(
      <SupabaseAuthProvider>
        <Harness />
      </SupabaseAuthProvider>
    );
  }

  it('reports that a verification step is required when the project requires email confirmation', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: null },
      error: null
    });
    renderProvider();

    let result;
    await act(async () => {
      result = await auth.signUp('new-user@example.com', 'correct-horse-battery');
    });

    expect(result.data).toEqual({
      needsVerification: true,
      verificationMode: 'signup_email_code'
    });
    expect(result.error).toBeNull();
  });

  it('reports that no verification step is required when the project auto-confirms the address', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 't' } },
      error: null
    });
    renderProvider();

    let result;
    await act(async () => {
      result = await auth.signUp('new-user@example.com', 'correct-horse-battery');
    });

    expect(result.data).toEqual({ needsVerification: false });
    expect(result.error).toBeNull();
  });

  it('verifies the code against the email given at sign-up time, not one supplied by the page', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: null },
      error: null
    });
    mockVerifyOtp.mockResolvedValue({
      data: { session: { access_token: 't' } },
      error: null
    });
    renderProvider();

    await act(async () => {
      await auth.signUp('new-user@example.com', 'correct-horse-battery');
    });

    let result;
    await act(async () => {
      result = await auth.verifySignUpCode('123456');
    });

    expect(mockVerifyOtp).toHaveBeenCalledWith({
      email: 'new-user@example.com',
      token: '123456',
      type: 'signup'
    });
    expect(result.error).toBeNull();
    expect(result.data.session).toEqual({ access_token: 't' });
  });

  it('returns the provider error when the code is rejected', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: null },
      error: null
    });
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: 'Invalid token' } });
    renderProvider();

    await act(async () => {
      await auth.signUp('new-user@example.com', 'correct-horse-battery');
    });

    let result;
    await act(async () => {
      result = await auth.verifySignUpCode('000000');
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('Invalid token');
    expect(result.data).toBeNull();
  });

  it('refuses to verify a code when no sign-up is pending', async () => {
    renderProvider();

    let result;
    await act(async () => {
      result = await auth.verifySignUpCode('123456');
    });

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(Error);
  });
});
