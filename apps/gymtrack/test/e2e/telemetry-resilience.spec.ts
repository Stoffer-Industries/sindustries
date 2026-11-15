import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  TELEMETRY_E2E_COMMIT_SHA,
  TELEMETRY_E2E_ENABLED
} from './telemetry-env';

/**
 * Browser-error telemetry resilience e2e (task `e89db27f`).
 *
 * These are the two Playwright rows the approved tech design
 * (`docs/specs/gymtrack-browser-error-telemetry-tech-design.md`, AC1 + AC3
 * verification table) promised, but which neither merged delivery PR
 * (#836, #967) actually delivered. The QA verifier flagged the gap on
 * 2026-11-11 alongside the `release=dev` defect.
 *
 *   AC1 — an uncaught browser exception and an authentication failure are
 *         both exported to the relay with the retained field set, and the
 *         `release` field identifies the build that produced them.
 *   AC3 — a blocked / failing relay is non-blocking: page rendering and
 *         navigation behave exactly as they did before telemetry existed.
 *
 * Structure:
 *   - The harness group drives `test/e2e/fixtures/telemetry-harness.html`,
 *     a dev-server-only page that imports the real telemetry module from
 *     `/src/lib/browserTelemetry.js`. It is hermetic: no auth provider, no
 *     live backend, no credentials. The relay endpoint is intercepted by
 *     every test, so no event ever leaves the machine.
 *   - The auth-failure group drives the real application against a live
 *     Clerk deployment and is gated exactly like `signin-clerk.spec.ts`
 *     (`CLERK_TEST_URL`, `CLERK_TEST_EMAIL`, `CLERK_TEST_PASSWORD`).
 *
 * Gating:
 *   - `GT_TELEMETRY_E2E=1` opts the suite in. `playwright.config.ts` starts
 *     the dev server with telemetry enabled and with a synthetic
 *     `VERCEL_GIT_COMMIT_SHA`, which is the production resolution path.
 */

const CLERK_TEST_URL = process.env.CLERK_TEST_URL;
const CLERK_TEST_EMAIL = process.env.CLERK_TEST_EMAIL;
const CLERK_TEST_PASSWORD = process.env.CLERK_TEST_PASSWORD;
const CLERK_GATE = Boolean(
  CLERK_TEST_URL && CLERK_TEST_EMAIL && CLERK_TEST_PASSWORD
);

const RELAY_GLOB = '**/api/telemetry';
const HARNESS_PATH = '/test/e2e/fixtures/telemetry-harness.html';
const EVIDENCE_MESSAGE = 'gymtrack-browser-error-telemetry-evidence-e2e';

type RelayEvent = {
  source: string;
  environment: string;
  release: string;
  route: string;
  operation: string;
  provider: string | null;
  errorCode: string | null;
  status: string | null;
  message: string | null;
  timestamp: string;
};

/**
 * Intercept the relay and capture the payload the browser sends. The
 * request is fulfilled locally with `204` — nothing is forwarded.
 */
async function captureRelay(page: Page) {
  const captured: RelayEvent[] = [];
  await page.route(RELAY_GLOB, async (route) => {
    captured.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  return captured;
}

test.describe('GymTrack — browser error telemetry', () => {
  test.skip(!TELEMETRY_E2E_ENABLED, 'GT_TELEMETRY_E2E=1 not set — telemetry suite skipped');

  test('AC1: an uncaught exception is exported with the retained field set', async ({ page }) => {
    const captured = await captureRelay(page);

    await page.goto(HARNESS_PATH);
    await expect(page.getByTestId('harness-heading')).toBeVisible();

    await page.getByTestId('harness-uncaught-error').click();

    await expect
      .poll(() => captured.length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const event = captured[0];

    // Every field the relay requires must be present and non-empty.
    expect(event.environment).toBeTruthy();
    expect(event.release).toBeTruthy();
    expect(event.route).toBeTruthy();
    expect(event.operation).toBeTruthy();
    expect(event.timestamp).toBeTruthy();

    // The build identifier: the dev server was started with a synthetic
    // VERCEL_GIT_COMMIT_SHA and no explicit VITE_RELEASE_TAG, so this is
    // the exact production resolution path. It must NOT be the literal
    // 'dev' — that is the defect the QA verifier found in live rows.
    expect(event.release).toBe(TELEMETRY_E2E_COMMIT_SHA);
    expect(event.release).not.toBe('dev');

    // The exception message is retained in redacted form.
    expect(event.message ?? '').toContain('gymtrack-browser-error-telemetry');
  });

  test('AC1: an authentication failure is exported with safe provider context', async ({ page }) => {
    const captured = await captureRelay(page);

    await page.goto(HARNESS_PATH);
    await page.getByTestId('harness-auth-failure').click();

    await expect
      .poll(() => captured.length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const event = captured[0];
    expect(event.source).toBe('auth');
    expect(event.provider).toBe('clerk');
    expect(event.operation).toBe('signin');
    expect(event.errorCode).toBeTruthy();
    expect(event.release).toBe(TELEMETRY_E2E_COMMIT_SHA);
    expect(event.release).not.toBe('dev');
  });

  test('AC3: a blocked relay does not break page rendering or navigation', async ({ page }) => {
    // Simulate the relay being unreachable.
    await page.route(RELAY_GLOB, async (route) => {
      await route.abort('failed');
    });

    await page.goto(HARNESS_PATH);
    await expect(page.getByTestId('harness-heading')).toBeVisible();

    // The auth-failure button still works — reporting a failure must not
    // throw out of the caller.
    await page.getByTestId('harness-auth-failure').click();
    await expect(page.getByTestId('harness-status')).toHaveText('auth-failure-reported');

    // An uncaught exception with the relay blocked does not tear the page
    // down either.
    await page.getByTestId('harness-uncaught-error').click();
    await expect(page.getByTestId('harness-heading')).toBeVisible();

    // Navigation still works with the relay dead.
    await page.getByTestId('harness-nav-link').click();
    await expect(page.getByTestId('harness-page')).toHaveText('page-two');
    await expect(page.getByTestId('harness-heading')).toBeVisible();
  });
});

test.describe('GymTrack — browser error telemetry (live app)', () => {
  test.skip(!TELEMETRY_E2E_ENABLED, 'GT_TELEMETRY_E2E=1 not set — telemetry suite skipped');
  test.skip(
    !CLERK_GATE,
    'CLERK_TEST_URL / CLERK_TEST_EMAIL / CLERK_TEST_PASSWORD not set — live auth-failure case skipped'
  );

  test('AC1 + AC3: an authentication failure is exported and still renders inline', async ({ page }) => {
    const captured = await captureRelay(page);

    await page.goto('/login');
    await page.getByTestId('login-email').fill(CLERK_TEST_EMAIL!);
    // Deliberately wrong password: the failure path is what is under test.
    await page.getByTestId('login-password').fill('definitely-not-the-password');
    await page.getByTestId('login-submit').click();

    // AC3: the failure still renders inline exactly as before telemetry
    // existed — the user is not left on a blank page.
    await expect(page.getByTestId('login-error')).toBeVisible();

    // AC1: the failure was exported with safe provider / error context.
    await expect
      .poll(() => captured.length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const authEvent = captured.find((event) => event.source === 'auth');
    expect(authEvent).toBeTruthy();
    expect(authEvent!.provider).toBeTruthy();
    expect(authEvent!.errorCode).toBeTruthy();
    expect(authEvent!.release).toBeTruthy();
    expect(authEvent!.release).not.toBe('dev');
  });
});
