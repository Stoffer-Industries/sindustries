import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Dev-only Vite plugin that serves the workspace's bookmark state files
 * on `/api/state`, `/api/transitions`, and `/api/compounding-signal`.
 *
 * Transition source preference (task 5c87ea16):
 *   - When `DATABASE_URL` is set and Postgres is reachable, `/api/transitions`
 *     reads from `analytics.bookmark_transitions` and normalizes each row
 *     into the existing event contract.
 *   - When `DATABASE_URL` is unset, the connection fails, or the query
 *     rejects, `/api/transitions` falls back to the existing JSONL log so
 *     local development never depends on database availability.
 *
 * `/api/state` and `/api/compounding-signal` remain file-backed because
 * snapshot state and the derived signal have not migrated to Postgres.
 *
 * Workspace root resolution (in priority order):
 *   1. `WORKSPACE_ROOT` env var (set by the Tiltfile / dev scripts)
 *   2. Three levels up from this config (sindustries/.. -> workspace/)
 *
 * In production (`vite build`) the plugin is a no-op; the endpoints 404
 * and the tab renders an empty state.
 */
export function brainStateApi({
  pgClient = null,
  logger = console
} = {}) {
  function resolveBrainRoot() {
    const explicit = process.env.WORKSPACE_ROOT;
    if (explicit) return path.resolve(explicit, 'brain');
    // apps/mission-control/brainStateApi.js -> ../../../.. = workspace root
    return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..', 'brain');
  }

  function readJsonlFallback(transitionsPath) {
    if (!fs.existsSync(transitionsPath)) return [];
    return fs
      .readFileSync(transitionsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  function rowToEvent(row) {
    if (!row || typeof row !== 'object') return null;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const occurredAt =
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : row.occurred_at ?? null;
    const at = payload.at ?? occurredAt;
    return {
      key: row.bookmark_key ?? null,
      from: row.from_status ?? null,
      to: row.to_status ?? null,
      at,
      actor: row.actor ?? null,
      reason: payload.reason ?? ''
    };
  }

  async function loadTransitionsFromPostgres(transitionsPath, databaseUrl) {
    let PoolCtor;
    let pool = null;
    try {
      if (pgClient) {
        // pgClient is a { Pool: Ctor } object supplied by tests; this keeps the
        // production code free of `require('pg')` at module load time and gives
        // the test suite a deterministic seam to assert on.
        PoolCtor = pgClient.Pool;
        pool = new PoolCtor({ connectionString: databaseUrl, max: 1 });
      } else {
        const pg = await import('pg');
        PoolCtor = pg.Pool;
        pool = new PoolCtor({ connectionString: databaseUrl, max: 1 });
      }
      const result = await pool.query(
        'SELECT id, occurred_at, bookmark_key, from_status, to_status, actor, payload '
          + 'FROM analytics.bookmark_transitions '
          + 'ORDER BY occurred_at ASC, id ASC'
      );
      const events = (result.rows ?? [])
        .map(rowToEvent)
        .filter((event) => event !== null);
      return { events, pool };
    } catch (err) {
      if (pool && typeof pool.end === 'function') {
        try { await pool.end(); } catch { /* swallow */ }
      }
      logger.warn?.(
        `[brain-state-api] Postgres transitions unavailable, falling back to JSONL: ${err?.message ?? 'unknown error'}`
      );
      return { events: readJsonlFallback(transitionsPath), pool: null };
    }
  }

  return {
    name: 'brain-state-api',
    configureServer(server) {
      const brainRoot = resolveBrainRoot();
      const statePath = path.join(brainRoot, 'state', 'bookmark-review-state.json');
      const transitionsPath = path.join(brainRoot, 'state', 'bookmark-transitions.jsonl');
      const signalPath = path.join(brainRoot, 'state', 'compounding-signal.json');

      let activePool = null;
      const closeActivePool = async () => {
        if (activePool && typeof activePool.end === 'function') {
          try { await activePool.end(); } catch { /* swallow */ }
        }
        activePool = null;
      };

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

      server.middlewares.use('/api/transitions', async (_req, res) => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          try {
            const rows = readJsonlFallback(transitionsPath);
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.statusCode = 200;
            res.end(JSON.stringify(rows));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err?.message ?? 'unknown' }));
          }
          return;
        }
        try {
          const { events, pool } = await loadTransitionsFromPostgres(transitionsPath, databaseUrl);
          if (pool) activePool = pool;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(JSON.stringify(events));
        } catch (err) {
          // Pool creation or query failed inside loadTransitionsFromPostgres and
          // already returned JSONL fallback events — but a serialization bug
          // could still throw. Surface it as 500 to match the existing pattern.
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message ?? 'unknown' }));
        }
      });

      // Compounding signal is a derived artifact. A missing file is a normal
      // state (the artifact only exists after the first weekly run) and 404s
      // here so the client can distinguish "no data yet" from a malformed
      // payload. A malformed payload is a 500 so the client can show the
      // "malformed" placeholder without crashing Vite.
      server.middlewares.use('/api/compounding-signal', (_req, res) => {
        try {
          if (!fs.existsSync(signalPath)) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'compounding-signal.json missing' }));
            return;
          }
          const body = fs.readFileSync(signalPath, 'utf8');
          try {
            JSON.parse(body);
          } catch (parseErr) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: `compounding-signal.json malformed: ${parseErr?.message ?? 'parse error'}` }));
            return;
          }
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(body);
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message ?? 'unknown' }));
        }
      });

      // Close the lazy pg pool when the dev server shuts down to avoid
      // leaked handles across local restarts and Vitest runs.
      const closeHook = () => { void closeActivePool(); };
      server.httpServer?.once?.('close', closeHook);
    }
  };
}
