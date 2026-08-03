// apps/gymtrack/server/agentAuth.js
//
// Shared server-only helper for the /api/agent/* serverless endpoints.
//
// Responsibilities:
//   - Parse the `Authorization: Bearer <token>` header.
//   - Hash the token with SHA-256 and look up a non-revoked row in
//     gymtrack_agent_api_keys.
//   - Return the resolved identity (user_id + key_id), or null on auth failure.
//   - Provide common response helpers (401 / 405 / 400).
//
// This module lives OUTSIDE the api/ directory on purpose: Vercel treats every
// file in api/ as a route, and we want shared helpers to never be addressable
// as public endpoints. Route handlers in apps/gymtrack/api/agent/* import from
// here via relative paths.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

let _adminClient = null;

export function _resetAdminClientForTests() {
  _adminClient = null;
}

/**
 * Returns a memoized Supabase client configured with the service-role key.
 * Throws if required env vars are missing — that is a deploy-time configuration
 * error and must surface, not be silently swallowed.
 */
export function adminClient() {
  if (_adminClient) return _adminClient;
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'GymTrack agent API: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'
    );
  }
  _adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _adminClient;
}

/**
 * Hash a bearer token with SHA-256. Returns the lowercase hex digest.
 * Exported so tests can pre-compute expected hashes.
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parse `Authorization: Bearer <token>`. Returns the token string or null if
 * the header is missing or malformed. Case-insensitive scheme matching.
 */
export function parseBearerToken(req) {
  const header = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Resolve the agent identity behind a request.
 *
 * Returns `{ user_id, key_id }` on success, or `null` on any auth failure
 * (missing header, malformed token, no matching row, revoked row).
 *
 * Throws on database errors so the caller can distinguish a server problem
 * from a client auth failure.
 *
 * Best-effort: fires an async `last_used_at` update without awaiting it.
 */
export async function resolveAgentIdentity(req) {
  const token = parseBearerToken(req);
  if (!token) return null;

  const client = adminClient();
  const { data, error } = await client
    .from('gymtrack_agent_api_keys')
    .select('id, user_id')
    .eq('token_hash', hashToken(token))
    .is('revoked_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  // Fire-and-forget touch of last_used_at — never block the response.
  client
    .from('gymtrack_agent_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {}, () => {});

  return { user_id: data.user_id, key_id: data.id };
}

/**
 * Resolve the OAuth identity behind a request. Parallel to
 * `resolveAgentIdentity` but for tokens minted by the MCP OAuth flow
 * (gymtrack_oauth_tokens, type=access).
 *
 * Returns `{ user_id, client_id, scopes, token_family_id }` on success,
 * or `null` on any auth failure (missing header, malformed token, no
 * matching access row, revoked row, expired row).
 *
 * Throws on database errors so the caller can distinguish a server problem
 * from a client auth failure.
 *
 * The scopes array is the canonical list granted to the agent — callers
 * should enforce scope checks against this array, NOT the row's client
 * allowed_scopes (which is broader and includes things the user did not
 * actually approve).
 */
export async function resolveOAuthIdentity(req) {
  const token = parseBearerToken(req);
  if (!token) return null;

  const client = adminClient();
  const { data, error } = await client
    .from('gymtrack_oauth_tokens')
    .select('user_id, client_id, scopes, token_family_id, expires_at, revoked_at, token_type')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (data.token_type !== 'access') return null;
  if (data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  return {
    user_id: data.user_id,
    client_id: data.client_id,
    scopes: data.scopes ?? [],
    token_family_id: data.token_family_id
  };
}

/**
 * Assert that the resolved OAuth identity carries all required scopes.
 * Returns `null` if every required scope is present; returns a 403 payload
 * `{ error: 'insufficient_scope', message, required_scopes }` otherwise.
 *
 * Callers should `return res.status(403).json(payload)` directly so the
 * WWW-Authenticate challenge header can be set in one place.
 */
export function requireOAuthScope(identity, requiredScopes) {
  if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) return null;
  const granted = new Set(identity?.scopes ?? []);
  const missing = requiredScopes.filter((s) => !granted.has(s));
  if (missing.length === 0) return null;
  return {
    error: 'insufficient_scope',
    message: `This tool requires scope(s): ${missing.join(', ')}.`,
    required_scopes: missing
  };
}

/**
 * Reject non-matching HTTP methods. Returns true if a 405 was already sent and
 * the caller should bail out.
 */
export function rejectIfWrongMethod(req, res, allowed) {
  const allowedUpper = allowed.map((m) => m.toUpperCase());
  if (allowedUpper.includes((req.method || '').toUpperCase())) return false;
  res.setHeader('Allow', allowedUpper.join(', '));
  res.status(405).json({ error: 'method_not_allowed' });
  return true;
}

/**
 * Send a 401 with the canonical agent API error shape. Sets the
 * WWW-Authenticate header to RFC 6750 §3 form so MCP clients see a
 * well-formed Bearer challenge on the wire.
 */
export function unauthorized(res, message = 'invalid_api_key', realm = 'gymtrack-mcp') {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="${realm}", error="${message}"`
  );
  res.status(401).json({ error: message });
}

/**
 * Send a 400 with a structured invalid_request payload.
 */
export function badRequest(res, message) {
  res.status(400).json({ error: 'invalid_request', message });
}
