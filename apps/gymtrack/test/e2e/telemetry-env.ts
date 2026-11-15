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
const DEFAULT_E2E_COMMIT_SHA = 'e2e00000000000000000000000000000000000000';

/**
 * A SHA-like shape: hex only, 7-64 characters.
 *
 * `GT_TELEMETRY_E2E_SHA` is interpolated into the dev-server command in
 * `playwright.config.ts`, so a value carrying a shell metacharacter could
 * alter that command. Only a SHA-like hex string is accepted; anything else
 * is a configuration error and fails the suite before the server starts.
 */
const SHA_LIKE = /^[0-9a-f]{7,64}$/i;

/**
 * Resolve the build-time release identifier for the e2e run.
 *
 * Throws on a value that is not SHA-like, rather than sanitising it: a
 * typo'd or injected value is a configuration bug, and silently rewriting it
 * would make the release assertion in the spec prove nothing.
 */
export function resolveTelemetryE2eCommitSha(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_E2E_COMMIT_SHA;
  if (!SHA_LIKE.test(value)) {
    throw new Error(
      'GT_TELEMETRY_E2E_SHA must be a SHA-like hex string (7-64 hex characters); got ' +
        JSON.stringify(value.slice(0, 32)),
    );
  }
  return value;
}

export const TELEMETRY_E2E_COMMIT_SHA = resolveTelemetryE2eCommitSha(
  process.env.GT_TELEMETRY_E2E_SHA
);

/**
 * Dummy relay token. The relay endpoint is intercepted by the test, so no
 * event ever leaves the machine; this value only has to be non-empty for the
 * browser bundle to attempt a send.
 */
export const TELEMETRY_E2E_RELAY_TOKEN = 'e2e-relay-token';

/** Opt-in gate for the whole suite. */
export const TELEMETRY_E2E_ENABLED = process.env.GT_TELEMETRY_E2E === '1';
