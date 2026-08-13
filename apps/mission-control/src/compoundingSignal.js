// Pure helpers for the bookmark compounding-signal tile.
//
// The compounding signal is a derived read-only artifact published by
// `agents/workflows/bookmarks/scripts/compute_compounding_signal.py` to
// `brain/state/compounding-signal.json`. The Vite dev plugin serves it at
// `/api/compounding-signal` (404 when missing, 500 when malformed). This
// module:
//
//   * Defines the schema the React layer expects (`SCHEMA_VERSION`).
//   * Classifies the fetched payload into `valid | missing | malformed`.
//   * Computes staleness (`generatedAt + 8 days`) and the colour band.
//   * Renders deterministic subtitle text. No JSX — UI strings live here.
//
// The module is intentionally dependency-free (no fetch, no DOM) so it can
// be unit-tested and reused outside the React tree.

export const SCHEMA_VERSION = 1;
export const STALE_AFTER_DAYS = 8;

export const SIGNAL_STATUS = Object.freeze({
  VALID: 'valid',
  MISSING: 'missing',
  MALFORMED: 'malformed'
});

export const SIGNAL_BAND = Object.freeze({
  GREEN: 'green',
  AMBER: 'amber',
  RED: 'red',
  NEUTRAL: 'neutral'
});

/**
 * Parse the raw response from `/api/compounding-signal` into a structured
 * result. The result is *always* one of the three `SIGNAL_STATUS` values;
 * callers never need to handle raw JSON themselves.
 *
 * @param {number} status  HTTP status code from the fetch.
 * @param {string} body    Raw response body (JSON or empty).
 * @returns {{ status: 'valid'|'missing'|'malformed', signal: object|null, error: string|null }}
 */
export function classifySignalResponse(status, body) {
  if (status === 404) {
    return { status: SIGNAL_STATUS.MISSING, signal: null, error: null };
  }
  if (status < 200 || status >= 300) {
    return {
      status: SIGNAL_STATUS.MALFORMED,
      signal: null,
      error: `compounding-signal HTTP ${status}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      status: SIGNAL_STATUS.MALFORMED,
      signal: null,
      error: `JSON parse error: ${err?.message ?? String(err)}`
    };
  }
  const validation = validateSignal(parsed);
  if (validation.ok) {
    return { status: SIGNAL_STATUS.VALID, signal: parsed, error: null };
  }
  return {
    status: SIGNAL_STATUS.MALFORMED,
    signal: null,
    error: validation.error
  };
}

/**
 * Validate the parsed signal against the JSON schema contract.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
 * Mirrors the Python calculator's invariants so the dashboard can rely on
 * the shape even when the artifact is hand-edited.
 */
export function validateSignal(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    return { ok: false, error: 'signal must be a JSON object' };
  }
  if (signal.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion: ${signal.schemaVersion}` };
  }
  for (const key of ['runId', 'generatedAt', 'asOf', 'headlinePercentage', 'trend', 'decisionPolicy', 'inputs']) {
    if (!(key in signal)) {
      return { ok: false, error: `missing required field: ${key}` };
    }
  }
  if (!Array.isArray(signal.trend) || signal.trend.length !== 4) {
    return { ok: false, error: 'trend must be an array of exactly 4 windows' };
  }
  for (const window of signal.trend) {
    if (!window || typeof window !== 'object') {
      return { ok: false, error: 'trend window must be an object' };
    }
    for (const key of ['offsetWeeks', 'start', 'end', 'eligibleCount', 'referencedCount', 'percentage']) {
      if (!(key in window)) {
        return { ok: false, error: `trend window missing ${key}` };
      }
    }
    if (window.percentage !== null && typeof window.percentage !== 'number') {
      return { ok: false, error: 'trend percentage must be null or number' };
    }
    if (window.eligibleCount < 0 || window.referencedCount < 0) {
      return { ok: false, error: 'counts must be non-negative' };
    }
    if (window.referencedCount > window.eligibleCount) {
      return { ok: false, error: 'referencedCount cannot exceed eligibleCount' };
    }
  }
  if (signal.headlinePercentage !== signal.trend[0].percentage) {
    return { ok: false, error: 'headlinePercentage must equal current window percentage' };
  }
  const note = signal.operatorNote;
  if (note !== null && note !== undefined) {
    if (!note || typeof note !== 'object' || typeof note.id !== 'string' || typeof note.text !== 'string') {
      return { ok: false, error: 'operatorNote must be null or {id, text}' };
    }
  }
  return { ok: true };
}

/**
 * True when the signal's `generatedAt` is more than `STALE_AFTER_DAYS`
 * days before `now`. The Vite plugin always reads the latest file, so
 * staleness is purely a read-time condition. A failed weekly run leaves the
 * previous successful artifact in place; the UI then shows the previous
 * value with a stale marker rather than going blank.
 */
export function isStale(signal, now = new Date()) {
  if (!signal || typeof signal.generatedAt !== 'string') return true;
  const generated = new Date(signal.generatedAt);
  if (Number.isNaN(generated.getTime())) return true;
  const ageMs = now.getTime() - generated.getTime();
  return ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Map a numeric percentage to one of the four colour bands. `null` is
 * neutral (no observations). Boundaries match the spec: green >= 50,
 * amber 25-49, red < 25.
 */
export function bandFor(percentage) {
  if (percentage === null || percentage === undefined) return SIGNAL_BAND.NEUTRAL;
  if (percentage >= 50) return SIGNAL_BAND.GREEN;
  if (percentage >= 25) return SIGNAL_BAND.AMBER;
  return SIGNAL_BAND.RED;
}

/**
 * Render the short subtitle shown beneath the headline percentage on the
 * KPI tile. Format is fixed: "<referenced>/<eligible> referenced ·
 * <n> dossier promotions". Caller may append "(stale)" when `isStale`.
 */
export function subtitleFor(signal) {
  if (!signal || !Array.isArray(signal.trend) || signal.trend.length === 0) {
    return '';
  }
  const current = signal.trend[0];
  const promotions = signal.currentWindow?.dossierPromotionCount ?? 0;
  return `${current.referencedCount}/${current.eligibleCount} referenced · ${promotions} dossier promotions`;
}

/**
 * Format the headline percentage for display. `null` becomes the em-dash
 * placeholder so the value column is never empty.
 */
export function formatHeadline(percentage) {
  if (percentage === null || percentage === undefined) return '—';
  return `${percentage.toFixed(1)}%`;
}
