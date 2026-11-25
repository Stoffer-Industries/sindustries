import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: 'http://127.0.0.1:4173'
  },
  webServer: {
    command:
      'VITE_TASKS_E2E_AUTH_TOKEN=e2e-harness-session-token VITE_TASKS_API_BASE_URL=http://127.0.0.1:4000/api/v1 npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: true,
    cwd: '.'
  }
});
