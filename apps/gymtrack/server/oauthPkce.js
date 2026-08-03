// apps/gymtrack/server/oauthPkce.js
//
// Shared server-only helpers for the /api/oauth/* MCP auth-code+PKCE flow.
//
// Responsibilities:
//   - Generate cryptographically random authorization codes, access tokens, and
//     refresh tokens.
//   - Compute and verify PKCE S256 challenges per RFC 7636.
//   - Hash bearer tokens with SHA-256 for storage (mirrors agentAuth.hashToken).
//
// This module lives OUTSIDE the api/ directory on purpose: Vercel treats every
// file in api/ as a route, and we want shared helpers to never be addressable
// as public endpoints. Route handlers in apps/gymtrack/api/oauth/* import from
// here via relative paths.

import { createHash, randomBytes } from 'node:crypto';

// 32-byte random string → 43-char url-safe base64 (no padding). Per RFC 6749 §A.10
// for access tokens and RFC 6749 §A.11 for authorization codes. Refresh tokens
// (RFC 6749 §A.17) use the same generator — high-entropy opaque string.
export function generateOpaqueToken(byteLength = 32) {
  return randomBytes(byteLength)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Compute the SHA-256 hex digest of a bearer token. Mirrors
 * agentAuth.hashToken so we can reuse the same hashing convention for the
 * new OAuth token storage without diverging.
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a PKCE S256 challenge: SHA-256(code_verifier) base64url-encoded must
 * equal code_challenge. Throws on malformed verifier rather than returning
 * false, so callers don't have to branch on shape vs content.
 *
 * Per RFC 7636 §4.1 the verifier is 43..128 chars of [A-Z][a-z][0-9]-._~.
 * Per RFC 7636 §4.2 the challenge is base64url(SHA256(verifier)) with no padding.
 */
export function verifyPkceS256({ codeVerifier, codeChallenge }) {
  if (typeof codeVerifier !== 'string' || typeof codeChallenge !== 'string') {
    throw new Error('PKCE verifier and challenge must both be strings.');
  }
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    throw new Error(
      `PKCE code_verifier length out of range: ${codeVerifier.length} (expected 43..128).`
    );
  }
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    throw new Error('PKCE code_verifier contains characters outside the unreserved set.');
  }
  const expected = createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  if (expected.length !== codeChallenge.length) {
    return false;
  }
  // Constant-time comparison — same-length hex/base64 strings, but timingSafeEqual
  // is the safe pattern even here.
  return timingSafeStringEqual(expected, codeChallenge);
}

/**
 * Constant-time string equality. Node's crypto.timingSafeEqual requires equal
 * lengths, so we coerce with the rule "if lengths differ, still compare against
 * the longer one with the shorter padded" — but a length mismatch is itself
 * a definitive "no match", so we can just return false after one full pass.
 * We deliberately walk the longer string even on length mismatch to keep the
 * comparison time roughly length-driven rather than early-exit driven.
 */
function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    result |= ac ^ bc;
  }
  return result === 0;
}

/**
 * Build the redirect URL for /oauth/authorize round-trip, including the
 * authorization code and echoed state. We deliberately use the URL constructor
 * so we fail loudly on invalid redirect_uris (defense in depth against open
 * redirect — the caller should have validated redirect_uri against the
 * allowlist first).
 */
export function buildAuthorizationCodeRedirect(redirectUri, { code, state }) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Validate a redirect_uri against the client's registered allowlist. Exact
 * string match — no substring, no globs. RFC 6749 §3.1.2 + RFC 8252 §7.1.
 * Returns null on match, or a string error on mismatch.
 */
export function validateRedirectUri(redirectUri, allowedUris) {
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) {
    return 'redirect_uri is required.';
  }
  if (!Array.isArray(allowedUris) || allowedUris.length === 0) {
    return 'Client has no registered redirect URIs.';
  }
  if (!allowedUris.includes(redirectUri)) {
    return 'redirect_uri does not match a registered URI for this client.';
  }
  return null;
}

/**
 * Validate a requested scope string against the client's allowed scopes.
 * Returns { ok, scopes, error }. The requested scope is a space-separated
 * list per RFC 6749 §3.3; we split, drop empties, and confirm every requested
 * scope is in the client's allowlist.
 */
export function validateScope(requestedScope, allowedScopes) {
  const requested = (requestedScope ?? '')
    .split(/\s+/)
    .filter((s) => s.length > 0);
  if (requested.length === 0) {
    return { ok: false, scopes: [], error: 'scope is required.' };
  }
  const allowSet = new Set(allowedScopes ?? []);
  const disallowed = requested.filter((s) => !allowSet.has(s));
  if (disallowed.length > 0) {
    return {
      ok: false,
      scopes: [],
      error: `Requested scope(s) not allowed for this client: ${disallowed.join(', ')}`
    };
  }
  return { ok: true, scopes: requested, error: null };
}
