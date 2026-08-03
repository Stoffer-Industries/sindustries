// apps/gymtrack/api/oauth/authorize.js
//
// Vercel serverless handler for GET /api/oauth/authorize.
//
// Implements RFC 6749 §4.1.1 / OAuth 2.1 §4.1.1 authorization-code endpoint
// with PKCE (RFC 7636) required. This handler is the first leg of the MCP
// client → GymTrack round-trip:
//
//   1. Client opens the user-agent at:
//        GET /api/oauth/authorize?
//          response_type=code
//          &client_id=claude-desktop
//          &redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcallback
//          &scope=workouts%3Aread+workouts%3Awrite
//          &state=<csrf>
//          &code_challenge=<base64url(SHA256(verifier))>
//          &code_challenge_method=S256
//
//   2. We validate client_id, redirect_uri (exact match against allowlist),
//      code_challenge_method (= "S256" — plain is rejected per OAuth 2.1),
//      and scope (subset of client's allowed_scopes).
//
//   3. We insert a row into gymtrack_oauth_authorization_codes with
//      user_id=NULL, the challenge, scopes, redirect_uri, and a 10-minute
//      expiry. The plaintext code is returned to the browser once, via the
//      consent page that completes the social-login round-trip.
//
//   4. We redirect the user-agent to the consent page with the code as a
//      query parameter: GET /agent-consent?code=<code>&client=<client_id>
//      &redirect=<redirect_uri>&state=<state>. The consent page renders the
//      Connected-Agents approval UI and calls /api/oauth/signin to bind
//      user_id onto the code once the user signs in and approves.
//
// Errors that we can attribute to the client (bad redirect_uri, bad
// challenge) are returned to redirect_uri with `error=invalid_request` per
// RFC 6749 §4.1.2.1. Errors that we cannot attribute (DB outage, missing
// client_id) render a plain HTML error page — we never redirect to the
// client with an error we cannot trust them to receive.
//
// Auth: anonymous. This endpoint must be reachable before sign-in so the
// MCP client can bootstrap the flow.

import { adminClient } from '../../server/agentAuth.js';
import {
  buildAuthorizationCodeRedirect,
  generateOpaqueToken,
  hashToken,
  validateRedirectUri,
  validateScope
} from '../../server/oauthPkce.js';

const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60; // 10 minutes per OAuth 2.1 §4.1.2.

/**
 * Validate the /authorize query parameters per RFC 6749 §4.1.1 + RFC 7636.
 * Returns { ok, params, error }. On success `params` is the normalized form
 * ready to persist. On failure `error` is a human-readable message and the
 * caller chooses between rendering it or attaching it to a redirect.
 */
export function parseAuthorizeRequest(query) {
  const responseType = query?.response_type;
  const clientId = query?.client_id;
  const redirectUri = query?.redirect_uri;
  const scope = query?.scope;
  const state = query?.state;
  const codeChallenge = query?.code_challenge;
  const codeChallengeMethod = query?.code_challenge_method ?? 'S256';

  if (typeof responseType !== 'string' || responseType.length === 0) {
    return { ok: false, error: 'response_type is required.' };
  }
  if (responseType !== 'code') {
    // Per RFC 6749 §4.1.2.1, only "code" is supported. We do NOT redirect to
    // the client's redirect_uri here because we haven't validated client_id yet.
    return { ok: false, error: 'response_type must be "code".' };
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return { ok: false, error: 'client_id is required.' };
  }
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) {
    return { ok: false, error: 'redirect_uri is required.' };
  }
  if (typeof codeChallenge !== 'string' || codeChallenge.length === 0) {
    return { ok: false, error: 'code_challenge is required (PKCE).' };
  }
  if (codeChallengeMethod !== 'S256') {
    // OAuth 2.1 §4.1.1: PKCE is required AND S256-only. Plain is rejected
    // because the verifier would be the challenge itself.
    return { ok: false, error: 'code_challenge_method must be "S256".' };
  }
  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    return { ok: false, error: 'code_challenge length out of range.' };
  }
  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      scope,
      state: typeof state === 'string' ? state : null,
      codeChallenge,
      codeChallengeMethod
    }
  };
}

export default async function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = parseAuthorizeRequest(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_request', message: parsed.error });
    return;
  }
  const { clientId, redirectUri, scope, state, codeChallenge } = parsed.params;

  // Look up the client allowlist row. No RLS on gymtrack_oauth_clients so we
  // read with the anon key for symmetry with the public-discovery handler —
  // but here we use the service-role key because we need to write back the
  // authorization code on the next step. Either path reads the same data.
  const client = adminClient();
  const { data: clientRow, error: clientError } = await client
    .from('gymtrack_oauth_clients')
    .select('client_id, display_name, redirect_uris, allowed_scopes, disabled_at')
    .eq('client_id', clientId)
    .maybeSingle();

  if (clientError) {
    res.status(500).json({ error: 'server_error', message: clientError.message });
    return;
  }
  if (!clientRow) {
    // Cannot redirect — client_id is unknown. Render a plain error page.
    res.status(400).json({ error: 'invalid_request', message: 'Unknown client_id.' });
    return;
  }
  if (clientRow.disabled_at) {
    res.status(403).json({ error: 'client_disabled', message: 'This client has been disabled.' });
    return;
  }

  const redirectErr = validateRedirectUri(redirectUri, clientRow.redirect_uris);
  if (redirectErr) {
    // redirect_uri is invalid — we MUST NOT redirect per RFC 6749 §3.1.2.5.
    res.status(400).json({ error: 'invalid_request', message: redirectErr });
    return;
  }

  const scopeCheck = validateScope(scope, clientRow.allowed_scopes);
  if (!scopeCheck.ok) {
    // Bad scope — redirect with error per RFC 6749 §4.1.2.1 because the
    // redirect_uri has already been validated.
    res.redirect(
      302,
      buildAuthorizationCodeRedirect(redirectUri, {
        error: 'invalid_scope',
        state
      })
    );
    return;
  }

  // Mint the code, hash it, and persist. The plaintext code is delivered to
  // the consent page via query string — never logged, never stored.
  const code = generateOpaqueToken(32);
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString();

  const { error: insertError } = await client.from('gymtrack_oauth_authorization_codes').insert({
    code_hash: codeHash,
    client_id: clientId,
    user_id: null,
    redirect_uri: redirectUri,
    scopes: scopeCheck.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
    expires_at: expiresAt
  });

  if (insertError) {
    res.status(500).json({ error: 'server_error', message: insertError.message });
    return;
  }

  // Redirect to the consent page. The consent page is a React route under
  // apps/gymtrack/src/components/AgentConsent.jsx (WS5). We pass the requested
  // scope so the consent page can render the per-scope allowlist without a
  // separate server lookup.
  const consentUrl = new URL('/agent-consent', `https://${req.headers.host ?? 'gymtrack.local'}`);
  consentUrl.searchParams.set('code', code);
  consentUrl.searchParams.set('client', clientId);
  consentUrl.searchParams.set('redirect', redirectUri);
  if (state) consentUrl.searchParams.set('state', state);
  if (typeof scope === 'string' && scope.length > 0) {
    consentUrl.searchParams.set('scope', scope);
  }

  res.redirect(302, consentUrl.pathname + consentUrl.search);
}

export const AUTHORIZE_CODE_TTL_SECONDS = AUTHORIZATION_CODE_TTL_SECONDS;
