import 'dotenv/config';
import { createApp } from './app';
import { config, ConfigValidationError } from './config/index.ts';
import { assertTaskApprovalSchema } from './lib/schemaPreflight.ts';

// `config` is parsed and frozen at module load. If any required value is
// missing or malformed, the import throws ConfigValidationError after
// logging a structured error line. We can't catch that here (ESM hoists
// static imports), so the process exits with non-zero status via the
// unhandled error. To make the exit explicit, we re-resolve the config
// in a try/catch around the bootstrap.
const { PORT, DATABASE_URL, ALLOW_PORT_DB_MISMATCH } = config;

const ALLOW_PORT_DB_MISMATCH_BOOL = ALLOW_PORT_DB_MISMATCH === '1';

function expectedDbPortForApiPort(apiPort: number): string | null {
  if (apiPort === 4000) return '6432';
  if (apiPort === 4001) return '7432';
  return null;
}

function assertApiPortDbPortPairing(apiPort: number) {
  if (ALLOW_PORT_DB_MISMATCH_BOOL) return;

  const expectedDbPort = expectedDbPortForApiPort(apiPort);
  if (!expectedDbPort) return;

  let dbUrl: URL;
  try {
    dbUrl = new URL(DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }

  const actualDbPort = dbUrl.port || '5432';
  if (actualDbPort !== expectedDbPort) {
    throw new Error(
      `Unsafe API/DB pairing: API port ${apiPort} expects DB port ${expectedDbPort}, ` +
      `but DATABASE_URL points to ${dbUrl.hostname}:${actualDbPort}. ` +
      'Set ALLOW_PORT_DB_MISMATCH=1 only for intentional overrides.'
    );
  }
}

assertApiPortDbPortPairing(PORT);

async function start() {
  // Task 20195ce7 AC2: the generated Prisma client and the database it
  // talks to move independently (Edge fast-forwards the checkout on every
  // merge; nothing applied the matching migration to the long-lived local
  // Postgres). On 2026-10-23 that drift 500'd every read on the shared
  // Tasks API. Verify the schema BEFORE opening the listener, so drift is
  // a loud, correctly-attributed startup failure instead of a silent
  // total outage.
  try {
    await assertTaskApprovalSchema();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          level: 'fatal',
          event: 'schema_preflight_failed',
          service: 'tasks-api',
          message: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const app = createApp();

  app.listen(PORT, () => {
    console.log(`tasks-api listening on http://localhost:${PORT}`);
  });
}

start();

// Defensive: if config somehow loaded but the assert above threw, surface
// it as a non-zero exit. The common case (config validation failure) is
// already handled by the ConfigValidationError from the static import.
process.on('unhandledRejection', (err) => {
  if (err instanceof ConfigValidationError) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
