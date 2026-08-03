// apps/gymtrack/api/oauth/revoke-by-consent.js
//
// Vercel serverless handler for POST /api/oauth/revoke-by-consent.
//
// User-facing counterpart to /api/oauth/revoke. The /revoke endpoint
// requires a plaintext OAuth bearer token (which the browser never holds —
// Supabase persists only its own session, not the MCP access token). This
// endpoint lets the Settings → Connected Agents page revoke a connected
// agent by (user, client) without the plaintext token.
//
// Flow:
//   1. The browser POSTs { client_id, access_token } where access_token is
//      the user's Supabase session access_token (NOT a GymTrack OAuth token).
//   2. We verify the Supabase JWT to learn user_id.
//   3. We revoke every still-live row in gymtrack_oauth_tokens matching
//      (user_id, client_id, revoked_at IS NULL).
//   4. We mark the matching consent row(s) revoked_at = now.
//   5. Return 200.
//
// This endpoint is anonymous — same posture as /api/oauth/signin. The
// Supabase JWT verification is what gates access; without a valid token,
// we cannot attribute the request to a real user, so the revoke is
// meaningless.
//
// We deliberately do NOT gate this on `client_id` matching the user's
// current consent set: revocation is a user-controlled operation, and the
// user is the only entity that can ask us to revoke their own tokens.

import { createClient } from '@supabase/supabase-js';
import { adminClient } from '../../server/agentAuth.js';

export default async function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req.body);
  const supabaseAccessToken = body.access_token;
  const clientId = body.client_id;

  if (typeof supabaseAccessToken !== 'string' || supabaseAccessToken.length === 0) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'A signed-in Supabase session is required to revoke an agent.'
    });
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'client_id is required.' });
  }

  // Verify the Supabase access token via the normal anon-client path so
  // the JWT is validated against the configured Supabase project.
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'server_error', message: 'Supabase env not configured.' });
  }
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(supabaseAccessToken);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Supabase session is invalid or expired.' });
  }
  const userId = userData.user.id;

  const client = adminClient();
  const now = new Date().toISOString();

  // Revoke every still-live token for this (user, client) pair. We do
  // not condition on token_type because the entire family must die —
  // orphan refresh tokens are an attack surface.
  const { error: tokenErr, count: tokenCount } = await client
    .from('gymtrack_oauth_tokens')
    .update({ revoked_at: now })
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .is('revoked_at', null);

  if (tokenErr) {
    return res.status(500).json({ error: 'server_error', message: tokenErr.message });
  }

  // Mark the matching consent row revoked_at = now so the user's
  // Connected Agents panel reflects the removal.
  const { error: consentErr, count: consentCount } = await client
    .from('gymtrack_oauth_consents')
    .update({ revoked_at: now })
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .is('revoked_at', null);

  if (consentErr) {
    return res.status(500).json({ error: 'server_error', message: consentErr.message });
  }

  return res.status(200).json({
    revoked_token_count: tokenCount ?? 0,
    revoked_consent_count: consentCount ?? 0,
    revoked_at: now
  });
}

function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    try {
      const json = JSON.parse(body);
      return json ?? {};
    } catch {
      const params = new URLSearchParams(body);
      return Object.fromEntries(params.entries());
    }
  }
  if (typeof body === 'object') return body;
  return {};
}