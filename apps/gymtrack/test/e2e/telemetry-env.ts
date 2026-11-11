/**
 * Shared constants for the browser-telemetry e2e suite.
 *
 * Kept in its own module so `playwright.config.ts` (which starts the dev
 * server with the same build-time environment the spec asserts against) and
 * the spec itself cannot drift apart.
 */

/**
 * Synthetic commit sha used as the build-time release identifier.
 *
 * The point is to exercise the *production* resolution path: a Vercel build
 * exposes `VERCEL_GIT_COMMIT_SHA`, `vite.config.js` allow-lists exactly that
 * variable name in `envPrefix`, and the telemetry module reads it when no
 * explicit `VITE_RELEASE_TAG` is set. Asserting on this value in the browser
 * proves the whole chain end to end.
 *
 * It is deliberately not a real commit — nothing depends on it resolving in
 * a git repository.
 */
export const TELEMETRY_E2E_COMMIT_SHA =
  process.env.GT_TELEMETRY_E2E_SHA ?? 'e2e00000000000000000000000000000000000000';

/**
 * Dummy relay token. The relay endpoint is intercepted by the test, so no
 * event ever leaves the machine; this value only has to be non-empty for
 * the browser bundle to attempt a send.
 */
export const TELEMETRY_E2E_RELAY_TOKEN = 'e2e-relay-token';

/** Opt-in gate for the whole suite. */
export const TELEMETRY_E2E_ENABLED = process.env.GT_TELEMETRY_E2E === '1';
