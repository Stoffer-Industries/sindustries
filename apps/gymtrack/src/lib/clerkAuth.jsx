import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSession, useUser, useSignIn, useSignUp, useClerk } from '@clerk/react';
import { AuthContext } from './authContext.jsx';
import { getClerkPublishableKey } from './clerkConfig.js';
import { setSupabaseAccessTokenGetter, supabase } from './supabase.js';
import { clearClerkSsoDestination, rememberClerkSsoDestination } from './clerkSsoDestination.js';

const AUTH_REQUEST_TIMEOUT_MS = 15_000;

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
  const { signIn: clerkSignIn } = useSignIn();
  const { signUp: clerkSignUp } = useSignUp();
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
   * Email + password sign-in. Identifies the account first so the app uses
   * a factor Clerk actually exposes for that user. Password-enabled accounts
   * continue through the password factor. Accounts imported from Google with
   * no Clerk password fall back to their supported email-code factor instead
   * of submitting an invalid password strategy.
   *
   * The returned verification mode tells LoginScreen whether a submitted
   * email code completes the first factor or Clerk's client-trust challenge;
   * both flows reuse the same code-entry form but must call different Clerk
   * methods.
   */
  const signIn = useCallback(
    async (email, password) => {
      try {
        const { error: identifyError } = await clerkSignIn.create({ identifier: email });
        if (identifyError) {
          return { data: null, error: new Error(clerkErrorMessage(identifyError, 'Sign-in failed.')) };
        }

        const supportedFirstFactors = clerkSignIn.supportedFirstFactors ?? [];
        const supportsPassword = supportedFirstFactors.some(
          (factor) => factor.strategy === 'password'
        );
        const supportsEmailCode = supportedFirstFactors.some(
          (factor) => factor.strategy === 'email_code'
        );

        if (!supportsPassword) {
          if (!supportsEmailCode) {
            const supportsGoogle = supportedFirstFactors.some(
              (factor) => factor.strategy === 'oauth_google'
            );
            return {
              data: null,
              error: new Error(
                supportsGoogle
                  ? 'This account uses Google sign-in. Choose “Continue with Google” above.'
                  : 'This account does not support password sign-in. Choose another sign-in method.'
              )
            };
          }

          const { error: emailCodeError } = await clerkSignIn.emailCode.sendCode();
          if (emailCodeError) {
            return {
              data: null,
              error: new Error(clerkErrorMessage(emailCodeError, 'Could not send the verification code.'))
            };
          }
          return {
            data: { needsVerification: true, verificationMode: 'first_factor_email_code' },
            error: null
          };
        }

        const { error } = await clerkSignIn.password({ password });
        if (error) {
          return { data: null, error: new Error(clerkErrorMessage(error, 'Sign-in failed.')) };
        }
        if (clerkSignIn.status === 'complete') {
          const { error: finalizeError } = await clerkSignIn.finalize();
          if (finalizeError) {
            return {
              data: null,
              error: new Error(clerkErrorMessage(finalizeError, 'Sign-in failed.'))
            };
          }
          return { data: { session: clerkSignIn.createdSessionId }, error: null };
        }
        if (clerkSignIn.status === 'needs_client_trust') {
          const supportsEmailCode = clerkSignIn.supportedSecondFactors?.some(
            (factor) => factor.strategy === 'email_code'
          );
          if (!supportsEmailCode) {
            return {
              data: null,
              error: new Error('This browser needs an additional verification method that is not available.')
            };
          }
          const { error: verificationError } = await clerkSignIn.mfa.sendEmailCode();
          if (verificationError) {
            return {
              data: null,
              error: new Error(clerkErrorMessage(verificationError, 'Could not send the verification code.'))
            };
          }
          return {
            data: { needsVerification: true, verificationMode: 'client_trust_email_code' },
            error: null
          };
        }
        // First-factor succeeded but additional steps required (e.g. 2FA,
        // email link verification). Surface the prepared state so the UI
        // can branch; today's LoginScreen treats this as an error, which
        // matches the Supabase email-not-confirmed-equivalent behaviour
        // until the UI gains 2FA code field support.
        return {
          data: null,
          error: new Error(
            `Additional sign-in steps required (status=${clerkSignIn.status}). ` +
              'Quinn: enable the 2FA code form on LoginScreen to handle this path.'
          )
        };
      } catch (err) {
        // Clerk errors carry `.errors[0].longMessage` for user-facing
        // rendering. Map to plain Error so LoginScreen's `error.message`
        // access keeps working.
        return { data: null, error: new Error(clerkErrorMessage(err, 'Sign-in failed.')) };
      }
    },
    [clerkSignIn]
  );

  const verifySignInCode = useCallback(
    async (code, verificationMode) => {
      try {
        const verification =
          verificationMode === 'first_factor_email_code'
            ? clerkSignIn.emailCode.verifyCode({ code })
            : clerkSignIn.mfa.verifyEmailCode({ code });
        const { error } = await verification;
        if (error) {
          return {
            data: null,
            error: new Error(clerkErrorMessage(error, 'Verification failed.'))
          };
        }
        if (clerkSignIn.status !== 'complete') {
          return {
            data: null,
            error: new Error('Additional sign-in verification is still required.')
          };
        }
        const { error: finalizeError } = await clerkSignIn.finalize();
        if (finalizeError) {
          return {
            data: null,
            error: new Error(clerkErrorMessage(finalizeError, 'Sign-in failed.'))
          };
        }
        return { data: { session: clerkSignIn.createdSessionId }, error: null };
      } catch (err) {
        return { data: null, error: new Error(clerkErrorMessage(err, 'Verification failed.')) };
      }
    },
    [clerkSignIn]
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
        const { error } = await withTimeout(
          clerkSignUp.password({
            emailAddress: email,
            password
          }),
          AUTH_REQUEST_TIMEOUT_MS,
          'Security check timed out. Please retry.'
        );
        if (error) {
          return { data: null, error: new Error(clerkErrorMessage(error, 'Sign-up failed.')) };
        }
        if (clerkSignUp.status === 'complete') {
          const { error: finalizeError } = await clerkSignUp.finalize();
          if (finalizeError) {
            return {
              data: null,
              error: new Error(clerkErrorMessage(finalizeError, 'Sign-up failed.'))
            };
          }
          return { data: { user: clerkSignUp.createdUserId }, error: null };
        }
        // Status === 'missing_requirements' | 'abandoned' etc. — the
        // email-verification step is queued by Clerk. Surface as success
        // for UI parity with Supabase's email-confirmation-required flow.
        // The user verifies via Clerk's hosted email link; on next
        // sign-in, status flips to 'complete'.
        const verificationError = await clerkSignUpPrepareEmailAddressVerification(clerkSignUp);
        if (verificationError) {
          return {
            data: null,
            error: new Error(clerkErrorMessage(verificationError, 'Sign-up failed.'))
          };
        }
        return { data: { pendingVerification: true }, error: null };
      } catch (err) {
        if (err?.name === 'AuthRequestTimeoutError') {
          await clerkSignUp.reset().catch(() => {});
        }
        return { data: null, error: new Error(clerkErrorMessage(err, 'Sign-up failed.')) };
      }
    },
    [clerkSignUp]
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
   * `clerkSignIn.sso` with the matching strategy;
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
      const redirectCallbackUrl = new URL('/sso-callback', window.location.origin).toString();
      rememberClerkSsoDestination(redirectPath);
      try {
        const { error } = await clerkSignIn.sso({
          strategy,
          redirectUrl,
          redirectCallbackUrl
        });
        if (error) {
          clearClerkSsoDestination();
          return {
            data: null,
            error: new Error(clerkErrorMessage(error, 'OAuth redirect failed.')),
            providerDisabled: false
          };
        }
        return { data: { provider }, error: null, providerDisabled: false };
      } catch (err) {
        clearClerkSsoDestination();
        return {
          data: null,
          error: new Error(clerkErrorMessage(err, 'OAuth redirect failed.')),
          providerDisabled: false
        };
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

  /**
   * Phase 4 linking — first-post-migration-sign-in side effect.
   *
   * On every Clerk session establish, call
   * `public.link_clerk_user_to_profile(...)` (a SECURITY DEFINER
   * function) with the verified email and the inferred signup source.
   * The function is idempotent:
   *
   *   - **Already linked** (steady state): returns the existing row.
   *   - **Pre-migration match by verified email**: sets
   *     `clerk_user_id` on the legacy row, preserving
   *     `legacy_auth_user_id` for the audit window.
   *   - **Fresh sign-up**: inserts a new `public.profiles` row keyed
   *     by the Clerk subject.
   *
   * Errors are logged but do NOT block sign-in. The user can still use
   * the app on `VITE_AUTH_PROVIDER=clerk`; the only consequence of a
   * failed linking call is that pre-migration workout history is not
   * yet visible (RLS subquery on `workouts` resolves to NULL until the
   * profile row exists). A retry runs on every Clerk session change,
   * so a transient network error self-heals on the next render.
   *
   * The Clerk JWT is sent as the bearer token by supabase.js's
   * `accessToken` callback. Supabase Third-Party Auth verifies it
   * server-side; `auth.jwt()->>'sub'` in the function resolves to the
   * Clerk subject, which the function then compares against
   * `p_clerk_user_id` as the security guard. The function will reject
   * any caller whose `p_clerk_user_id` does not match their own JWT
   * sub, so a signed-in user cannot impersonate another Clerk subject
   * to claim their legacy account.
   *
   * Source-of-truth: docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
   * Phase 4, and the migration
   * apps/gymtrack/supabase/migrations/20261013000000_clerk_phase_4_link_existing_users.sql
   * which defines the function.
   */
  useEffect(() => {
    const clerkSubject = user?.id;
    const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? null;
    const emailVerified =
      user?.primaryEmailAddress?.verification?.status === 'verified';

    // Not yet signed in, or Clerk has not surfaced a primary email
    // address yet (rare but possible while Clerk finishes loading).
    // Skip; the effect re-runs when the user changes.
    if (!clerkSubject || !primaryEmail) {
      return;
    }

    // Infer the signup source from Clerk's user shape so the linked
    // row carries the right `signup_source` audit value. The function
    // accepts these four values: 'google' | 'apple' | 'email_password'
    // | 'clerk_first_login' | 'clerk_import'.
    const externalProvider = user?.externalAccounts?.[0]?.provider ?? null;
    const signupSource = externalAccountToSignupSource(externalProvider, user);

    let cancelled = false;
    supabase
      .rpc('link_clerk_user_to_profile', {
        p_clerk_user_id: clerkSubject,
        p_email: primaryEmail,
        p_email_verified: emailVerified,
        p_signup_source: signupSource
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Log and continue. The auth flow should not block on the
          // linking side-effect; the next session change retries
          // (the function is idempotent, so the second call is a
          // cheap steady-state read).
          // eslint-disable-next-line no-console
          console.error(
            'gymtrack/clerk-phase-4-linking: rpc failed',
            { code: error.code, message: error.message, details: error.details }
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('gymtrack/clerk-phase-4-linking: unexpected error', err);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.primaryEmailAddress?.emailAddress, user?.primaryEmailAddress?.verification?.status]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signIn,
      verifySignInCode,
      signUp,
      signOut,
      startOAuthRedirect,
      getAccessToken
    }),
    [session, loading, signIn, verifySignInCode, signUp, signOut, startOAuthRedirect, getAccessToken]
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
      const { error } = await signUpResource.verifications.sendEmailCode();
      return error;
    }
    return null;
  } catch (err) {
    return err;
  }
}

function clerkErrorMessage(error, fallback) {
  return (
    error?.longMessage ??
    error?.errors?.[0]?.longMessage ??
    error?.message ??
    fallback
  );
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error(message);
      error.name = 'AuthRequestTimeoutError';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

/**
 * Map Clerk's user shape to the `signup_source` value the linking
 * function accepts. The function's check constraint enforces
 * 'google' | 'apple' | 'email_password' | 'clerk_first_login'
 * | 'clerk_import'; anything outside this set is rejected at the
 * database boundary, so this mapper is the single place that maps
 * Clerk's provider strings to the audit value.
 *
 * Clerk's `externalAccounts[].provider` for OAuth is
 * 'oauth_google' | 'oauth_apple' | etc. Email + password sign-up is
 * distinguished by `passwordEnabled` (true if the user has a
 * password on file at Clerk). The default 'clerk_first_login' covers
 * any path we did not classify (e.g. SAML, magic link).
 */
function externalAccountToSignupSource(externalProvider, user) {
  if (externalProvider === 'oauth_google') return 'google';
  if (externalProvider === 'oauth_apple') return 'apple';
  if (user?.passwordEnabled) return 'email_password';
  return 'clerk_first_login';
}
