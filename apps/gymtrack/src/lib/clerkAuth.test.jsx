import { useContext, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signIn: {
    status: 'needs_identifier',
    createdSessionId: null,
    password: vi.fn(),
    finalize: vi.fn(),
    create: vi.fn(),
    sso: vi.fn(),
    supportedSecondFactors: [],
    supportedFirstFactors: [],
    emailCode: { sendCode: vi.fn(), verifyCode: vi.fn() },
    mfa: { sendEmailCode: vi.fn(), verifyEmailCode: vi.fn() }
  },
  signUp: {
    status: 'missing_requirements',
    createdUserId: null,
    password: vi.fn(),
    finalize: vi.fn(),
    reset: vi.fn(),
    verifications: { sendEmailCode: vi.fn() }
  }
}));

vi.mock('@clerk/react', () => ({
  useSession: () => ({ isLoaded: true, session: null }),
  useUser: () => ({ isLoaded: true, user: null }),
  useSignIn: () => ({ signIn: mocks.signIn }),
  useSignUp: () => ({ signUp: mocks.signUp }),
  useClerk: () => ({ signOut: vi.fn() })
}));

vi.mock('./clerkConfig.js', () => ({ getClerkPublishableKey: () => 'pk_test_fixture' }));
vi.mock('./supabase.js', () => ({
  setSupabaseAccessTokenGetter: vi.fn(),
  supabase: { rpc: vi.fn() }
}));

import { ClerkAuthProvider } from './clerkAuth.jsx';
import { AuthContext } from './authContext.jsx';

function Harness() {
  const auth = useContext(AuthContext);
  const [message, setMessage] = useState('');
  const [verificationMode, setVerificationMode] = useState(null);
  return (
    <>
      <button
        onClick={async () => {
          const result = await auth.signIn('person@example.com', 'wrong-password');
          setVerificationMode(result.data?.verificationMode ?? null);
          setMessage(result.error?.message ?? 'signed-in');
        }}
      >
        sign in
      </button>
      <button
        onClick={async () => {
          const result = await auth.verifySignInCode('123456', verificationMode);
          setMessage(result.error?.message ?? 'verified');
        }}
      >
        verify
      </button>
      <button
        onClick={async () => {
          const result = await auth.signUp('person@example.com', 'valid-password');
          setMessage(result.error?.message ?? 'signed-up');
        }}
      >
        sign up
      </button>
      <button
        onClick={async () => {
          const result = await auth.startOAuthRedirect('google', '/history');
          setMessage(result.error?.message ?? 'redirecting');
        }}
      >
        google
      </button>
      <output>{message}</output>
    </>
  );
}

