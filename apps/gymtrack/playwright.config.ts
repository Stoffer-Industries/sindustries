import { defineConfig, devices } from '@playwright/test';

// Playwright config for GymTrack e2e. iPhone 13 emulation covers AC1 (mobile-first UI).
export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5179',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'npm run dev',
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