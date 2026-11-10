import { createContext, useContext } from 'react';

/**
 * Shared AuthContext for both SupabaseAuthProvider and ClerkAuthProvider.
 *
 * The two providers expose the same shape (`{ session, user, loading,
 * signIn, signUp, signOut, startOAuthRedirect }`) so consumers (`useAuth`)
 * can read from either implementation. Provider-internal state management
 * (Supabase listener wiring vs Clerk hook consumption) lives in the
 * respective provider module — this file owns only the context object and
 * the hook.
 *
 * `startOAuthRedirect(provider, redirectPath)` contract (both providers):
 *
 *   - Returns `{ data, error, providerDisabled }`.
 *   - `data.redirecting === true` means "the provider accepted the request
 *     and the browser is navigating". Clerk owns the navigation and returns
 *     no URL; Supabase also returns `data.url`, which the caller assigns to
 *     `window.location`.
 *   - `error` is an `Error` the caller can render verbatim.
 *   - `providerDisabled === true` means the provider is not configured; the
 *     caller removes the button and shows the "not available" message.
 *
 * The contract is consumed through `useOAuthRedirect()`
 * (`apps/gymtrack/src/lib/useOAuthRedirect.js`), which is the single total
 * error boundary for the OAuth click so `/login` and `/signup` behave
 * identically (task 7e7826c5).
 *
 * The context lives in its own module (rather than inside auth.jsx) to
 * break the import cycle that would otherwise arise between auth.jsx
 * (which dispatches between providers) and the provider modules.
 */
export const AuthContext = createContext(null);

/**
 * Consumer hook. Resolves the context to the active provider's value.
 * Throws if called outside any AuthProvider, which surfaces misconfigured
 * main.jsx (e.g. forgetting to wrap with `<AuthProvider>`) early.
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
