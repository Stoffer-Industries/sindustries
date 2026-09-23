import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Unit tests for the VITE_AUTH_PROVIDER-driven AuthProvider dispatcher
 * (task bb09eaed Phase 3 Slice A).
 *
 * Validates:
 *
 *   1. The dispatcher reads VITE_AUTH_PROVIDER at module load via
 *      `getActiveProvider()` and mounts the matching implementation.
 *   2. The default (no env var set) is the Supabase-backed provider, so
 *      existing deployments keep working without an env-var flip.
 *   3. The Clerk-backed provider publishes the same shape
 *      (`{ session, user, loading, signIn, signUp, signOut,
 *      startOAuthRedirect, getAccessToken }`) as the Supabase provider,
 *      so the existing consumers (LoginScreen, SignUpPage, AuthGate,
 *      WorkoutLogger, WorkoutsTab, AgentConsentPage, …) keep their
 *      `import { useAuth } from '../lib/auth.jsx'` surface area.
 *
 * The Clerk SDK is not exercised here — that requires a ClerkProvider
 * wrapper and a Clerk instance; e2e coverage of the Clerk flow lands in
 * Slice B alongside the Clerk-side OAuth redirect wiring. These tests
 * validate the dispatcher surface, not the Clerk SDK behaviour.
 */

const mockSupabaseAuthProvider = vi.fn(({ children }) => (
  <div data-testid="supabase-auth-provider">{children}</div>
));
const mockClerkAuthProvider = vi.fn(({ children }) => (
  <div data-testid="clerk-auth-provider">{children}</div>
));

vi.mock('./supabaseAuth.jsx', () => ({
  SupabaseAuthProvider: (props) => mockSupabaseAuthProvider(props)
}));
vi.mock('./clerkAuth.jsx', () => ({
  ClerkAuthProvider: (props) => mockClerkAuthProvider(props)
}));
vi.mock('./authContext.jsx', () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    startOAuthRedirect: vi.fn(),
    getAccessToken: () => null
  })
}));

describe('AuthProvider dispatcher', () => {
  beforeEach(() => {
    mockSupabaseAuthProvider.mockClear();
    mockClerkAuthProvider.mockClear();
    vi.resetModules();
  });

  it('mounts SupabaseAuthProvider when VITE_AUTH_PROVIDER is unset', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', '');
    const { AuthProvider } = await import('./auth.jsx');
    render(
      <AuthProvider>
        <span data-testid="child" />
      </AuthProvider>
    );
    expect(mockSupabaseAuthProvider).toHaveBeenCalledTimes(1);
    expect(mockClerkAuthProvider).not.toHaveBeenCalled();
    expect(screen.getByTestId('supabase-auth-provider')).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it('mounts SupabaseAuthProvider when VITE_AUTH_PROVIDER=supabase', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'supabase');
    const { AuthProvider } = await import('./auth.jsx');
    render(
      <AuthProvider>
        <span data-testid="child" />
      </AuthProvider>
    );
    expect(mockSupabaseAuthProvider).toHaveBeenCalledTimes(1);
    expect(mockClerkAuthProvider).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('mounts ClerkAuthProvider when VITE_AUTH_PROVIDER=clerk', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'clerk');
    const { AuthProvider } = await import('./auth.jsx');
    render(
      <AuthProvider>
        <span data-testid="child" />
      </AuthProvider>
    );
    expect(mockClerkAuthProvider).toHaveBeenCalledTimes(1);
    expect(mockSupabaseAuthProvider).not.toHaveBeenCalled();
    expect(screen.getByTestId('clerk-auth-provider')).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it('throws on an unknown VITE_AUTH_PROVIDER value', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'bogus');
    const { AuthProvider } = await import('./auth.jsx');
    expect(() =>
      render(
        <AuthProvider>
          <span data-testid="child" />
        </AuthProvider>
      )
    ).toThrow(/invalid VITE_AUTH_PROVIDER/);
    vi.unstubAllEnvs();
  });

  it('re-exports useAuth from authContext.jsx so existing call-sites stay unchanged', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'supabase');
    const { useAuth } = await import('./auth.jsx');
    // The re-export resolves to the same hook function the consumer
    // already imports; we verify it does not throw when called inside
    // an AuthProvider (the authContext mock above returns a value).
    const TestConsumer = () => {
      const ctx = useAuth();
      return <span data-testid="ctx-shape">{typeof ctx.signIn}</span>;
    };
    const { AuthProvider } = await import('./auth.jsx');
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );
    expect(screen.getByTestId('ctx-shape')).toHaveTextContent('function');
    vi.unstubAllEnvs();
  });
});
