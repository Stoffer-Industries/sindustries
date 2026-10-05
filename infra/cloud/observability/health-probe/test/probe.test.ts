import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configFromEnv,
  parseDbTargets,
  parseHttpTargets,
  parseRedisTargets,
  probeDb,
  probeFlyApp,
  probeRedis,
  runProbe,
} from '../src/probe.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDbTargets', () => {
  it('parses a single target', () => {
    expect(
      parseDbTargets('tasks-api=postgres://u:p@h:5432/db'),
    ).toEqual([
      { app: 'tasks-api', connectionString: 'postgres://u:p@h:5432/db' },
    ]);
  });

  it('parses multiple comma-separated targets', () => {
    expect(
      parseDbTargets(
        'tasks-api=postgres://u:p@h:5432/db,budget-api=postgres://u:p@h:5432/budget',
      ),
    ).toEqual([
      { app: 'tasks-api', connectionString: 'postgres://u:p@h:5432/db' },
      { app: 'budget-api', connectionString: 'postgres://u:p@h:5432/budget' },
    ]);
  });

  it('skips empty entries and malformed lines', () => {
    expect(
      parseDbTargets(
        ',tasks-api=postgres://u:p@h:5432/db,no-equals,=missing-app,app-without-url=',
      ),
    ).toEqual([
      { app: 'tasks-api', connectionString: 'postgres://u:p@h:5432/db' },
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseDbTargets('')).toEqual([]);
  });
});

describe('parseHttpTargets', () => {
  it('parses a single Fly app health URL', () => {
    expect(
      parseHttpTargets('tasks-api=https://sindustries-tasks-api.fly.dev/health'),
    ).toEqual([
      {
        app: 'tasks-api',
        url: 'https://sindustries-tasks-api.fly.dev/health',
      },
    ]);
  });

  it('parses multiple Fly app health URLs', () => {
    expect(
      parseHttpTargets(
        'tasks-api=https://a.fly.dev/health,budget-api=https://b.fly.dev/health',
      ),
    ).toHaveLength(2);
  });

  it('skips malformed entries', () => {
    expect(
      parseHttpTargets('=https://a.fly.dev/health,app-without-url='),
    ).toEqual([]);
  });
});

describe('parseRedisTargets', () => {
  it('parses a single Redis URL', () => {
    expect(
      parseRedisTargets(
        'content-scheduler=rediss://default:pw@host:6379',
      ),
    ).toEqual([
      { app: 'content-scheduler', url: 'rediss://default:pw@host:6379' },
    ]);
  });
});

describe('configFromEnv', () => {
  it('reads HEALTH_PROBE_* env vars into typed targets', () => {
    const env = {
      HEALTH_PROBE_DATABASES:
        'tasks-api=postgres://u@h/db,budget-api=postgres://u@h/budget',
      HEALTH_PROBE_FLY_APPS:
        'tasks-api=https://t.fly.dev/health,budget-api=https://b.fly.dev/health',
      HEALTH_PROBE_REDIS: 'content-scheduler=rediss://default@host:6379',
      HEALTH_PROBE_TIMEOUT_MS: '7500',
    };
    const cfg = configFromEnv(env);
    expect(cfg.dbs).toHaveLength(2);
    expect(cfg.flyApps).toHaveLength(2);
    expect(cfg.redis).toHaveLength(1);
    expect(cfg.timeoutMs).toBe(7500);
  });

  it('returns empty target lists when env vars are unset', () => {
    const cfg = configFromEnv({});
    expect(cfg.dbs).toEqual([]);
    expect(cfg.flyApps).toEqual([]);
    expect(cfg.redis).toEqual([]);
    expect(cfg.timeoutMs).toBeUndefined();
  });
});

describe('probeDb', () => {
  it('returns up=0 with error when the connection fails', async () => {
    const result = await probeDb(
      {
        app: 'tasks-api',
        connectionString: 'postgres://no:no@127.0.0.1:1/no',
      },
      100,
    );
    expect(result.up).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.durationSeconds).toBe(0);
  });
});

describe('probeFlyApp', () => {
  it('returns up=1 on a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const result = await probeFlyApp(
      { app: 'tasks-api', url: 'https://example.test/health' },
      1000,
    );
    expect(result).toEqual({ app: 'tasks-api', up: 1 });
  });

  it('returns up=0 on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const result = await probeFlyApp(
      { app: 'tasks-api', url: 'https://example.test/health' },
      1000,
    );
    expect(result.up).toBe(0);
    expect(result.error).toMatch(/HTTP 503/);
  });

  it('returns up=0 when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    const result = await probeFlyApp(
      { app: 'tasks-api', url: 'https://example.test/health' },
      1000,
    );
    expect(result.up).toBe(0);
    expect(result.error).toMatch(/connection refused/);
  });
});

describe('probeRedis', () => {
  it('returns up=0 with error when the connection fails', async () => {
    const result = await probeRedis(
      { app: 'content-scheduler', url: 'rediss://127.0.0.1:1' },
      100,
    );
    expect(result.up).toBe(0);
    expect(result.error).toBeDefined();
  });
});

describe('runProbe', () => {
  it('returns a ProbeResult with empty arrays when no targets are configured', async () => {
    const result = await runProbe({
      dbs: [],
      flyApps: [],
      redis: [],
      timeoutMs: 100,
    });
    expect(result).toEqual({
      timestamp: expect.any(Number),
      db: [],
      fly: [],
      redis: [],
    });
  });

  it('continues probing other targets when one fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const result = await runProbe({
      dbs: [
        { app: 'broken', connectionString: 'postgres://no:no@127.0.0.1:1/no' },
      ],
      flyApps: [
        { app: 'tasks-api', url: 'https://example.test/health' },
      ],
      redis: [
        { app: 'broken-redis', url: 'rediss://127.0.0.1:1' },
      ],
      timeoutMs: 100,
    });
    expect(result.db[0]?.up).toBe(0);
    expect(result.fly[0]).toEqual({ app: 'tasks-api', up: 1 });
    expect(result.redis[0]?.up).toBe(0);
  });
});
