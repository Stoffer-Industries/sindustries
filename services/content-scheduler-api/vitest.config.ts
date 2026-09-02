import { defineConfig } from 'vitest/config';

// Vitest config for content-scheduler-api.
//
// We pin the test runner to Node (the package's only runtime is Node
// 22+), and we register test/setup.ts as a global setupFiles entry so
// the integration-test service credential is present in process.env
// before any test file imports `../src/app.ts` (the auth middleware
// parses the env var at module-load time).
//
// Task: bd755ad4-314e-410d-84ec-0083178a7ea2 (W36 audit A1).
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts']
  }
});
