import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    // api/ is covered too — the Vercel relay (`api/telemetry.js`) is the
    // trust boundary in front of the hosted Grafana credentials, so its
    // token check, rate limit, redaction, and size caps are asserted in
    // `api/telemetry.test.js` under the `node` environment.
    include: [
      'src/**/*.test.{js,jsx}',
      'api/**/*.test.{js,jsx}',
      // The Grafana dashboard ships next to the app it visualizes, and
      // its LogQL selectors are a contract with the relay — the
      // dashboard-contract test asserts both halves line up.
      'grafana/**/*.test.{js,jsx}',
      // Playwright's own specs live in `test/e2e` and are matched by
      // `*.spec.ts`, so they are not picked up here. `test/unit` holds
      // plain unit tests for the e2e support code itself.
      'test/**/*.test.{ts,tsx}'
    ]
  }
});
