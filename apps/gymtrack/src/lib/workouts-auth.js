import { supabase } from './supabase.js';

/**
 * Resolve the currently authenticated user for workout operations.
 *
 * Centralises the `supabase.auth.getUser()` check so CRUD functions in
 * `workouts.js` can declare their auth precondition without re-implementing
 * the same boilerplate. RLS on the underlying tables is still the primary
 * access-control mechanism; this helper exists to surface an explicit
 * authentication error to callers before any database round-trip.
 *
 * @returns {Promise<{ user: import('@supabase/supabase-js').User|null, error: Error|null }>}
 *   Resolves with the user on success, or `{ user: null, error }` when no
 *   authenticated session is present. Never throws.
 */
export async function requireAuthenticatedUser() {
  const { data: { user } = {} } = await supabase.auth.getUser();
  if (!user) {
    return { user: null, error: new Error('Not authenticated') };
  }
  return { user, error: null };
}