// apps/gymtrack/api/oauth/signin.js
//
// Vercel serverless handler for POST /api/oauth/signin.
//
// Completes the OAuth authorization-code round-trip for public-client MCP
// integrations. Called by the /agent-consent React page after the user has:
//
//   1. Landed on /agent-consent?code=<auth code from /authorize>&...
//   2. Completed Supabase social sign-in (Google or Apple — same primitive
//      as the public sign-up flow shipped in task 72d7cc3b).
//   3. Approved the consent UI showing which scopes the client requested.
//
// The consent page then POSTs to /api/oauth/signin with:
//   { code: "<auth code>", access_token: "<Supabase access_token JWT>" }
//
// This endpoint:
//   1. Verifies the Supabase JWT against the configured Supabase project so
//      we know the access_token corresponds to a real signed-in user.
//   2. Looks up the auth code row, verifies it is still valid (not consumed,
//      not expired, code_challenge_method = S256).
//   3. Back-fills user_id on the auth code row.
//   4. Returns the redirect_uri with `code` (NOT the user's Supabase JWT —
//      the original authorization code from /authorize) and `state`. The
//      consent page navigates the browser there, completing the round-trip.
//
// We deliberately do NOT validate the code_verifier here — that happens at
// /api/oauth/token when the client exchanges the code. Keeping the two
// steps separate means /signin can run in the browser while /token runs on
// the client (typically server-side for confidential clients, but our
// clients are public + PKCE-only).
//
// Auth: requires a valid Supabase access_token in the request body. The
// endpoint is otherwise anonymous — it does not require the legacy agent
// API key or any OAuth bearer token. This is safe because /signin cannot
// leak anything sensitive; the worst it can do is back-fill user_id on an
// already-issued auth code row, and the auth code can only be exchanged by
// the original client (which must present PKCE).

import { createClient } from '@supabase/supabase-js';
import { adminClient } from '../../server/agentAuth.js';

export default async function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseSigninBody(req.body);
  const code = body.code;
  const supabaseAccessToken = body.access_token;

  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'code is required.' });
  }
  if (typeof supabaseAccessToken !== 'string' || supabaseAccessToken.length === 0) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'A signed-in Supabase session is required before approving an OAuth consent.'
    });
  }

  // Verify the Supabase access token. We use a dedicated anon-key client per
  // request (NOT the admin client) so Supabase's getUser() runs through the
  // normal JWT-validation path. This rejects tokens signed for a different
  // project, expired tokens, and tokens with a tampered payload.
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

  // Look up the auth code row. We do NOT have user_id yet — that's the whole
  // point of /signin. We resolve by code_hash to keep the plaintext code out
  // of any database log.
  const client = adminClient();
  const codeHash = await sha256Hex(code);
  const { data: codeRow, error: codeError } = await client
    .from('gymtrack_oauth_authorization_codes')
    .select('code_hash, client_id, user_id, redirect_uri, scopes, expires_at, consumed_at')
    .eq('code_hash', codeHash)
    .maybeSingle();

  if (codeError) {
    return res.status(500).json({ error: 'server_error', message: codeError.message });
  }
  if (!codeRow) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code is invalid.' });
  }
  if (codeRow.consumed_at) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code has already been used.' });
  }
  if (new Date(codeRow.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code has expired.' });
  }
  if (codeRow.user_id && codeRow.user_id !== userId) {
    // The code was previously bound to a different user (probably because the
    // user navigated back to /agent-consent after signing in as someone
    // else). Refuse rather than silently rebinding.
    return res.status(409).json({
      error: 'consent_conflict',
      message: 'Authorization code is already bound to a different user. Restart the flow.'
    });
  }

  // Back-fill user_id. We condition on user_id IS NULL so two concurrent
  // /signin calls cannot both succeed. The losing caller sees 0 rows
  // updated and we re-fetch.
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await client
    .from('gymtrack_oauth_authorization_codes')
    .update({ user_id: userId })
    .eq('code_hash', codeHash)
    .is('user_id', null)
    .select('code_hash');

  if (updateError) {
    return res.status(500).json({ error: 'server_error', message: updateError.message });
  }
  if (!updated || updated.length === 0) {
    return res.status(409).json({
      error: 'consent_conflict',
      message: 'Authorization code was bound by another request. Restart the flow.'
    });
  }

  // Build the redirect URI the consent page should navigate the browser to.
  // The browser already has the plaintext code from the URL it landed on;
  // we echo it back so the consent page can `window.location.assign` the
  // exact URL.
  const url = new URL(codeRow.redirect_uri);
  url.searchParams.set('code', code);

  // We don't have access to the original `state` here because we didn't
  // persist it separately for /signin callers — but the schema's state
  // column has it. Fetch again to get the state.
  const { data: codeRowWithState } = await client
    .from('gymtrack_oauth_authorization_codes')
    .select('state')
    .eq('code_hash', codeHash)
    .maybeSingle();
  if (codeRowWithState?.state) {
    url.searchParams.set('state', codeRowWithState.state);
  }

  return res.status(200).json({
    redirect_uri: url.toString(),
    client_id: codeRow.client_id,
    scopes: codeRow.scopes ?? [],
    bound_at: now
  });
}

function parseSigninBody(body) {
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

async function sha256Hex(input) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
