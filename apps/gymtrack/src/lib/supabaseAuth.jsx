import { useEffect, useMemo, useState } from 'react';
import { supabase, setSupabaseAccessTokenGetter } from './supabase.js';
import { AuthContext } from './authContext.jsx';
import { isProviderDisabledError } from './authFlow.js';

/**
 * Supabase-backed AuthProvider. Default GymTrack identity implementation.
 *
 * Exposes the same interface as ClerkAuthProvider so consumers (AuthGate,
 * LoginScreen, SignUpPage, WorkoutLogger, WorkoutsTab, AgentConsentPage, …)
 * can stay implementation-agnostic. The auth.jsx dispatcher picks this
 * provider when VITE_AUTH_PROVIDER is unset or set to 'supabase'.
 *
 * The session/user shape mirrors what ClerkAuthProvider returns so a single
 * consumer can render under either backend:
 *
 *   - session: Supabase session object (carries access_token + refresh_token
 *              + user). null when signed out.
 *   - user:    session?.user ?? null  (the user object is what
 *              supabase.auth.getUser() exposes; both backends provide `id`
 *              which downstream code reads)
 *   - loading: true until the initial session has been resolved
 *
 * signIn / signUp / signOut each return a `{ data, error }` envelope so the
 * caller can branch on either branch without re-implementing the
 * Supabase error envelope.
 */
export function SupabaseAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  /**
   * Ensure no stale Clerk access-token getter is wired into the supabase-js
   * singleton. Supabase manages its own bearer token via the persisted
   * session; the Clerk getter is only relevant when ClerkAuthProvider is
   * mounted. Clearing on mount + unmount keeps HMR / test environments
   * deterministic.
   */
  useEffect(() => {
    setSupabaseAccessTokenGetter(null);
    return () => setSupabaseAccessTokenGetter(null);
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession ?? null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      async signIn(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        return { data, error };
      },
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        return { data, error };
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        return { error };
      },
      /**
       * OAuth redirect entrypoint. Supabase implementation calls
       * `supabase.auth.signInWithOAuth` and returns the same `{ data,
       * error, providerDisabled }` envelope as the Clerk implementation
       * so callers (SignUpPage / LoginScreen) can branch without
       * re-implementing the heuristic.
       */
      async startOAuthRedirect(provider, redirectPath = '/workout') {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: new URL(redirectPath, window.location.origin).toString()
          }
        });
        const providerDisabled = !!error && isProviderDisabledError(error);
        return {
          data,
          error: error ?? null,
          providerDisabled
        };
      }
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
