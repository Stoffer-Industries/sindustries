import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStartOAuthRedirect = vi.fn();

vi.mock('./auth.jsx', () => ({
  useAuth: () => ({ startOAuthRedirect: mockStartOAuthRedirect })
}));

import { OAUTH_REDIRECT_FALLBACK_MS, useOAuthRedirect } from './useOAuthRedirect.js';

let hook;

function Harness() {
  hook = useOAuthRedirect();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  hook = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useOAuthRedirect', () => {
  it('never rejects when the provider throws, and exposes a user-facing error', async () => {
    mockStartOAuthRedirect.mockRejectedValue(new Error('SecurityError: sessionStorage'));
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/Something went wrong starting Google sign-in/);
    expect(result.providerDisabled).toBe(false);
    expect(hook.error).toBeInstanceOf(Error);
    expect(hook.redirecting).toBe(false);
    expect(hook.pending).toBe(false);
  });

  it('passes a provider error through untouched', async () => {
    const providerError = new Error('OAuth redirect failed.');
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: providerError,
      providerDisabled: false
    });
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.error).toBe(providerError);
    expect(hook.error).toBe(providerError);
    expect(hook.redirecting).toBe(false);
  });

  it('replaces a provider error with an empty message with a visible fallback', async () => {
    const providerError = { code: 'oauth_failed', message: '' };
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: providerError,
      providerDisabled: false
    });
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe(
      'Could not start Google sign-in. Try again, or use email + password instead.'
    );
    expect(hook.error).toBe(result.error);
    expect(hook.redirecting).toBe(false);
  });

  it('replaces a provider error with no message at all with a visible fallback', async () => {
    const providerError = { code: 'oauth_failed' };
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: providerError,
      providerDisabled: false
    });
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe(
      'Could not start Google sign-in. Try again, or use email + password instead.'
    );
    expect(hook.error).toBe(result.error);
  });

  it('preserves the providerDisabled signal', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: null,
      providerDisabled: true
    });
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.providerDisabled).toBe(true);
    expect(hook.providerDisabled).toBe(true);
    expect(hook.error).toBeNull();
  });

  it('reports the redirect as started and bounds it with an actionable fallback', async () => {
    vi.useFakeTimers();
    mockStartOAuthRedirect.mockResolvedValue({
      data: { provider: 'google', redirecting: true },
      error: null,
      providerDisabled: false
    });
    render(<Harness />);

    let result;
    await act(async () => {
      result = await hook.startOAuth('google', '/workout');
    });

    expect(result.redirecting).toBe(true);
    expect(hook.redirecting).toBe(true);
    expect(hook.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OAUTH_REDIRECT_FALLBACK_MS);
    });

    expect(hook.redirecting).toBe(false);
    expect(hook.error).toBeInstanceOf(Error);
    expect(hook.error.message).toBe(
      'Could not start Google sign-in. Try again, or use email + password instead.'
    );
  });

  it('clearError drops the error and resets the redirecting state', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: new Error('OAuth redirect failed.'),
      providerDisabled: false
    });
    render(<Harness />);

    await act(async () => {
      await hook.startOAuth('google', '/workout');
    });
    expect(hook.error).toBeInstanceOf(Error);

    await act(async () => {
      hook.clearError();
    });

    expect(hook.error).toBeNull();
    expect(hook.redirecting).toBe(false);
  });

  it('clearError abandons a pending fallback so it cannot fire over the email flow', async () => {
    vi.useFakeTimers();
    mockStartOAuthRedirect.mockResolvedValue({
      data: { provider: 'google', redirecting: true },
      error: null,
      providerDisabled: false
    });
    render(<Harness />);

    await act(async () => {
      await hook.startOAuth('google', '/workout');
    });
    expect(hook.redirecting).toBe(true);

    await act(async () => {
      hook.clearError();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OAUTH_REDIRECT_FALLBACK_MS + 1000);
    });

    expect(hook.error).toBeNull();
    expect(hook.redirecting).toBe(false);
  });

  it('clears the fallback timer when a new attempt starts', async () => {
    vi.useFakeTimers();
    mockStartOAuthRedirect.mockResolvedValue({
      data: { provider: 'google', redirecting: true },
      error: null,
      providerDisabled: false
    });
    render(<Harness />);

    await act(async () => {
      await hook.startOAuth('google', '/workout');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OAUTH_REDIRECT_FALLBACK_MS - 1000);
    });
    await act(async () => {
      await hook.startOAuth('google', '/workout');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OAUTH_REDIRECT_FALLBACK_MS + 1000);
    });

    // The first attempt's timer was replaced, so the fallback fires once,
    // for the still-pending second attempt — not twice.
    expect(hook.error).toBeInstanceOf(Error);
  });
});
