import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// GymTrack is a standalone SPA. Port 5179 keeps it clear of the other
// Vite apps in this repo (5173, 5174, 5175). Preview runs on 4179.
export default defineConfig({
  plugins: [react()],
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