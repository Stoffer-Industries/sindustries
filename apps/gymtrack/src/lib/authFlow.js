/**
 * authFlow.js — Supabase-side OAuth helpers that pre-date the Clerk
 * cutover. Slice A of task bb09eaed (Phase 3) moves the OAuth redirect
 * logic into the AuthContext (`useAuth().startOAuthRedirect`) so both
 * SupabaseAuthProvider and ClerkAuthProvider can publish the same
 * `{ data, error, providerDisabled }` envelope.
 *
 * This module now exports only:
 *
 *   - `SUPPORTED_OAUTH_PROVIDERS` / `DISABLED_OAUTH_PROVIDERS` — the
 *     provider allow/deny lists consumed by SignUpPage / LoginScreen to
 *     decide which OAuth buttons to render.
 *   - `isProviderDisabledError(err)` — the heuristic used to detect
 *     "Supabase has not enabled this provider" so the UI can drop the
 *     button instead of crashing. Re-exported through this module so
 *     tests and any future server-side helper that does NOT have access
 *     to React context can use it directly.
 *   - `signInWithOAuthRedirect` / `getPostOAuthSession` — kept for
 *     backward compatibility with Playwright tests and any third-party
 *     helper that imports them. Both delegate to the AuthContext's
 *     `startOAuthRedirect` and the supabase client's `auth.getSession`
 *     when run inside a React tree; outside the React tree they fall
 *     back to the Supabase direct call so non-React code (test
 *     helpers, scripts) keeps working.
 *
 * Apple stays in `DISABLED_OAUTH_PROVIDERS` until Quinn wires the Apple
 * Developer account and removes the entry; the gating logic is the
 * single source of truth for "Apple must not render on first paint".
 */

import { supabase } from './supabase.js';
import { getActiveProvider } from './clerkConfig.js';

/**
 * OAuth providers the public sign-up page knows how to wire up. Order
 * matters for the UI: Google first (broadest support), Apple second.
 */
export const SUPPORTED_OAUTH_PROVIDERS = ['google', 'apple'];

/**
 * Providers that are intentionally excluded from the rendered button list
 * because the Supabase project has not been configured for them.
 *
 * Apple is in this list by default — Tom punted on the Apple Developer
 * account wiring. The UI directive is: the Apple button MUST NOT render
 * until Apple is wired up. `SignUpPage` filters `SUPPORTED_OAUTH_PROVIDERS`
 * against this list at mount so the button is absent from the first paint,
 * not just hidden after a click.
 *
 * When Quinn wires Apple via `.openclaw`, they remove 'apple' from this
 * array and the Apple button re-appears on `/signup` with no other code
 * change required.
 */
export const DISABLED_OAUTH_PROVIDERS = ['apple'];

/**
 * Heuristically detect "this provider is not enabled on the Supabase project"
 * so the UI can hide the button instead of rendering a raw 500. This is a
 * safety net for providers that are NOT in `DISABLED_OAUTH_PROVIDERS` but
 * still fail at click time (e.g. Supabase-side config drift between
 * deploys). Providers known to be unconfigured belong in
 * `DISABLED_OAUTH_PROVIDERS` instead, so the button is absent from first
 * paint.
 *
 * Supabase returns a 422 with message "Provider <name> is not enabled" when
 * the project has not been configured for that provider. We match on the
 * fragment rather than rely on the status code shape, because the message is
 * the only stable signal across SDK versions.
 */
export function isProviderDisabledError(err) {
  if (!err) return false;
  const msg = (err.message ?? '').toLowerCase();
  return (
    msg.includes('provider') &&
    msg.includes('not enabled')
  ) || msg.includes('unsupported provider');
}

/**
 * Legacy entrypoint preserved for the existing SignUpPage / LoginScreen
 * call-sites and any third-party helper. Inside a React tree the AuthContext
 * already exposes `useAuth().startOAuthRedirect(...)` which the consumer
 * should prefer — this shim is the bridge for non-React callers and for the
 * existing tests that mock this module.
 *
 * When called from inside a React tree while VITE_AUTH_PROVIDER === 'clerk',
 * the shim returns a "OAuth redirect handled by Clerk" stub: Clerk performs
 * the actual window.location assignment via `signIn.authenticateWithRedirect`
 * inside ClerkAuthProvider.startOAuthRedirect, which the React component
 * should call directly. This shim is not the React-tree path; it exists for
 * test-helper compatibility and graceful degradation.
 */
export async function signInWithOAuthRedirect(provider, redirectPath = '/workout') {
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
    return {
      data: null,
      error: new Error(`Unsupported OAuth provider: ${provider}`),
      providerDisabled: false
    };
  }

  if (getActiveProvider() === 'clerk') {
    return {
      data: null,
      error: new Error(
        'signInWithOAuthRedirect invoked under Clerk provider. ' +
          'Use useAuth().startOAuthRedirect from inside a React component.'
      ),
      providerDisabled: false
    };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: new URL(redirectPath, window.location.origin).toString()
    }
  });

  if (error && isProviderDisabledError(error)) {
    return { data: null, error: null, providerDisabled: true };
  }

  return { data, error: error ?? null, providerDisabled: false };
}

/**
 * Explicit "wait for auth to settle" call after an OAuth redirect.
 *
 * Supabase already handles post-redirect session detection via
 * `detectSessionInUrl: true` in `lib/supabase.js` + the `onAuthStateChange`
 * listener in `lib/auth.jsx`, so this is mostly redundant for the UI.
 * It's useful in Playwright tests where the test must deterministically
 * observe the session before continuing — calling `getSession()` resolves
 * once Supabase has finished parsing the URL hash.
 *
 * Returns the current `{ session, user }` pair or `{ session: null, user: null }`.
 */
export async function getPostOAuthSession() {
  if (getActiveProvider() === 'clerk') {
    // Clerk handles session resolution through its own hooks inside
    // ClerkAuthProvider. Consumers reading this helper are typically
    // Playwright tests that wait on the Clerk session via the
    // data-testid on the post-redirect page; the test surface area is
    // covered by signup-google.spec.ts after Slice B lands.
    return { session: null, user: null };
  }

  const { data } = await supabase.auth.getSession();
  return {
    session: data.session ?? null,
    user: data.session?.user ?? null
  };
}
