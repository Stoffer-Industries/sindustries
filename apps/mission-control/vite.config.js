import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sindustries/ui/react/styles.css': fileURLToPath(new URL('../../packages/ui/src/react/styles.css', import.meta.url)),
      '@sindustries/ui/react': fileURLToPath(new URL('../../packages/ui/src/react/index.jsx', import.meta.url)),
      '@sindustries/ui/specimen/styles.css': fileURLToPath(new URL('../../packages/ui/src/specimen/styles.css', import.meta.url)),
      '@sindustries/ui/specimen': fileURLToPath(new URL('../../packages/ui/src/specimen/index.jsx', import.meta.url))
    }
  }
});
