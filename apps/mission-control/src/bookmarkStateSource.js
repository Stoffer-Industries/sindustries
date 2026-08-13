// Tiny client wrapping the dev-only brain state API mounted by the Vite
// plugin in vite.config.js. The plugin serves:
//   GET /api/state                -> bookmark-review-state.json
//   GET /api/transitions          -> bookmark-transitions.jsonl (parsed to array)
//   GET /api/compounding-signal   -> compounding-signal.json (raw body)
//
// `baseUrl` defaults to the same origin the app is served from, which is
// the dev-server URL. In production (no plugin), all three fetches 404 and the
// tab renders an empty state — no hard failure.

import { classifySignalResponse, SIGNAL_STATUS } from './compoundingSignal.js';

export const DEFAULT_BASE_URL = '';

export function bookmarkStateBaseUrl() {
  return (
    import.meta.env.VITE_BOOKMARK_STATE_BASE_URL ?? DEFAULT_BASE_URL
  );
}

async function fetchJson(path, baseUrl, signal) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal
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

async function fetchText(path, baseUrl, signal) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal
  });
  // Returning the raw body + status lets the signal classifier distinguish
  // 404 (missing), 500 (malformed), and 200 (valid) without re-reading the
  // stream. The body is empty for non-2xx responses we want to treat as
  // empty/missing downstream.
  if (res.status === 404) {
    return { status: 404, body: '' };
  }
  if (!res.ok) {
    return { status: res.status, body: '' };
  }
  return { status: res.status, body: await res.text() };
}

/**
 * Load the bookmark pipeline state, transition log, and compounding signal
 * in parallel. Returns `{ snapshot, transitions, compoundingSignal, ... }`.
 *
 * - `snapshot` defaults to `{ version: 1, items: {} }` when not present
 *   (e.g. the dev plugin is not active and both endpoints 404).
 * - `transitions` defaults to `[]` when not present.
 * - `compoundingSignal` is `{ status: 'valid'|'missing'|'malformed', signal, error }`.
 * - `error` is set when one of the state/transitions fetches returns a
 *   non-404 error; the partial result is still returned so the UI can
 *   render what loaded. Signal failures are surfaced via `compoundingSignal`
 *   and never bubble into `error`, so a missing or malformed signal does
 *   not block the rest of the tab.
 *
 * Uses `Promise.allSettled` so a failing endpoint does not block the others.
 */
export async function loadBookmarkState({ baseUrl = bookmarkStateBaseUrl(), signal } = {}) {
  const [stateResult, transitionsResult, signalResult] = await Promise.allSettled([
    fetchJson('/api/state', baseUrl, signal),
    fetchJson('/api/transitions', baseUrl, signal),
    fetchText('/api/compounding-signal', baseUrl, signal)
  ]);

  const errors = [];
  const snapshot = stateResult.status === 'fulfilled'
    ? (stateResult.value ?? { version: 1, items: {} })
    : (errors.push(stateResult.reason?.message ?? 'state failed'), { version: 1, items: {} });
  const transitions = transitionsResult.status === 'fulfilled'
    ? (Array.isArray(transitionsResult.value) ? transitionsResult.value : [])
    : (errors.push(transitionsResult.reason?.message ?? 'transitions failed'), []);

  let compoundingSignal = { status: SIGNAL_STATUS.MISSING, signal: null, error: null };
  if (signalResult.status === 'fulfilled') {
    const { status, body } = signalResult.value;
    compoundingSignal = classifySignalResponse(status, body);
  } else {
    // Network-level failure (e.g. abort). Treat as missing so the tile
    // shows its placeholder; the caller still learns about the abort from
    // the rejected promise if they care.
    compoundingSignal = {
      status: SIGNAL_STATUS.MISSING,
      signal: null,
      error: signalResult.reason?.message ?? null
    };
  }

  return {
    snapshot,
    transitions,
    compoundingSignal,
    loadedAt: new Date().toISOString(),
    error: errors.length === 0 ? null : errors.join('; ')
  };
}