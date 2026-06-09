import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sindustries/ui/react/styles.css': fileURLToPath(new URL('../../packages/ui/src/react/styles.css', import.meta.url)),
      '@sindustries/ui/react': fileURLToPath(new URL('../../packages/ui/src/react/index.jsx', import.meta.url))
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/*.test.{js,jsx}']
  }
});
