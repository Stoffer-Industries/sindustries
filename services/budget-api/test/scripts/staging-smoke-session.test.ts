import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so vi.mock factory can reference them. We mock the prisma
// module the same way dev-login.test.ts does, keeping consistent style.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn()
    },
    session: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn()
    },
    $disconnect: vi.fn()
  }
}));

vi.mock('../../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));

// Capture the CLI invocation by stubbing node:process argv + env in
// beforeEach. We import the module lazily so the global setup runs first.
async function runCli(args: string[], envOverrides: Record<string, string | undefined>) {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  process.argv = ['node', 'staging-smoke-session.ts', ...args];
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Force module re-evaluation so the top-level main() runs again with the
  // new argv. Vitest caches modules; we use vi.resetModules().
  vi.resetModules();
  try {
    // The CLI calls exit() on its own; intercept by stubbing.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw error(`exit:${code ?? 'undefined'}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let caught: unknown = null;
    try {
      await import('../../scripts/staging-smoke-session.js');
    } catch (err) {
      caught = err;
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    return {
      caught,
      stderr: stderrSpy.mock.calls.map((c) => String(c[0])).join(''),
      stdout: stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    };
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
  }
}

// Mock fs operations so the mint mode test can assert the chmod 0600 write
// without touching the filesystem.
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn()
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    writeFileSync: fsMocks.writeFileSync,
    chmodSync: fsMocks.chmodSync,
    unlinkSync: fsMocks.unlinkSync
  };
});

const SYNTHETIC_VALID_URL = 'postgresql://app:pass@db.internal:5432/budget_staging?schema=public';
const SYNTHETIC_PROD_URL = 'postgresql://app:pass@db.internal:5432/budget_production?schema=public';

describe('staging-smoke-session CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('environment guards', () => {
    it('refuses to run without --staging flag', async () => {
      const { caught, stderr } = await runCli(['mint', '--token-out', '/tmp/x'], {
        BUDGET_STAGING_ENVIRONMENT: 'staging',
        DATABASE_URL: SYNTHETIC_VALID_URL
      });
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('--staging flag required');
      expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses to run without BUDGET_STAGING_ENVIRONMENT=staging', async () => {
      const { caught, stderr } = await runCli(
        ['mint', '--staging', '--token-out', '/tmp/x'],
        {
          BUDGET_STAGING_ENVIRONMENT: undefined,
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('BUDGET_STAGING_ENVIRONMENT must be set to');
      expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a DATABASE_URL that smells like production', async () => {
      const { caught, stderr } = await runCli(
        ['mint', '--staging', '--token-out', '/tmp/x'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_PROD_URL
        }
      );
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('strongly suggests a production/main database');
      expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('mint mode', () => {
    it('refuses a non-synthetic email', async () => {
      const { caught, stderr } = await runCli(
        [
          'mint',
          '--staging',
          '--email',
          'user@example.com',
          '--token-out',
          '/tmp/x'
        ],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('requires a synthetic email ending in @sindustries.invalid');
    });

    it('refuses to overwrite an existing token-out path', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      const { caught, stderr } = await runCli(
        ['mint', '--staging', '--token-out', '/tmp/x'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('refusing to overwrite existing file');
    });

    it('mints a session, writes the token at mode 0600, and returns JSON', async () => {
      fsMocks.existsSync.mockReturnValue(false);
      mocks.prisma.user.findUnique.mockResolvedValue(null);
      mocks.prisma.user.create.mockResolvedValue({
        id: 'user_smoke_1',
        email: 'staging-smoke+test@sindustries.invalid'
      });
      mocks.prisma.session.create.mockResolvedValue({ id: 'session_smoke_1' });

      const { caught, stdout } = await runCli(
        ['mint', '--staging', '--json', '--token-out', '/tmp/smoke-token'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );

      expect(caught).toBeNull();
      expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
      expect(fsMocks.writeFileSync.mock.calls[0]?.[2]).toEqual({ mode: 0o600 });
      expect(fsMocks.chmodSync).toHaveBeenCalledWith('/tmp/smoke-token', 0o600);

      const parsed = JSON.parse(stdout) as {
        mode: string;
        userId: string;
        sessionId: string;
        email: string;
      };
      expect(parsed.mode).toBe('mint');
      expect(parsed.userId).toBe('user_smoke_1');
      expect(parsed.sessionId).toBe('session_smoke_1');
      expect(parsed.email.endsWith('@sindustries.invalid')).toBe(true);
      // The token itself must NOT appear in stdout.
      expect(stdout).not.toMatch(/[a-f0-9]{48}/);
    });
  });

  describe('revoke mode', () => {
    it('requires an identifier', async () => {
      const { caught, stderr } = await runCli(['revoke', '--staging'], {
        BUDGET_STAGING_ENVIRONMENT: 'staging',
        DATABASE_URL: SYNTHETIC_VALID_URL
      });
      expect(String(caught)).toContain('exit:1');
      expect(stderr).toContain('--email, --user-id, or --session-id');
    });

    it('deletes the user and cascade-deletes the sessions', async () => {
      mocks.prisma.user.findUnique.mockResolvedValue({ id: 'user_smoke_1' });
      mocks.prisma.session.deleteMany.mockResolvedValue({ count: 1 });
      mocks.prisma.user.deleteMany.mockResolvedValue({ count: 1 });

      const { caught, stdout } = await runCli(
        ['revoke', '--staging', '--email', 'staging-smoke+test@sindustries.invalid'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );

      expect(caught).toBeNull();
      const parsed = JSON.parse(stdout) as {
        mode: string;
        deletedUsers: number;
        deletedSessions: number;
      };
      expect(parsed.mode).toBe('revoke');
      expect(parsed.deletedUsers).toBe(1);
      expect(parsed.deletedSessions).toBe(1);
    });
  });

  describe('reconcile mode', () => {
    it('dry-run reports matches without deleting', async () => {
      mocks.prisma.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'staging-smoke+a@sindustries.invalid' },
        { id: 'u2', email: 'staging-smoke+b@sindustries.invalid' }
      ]);

      const { caught, stdout } = await runCli(
        ['reconcile', '--staging', '--dry-run', '--json'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );

      expect(caught).toBeNull();
      const parsed = JSON.parse(stdout) as {
        mode: string;
        dryRun: boolean;
        matchedUsers: number;
        deletedUsers: number;
      };
      expect(parsed.mode).toBe('reconcile');
      expect(parsed.dryRun).toBe(true);
      expect(parsed.matchedUsers).toBe(2);
      expect(parsed.deletedUsers).toBe(0);
      expect(mocks.prisma.user.deleteMany).not.toHaveBeenCalled();
    });

    it('non-dry-run deletes matched users and their sessions', async () => {
      mocks.prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'staging-smoke+a@sindustries.invalid' }]);
      mocks.prisma.session.deleteMany.mockResolvedValue({ count: 1 });
      mocks.prisma.user.deleteMany.mockResolvedValue({ count: 1 });

      const { caught, stdout } = await runCli(
        ['reconcile', '--staging', '--json'],
        {
          BUDGET_STAGING_ENVIRONMENT: 'staging',
          DATABASE_URL: SYNTHETIC_VALID_URL
        }
      );

      expect(caught).toBeNull();
      const parsed = JSON.parse(stdout) as {
        deletedUsers: number;
        deletedSessions: number;
      };
      expect(parsed.deletedUsers).toBe(1);
      expect(parsed.deletedSessions).toBe(1);
    });
  });
});

// Helper used by runCli to throw inside an exit override. We re-export the
// shape expected by the spy.
function error(message: string): Error {
  const e = new Error(message);
  return e;
}