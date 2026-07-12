import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'GymTrack: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. ' +
      'See apps/gymtrack/.env.example and ask Quinn to wire the values into Vercel for live deploys.'
  );
}

/**
 * Single shared Supabase client. anon key is public-by-design; RLS is the gate.
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  }
});