import { supabase } from './supabase.js';

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
 * Start the OAuth redirect for `provider` (one of `SUPPORTED_OAUTH_PROVIDERS`).
 * Returns `{ data, error, providerDisabled }`:
 *   - `data` is whatever Supabase returned (usually `{ provider, url }` where
 *     `url` is the redirect URL the caller should send the browser to).
 *   - `error` is the raw Supabase error, or null on success.
 *   - `providerDisabled` is true iff the heuristic detected a "provider not
 *     enabled" error so the UI can hide the button instead of crashing.
 *
 * Callers should branch on `providerDisabled` first, then `error`, then
 * proceed with `data.url` (window.location.assign or similar).
 */
export async function signInWithOAuthRedirect(provider, redirectPath = '/workout') {
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
    return {
      data: null,
      error: new Error(`Unsupported OAuth provider: ${provider}`),
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
  const { data } = await supabase.auth.getSession();
  return {
    session: data.session ?? null,
    user: data.session?.user ?? null
  };
}