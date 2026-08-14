import { defineConfig } from 'vitest/config';

const defaultDevDatabaseUrl = 'postgresql://postgres:postgres@localhost:6432/sindustries_dev?schema=tasks_api';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/db-integration.test.ts'],
    env: {
      DATABASE_URL: process.env.DATABASE_URL || defaultDevDatabaseUrl
    },
    // Load the same setup.ts as the unit-test config so the
    // TASKS_API_APPROVAL_SERVICE_CREDENTIALS seeded for authedRequest()
    // (task 0719a8e3) is available to integration tests too.
    // setup.ts uses `??` for DATABASE_URL so the dev DB set above wins.
    setupFiles: ['./test/setup.ts']
  }
});
