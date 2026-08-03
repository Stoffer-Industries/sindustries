// apps/gymtrack/api/oauth/token.js
//
// Vercel serverless handler for POST /api/oauth/token.
//
// Implements RFC 6749 §4.1.3 / OAuth 2.1 §4.1.3 token endpoint with PKCE
// (RFC 7636) required and refresh-token rotation (OAuth 2.1 §6.1 best
// practice) enforced.
//
// Two grant_types are supported:
//
//   1) authorization_code
//      POST application/x-www-form-urlencoded
//        grant_type=authorization_code
//        &code=<auth code from /authorize round-trip>
//        &code_verifier=<PKCE verifier>
//        &client_id=<client_id>
//        &redirect_uri=<exact same redirect_uri used at /authorize>
//
//      Validates:
//        - client_id is registered and not disabled.
//        - code row exists, not consumed, not expired.
//        - code_verifier SHA-256 base64url-encoded matches stored code_challenge.
//        - redirect_uri is exactly the same string used at /authorize.
//
//      On success: marks the code consumed, mints an access + refresh token
//      pair tied to a new token_family_id, returns JSON.
//
//   2) refresh_token
//      POST application/x-www-form-urlencoded
//        grant_type=refresh_token
//        &refresh_token=<refresh token from a prior /token response>
//        &client_id=<client_id>
//        &scope=<optional subset of original scopes>
//
//      Validates:
//        - refresh token row exists, not revoked, not expired, type='refresh'.
//        - client_id matches the row's client_id.
//        - requested scope is a subset of the row's scope.
//
//      On success:
//        - Issues a new access + refresh token tied to the SAME token_family_id.
//        - Marks the presented refresh as revoked with replaced_by_hash set
//          to the new refresh's hash.
//        - If the presented refresh was ALREADY revoked (replay), revokes
//          every still-live token in the family and returns invalid_grant —
//          this is the OAuth 2.1 §6.1.1 replay-detection contract.
//
// Auth: anonymous (public-client PKCE). Confidential clients can be added
// later via client_secret_basic; we do not implement that here because all
// currently-registered clients (claude-desktop, chatgpt, local-dev) are
// public per the MCP integration guide.

import { adminClient } from '../../server/agentAuth.js';
import {
  generateOpaqueToken,
  hashToken,
  verifyPkceS256
} from '../../server/oauthPkce.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour per MCP best practice.
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days.

/**
 * Parse an application/x-www-form-urlencoded or JSON body. Vercel serverless
 * functions don't auto-parse urlencoded bodies unless content-type matches,
 * so we tolerate both for robustness.
 */
export function parseTokenRequestBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }
  if (typeof body === 'object') {
    // Vercel parses urlencoded into an object for us when content-type is set.
    return body;
  }
  return {};
}

export default async function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseTokenRequestBody(req.body);
  const grantType = body.grant_type;
  const clientId = body.client_id;

  if (typeof grantType !== 'string' || grantType.length === 0) {
    res.status(400).json({ error: 'invalid_request', message: 'grant_type is required.' });
    return;
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    res.status(400).json({ error: 'invalid_request', message: 'client_id is required.' });
    return;
  }

  const client = adminClient();
  const { data: clientRow, error: clientError } = await client
    .from('gymtrack_oauth_clients')
    .select('client_id, disabled_at')
    .eq('client_id', clientId)
    .maybeSingle();
  if (clientError) {
    res.status(500).json({ error: 'server_error', message: clientError.message });
    return;
  }
  if (!clientRow) {
    res.status(400).json({ error: 'invalid_client', message: 'Unknown client_id.' });
    return;
  }
  if (clientRow.disabled_at) {
    res.status(403).json({ error: 'client_disabled', message: 'This client has been disabled.' });
    return;
  }

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(req, res, client, clientId, body);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(req, res, client, clientId, body);
  }

  res.status(400).json({
    error: 'unsupported_grant_type',
    message: `grant_type "${grantType}" is not supported. Use "authorization_code" or "refresh_token".`
  });
}

async function handleAuthorizationCodeGrant(req, res, client, clientId, body) {
  const code = body.code;
  const codeVerifier = body.code_verifier;
  const redirectUri = body.redirect_uri;

  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'code is required.' });
  }
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'code_verifier is required (PKCE).' });
  }
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'redirect_uri is required.' });
  }

  const codeHash = hashToken(code);
  const { data: codeRow, error: codeError } = await client
    .from('gymtrack_oauth_authorization_codes')
    .select('code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, consumed_at')
    .eq('code_hash', codeHash)
    .maybeSingle();

  if (codeError) {
    return res.status(500).json({ error: 'server_error', message: codeError.message });
  }
  if (!codeRow) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code is invalid.' });
  }
  if (codeRow.consumed_at) {
    // Per RFC 6749 §4.1.2, single-use codes. If we see a consumed code again,
    // it's a replay attempt — revoke the family the code eventually produced.
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code has already been used.' });
  }
  if (new Date(codeRow.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code has expired.' });
  }
  if (codeRow.client_id !== clientId) {
    return res.status(400).json({ error: 'invalid_grant', message: 'client_id does not match the authorization request.' });
  }
  if (codeRow.redirect_uri !== redirectUri) {
    return res.status(400).json({ error: 'invalid_grant', message: 'redirect_uri must match the value used at /authorize.' });
  }
  if (!codeRow.user_id) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code has not been bound to a user yet.' });
  }

  let pkceOk = false;
  try {
    pkceOk = verifyPkceS256({ codeVerifier, codeChallenge: codeRow.code_challenge });
  } catch (err) {
    return res.status(400).json({ error: 'invalid_grant', message: err.message });
  }
  if (!pkceOk) {
    return res.status(400).json({ error: 'invalid_grant', message: 'PKCE verification failed.' });
  }

  // Mark consumed atomically. We condition on consumed_at IS NULL so two
  // concurrent /token requests cannot both succeed. If the conditional update
  // returns 0 rows, the other request got there first.
  const { data: consumed, error: consumeError } = await client
    .from('gymtrack_oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .is('consumed_at', null)
    .select('code_hash');

  if (consumeError) {
    return res.status(500).json({ error: 'server_error', message: consumeError.message });
  }
  if (!consumed || consumed.length === 0) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code was used concurrently.' });
  }

  // Persist a consent row if one doesn't already exist for (user, client).
  // The unique index (user_id, client_id) makes this a no-op when there's
  // already an active consent.
  await client
    .from('gymtrack_oauth_consents')
    .upsert(
      {
        user_id: codeRow.user_id,
        client_id: codeRow.client_id,
        scopes: codeRow.scopes,
        granted_at: new Date().toISOString(),
        revoked_at: null
      },
      { onConflict: 'user_id,client_id', ignoreDuplicates: false }
    );

  return await mintTokenPair(res, client, {
    userId: codeRow.user_id,
    clientId: codeRow.client_id,
    scopes: codeRow.scopes
  });
}

