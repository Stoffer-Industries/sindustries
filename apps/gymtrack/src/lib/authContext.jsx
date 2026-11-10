import { createContext, useContext } from 'react';

/**
 * Shared AuthContext for both SupabaseAuthProvider and ClerkAuthProvider.
 *
 * The two providers expose the same shape (`{ session, user, loading,
 * signIn, signUp, verifySignInCode, verifySignUpCode, signOut,
 * startOAuthRedirect }`) so consumers (`useAuth`) can read from either
 * implementation. Provider-internal state management
 * (Supabase listener wiring vs Clerk hook consumption) lives in the
 * respective provider module — this file owns only the context object and
 * the hook.
 *
 * Sign-up contract (both providers):
 *
 *   - `signUp(email, password) -> { data, error }`
 *       `data.needsVerification === true` means the account was created but
 *       its email address is not verified yet, so NO session exists. The
 *       page must render a code-entry step. `data.verificationMode` names
 *       the verification mechanism ('signup_email_code' for both
 *       providers today). When a session is issued immediately,
 *       `data.needsVerification === false`.
 *   - `verifySignUpCode(code) -> { data, error }`
 *       Completes the pending sign-up with the emailed one-time code and
 *       returns `{ data: { session } }`. The page never supplies the email
 *       address — each provider already owns the pending sign-up attempt
 *       (Clerk's `signUp` resource; Supabase's stored email + token) — so
 *       the view never becomes a second source of truth for it.
 *
 * `verifySignUpCode` is deliberately separate from `verifySignInCode`:
 * the sign-in code and the sign-up code live on different provider
 * resources (`signIn` vs `signUp`) and are different OTP types, so folding
 * them into one method would put a provider-shaped switch in this shared
 * contract.
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
