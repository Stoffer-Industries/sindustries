import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { brainStateApi } from './brainStateApi.js';

export default defineConfig({
  plugins: [tailwindcss(), react(), brainStateApi()],
  resolve: {
    alias: {
      '@sindustries/ui/react/styles.css': fileURLToPath(new URL('../../packages/ui/src/react/styles.css', import.meta.url)),
      '@sindustries/ui/react': fileURLToPath(new URL('../../packages/ui/src/react/index.jsx', import.meta.url)),
      '@sindustries/ui/specimen/styles.css': fileURLToPath(new URL('../../packages/ui/src/specimen/styles.css', import.meta.url)),
      '@sindustries/ui/specimen': fileURLToPath(new URL('../../packages/ui/src/specimen/index.jsx', import.meta.url))
    }
  }
});
