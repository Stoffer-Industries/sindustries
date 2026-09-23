import { createClient } from '@supabase/supabase-js';
import { getActiveProvider } from './clerkConfig.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'GymTrack: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
      'See apps/gymtrack/.env.example and ask Quinn to wire the values into Vercel for live deploys.'
  );
}

if (typeof window === 'undefined') {
  throw new Error(
    'GymTrack: apps/gymtrack/src/lib/supabase.js must not be imported in a server context. ' +
      'Use a service-role client on the server side instead.'
  );
}

/**
 * Single shared Supabase client. anon key is public-by-design; RLS is the gate.
 *
 * The `accessToken` callback is the bridge between Clerk and Supabase when
 * VITE_AUTH_PROVIDER === 'clerk'. supabase-js calls this once per request,
 * and the value it returns is sent as the bearer token. Supabase Third-Party
 * Auth (configured by Quinn against the Clerk instance — see
 * docs/specs/migrate-gymtrack-identity-supabase-auth-to-clerk-tech-design.md
 * Phase 0) verifies the Clerk signature and resolves `auth.uid()` to the
 * Clerk subject at the RLS boundary, so RLS policies that read
 * `auth.uid() = user_id` keep working once Phase 4's first-login linking
 * populates public.profiles.
 *
 * The callback holds a closure over a getter that ClerkAuthProvider
 * publishes via the AuthContext (see `getAccessToken`). The closure is
 * updated whenever the Clerk session changes because the module re-imports
 * happen exactly once at module load — to keep the closure live, we
 * stash the latest getter in a module-scoped variable and refresh it
 * through the AuthContext subscriber pattern in ClerkAuthProvider. Today
 * the simplest working pattern: a getter registered at provider mount,
 * null when Supabase is the active provider.
 *
 * The Supabase path keeps the original `persistSession` / `autoRefreshToken`
 * / `detectSessionInUrl` / `storage` options unchanged — those still apply
 * to the Supabase session when VITE_AUTH_PROVIDER === 'supabase' AND when
 * the Supabase session was established before the Clerk cutover.
 */
let liveAccessTokenGetter = null;

/**
 * Register (or clear) the getter used by supabase-js's `accessToken`
 * callback. ClerkAuthProvider calls this from a useEffect to publish
 * its `() => accessToken` closure; SupabaseAuthProvider calls it with
 * null since Supabase manages its own bearer token via the persisted
 * session.
 *
 * Module-scoped on purpose: supabase.js is a singleton client and the
 * callback closure must outlive the React component tree that owns the
 * Clerk session. The setter is idempotent — calling it repeatedly with
 * the same value is a no-op.
 */
export function setSupabaseAccessTokenGetter(getter) {
  liveAccessTokenGetter = typeof getter === 'function' ? getter : null;
}

/**
 * Single shared Supabase client. anon key is public-by-design; RLS is the gate.
 *
 * When VITE_AUTH_PROVIDER === 'clerk', the `accessToken` callback pulls
 * the Clerk session JWT from the registered getter; supabase-js calls it
 * before each request, so token rotation propagates without manual refresh.
 *
 * When VITE_AUTH_PROVIDER === 'supabase' (default), the callback returns
 * null and supabase-js uses its internally-persisted Supabase session
 * token (the original behaviour). The getter is set to null by
 * SupabaseAuthProvider on mount.
 *
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: getActiveProvider() === 'supabase',
    autoRefreshToken: getActiveProvider() === 'supabase',
    detectSessionInUrl: getActiveProvider() === 'supabase',
    storage: window.localStorage
  },
  accessToken: async () => {
    if (!liveAccessTokenGetter) return null;
    try {
      const token = await liveAccessTokenGetter();
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      // Token getter threw — fall through to anon. RLS will reject the
      // request, which is the right behaviour for a torn-down session.
      return null;
    }
  }
});