async function handleRefreshTokenGrant(req, res, client, clientId, body) {
  const refreshToken = body.refresh_token;
  const requestedScope = body.scope;

  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'refresh_token is required.' });
  }

  const refreshHash = hashToken(refreshToken);
  const { data: tokenRow, error: tokenError } = await client
    .from('gymtrack_oauth_tokens')
    .select('token_hash, token_type, token_family_id, user_id, client_id, scopes, expires_at, revoked_at, replaced_by_hash')
    .eq('token_hash', refreshHash)
    .maybeSingle();

  if (tokenError) {
    return res.status(500).json({ error: 'server_error', message: tokenError.message });
  }
  if (!tokenRow) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Refresh token is invalid.' });
  }
  if (tokenRow.token_type !== 'refresh') {
    return res.status(400).json({ error: 'invalid_grant', message: 'Token is not a refresh token.' });
  }
  if (tokenRow.client_id !== clientId) {
    return res.status(400).json({ error: 'invalid_grant', message: 'client_id does not match the refresh token.' });
  }

  if (tokenRow.revoked_at) {
    // Replay detection — OAuth 2.1 §6.1.1: revoke the entire family.
    await revokeTokenFamily(client, tokenRow.token_family_id);
    return res.status(400).json({
      error: 'invalid_grant',
      message: 'Refresh token replay detected; token family revoked.'
    });
  }
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Refresh token has expired.' });
  }

  // Optional scope downscoping — RFC 6749 §6.
  if (typeof requestedScope === 'string' && requestedScope.length > 0) {
    const requested = requestedScope.split(/\s+/).filter((s) => s.length > 0);
    const allowed = new Set(tokenRow.scopes);
    const disallowed = requested.filter((s) => !allowed.has(s));
    if (disallowed.length > 0) {
      return res.status(400).json({
        error: 'invalid_scope',
        message: `Requested scope(s) not in original grant: ${disallowed.join(', ')}`
      });
    }
    if (requested.length < (tokenRow.scopes?.length ?? 0)) {
      tokenRow.scopes = requested;
    }
  }

  // Rotate: mark this refresh revoked (with replaced_by_hash) and mint a new pair.
  // We persist the new refresh first, then update the old row's replaced_by_hash
  // so the foreign-key reference resolves.
  const issued = await mintTokenPair(res, client, {
    userId: tokenRow.user_id,
    clientId: tokenRow.client_id,
    scopes: tokenRow.scopes,
    familyId: tokenRow.token_family_id,
    skipResponse: true
  });

  const { error: rotateError } = await client
    .from('gymtrack_oauth_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by_hash: issued.refreshHash })
    .eq('token_hash', refreshHash)
    .is('revoked_at', null);

  if (rotateError) {
    return res.status(500).json({ error: 'server_error', message: rotateError.message });
  }

  // Now write the token response.
  return res.status(200).json({
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: issued.refreshToken,
    scope: (tokenRow.scopes ?? []).join(' ')
  });
}

async function mintTokenPair(res, client, { userId, clientId, scopes, familyId, skipResponse = false }) {
  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);
  const accessHash = hashToken(accessToken);
  const refreshHash = hashToken(refreshToken);
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();

  const rows = [
    {
      token_hash: accessHash,
      token_type: 'access',
      token_family_id: familyId ?? undefined,
      user_id: userId,
      client_id: clientId,
      scopes,
      expires_at: accessExpires
    },
    {
      token_hash: refreshHash,
      token_type: 'refresh',
      token_family_id: familyId ?? undefined,
      user_id: userId,
      client_id: clientId,
      scopes,
      expires_at: refreshExpires
    }
  ];

  const { error: insertError } = await client.from('gymtrack_oauth_tokens').insert(rows);
  if (insertError) {
    throw new Error(`mintTokenPair insert failed: ${insertError.message}`);
  }

  if (skipResponse) {
    return { accessToken, refreshToken, accessHash, refreshHash };
  }

  return res.status(200).json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(' ')
  });
}

async function revokeTokenFamily(client, familyId) {
  await client
    .from('gymtrack_oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_family_id', familyId)
    .is('revoked_at', null);
}

export const TOKEN_TTL_SECONDS = {
  ACCESS: ACCESS_TOKEN_TTL_SECONDS,
  REFRESH: REFRESH_TOKEN_TTL_SECONDS
};