function renderProvider() {
  return render(
    <ClerkAuthProvider>
      <Harness />
    </ClerkAuthProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signIn.status = 'needs_identifier';
  mocks.signIn.createdSessionId = null;
  mocks.signIn.create.mockResolvedValue({ error: null });
  mocks.signIn.supportedFirstFactors = [{ strategy: 'password' }];
  mocks.signIn.supportedSecondFactors = [];
  mocks.signUp.status = 'missing_requirements';
  mocks.signUp.createdUserId = null;
  mocks.signUp.reset.mockResolvedValue({ error: null });
  mocks.signUp.verifications.sendEmailCode.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClerkAuthProvider Clerk v6 custom-flow contract', () => {
  it('finalizes a completed password sign-in', async () => {
    mocks.signIn.password.mockImplementation(async () => {
      mocks.signIn.status = 'complete';
      mocks.signIn.createdSessionId = 'sess_fixture';
      return { error: null };
    });
    mocks.signIn.finalize.mockResolvedValue({ error: null });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    expect(await screen.findByText('signed-in')).toBeVisible();
    expect(mocks.signIn.finalize).toHaveBeenCalledOnce();
  });

  it('surfaces a structured password error instead of reading status from the response envelope', async () => {
    mocks.signIn.password.mockResolvedValue({
      error: { longMessage: 'Password is incorrect. Try again.' }
    });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    expect(await screen.findByText('Password is incorrect. Try again.')).toBeVisible();
    expect(mocks.signIn.password).toHaveBeenCalledWith({
      password: 'wrong-password'
    });
    expect(mocks.signIn.finalize).not.toHaveBeenCalled();
  });

  it('sends and verifies an email code when Clerk requires client trust', async () => {
    mocks.signIn.password.mockImplementation(async () => {
      mocks.signIn.status = 'needs_client_trust';
      mocks.signIn.supportedSecondFactors = [{ strategy: 'email_code' }];
      return { error: null };
    });
    mocks.signIn.mfa.sendEmailCode.mockResolvedValue({ error: null });
    mocks.signIn.mfa.verifyEmailCode.mockImplementation(async () => {
      mocks.signIn.status = 'complete';
      mocks.signIn.createdSessionId = 'sess_verified';
      return { error: null };
    });
    mocks.signIn.finalize.mockResolvedValue({ error: null });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    expect(await screen.findByText('signed-in')).toBeVisible();
    expect(mocks.signIn.mfa.sendEmailCode).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'verify' }));
    expect(await screen.findByText('verified')).toBeVisible();
    expect(mocks.signIn.mfa.verifyEmailCode).toHaveBeenCalledWith({ code: '123456' });
    expect(mocks.signIn.finalize).toHaveBeenCalledOnce();
  });

  it('uses an email code when the account does not support password sign-in', async () => {
    mocks.signIn.supportedFirstFactors = [
      { strategy: 'email_code', emailAddressId: 'idn_fixture' },
      { strategy: 'oauth_google' }
    ];
    mocks.signIn.emailCode.sendCode.mockResolvedValue({ error: null });
    mocks.signIn.emailCode.verifyCode.mockImplementation(async () => {
      mocks.signIn.status = 'complete';
      mocks.signIn.createdSessionId = 'sess_email_code';
      return { error: null };
    });
    mocks.signIn.finalize.mockResolvedValue({ error: null });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    expect(await screen.findByText('signed-in')).toBeVisible();
    expect(mocks.signIn.create).toHaveBeenCalledWith({ identifier: 'person@example.com' });
    expect(mocks.signIn.password).not.toHaveBeenCalled();
    expect(mocks.signIn.emailCode.sendCode).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'verify' }));
    expect(await screen.findByText('verified')).toBeVisible();
    expect(mocks.signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: '123456' });
    expect(mocks.signIn.mfa.verifyEmailCode).not.toHaveBeenCalled();
  });

  it('directs an OAuth-only account to Google without submitting an invalid password strategy', async () => {
    mocks.signIn.supportedFirstFactors = [{ strategy: 'oauth_google' }];
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    expect(
      await screen.findByText('This account uses Google sign-in. Choose “Continue with Google” above.')
    ).toBeVisible();
    expect(mocks.signIn.password).not.toHaveBeenCalled();
    expect(mocks.signIn.emailCode.sendCode).not.toHaveBeenCalled();
  });

  it('uses the v6 SSO method and preserves the requested destination', async () => {
    mocks.signIn.sso.mockResolvedValue({ error: null });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'google' }));

    expect(await screen.findByText('redirecting')).toBeVisible();
    expect(mocks.signIn.sso).toHaveBeenCalledWith({
      strategy: 'oauth_google',
      redirectUrl: 'http://localhost:3000/history',
      redirectCallbackUrl: 'http://localhost:3000/sso-callback'
    });
  });

  it('starts email verification after a password sign-up remains incomplete', async () => {
    mocks.signUp.password.mockResolvedValue({ error: null });
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign up' }));

    await waitFor(() => expect(mocks.signUp.verifications.sendEmailCode).toHaveBeenCalled());
    expect(screen.getByText('signed-up')).toBeVisible();
  });

  it('bounds a stalled sign-up security check and resets the attempt', async () => {
    vi.useFakeTimers();
    mocks.signUp.password.mockReturnValue(new Promise(() => {}));
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'sign up' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText('Security check timed out. Please retry.')).toBeVisible();
    expect(mocks.signUp.reset).toHaveBeenCalledOnce();
  });
});
