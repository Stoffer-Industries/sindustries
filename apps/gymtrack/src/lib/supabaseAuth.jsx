import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, setSupabaseAccessTokenGetter } from './supabase.js';
import { AuthContext } from './authContext.jsx';
import { isProviderDisabledError } from './authFlow.js';
import { reportAuthError } from './browserTelemetry.js';

/**
 * Supabase error envelope → safe telemetry context. The supabase-js
 * `AuthError` carries `.code` (a short machine-readable string) and
 * `.status` (the HTTP status when the SDK surfaces one). The error
 * `.message` is user-facing and is intentionally NOT sent to
 * telemetry — only the safe code + status go out, matching the
 * Clerk implementation's redaction contract.
 */
function supabaseSafeContext(error, operation) {
  return {
    provider: 'supabase',
    operation,
    errorCode: error?.code ?? null,
    status: error?.status != null ? String(error.status) : null
  };
}

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
   * The email address of the sign-up attempt that is awaiting a
   * verification code.
   *
   * Supabase's `verifyOtp` needs the email alongside the token, but the
   * provider-agnostic contract deliberately does not take one — the page
   * must not become a second source of truth for the pending sign-up.
   * The provider therefore remembers the address it was given at sign-up
   * time and consumes it when the code is verified. A ref (not state) is
   * correct here: it is provider-internal bookkeeping, and writing it must
   * not re-create the context value for every consumer.
   */
  const pendingSignupEmailRef = useRef(null);

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
        if (error) reportAuthError(error, supabaseSafeContext(error, 'signin'));
        return { data, error };
      },
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
          reportAuthError(error, supabaseSafeContext(error, 'signup'));
          return { data: null, error };
        }
        // A project with email confirmation enabled returns a user but NO
        // session — the account exists but is not usable until the emailed
        // code is verified. That is the case SignUpPage must render a code
        // field for (task 6e9410d5). A project with auto-confirm returns a
        // session straight away.
        const needsVerification = data?.user != null && data?.session == null;
        if (needsVerification) {
          pendingSignupEmailRef.current = email;
          return {
            data: { needsVerification: true, verificationMode: 'signup_email_code' },
            error: null
          };
        }
        pendingSignupEmailRef.current = null;
        return { data: { needsVerification: false }, error: null };
      },
      /**
       * Verify the one-time code emailed when the account was created.
       *
       * Contract: `verifySignUpCode(code) -> { data: { session }, error }`.
       * The email address comes from the provider's own pending-sign-up
       * state, so the page stays provider-agnostic and matches the Clerk
       * implementation's shape exactly.
       */
      async verifySignUpCode(code) {
        const email = pendingSignupEmailRef.current;
        if (!email) {
          return {
            data: null,
            error: new Error('This verification code is no longer valid. Please sign up again.')
          };
        }
        const { data, error } = await supabase.auth.verifyOtp({
          email,
          token: code,
          type: 'signup'
        });
        if (error) {
          reportAuthError(error, supabaseSafeContext(error, 'verify_signup_code'));
          return { data: null, error: new Error(error.message) };
        }
        pendingSignupEmailRef.current = null;
        return { data: { session: data?.session ?? null }, error: null };
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) reportAuthError(error, supabaseSafeContext(error, 'signout'));
        return { error };
      },
      /**
       * OAuth redirect entrypoint. Supabase implementation calls
       * `supabase.auth.signInWithOAuth` and returns the same `{ data,
       * error, providerDisabled }` envelope as the Clerk implementation
       * so callers (SignUpPage / LoginScreen) can branch without
       * re-implementing the heuristic.
       *
       * `data.redirecting` is the provider-agnostic "the browser is
       * navigating" signal shared with the Clerk implementation. Supabase
       * additionally returns `data.url`, which the page assigns to
       * `window.location`.
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
          data: data ? { ...data, redirecting: true } : null,
          error: error ?? null,
          providerDisabled
        };
      }
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
