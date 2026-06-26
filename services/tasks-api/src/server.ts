import 'dotenv/config';
import { createApp } from './app';

const port = Number(process.env.PORT || 4000);
const ALLOW_PORT_DB_MISMATCH = process.env.ALLOW_PORT_DB_MISMATCH === '1';

function expectedDbPortForApiPort(apiPort: number): string | null {
  if (apiPort === 4000) return '6432';
  if (apiPort === 4001) return '7432';
  return null;
}

function assertApiPortDbPortPairing(apiPort: number) {
  if (ALLOW_PORT_DB_MISMATCH) return;

  const expectedDbPort = expectedDbPortForApiPort(apiPort);
  if (!expectedDbPort) return;

  const dbUrlRaw = process.env.DATABASE_URL;
  if (!dbUrlRaw) {
    throw new Error('DATABASE_URL is required.');
  }

  let dbUrl: URL;
  try {
    dbUrl = new URL(dbUrlRaw);
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

assertApiPortDbPortPairing(port);

const app = createApp();

app.listen(port, () => {
  console.log(`tasks-api listening on http://localhost:${port}`);
});
