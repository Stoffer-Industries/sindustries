import { defineConfig, devices } from '@playwright/test';
import {
  TELEMETRY_E2E_COMMIT_SHA,
  TELEMETRY_E2E_ENABLED,
  TELEMETRY_E2E_RELAY_TOKEN
} from './test/e2e/telemetry-env';

/**
 * Playwright config for GymTrack e2e. iPhone 13 emulation covers AC1 (mobile-first UI).
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.CLERK_TEST_URL ?? 'http://localhost:5179',
    trace: 'on-first-retry'
  },
  webServer: process.env.CLERK_TEST_URL
    ? undefined
    : {
        // The telemetry suite (task e89db27f) needs a build with telemetry
        // enabled and with build-time release metadata, so the browser
        // resolves `release` the same way a Vercel production build does.
        // The relay is intercepted by the test — nothing leaves the machine.
        // `TELEMETRY_E2E_COMMIT_SHA` is validated against a SHA-like hex
        // shape in `test/e2e/telemetry-env.ts` (it is interpolated into this
        // shell command, so a metacharacter could otherwise alter it). The
        // quotes are defence in depth on top of that validation.
        command: TELEMETRY_E2E_ENABLED
          ? `VITE_TELEMETRY_ENABLED=1 VITE_TELEMETRY_TOKEN=${TELEMETRY_E2E_RELAY_TOKEN} ` +
            `VERCEL_GIT_COMMIT_SHA="${TELEMETRY_E2E_COMMIT_SHA}" ` +
            // `src/lib/supabase.js` throws at import time when these are
            // unset, so the app renders nothing. The telemetry suite never
            // talks to Supabase — placeholders are enough to mount the UI.
            `VITE_SUPABASE_URL=https://telemetry-e2e.invalid ` +
            `VITE_SUPABASE_ANON_KEY=telemetry-e2e-placeholder-key ` +
            `npm run dev`
          : 'npm run dev',
        url: 'http://localhost:5179',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
      },
  projects: [
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] }
    }
  ]
});
