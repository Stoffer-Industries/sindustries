const DESTINATION_KEY = 'gymtrack:clerk-sso-destination';

/**
 * In-memory fallback for the SSO destination.
 *
 * `window.sessionStorage` can throw a `SecurityError` — most commonly on
 * iOS Safari when cookies are blocked (ITP) or in certain private-browsing
 * states. That throw used to escape `rememberClerkSsoDestination()` before
 * the provider's own `try` block, which turned a Google sign-in click into
 * a silent no-op (task 7e7826c5). Every storage access here is therefore
 * guarded, and the destination is mirrored in memory so the current page can
 * still read it back.
 *
 * Documented degradation: when `sessionStorage` is unavailable the
 * destination cannot survive the off-site round trip, so `/sso-callback`
 * falls back to `/workout` (the helper's existing default) instead of the
 * user's requested destination. Losing the destination is far better than a
 * dead button.
 */
let memoryDestination = null;

function safeInternalDestination(value) {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '/workout';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/workout';
  }
}

export function rememberClerkSsoDestination(destination) {
  const safe = safeInternalDestination(destination);
  memoryDestination = safe;
  try {
    window.sessionStorage.setItem(DESTINATION_KEY, safe);
  } catch {
    // Storage unavailable — the in-memory copy above is the fallback.
  }
}

export function clearClerkSsoDestination() {
  memoryDestination = null;
  try {
    window.sessionStorage.removeItem(DESTINATION_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export function consumeClerkSsoDestination() {
  let stored = null;
  try {
    stored = window.sessionStorage.getItem(DESTINATION_KEY);
  } catch {
    stored = null;
  }
  const destination = stored ?? memoryDestination ?? '/workout';
  clearClerkSsoDestination();
  return safeInternalDestination(destination);
}
