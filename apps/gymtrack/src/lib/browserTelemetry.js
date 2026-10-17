/**
 * Browser error telemetry — production client for GymTrack.
 *
 * Task: e89db27f-6d78-418e-91c1-0759f8779d06 (Add GymTrack browser error
 * telemetry to Grafana).
 *
 * Captures uncaught exceptions, unhandled promise rejections, and
 * explicitly reported Clerk/Supabase authentication failures from the
 * GymTrack browser bundle, redacts the payload to an allow-list of
 * non-sensitive fields, dedupes + volume-caps in-memory, and forwards
 * the sanitized event to the Vercel serverless relay
 * `apps/gymtrack/api/telemetry.js` (which then forwards to the hosted
 * Grafana Cloud Loki tenant).
 *
 * The browser bundle deliberately never holds the Grafana Cloud
 * credentials — only the relay token (`VITE_TELEMETRY_TOKEN`) which
 * Quinn rotates on deploy. The Loki / OTLP credentials live in Vercel
 * project env vars and are applied by the serverless function. See
 * `docs/specs/gymtrack-browser-error-telemetry-tech-design.md` for the
 * full design.
 *
 * Module-level gate: `installBrowserTelemetry()` is a no-op when
 * `VITE_TELEMETRY_ENABLED !== '1'`, so dev / CI / preview builds
 * (where the env var is unset) emit nothing to staging.
 *
 * The module exports three symbols:
 *   - `installBrowserTelemetry()` — registers global listeners once.
 *   - `reportAuthError(error, context)` — explicitly called from
 *     every `{ data: null, error: ... }` return in
 *     `clerkAuth.jsx` and `supabaseAuth.jsx`.
 *   - `_resetBrowserTelemetryForTests()` — clears module-level state
 *     between vitest cases (the dedupe / volume counters are
 *     module-level, so a per-test reset is required).
 */

const MAX_EVENTS_PER_MINUTE = 5;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const RELAY_URL = '/api/telemetry';
const DEDUPE_WINDOW_MS = 60_000;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
const PASSWORD_PATTERN = /password[=:]\s*\S+/gi;

let installed = false;
let dedupeCounters = new Map();
let minuteBucketStart = Date.now();
let minuteCount = 0;

function getRelayToken() {
  // import.meta.env is Vite's runtime accessor; in vitest it is replaced
  // by `vi.stubEnv`. The token is intentionally exposed in the bundle —
  // it is a relay identifier, not an OAuth token, and it has no user
  // identity. Quinn rotates the value (and the Vercel-side counterpart)
  // together.
  return (import.meta.env?.VITE_TELEMETRY_TOKEN ?? '').trim();
}

function isEnabled() {
  // The string '1' is the explicit opt-in. Anything else (including
  // undefined, '', 'true', '0') disables the telemetry to keep dev/CI
  // builds from emitting to staging.
  return (import.meta.env?.VITE_TELEMETRY_ENABLED ?? '') === '1';
}

