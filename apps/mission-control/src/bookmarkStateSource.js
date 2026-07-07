// Tiny client wrapping the dev-only brain state API mounted by the Vite
// plugin in vite.config.js. The plugin serves:
//   GET /api/state        -> bookmark-review-state.json
//   GET /api/transitions  -> bookmark-transitions.jsonl (parsed to array)
//
// `baseUrl` defaults to the same origin the app is served from, which is
// the dev-server URL. In production (no plugin), both fetches 404 and the
// tab renders an empty state — no hard failure.

export const DEFAULT_BASE_URL = '';

export function bookmarkStateBaseUrl() {
  return (
    import.meta.env.VITE_BOOKMARK_STATE_BASE_URL ?? DEFAULT_BASE_URL
  );
}

async function fetchJson(path, baseUrl) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json' }
  });
  if (res.status === 404) {
    // The dev plugin is not active. Treat as empty state — the caller
    // is responsible for showing the empty branch.
    return null;
  }
  if (!res.ok) {
    throw new Error(`Bookmark state ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Load the bookmark pipeline state and transition log in parallel.
 * Returns `{ snapshot, transitions, loadedAt, error }`.
 *
 * - `snapshot` defaults to `{ version: 1, items: {} }` when not present
 *   (e.g. the dev plugin is not active and both endpoints 404).
 * - `transitions` defaults to `[]` when not present.
 * - `error` is set when one of the fetches returns a non-404 error; the
 *   partial result is still returned so the UI can render what loaded.
 *
 * Uses `Promise.allSettled` so a failing transitions endpoint does not
 * block the snapshot, and vice versa.
 */
export async function loadBookmarkState({ baseUrl = bookmarkStateBaseUrl(), signal } = {}) {
  const [stateResult, transitionsResult] = await Promise.allSettled([
    fetchJson('/api/state', baseUrl),
    fetchJson('/api/transitions', baseUrl)
  ]);

  const errors = [];
  const snapshot = stateResult.status === 'fulfilled'
    ? (stateResult.value ?? { version: 1, items: {} })
    : (errors.push(stateResult.reason?.message ?? 'state failed'), { version: 1, items: {} });
  const transitions = transitionsResult.status === 'fulfilled'
    ? (Array.isArray(transitionsResult.value) ? transitionsResult.value : [])
    : (errors.push(transitionsResult.reason?.message ?? 'transitions failed'), []);

  return {
    snapshot,
    transitions,
    loadedAt: new Date().toISOString(),
    error: errors.length === 0 ? null : errors.join('; ')
  };
}