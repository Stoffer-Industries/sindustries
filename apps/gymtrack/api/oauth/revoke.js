// apps/gymtrack/api/oauth/revoke.js
//
// Vercel serverless handler for POST /api/oauth/revoke.
//
// Implements RFC 7009 token revocation. Either an access_token or a
// refresh_token can be revoked; the response is always 200 if the token was
// recognized (per RFC 7009 §2.2, the server MUST respond 200 even if the
// token is invalid — to avoid leaking which tokens are valid).
//
// Side effects:
//   - The presented token is marked revoked_at = now.
//   - If the presented token is a refresh token whose replaced_by_hash
//     resolves to a row that has itself been replaced again (i.e., it is
//     stale — newer rotations have happened), we revoke the entire token
//     family. This mirrors the OAuth 2.1 §6.1.1 replay-detection posture
//     from /api/oauth/token, applied through the revoke endpoint for
//     clients that detect their own compromise and call /revoke proactively.
//
//   - If the token is associated with a consent row, we mark the consent
//     revoked_at = now so the user's "Connected Agents" settings panel
//     reflects the removal. (Note: revoking the consent here revokes only
//     the user-facing record. The token rows are independently revoked via
//     the token_family_id cascade.)
//
// Auth: anonymous. Per RFC 7009 §2.1 the client authenticates with its
// client credentials; we use the public-client PKCE posture (client_id only)
// to match the rest of this flow. Confidential clients can be added later.
//
// On unknown / invalid tokens: return 200 with empty body — the spec
// requires not leaking token validity to the caller.

import { adminClient } from '../../server/agentAuth.js';
import { hashToken } from '../../server/oauthPkce.js';

export default async function handler(req, res) {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseRevokeBody(req.body);
  const token = body.token;
  const tokenTypeHint = body.token_type_hint;
  const clientId = body.client_id;

  if (typeof token !== 'string' || token.length === 0) {
    // RFC 7009 §2.2 says: "The authorization server responds with HTTP
    // status code 200 if the token has been revoked successfully or if the
    // client submitted an invalid token." So even malformed input returns 200.
    return res.status(200).end();
  }

  const client = adminClient();
  const tokenHash = hashToken(token);

  // If token_type_hint is given, try that type first. Otherwise look at both
  // columns — token_hash is the PK so we can always look up by it directly.
  const { data: tokenRow, error: tokenError } = await client
    .from('gymtrack_oauth_tokens')
    .select('token_hash, token_type, token_family_id, user_id, client_id, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (tokenError) {
    // We can't distinguish "token not found" from "server error" here
    // because the error response code is the same (200). Log and return 200.
    console.error('[oauth/revoke] lookup error:', tokenError.message);
    return res.status(200).end();
  }
  if (!tokenRow) {
    return res.status(200).end();
  }

  // Per RFC 7009 §2.1 the client must authenticate; if client_id doesn't
  // match the token's owner, refuse. We still return 200 to avoid leaking
  // whether the token exists, but we do not actually revoke.
  if (typeof clientId === 'string' && clientId.length > 0 && tokenRow.client_id !== clientId) {
    return res.status(200).end();
  }

  // Already revoked? No-op, still return 200.
  if (tokenRow.revoked_at) {
    return res.status(200).end();
  }

  // Revoke the entire family. Even when the caller presents only an access
  // token, the safest interpretation of "revoke" is "kill every still-live
  // token in this family" — otherwise a leaked access token can keep working
  // until it expires while the user thinks they revoked "the agent".
  const now = new Date().toISOString();
  const { error: revokeError } = await client
    .from('gymtrack_oauth_tokens')
    .update({ revoked_at: now })
    .eq('token_family_id', tokenRow.token_family_id)
    .is('revoked_at', null);

  if (revokeError) {
    console.error('[oauth/revoke] revoke failed:', revokeError.message);
    return res.status(200).end();
  }

  // Mark the consent row revoked. This is best-effort — there might not be
  // an active consent (e.g., admin-issued legacy path), and we don't want to
  // fail the revocation if the consent update fails.
  await client
    .from('gymtrack_oauth_consents')
    .update({ revoked_at: now })
    .eq('user_id', tokenRow.user_id)
    .eq('client_id', tokenRow.client_id)
    .is('revoked_at', null);

  // token_type_hint is informational — we always revoke the family. The hint
  // is only used to bias the lookup order, which we no longer need.
  void tokenTypeHint;

  return res.status(200).end();
}

function parseRevokeBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }
  if (typeof body === 'object') return body;
  return {};
}
