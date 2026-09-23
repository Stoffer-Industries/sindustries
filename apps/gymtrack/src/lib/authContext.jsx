import { createContext, useContext } from 'react';

/**
 * Shared AuthContext for both SupabaseAuthProvider and ClerkAuthProvider.
 *
 * The two providers expose the same shape (`{ session, user, loading,
 * signIn, signUp, signOut }`) so consumers (`useAuth`) can read from
 * either implementation. Provider-internal state management (Supabase
 * listener wiring vs Clerk hook consumption) lives in the respective
 * provider module — this file owns only the context object and the hook.
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
