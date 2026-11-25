import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, getToken: vi.fn() },
  redirectToSignIn: vi.fn(),
  fetchAuthSession: vi.fn()
}));
vi.mock('@clerk/react', () => ({
  useAuth: () => mocks.auth,
  useClerk: () => ({ redirectToSignIn: mocks.redirectToSignIn })
}));
vi.mock('../tasksApi.js', () => ({ fetchAuthSession: (...args) => mocks.fetchAuthSession(...args) }));

import { AuthBoundary } from './AuthBoundary.jsx';

describe('Mission Control AuthBoundary', () => {
  beforeEach(() => {
    mocks.auth = { isLoaded: true, isSignedIn: true, getToken: vi.fn().mockResolvedValue('token') };
    mocks.redirectToSignIn.mockReset();
    mocks.fetchAuthSession.mockReset();
  });

  it('does not mount domain UI before the API authorizes the Clerk subject', async () => {
    let resolve;
    mocks.fetchAuthSession.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AuthBoundary><div>Mission Control UI</div></AuthBoundary>);
    expect(screen.queryByText('Mission Control UI')).not.toBeInTheDocument();
    await act(async () => resolve({ actor: 'Tom' }));
    expect(await screen.findByText('Mission Control UI')).toBeInTheDocument();
  });

  it('renders no domain UI for a signed-in but unauthorized account', async () => {
    mocks.fetchAuthSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(<AuthBoundary><div>Mission Control UI</div></AuthBoundary>);
    expect(await screen.findByRole('heading', { name: 'Not authorized' })).toBeInTheDocument();
    expect(screen.queryByText('Mission Control UI')).not.toBeInTheDocument();
  });

  it('redirects signed-out visitors without exposing a sign-up surface', async () => {
    mocks.auth = { isLoaded: true, isSignedIn: false, getToken: vi.fn() };
    render(<AuthBoundary><div>Mission Control UI</div></AuthBoundary>);
    expect(mocks.redirectToSignIn).toHaveBeenCalledWith({
      redirectUrl: window.location.href,
      withSignUp: false
    });
    expect(screen.queryByText('Mission Control UI')).not.toBeInTheDocument();
  });
});
