import { defineConfig, devices } from '@playwright/test';
import {
  TELEMETRY_E2E_COMMIT_SHA,
  TELEMETRY_E2E_RELAY_TOKEN
} from './test/e2e/telemetry-env';

/**
 * Playwright config for the **real-application** telemetry resilience suite
 * (task `8c3aa401`).
 *
 * WHY THIS IS A SEPARATE CONFIG AND NOT A PROJECT IN `playwright.config.ts`
 *
 * `playwright.config.ts` derives both the base URL and the dev-server
 * decision from `CLERK_TEST_URL`:
 *
 *     use:       { baseURL: process.env.CLERK_TEST_URL ?? 'http://localhost:5179' }
 *     webServer: process.env.CLERK_TEST_URL ? undefined : { … }
 *
 * So when `CLERK_TEST_URL` is set — and it IS set in the agent runtime,
 * pointing at the live production app `https://gymtrack.sindustries.co.nz` —
 * that config drives the **production app** and never starts a local dev
 * server. That is correct for the credentialed Clerk suite, which is meant
 * to run against the deployed app.
 *
 * This suite is the opposite: it is **credential-free** by construction and
 * must prove the resilience claim against a local build whose identity
 * provider HTTP boundary is stubbed by Playwright. If it inherited the
 * `CLERK_TEST_URL` branch, it would silently drive production and send real
 * sign-in attempts to the live identity provider — which is exactly what
 * happened when the first spike reused `playwright.config.ts`.
 *
 * The isolation here is therefore **structural, not conditional**:
 *
 *   - `baseURL` is a hard-coded literal. There is no environment variable
 *     that can point this suite at a deployed app.
 *   - `webServer` is unconditionally defined, so the suite always runs
 *     against a local build it started itself.
 *   - `reuseExistingServer` is `false`, so a dev server left running on
 *     port 5179 by another worktree can never be silently reused. A stale
 *     server would be a build with an unknown provider and an unknown
 *     telemetry flag, and the suite would then prove something other than
 *     what it claims. Failing loudly is the correct outcome.
 *
 * The provider under test is pinned explicitly (`VITE_AUTH_PROVIDER=supabase`)
 * on the dev-server command rather than inferred from `getActiveProvider()`'s
 * default, so the build under test states which identity provider it uses.
 */

export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'telemetry-real-app.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    // Literal, not derived from the environment. See the note above.
    baseURL: 'http://localhost:5179',
    trace: 'on-first-retry'
  },
  webServer: {
    // The telemetry suite needs a build with telemetry enabled and with
    // build-time release metadata, so the browser resolves `release` the
    // same way a Vercel production build does. The relay is intercepted by
    // the test — nothing leaves the machine.
    //
    // `TELEMETRY_E2E_COMMIT_SHA` is validated against a SHA-like hex shape
    // in `test/e2e/telemetry-env.ts` (it is interpolated into this shell
    // command, so a metacharacter could otherwise alter it). The quotes are
    // defence in depth on top of that validation.
    command:
      `VITE_TELEMETRY_ENABLED=1 VITE_TELEMETRY_TOKEN=${TELEMETRY_E2E_RELAY_TOKEN} ` +
      `VERCEL_GIT_COMMIT_SHA="${TELEMETRY_E2E_COMMIT_SHA}" ` +
      // `src/lib/supabase.js` throws at import time when these are unset,
      // so the app renders nothing. The suite never talks to a real
      // Supabase — the placeholder host is unresolvable and every request
      // to it is intercepted by the test.
      `VITE_SUPABASE_URL=https://telemetry-e2e.invalid ` +
      `VITE_SUPABASE_ANON_KEY=telemetry-e2e-placeholder-key ` +
      `VITE_AUTH_PROVIDER=supabase ` +
      `npm run dev`,
    url: 'http://localhost:5179',
    reuseExistingServer: false,
    timeout: 60_000
  },
  projects: [
    {
      name: 'real-app-mobile-safari',
      use: { ...devices['iPhone 13'] }
    }
  ]
});
