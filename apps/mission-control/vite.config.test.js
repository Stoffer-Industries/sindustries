import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainStateApi } from './brainStateApi.js';

// Minimal in-memory fake of the subset of Vite's dev-server middleware API
// that brainStateApi touches. We deliberately avoid pulling in vite itself
// so the test stays fast and does not need a Vite dev server to boot.
function createFakeServer() {
  const middlewares = [];
  const httpServerListeners = {};
  return {
    middlewares: {
      use(path, handler) {
        middlewares.push({ path, handler });
      }
    },
    httpServer: {
      once(event, listener) {
        httpServerListeners[event] = listener;
      },
      _fireClose() {
        httpServerListeners.close?.();
      }
    },
    _handlers: middlewares
  };
}

function getHandler(server, routePath) {
  const entry = server._handlers.find((h) => h.path === routePath);
  if (!entry) throw new Error(`No handler registered for ${routePath}`);
  return entry.handler;
}

function runHandler(handler, { url = '/', method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = { url, method };
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(key, value) {
        headers[key.toLowerCase()] = value;
      },
      end(body) {
        resolve({
          status: res.statusCode,
          headers,
          body
        });
      }
    };
    handler(req, res);
  });
}

function makePoolMock({ rows = [], rejectWith = null, end = vi.fn().mockResolvedValue(undefined) } = {}) {
  const query = rejectWith
    ? vi.fn().mockRejectedValue(rejectWith)
    : vi.fn().mockResolvedValue({ rows });
  return vi.fn().mockImplementation(function PoolImpl() {
    return {
      query,
      end
    };
  });
}

function makeJsonlFixture(workspaceRoot, events) {
  // The plugin resolves the brain root to `${workspaceRoot}/brain`, so the
  // JSONL fixture lives at `${workspaceRoot}/brain/state/...`.
  const stateDir = path.join(workspaceRoot, 'brain', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'bookmark-transitions.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(stateDir, 'bookmark-review-state.json'),
    JSON.stringify({ version: 1, items: { a: { title: 'A' } } })
  );
}

describe('brainStateApi (/api/transitions Postgres wiring)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
  let workspaceRoot;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-state-api-test-'));
    process.env.WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('queries analytics.bookmark_transitions through pg and normalises rows to the existing event contract', async () => {
    process.env.DATABASE_URL = 'postgres://example/test';
    const logger = { warn: vi.fn() };
    const rows = [
      {
        id: 2,
        occurred_at: new Date('2026-08-02T00:00:00.000Z'),
        bookmark_key: 'b',
        from_status: 'pending',
        to_status: 'summarized',
        actor: 'curate.py',
        payload: { at: '2026-08-02T00:00:00.000Z', reason: 'high-signal' }
      },
      {
        id: 1,
        occurred_at: new Date('2026-08-01T00:00:00.000Z'),
        bookmark_key: 'a',
        from_status: null,
        to_status: 'spec_requested',
        actor: null,
        payload: {}
      }
    ];
    const Pool = makePoolMock({ rows });
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool }, logger }).configureServer(server);

    const handler = getHandler(server, '/api/transitions');
    const response = await runHandler(handler);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    const sentSql = Pool.mock.results[0].value.query.mock.calls[0][0];
    expect(sentSql).toMatch(/FROM analytics\.bookmark_transitions/);
    expect(sentSql).toMatch(/ORDER BY occurred_at ASC, id ASC/);
    expect(response.body).toBe(
      JSON.stringify([
        {
          key: 'b',
          from: 'pending',
          to: 'summarized',
          at: '2026-08-02T00:00:00.000Z',
          actor: 'curate.py',
          reason: 'high-signal'
        },
        {
          key: 'a',
          from: null,
          to: 'spec_requested',
          at: '2026-08-01T00:00:00.000Z',
          actor: null,
          reason: ''
        }
      ])
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to the JSONL log when DATABASE_URL is unset', async () => {
    // DATABASE_URL stays deleted in beforeEach.
    makeJsonlFixture(workspaceRoot, [
      { key: 'a', from: 'pending', to: 'summarized', at: '2026-08-01T00:00:00Z' }
    ]);
    const Pool = makePoolMock();
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool } }).configureServer(server);

    const handler = getHandler(server, '/api/transitions');
    const response = await runHandler(handler);

    expect(response.status).toBe(200);
    expect(Pool).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toEqual([
      { key: 'a', from: 'pending', to: 'summarized', at: '2026-08-01T00:00:00Z' }
    ]);
  });

  it('falls back to the JSONL log and logs a warning when the pool query rejects', async () => {
    process.env.DATABASE_URL = 'postgres://example/test';
    makeJsonlFixture(workspaceRoot, [
      { key: 'a', from: 'pending', to: 'spec_requested', at: '2026-08-01T00:00:00Z' }
    ]);
    const logger = { warn: vi.fn() };
    const Pool = makePoolMock({ rejectWith: new Error('connection refused') });
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool }, logger }).configureServer(server);

    const handler = getHandler(server, '/api/transitions');
    const response = await runHandler(handler);

    expect(response.status).toBe(200);
    expect(Pool).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Postgres transitions unavailable/));
    expect(logger.warn.mock.calls[0][0]).toMatch(/connection refused/);
    expect(JSON.parse(response.body)).toEqual([
      { key: 'a', from: 'pending', to: 'spec_requested', at: '2026-08-01T00:00:00Z' }
    ]);
  });

  it('falls back to the JSONL log when the pool query rejects and still calls end() on the pool', async () => {
    process.env.DATABASE_URL = 'postgres://example/test';
    makeJsonlFixture(workspaceRoot, []);
    const end = vi.fn().mockResolvedValue(undefined);
    const Pool = makePoolMock({ rejectWith: new Error('boom'), end });
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool } }).configureServer(server);

    const handler = getHandler(server, '/api/transitions');
    await runHandler(handler);

    expect(Pool).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('keeps /api/state file-backed and never instantiates a pg pool', async () => {
    process.env.DATABASE_URL = 'postgres://example/test';
    makeJsonlFixture(workspaceRoot, []);
    const Pool = makePoolMock();
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool } }).configureServer(server);

    const handler = getHandler(server, '/api/state');
    const response = await runHandler(handler);

    expect(response.status).toBe(200);
    expect(Pool).not.toHaveBeenCalled();
    const parsed = JSON.parse(response.body);
    expect(parsed.items.a.title).toBe('A');
  });

  it('closes the active pg pool when the dev server emits close', async () => {
    process.env.DATABASE_URL = 'postgres://example/test';
    const end = vi.fn().mockResolvedValue(undefined);
    const Pool = makePoolMock({ rows: [], end });
    const server = createFakeServer();
    brainStateApi({ pgClient: { Pool } }).configureServer(server);

    const handler = getHandler(server, '/api/transitions');
    await runHandler(handler);

    expect(end).not.toHaveBeenCalled();
    server.httpServer._fireClose();
    // give the unawaited void promise a microtask to resolve
    await new Promise((resolve) => setImmediate(resolve));
    expect(end).toHaveBeenCalledTimes(1);
  });
});
