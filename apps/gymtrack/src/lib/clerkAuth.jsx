import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSession, useUser, useSignIn, useSignUp, useClerk } from '@clerk/clerk-react';
import { AuthContext } from './authContext.jsx';
import { getClerkPublishableKey } from './clerkConfig.js';
import { setSupabaseAccessTokenGetter } from './supabase.js';

/**
 * Clerk-backed AuthProvider. Activated when VITE_AUTH_PROVIDER === 'clerk'.
 *
 * Wraps Clerk's React hooks behind the same `{ session, user, loading,
 * signIn, signUp, signOut }` interface that SupabaseAuthProvider exposes,
 * so consumers (`useAuth`) can render under either backend without
 * branching on identity provider.
 *
 * Session shape (synchronous view):
 *   - `session` is `{ accessToken, user }` where accessToken is the most
 *     recently issued Clerk session JWT (nullable until Clerk finishes
 *     loading) and user carries the Clerk `userId` plus the primary email.
 *   - `session.user.id` is the Clerk subject (e.g. `user_2abc…`). The
 *     supabase.js bridge injects `session.accessToken` as the bearer token
 *     on every request; Supabase Third-Party Auth verifies the Clerk
 *     signature and resolves `auth.uid()` to the same Clerk subject at the
 *     RLS boundary, so downstream queries that read `session.user.id` keep
 *     working against `public.profiles.id` once Phase 4's first-login
 *     linking populates that table.
 *   - `loading` mirrors Clerk's `isLoaded` flag for both user and session.
 *   - `signIn`/`signUp` map Clerk's email+password flows to the Supabase
 *     envelope shape (`{ data, error }`) so existing call-sites in
 *     LoginScreen / SignUpPage stay unchanged.
 *   - `signOut` calls Clerk's `signOut()`.
 *
 * The ClerkProvider that supplies these hooks MUST be mounted above this
 * provider in main.jsx — see apps/gymtrack/src/main.jsx, where the
 * dispatcher wraps the tree in `<ClerkProvider publishableKey=…>` when
 * the flag is on.
 *
 * If VITE_AUTH_PROVIDER === 'clerk' but the publishable key is missing,
 * `getClerkPublishableKey()` throws so the misconfiguration surfaces at
 * app start rather than during the first auth attempt.
 */
