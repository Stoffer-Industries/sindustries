import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockSignIn = vi.fn();
const mockSignInWithOAuthRedirect = vi.fn();

vi.mock('./lib/supabase.js', () => ({ supabase: { auth: { getUser: vi.fn(), onAuthStateChange: vi.fn() } } }));

vi.mock('./lib/auth.jsx', () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
    signIn: mockSignIn,
    signUp: vi.fn(),
    signOut: vi.fn()
  }),
  AuthProvider: ({ children }) => children
}));

vi.mock('./lib/authFlow.js', () => ({
  DISABLED_OAUTH_PROVIDERS: ['apple'],
  SUPPORTED_OAUTH_PROVIDERS: ['google', 'apple'],
  signInWithOAuthRedirect: (...args) => mockSignInWithOAuthRedirect(...args)
}));

import App from './App.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  mockSignInWithOAuthRedirect.mockResolvedValue({
    data: null,
    error: null,
    providerDisabled: false
  });
});

describe('GymTrack protected-route continuation', () => {
  it('preserves /agent-consent intent when Google sign-in starts from AuthGate', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter
        initialEntries={[
          '/agent-consent?client_id=claude-desktop&redirect_uri=https%3A%2F%2Fclaude.example%2Fcallback&response_type=code&scope=history%3Aread&state=opaque-state&code_challenge=pkce&code_challenge_method=S256'
        ]}
      >
        <App />
      </MemoryRouter>
    );

    await user.click(await screen.findByTestId('login-google'));

    expect(mockSignInWithOAuthRedirect).toHaveBeenCalledWith(
      'google',
      '/agent-consent?client_id=claude-desktop&redirect_uri=https%3A%2F%2Fclaude.example%2Fcallback&response_type=code&scope=history%3Aread&state=opaque-state&code_challenge=pkce&code_challenge_method=S256'
    );
  });
});
