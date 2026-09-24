import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/db-integration.test.ts',
      'test/taskAttentionOwnersPositionMove.test.ts',
      'test/dedupeAttentionOwnersScript.test.ts'
    ],
    setupFiles: ['./test/setup.ts']
  }
});