export function ClerkAuthProvider({ children }) {
  // Validate the publishable key at module load so a missing key fails
  // fast. getClerkPublishableKey() is a no-throw reader when the key is
  // present; it throws only on missing/invalid values.
  getClerkPublishableKey();

  const { isLoaded: sessionLoaded, session: clerkSession } = useSession();
  const { isLoaded: userLoaded, user } = useUser();
  const { signIn: clerkSignIn, setActive: clerkSignInSetActive } = useSignIn();
  const { signUp: clerkSignUp, setActive: clerkSignUpSetActive } = useSignUp();
  const { signOut: clerkSignOut } = useClerk();

  const loading = !sessionLoaded || !userLoaded;

  /**
   * Latest Clerk session JWT. Refreshed automatically by Clerk on token
   * rotation; supabase.js's `accessToken` accessor pulls this each
   * request so rotated tokens propagate without a manual refresh cycle.
   * Null until Clerk finishes loading.
   */
  const accessToken = clerkSession?.lastActiveToken?.jwt ?? null;

  /**
   * Synthesise a Supabase-shaped session object from Clerk's hooks so
   * downstream code that reads `session.user.id` (e.g. to verify the
   * authenticated subject against RLS) gets the Clerk `userId` without
   * branching on provider.
   */
  const session = useMemo(() => {
    if (!clerkSession || !user) return null;
    return {
      accessToken,
      user: {
        id: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? null,
        clerkUserId: user.id
      }
    };
  }, [clerkSession, user, accessToken]);

  /**
   * Email + password sign-in. Maps Clerk's `signIn.create({ identifier,
   * password })` shape to `{ data, error }`. `identifier` accepts email,
   * phone, or username; we constrain it to email at the call-site
   * (LoginScreen form), matching the current Supabase password path.
   *
   * On successful first-factor sign-in, the second-factor challenge is
   * surfaced via Clerk's hosted account portal — the LoginScreen UI does
   * not yet render a 2FA code field. Quinn's Phase 0 plan to deliver
   * email-link + password as the only first factors means this code path
   * is the production hot path. A future task can extend `signIn` to
   * return the prepared second-factor and drive a 2FA code form.
   */
  const signIn = useCallback(
    async (email, password) => {
      try {
        const result = await clerkSignIn.create({
          identifier: email,
          password
        });
        if (result.status === 'complete') {
          await clerkSignInSetActive({ session: result.createdSessionId });
          return { data: { user: result.createdUserId }, error: null };
        }
        // First-factor succeeded but additional steps required (e.g. 2FA,
        // email link verification). Surface the prepared state so the UI
        // can branch; today's LoginScreen treats this as an error, which
        // matches the Supabase email-not-confirmed-equivalent behaviour
        // until the UI gains 2FA code field support.
        return {
          data: null,
          error: new Error(
            `Additional sign-in steps required (status=${result.status}). ` +
              'Quinn: enable the 2FA code form on LoginScreen to handle this path.'
          )
        };
      } catch (err) {
        // Clerk errors carry `.errors[0].longMessage` for user-facing
        // rendering. Map to plain Error so LoginScreen's `error.message`
        // access keeps working.
        const message =
          err?.errors?.[0]?.longMessage ?? err?.message ?? 'Sign-in failed.';
        return { data: null, error: new Error(message) };
      }
    },
    [clerkSignIn, clerkSignInSetActive]
  );

  /**
   * Email + password sign-up. Maps Clerk's `signUp.create({ emailAddress,
   * password })` to `{ data, error }`. Email verification (Clerk sends a
   * one-time code) is treated as success for parity with Supabase's
   * "create account, then verify email" flow — the user can log in after
   * verifying, and SignUpPage navigates to the post-signup route as today.
   */
  const signUp = useCallback(
    async (email, password) => {
      try {
        const result = await clerkSignUp.create({
          emailAddress: email,
          password
        });
        if (result.status === 'complete') {
          await clerkSignUpSetActive({ session: result.createdSessionId });
          return { data: { user: result.createdUserId }, error: null };
        }
        // Status === 'missing_requirements' | 'abandoned' etc. — the
        // email-verification step is queued by Clerk. Surface as success
        // for UI parity with Supabase's email-confirmation-required flow.
        // The user verifies via Clerk's hosted email link; on next
        // sign-in, status flips to 'complete'.
        await clerkSignUpPrepareEmailAddressVerification(result);
        return { data: { pendingVerification: true }, error: null };
      } catch (err) {
        const message =
          err?.errors?.[0]?.longMessage ?? err?.message ?? 'Sign-up failed.';
        return { data: null, error: new Error(message) };
      }
    },
    [clerkSignUp, clerkSignUpSetActive]
  );

  const signOut = useCallback(async () => {
    try {
      await clerkSignOut();
      return { error: null };
    } catch (err) {
      const message =
        err?.errors?.[0]?.longMessage ?? err?.message ?? 'Sign-out failed.';
      return { error: new Error(message) };
    }
  }, [clerkSignOut]);

  /**
   * OAuth redirect entrypoint. Clerk implementation calls
   * `clerkSignIn.authenticateWithRedirect` with the matching strategy;
   * Clerk's hosted account portal performs the actual consent screen
   * and handles the redirect. The call returns void on success — the
   * browser is already navigating to Clerk — so we synthesise the
   * `{ data, error, providerDisabled }` envelope for caller parity
   * with the Supabase implementation.
   *
   * The strategy map is the single source of truth for "GymTrack
   * provider name -> Clerk OAuth strategy". Quinn can extend it as
   * Apple / GitHub / etc. come online.
   */
  const startOAuthRedirect = useCallback(
    async (provider, redirectPath = '/workout') => {
      const strategy = clerkStrategyForProvider(provider);
      const redirectUrl = new URL(redirectPath, window.location.origin).toString();
      try {
        await clerkSignIn.authenticateWithRedirect({
          strategy,
          redirectUrl,
          redirectUrlComplete: redirectUrl
        });
        return { data: { provider, url: redirectUrl }, error: null, providerDisabled: false };
      } catch (err) {
        const message =
          err?.errors?.[0]?.longMessage ?? err?.message ?? 'OAuth redirect failed.';
        return { data: null, error: new Error(message), providerDisabled: false };
      }
    },
    [clerkSignIn]
  );

  /**
   * Bridge for supabase.js: returns the latest Clerk session JWT so
   * supabase-js's `accessToken` callback can read it before each
   * request. Returns null when Clerk is loading or no session exists;
   * supabase-js treats null as "no bearer token, anon request" which
   * is fine for unauthenticated reads.
   */
  const getAccessToken = useCallback(() => accessToken, [accessToken]);

  /**
   * Publish the latest access-token getter into supabase.js so its
   * accessToken callback can resolve to the Clerk session JWT before
   * each request. The ref keeps the published closure stable across
   * re-renders (supabase.js imports the singleton at module load and
   * must see the same getter identity until we publish a new one).
   */
  const publishedGetterRef = useRef(null);
  useEffect(() => {
    if (publishedGetterRef.current !== getAccessToken) {
      publishedGetterRef.current = getAccessToken;
      setSupabaseAccessTokenGetter(getAccessToken);
    }
    return () => {
      if (publishedGetterRef.current === getAccessToken) {
        publishedGetterRef.current = null;
        setSupabaseAccessTokenGetter(null);
      }
    };
  }, [getAccessToken]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signIn,
      signUp,
      signOut,
      startOAuthRedirect,
      getAccessToken
    }),
    [session, loading, signIn, signUp, signOut, startOAuthRedirect, getAccessToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Map a GymTrack OAuth provider name ('google' | 'apple') to the Clerk
 * strategy string expected by `signIn.authenticateWithRedirect`. The
 * Clerk OAuth strategies for social providers use the lower-case
 * provider name with an `oauth_` prefix ('oauth_google', 'oauth_apple').
 *
 * Today only Google is wired (Phase 0 Google OAuth re-registration is
 * live). Apple ships when Quinn wires the Apple Developer account and
 * removes 'apple' from DISABLED_OAUTH_PROVIDERS — the strategy mapping
 * is already in place so the UI can flip on with no further code change.
 */
function clerkStrategyForProvider(provider) {
  if (provider === 'google') return 'oauth_google';
  if (provider === 'apple') return 'oauth_apple';
  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

/**
 * Best-effort kick-off of Clerk's email verification step. Some sign-up
 * flows land in `missing_requirements` with the email verification not yet
 * prepared; calling `prepareEmailAddressVerification` is idempotent and
 * ensures Clerk sends the one-time code so the user can complete the flow
 * out-of-band. Safe to call even when not strictly required.
 */
async function clerkSignUpPrepareEmailAddressVerification(signUpResource) {
  try {
    if (signUpResource?.status === 'missing_requirements') {
      await signUpResource.prepareEmailAddressVerification({ strategy: 'email_code' });
    }
  } catch {
    // Non-fatal: the next sign-in attempt will re-trigger verification
    // preparation on the server side.
  }
}