function truncate(str, max) {
  if (typeof str !== 'string') return null;
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function redactString(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(PASSWORD_PATTERN, 'password=[redacted]');
}

function redactStack(stack) {
  if (typeof stack !== 'string') return null;
  return redactString(truncate(stack, 1024));
}

function redactMessage(message) {
  if (typeof message !== 'string') return null;
  return truncate(redactString(message).toLowerCase(), 200);
}

function buildPayload({ error, context, source }) {
  const safeMessage =
    redactMessage(context?.safeMessage) ??
    redactMessage(safeErrorMessage(error)) ??
    null;
  const safeStack =
    context?.safeStack !== undefined
      ? redactStack(context.safeStack)
      : redactStack(safeErrorStack(error));

  return {
    environment:
      (import.meta.env?.MODE ?? 'unknown').toString().slice(0, 32) || 'unknown',
    release: truncate(import.meta.env?.VITE_RELEASE_TAG ?? '', 64) || 'dev',
    route: truncate(window?.location?.pathname ?? '', 128),
    operation: truncate(context?.operation ?? source ?? 'unknown', 64),
    provider: context?.provider ?? null,
    errorCode: truncate(context?.errorCode ?? '', 64) || null,
    status: truncate(context?.status ?? '', 32) || null,
    message: safeMessage,
    stack: safeStack,
    userAgent: truncate(window?.navigator?.userAgent ?? '', 256),
    timestamp: new Date().toISOString(),
    source
  };
}

function safeErrorMessage(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return null;
}

function safeErrorStack(error) {
  if (!error || typeof error.stack !== 'string') return null;
  return error.stack;
}

function shouldDedupe(payload) {
  const key = `${payload.errorCode ?? 'null'}|${payload.operation}|${payload.route}`;
  const now = Date.now();

  // Reset the dedupe map every window so memory does not grow without bound
  // when the app is left open for a long time.
  if (now - dedupeCounters.get('__reset', 0) > DEDUPE_WINDOW_MS) {
    dedupeCounters = new Map();
    dedupeCounters.set('__reset', now);
  }

  const lastSeen = dedupeCounters.get(key);
  if (typeof lastSeen === 'number' && now - lastSeen < DEDUPE_WINDOW_MS) {
    dedupeCounters.set(key, now);
    return true;
  }
  dedupeCounters.set(key, now);
  return false;
}

function shouldThrottle() {
  const now = Date.now();
  if (now - minuteBucketStart >= 60_000) {
    minuteBucketStart = now;
    minuteCount = 0;
  }
  if (minuteCount >= MAX_EVENTS_PER_MINUTE) {
    return true;
  }
  minuteCount += 1;
  return false;
}

async function sendPayload(payload) {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && document.visibilityState === 'hidden') {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(RELAY_URL, blob);
    } catch {
      // Swallow — the function never throws.
    }
    return;
  }

  const token = getRelayToken();
  if (!token) return;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: controller.signal
    });
  } catch {
    // Swallow — telemetry is best-effort, never blocks the auth flow.
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function dispatch({ error, context, source }) {
  try {
    if (!isEnabled()) return;
    const payload = buildPayload({ error, context, source });
    const json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD_BYTES) {
      // Drop oversized payloads rather than truncate, so the redaction
      // contract is never broken on a half-trimmed string.
      return;
    }
    if (shouldDedupe(payload)) return;
    if (shouldThrottle()) return;
    void sendPayload(payload);
  } catch {
    // Never throw out of the telemetry path.
  }
}

/**
 * Install the global error and unhandled-rejection listeners. Idempotent
 * — calling it twice is a no-op (guarded by the module-level `installed`
 * boolean). The function is intentionally exported for main.jsx; tests
 * call it directly and then assert listener registration via spies on
 * `window.addEventListener`.
 */
export function installBrowserTelemetry() {
  if (installed) return false;
  if (typeof window === 'undefined') return false;
  if (!isEnabled()) return false;

  installed = true;

  window.addEventListener('error', (event) => {
    dispatch({
      error: event?.error ?? event?.message ?? 'window.error',
      context: null,
      source: 'window.error'
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    dispatch({
      error: reason instanceof Error ? reason : new Error(String(reason ?? 'unhandledrejection')),
      context: null,
      source: 'unhandledrejection'
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Reset the per-minute counter on visibility return so a tab
      // returning from background can emit a small burst if it queued
      // events while hidden. sendBeacon handles the hidden path.
      minuteBucketStart = Date.now();
      minuteCount = 0;
      dedupeCounters = new Map();
    }
  });

  return true;
}

/**
 * Explicit auth-error reporting. Called from every
 * `{ data: null, error: ... }` return in clerkAuth.jsx and
 * supabaseAuth.jsx. The `context` argument carries the operation name,
 * the provider ('clerk' | 'supabase'), and a safe Clerk error code /
 * status extracted from the error envelope (no message, no stack).
 *
 * The function never throws. Caller code is unchanged — failures here
 * cannot break the auth flow.
 */
export function reportAuthError(error, context) {
  dispatch({ error, context, source: 'auth' });
}

/**
 * Test-only state reset. Vitest cases need a clean dedupe / minute
 * counter between runs because the module state is shared across
 * imports. Not exported via the public package boundary.
 */
export function _resetBrowserTelemetryForTests() {
  installed = false;
  dedupeCounters = new Map();
  minuteBucketStart = Date.now();
  minuteCount = 0;
}
