import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5183,
    strictPort: true
  },
  preview: {
    port: 5184,
    strictPort: true
  }
});
