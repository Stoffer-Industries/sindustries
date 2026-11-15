/**
 * Behavioural coverage for the tasks-api startup schema preflight
 * (task 20195ce7, AC2 — and the CHANGES_REQUESTED follow-up).
 *
 * `startupLifecycle.test.ts` proves the wiring by string-matching
 * `server.ts`. That catches a removed call and a reordered call, but it
 * does not prove the preflight actually runs on the boot path. This file
 * proves the behaviour: it spawns the real `src/server.ts` against a
 * database whose `TaskApproval` table is missing a column the generated
 * Prisma client selects, and asserts that
 *
 *  - the process exits with code 1,
 *  - the `schema_preflight_failed` payload reaches stderr **in full**,
 *  - and nothing ever listens on the configured port.
 *
 * The stderr assertion is also the regression guard for the truncation
 * bug: Node writes to a pipe asynchronously on macOS, so a
 * `console.error(...)` immediately followed by `process.exit(1)` could cut
 * the payload off mid-write. The child's stderr is a pipe here, exactly
 * like Tilt's and Fly's, and the payload is parsed as JSON — a truncated
 * write would fail to parse.
 *
 * The fixture is a throwaway **database** (not a schema): the service
 * config gate requires `?schema=tasks_api`, so the drifted table has to
 * live in a schema with that exact name. Putting it in its own database
 * keeps the live `tasks_api` table untouched — no dropped column, no
 * ACCESS EXCLUSIVE lock on a table other services are reading. The
 * database is created in `beforeAll` and dropped in `afterAll`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/index.js';
import { expectedColumnsFromDmmf } from '../src/lib/schemaPreflight.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(SERVICE_DIR, 'src/server.ts');

/** Throwaway database holding the drifted `tasks_api.TaskApproval` table. */
const TEST_DB = 'tasks_api_preflight_boot_test';
/** The schema the service config gate requires the datasource to name. */
const TEST_SCHEMA = 'tasks_api';
/** The column the fixture omits — one of the three that caused the 2026-10-23 outage. */
const MISSING_COLUMN = 'verifiedPrHeadSha';
/** The migration directory that adds `MISSING_COLUMN`. */
const MISSING_COLUMN_MIGRATION = '20261022140000_add_qa_approval_evidence_pins';

/**
 * A port outside the 4000/4001 pairings the service guards, so the
 * API-port/DB-port assertion in `server.ts` does not apply and the test
 * never collides with a running local stack.
 */
const SERVER_PORT = 45987;

const CHILD_TIMEOUT_MS = 60_000;

const baseUrl = new URL(process.env.DATABASE_URL as string);

/** Admin URL — same server, the `postgres` maintenance database. */
const adminUrl = new URL(baseUrl.toString());
adminUrl.pathname = '/postgres';
adminUrl.searchParams.set('schema', 'public');

/** The drifted datasource the spawned server is pointed at. */
const driftedUrl = new URL(baseUrl.toString());
driftedUrl.pathname = `/${TEST_DB}`;
driftedUrl.searchParams.set('schema', TEST_SCHEMA);

const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });

function resolveTsxBinary(): string {
  const candidates = [
    path.resolve(SERVICE_DIR, '../../node_modules/.bin/tsx'),
    path.resolve(SERVICE_DIR, 'node_modules/.bin/tsx')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find the tsx binary. Looked in: ${candidates.join(', ')}`);
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `src/server.ts` against the drifted schema and collect its output.
 * The child's stdout/stderr are pipes — the exact condition under which
 * Node's asynchronous pipe writes could truncate a `console.error` payload.
 */
function spawnServerAgainstDriftedSchema(): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTsxBinary(), [SERVER_ENTRY], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(SERVER_PORT),
        DATABASE_URL: driftedUrl.toString(),
        X_CLIENT: 'fake',
        CONTENT_SCHEDULER_JOB_ADAPTER: 'in-process',
        OTEL_SDK_DISABLED: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`tasks-api did not exit within ${CHILD_TIMEOUT_MS}ms. stderr so far:\n${stderr}`)
      );
    }, CHILD_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** True when something accepts a TCP connection on `port`. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB}"`);

  const drifted = new PrismaClient({ datasources: { db: { url: driftedUrl.toString() } } });
  try {
    await drifted.$executeRawUnsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);

    // Same column set as the generated client, minus one — everything the
    // preflight checks is derived from the DMMF, so the fixture stays in
    // sync with schema.prisma automatically.
    const columnDefs = expectedColumnsFromDmmf()
      .filter((column) => column.name !== MISSING_COLUMN)
      .map((column) => `"${column.name}" TEXT`)
      .join(', ');

    await drifted.$executeRawUnsafe(`CREATE TABLE "${TEST_SCHEMA}"."TaskApproval" (${columnDefs})`);
  } finally {
    await drifted.$disconnect();
  }
});

afterAll(async () => {
  try {
    // The spawned server may still hold a connection to the throwaway
    // database; terminate it before dropping the database.
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  } finally {
    await admin.$disconnect();
  }
});

describe('tasks-api startup preflight — behavioural (AC2)', () => {
  it('refuses to boot on a drifted schema, reporting the missing column on stderr', async () => {
    const result = await spawnServerAgainstDriftedSchema();

    // Fails closed: non-zero exit, no listener.
    expect(result.code, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.signal).toBeNull();

    // The payload is present, and it is the structured preflight failure.
    expect(result.stderr).toContain('schema_preflight_failed');
    expect(result.stderr).toContain(MISSING_COLUMN);
    expect(result.stderr).toContain(MISSING_COLUMN_MIGRATION);
    expect(result.stderr).toContain('npm run prisma:migrate');

    // The payload is COMPLETE, not truncated: a `console.error` write that
    // was cut off by `process.exit(1)` would not parse as JSON.
    const payload = JSON.parse(result.stderr) as {
      level?: string;
      event?: string;
      service?: string;
      message?: string;
    };
    expect(payload.event).toBe('schema_preflight_failed');
    expect(payload.level).toBe('fatal');
    expect(payload.service).toBe('tasks-api');
    expect(payload.message).toContain(MISSING_COLUMN);

    // Nothing ever listened on the port.
    await expect(canConnect(SERVER_PORT)).resolves.toBe(false);
  }, CHILD_TIMEOUT_MS);
});
