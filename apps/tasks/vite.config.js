import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export function tasksFrameAncestors(shellOrigin = 'http://localhost:5176') {
  return `frame-ancestors ${shellOrigin}`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const shellOrigin = env.VITE_SHELL_ORIGIN || 'http://localhost:5176';
  return {
  plugins: [tailwindcss(), react()],
  server: { headers: { 'Content-Security-Policy': tasksFrameAncestors(shellOrigin) } },
  resolve: {
    alias: {
      '@sindustries/ui/react/styles.css': fileURLToPath(new URL('../../packages/ui/src/react/styles.css', import.meta.url)),
      '@sindustries/ui/react': fileURLToPath(new URL('../../packages/ui/src/react/index.jsx', import.meta.url)),
      '@sindustries/ui/specimen/styles.css': fileURLToPath(new URL('../../packages/ui/src/specimen/styles.css', import.meta.url)),
      '@sindustries/ui/specimen': fileURLToPath(new URL('../../packages/ui/src/specimen/index.jsx', import.meta.url))
    }
  }
  };
});
