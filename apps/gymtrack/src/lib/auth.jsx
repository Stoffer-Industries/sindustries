import { SupabaseAuthProvider } from './supabaseAuth.jsx';
import { ClerkAuthProvider } from './clerkAuth.jsx';
import { getActiveProvider } from './clerkConfig.js';
import { useAuth as useAuthContext } from './authContext.jsx';

/**
 * AuthProvider — dispatcher that mounts the right identity implementation
 * based on VITE_AUTH_PROVIDER.
 *
 *   - 'supabase' (default)  -> SupabaseAuthProvider  (current behaviour)
 *   - 'clerk'               -> ClerkAuthProvider     (Phase 3 cutover)
 *
 * The dispatcher is intentionally a single component (not a wrapper) so
 * that consumers always mount `<AuthProvider>` regardless of provider —
 * no need to update every consumer's import path when the flag flips.
 *
 * Reads the flag once at module-load via getActiveProvider(); Vite
 * resolves import.meta.env at build time so the branch the bundler
 * emits is deterministic. A runtime env override would require a
 * `?auth=clerk` query-string switch on top of the build-time flag —
 * not implemented in this slice; document as a follow-up if Tom needs it.
 *
 * The ClerkProvider that supplies ClerkAuthProvider's hooks MUST be
 * mounted above this dispatcher in main.jsx — see apps/gymtrack/src/main.jsx.
 */
export function AuthProvider({ children }) {
  if (getActiveProvider() === 'clerk') {
    return <ClerkAuthProvider>{children}</ClerkAuthProvider>;
  }
  return <SupabaseAuthProvider>{children}</SupabaseAuthProvider>;
}

/**
 * Consumer hook. Re-exported from authContext so existing call-sites
 * (`import { useAuth } from '../lib/auth.jsx'`) keep working without
 * touching their import path. The hook itself is provider-agnostic —
 * both providers publish into the same AuthContext.
 */
export function useAuth() {
  return useAuthContext();
}
