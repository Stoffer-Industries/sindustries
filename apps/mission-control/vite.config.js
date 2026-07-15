import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Dev-only Vite plugin that serves the workspace's bookmark state files
 * on `/api/state` and `/api/transitions`. Mirrors what
 * `tools/bookmark-dashboard/serve.py` does so the Bookmarks tab can
 * `fetch('/api/state')` instead of running a separate dashboard server.
 *
 * Workspace root resolution (in priority order):
 *   1. `WORKSPACE_ROOT` env var (set by the Tiltfile / dev scripts)
 *   2. Three levels up from this config (sindustries/.. -> workspace/)
 *
 * In production (`vite build`) the plugin is a no-op; the endpoints 404
 * and the tab renders an empty state.
 */
function brainStateApi() {
  function resolveBrainRoot() {
    const explicit = process.env.WORKSPACE_ROOT;
    if (explicit) return path.resolve(explicit, 'brain');
    // apps/mission-control/vite.config.js -> ../../../.. = workspace root (codebases/sindustries/apps/mission-control -> workspace)
    return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..', 'brain');
  }

  return {
    name: 'brain-state-api',
    configureServer(server) {
      const brainRoot = resolveBrainRoot();
      const statePath = path.join(brainRoot, 'state', 'bookmark-review-state.json');
      const transitionsPath = path.join(brainRoot, 'state', 'bookmark-transitions.jsonl');

      server.middlewares.use('/api/state', (_req, res) => {
        try {
          const body = fs.existsSync(statePath)
            ? fs.readFileSync(statePath, 'utf8')
            : JSON.stringify({ version: 1, items: {} });
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(body);
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message ?? 'unknown' }));
        }
      });

      server.middlewares.use('/api/transitions', (_req, res) => {
        try {
          const rows = fs.existsSync(transitionsPath)
            ? fs
                .readFileSync(transitionsPath, 'utf8')
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line))
            : [];
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(JSON.stringify(rows));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message ?? 'unknown' }));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), brainStateApi()],
  resolve: {
    alias: {
      '@sindustries/ui/react/styles.css': fileURLToPath(new URL('../../packages/ui/src/react/styles.css', import.meta.url)),
      '@sindustries/ui/react': fileURLToPath(new URL('../../packages/ui/src/react/index.jsx', import.meta.url)),
      '@sindustries/ui/specimen/styles.css': fileURLToPath(new URL('../../packages/ui/src/specimen/styles.css', import.meta.url)),
      '@sindustries/ui/specimen': fileURLToPath(new URL('../../packages/ui/src/specimen/index.jsx', import.meta.url))
    }
  }
});