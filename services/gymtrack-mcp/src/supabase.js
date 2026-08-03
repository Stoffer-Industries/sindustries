import { createClient } from '@supabase/supabase-js';

let cached = null;

export function createSupabaseAdminClient(env = process.env) {
  const url = env.VITE_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('GymTrack MCP: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function supabaseAdminClient(env = process.env) {
  if (!cached) cached = createSupabaseAdminClient(env);
  return cached;
}

export function resetSupabaseAdminClientForTests() {
  cached = null;
}
