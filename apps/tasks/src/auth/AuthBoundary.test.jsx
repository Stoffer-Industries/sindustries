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
vi.mock('../tasksApi.ts', () => ({ fetchAuthSession: (...args) => mocks.fetchAuthSession(...args) }));

import { AuthBoundary } from './AuthBoundary.jsx';

describe('Tasks AuthBoundary', () => {
  beforeEach(() => {
    mocks.auth = { isLoaded: true, isSignedIn: true, getToken: vi.fn().mockResolvedValue('token') };
    mocks.redirectToSignIn.mockReset();
    mocks.fetchAuthSession.mockReset();
  });

  it('does not mount the board before the API authorizes the Clerk subject', async () => {
    let resolve;
    mocks.fetchAuthSession.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AuthBoundary><div>Tasks board</div></AuthBoundary>);
    expect(screen.queryByText('Tasks board')).not.toBeInTheDocument();
    await act(async () => resolve({ actor: 'Tom' }));
    expect(await screen.findByText('Tasks board')).toBeInTheDocument();
  });

  it('renders no board for a signed-in but unauthorized account', async () => {
    mocks.fetchAuthSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(<AuthBoundary><div>Tasks board</div></AuthBoundary>);
    expect(await screen.findByRole('heading', { name: 'Not authorized' })).toBeInTheDocument();
    expect(screen.queryByText('Tasks board')).not.toBeInTheDocument();
  });

  it('renders the board in the test-only e2e session without a Clerk session', async () => {
    vi.stubEnv('VITE_TASKS_E2E_AUTH_TOKEN', 'e2e-harness-session-token');
    render(<AuthBoundary><div>Tasks board</div></AuthBoundary>);
    expect(await screen.findByText('Tasks board')).toBeInTheDocument();
    expect(mocks.fetchAuthSession).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('redirects signed-out visitors without exposing a sign-up surface', async () => {
    mocks.auth = { isLoaded: true, isSignedIn: false, getToken: vi.fn() };
    render(<AuthBoundary><div>Tasks board</div></AuthBoundary>);
    expect(mocks.redirectToSignIn).toHaveBeenCalledWith({
      redirectUrl: window.location.href,
      withSignUp: false
    });
    expect(screen.queryByText('Tasks board')).not.toBeInTheDocument();
  });
});
