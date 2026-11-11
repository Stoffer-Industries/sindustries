import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// GymTrack is a standalone SPA. Port 5179 keeps it clear of the other
// Vite apps in this repo (5173, 5174, 5175). Preview runs on 4179.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  // `VITE_` is the default prefix. The two extra entries are the only
  // Vercel variables the browser bundle may read: they identify the
  // deployed build so browser telemetry can carry a real `release`
  // instead of a placeholder. Both are build metadata, not secrets.
  // Do NOT widen this to the bare `VERCEL_` prefix — that would expose
  // every Vercel-provided variable to the bundle.
  envPrefix: ['VITE_', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_DEPLOYMENT_ID'],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5179
  },
  preview: {
    port: 4179
  }
});