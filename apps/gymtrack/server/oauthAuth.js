// apps/gymtrack/server/oauthAuth.js
//
// Shared server-only helper for the /api/agent/* serverless endpoints.
//
// Responsibilities:
//   - Parse the `Authorization: Bearer <token>` header.
//   - Hash the token with SHA-256 and look up the active row in
//     gymtrack_oauth_tokens (joined with gymtrack_oauth_consents).
//   - Return the resolved identity (user_id + consent_id + client_id + scope),
//     or null on any auth failure (missing header, malformed token, no row,
//     revoked token, revoked consent, expired token, insufficient scope).
//   - Provide common response helpers (401 / 405 / 400).
//
// This module lives OUTSIDE the api/ directory on purpose: Vercel treats every
// file in api/ as a route, and we want shared helpers to never be addressable
// as public endpoints. Route handlers in apps/gymtrack/api/agent/* import from
// here via relative paths.
//
// Scope handling: SUPPORTED_SCOPES and scopeAllows are local copies of the
// canonical definitions in services/gymtrack-mcp/src/scopes.js. The MCP server
// is a separately deployed service whose module is not importable from the
// Vercel build, so the same three-scope list lives here for the agent API
// surface. A follow-up task should extract both into a shared package; the
// duplication is intentionally narrow (one array of three strings) and called
// out in docs/specs/gymtrack-oauth-decommission-2026-08-14-tech-design.md.

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

// Local mirror of services/gymtrack-mcp/src/scopes.js. Keep in sync with the
// canonical definitions until the shared-package refactor lands.
export const SUPPORTED_SCOPES = [
  'workouts:write',
  'history:read',
  'progression:read'
];

/**
 * Returns true when `scope` grants `required`. `scope` is a space-separated
 * list of scopes as recorded in gymtrack_oauth_consents.scope.
 */
export function scopeAllows(scope, required) {
  if (!scope || typeof scope !== 'string') return false;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return granted.has(required);
}

/**
 * Resolve the OAuth identity behind a request.
 *
 * Returns `{ user_id, consent_id, client_id, scope }` on success, or `null` on
 * any auth failure (missing header, malformed token, no matching row,
 * revoked token, revoked consent, expired token, insufficient scope).
 *
 * Throws on database errors so the caller can distinguish a server problem
 * from a client auth failure.
 *
 * No `last_used_at` write on every read — the OAuth rotation path updates
 * `gymtrack_oauth_consents.last_used_at`. Updating it on every read would be
 * churn on hot paths and the Connected Agents UI does not surface "last used"
 * at read-frequency granularity.
 */
export async function resolveOAuthIdentity(req, { requireScope } = {}) {
  const token = parseBearerToken(req);
  if (!token) return null;

  const client = adminClient();
  const { data, error } = await client
    .from('gymtrack_oauth_tokens')
    .select('id, consent_id, user_id, client_id, scope, access_token_expires_at, revoked_at')
    .eq('access_token_hash', hashToken(token))
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (data.revoked_at) return null;
  if (new Date(data.access_token_expires_at).getTime() <= Date.now()) return null;

  // Confirm the consent is still active. The OAuth rotate path revokes
  // consent by stamping revoked_at on the consent row.
  const { data: consent, error: consentError } = await client
    .from('gymtrack_oauth_consents')
    .select('id, user_id, client_id, scope, revoked_at')
    .eq('id', data.consent_id)
    .maybeSingle();

  if (consentError) throw consentError;
  if (!consent) return null;
  if (consent.revoked_at) return null;
  if (consent.user_id !== data.user_id) return null;

  if (requireScope && !scopeAllows(consent.scope ?? data.scope, requireScope)) {
    return null;
  }

  return {
    user_id: data.user_id,
    consent_id: consent.id,
    client_id: data.client_id,
    scope: consent.scope ?? data.scope
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
 * Send a 401 with the canonical agent API error shape.
 */
export function unauthorized(res, message = 'invalid_api_key') {
  res.status(401).json({ error: message });
}

/**
 * Send a 400 with a structured invalid_request payload.
 */
export function badRequest(res, message) {
  res.status(400).json({ error: 'invalid_request', message });
}
