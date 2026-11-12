/**
 * Startup lifecycle wiring for tasks-api (task 20195ce7, AC1 + AC2).
 *
 * AC1: the dev/start lifecycle scripts apply pending migrations before the
 * server is allowed to serve, so a merged migration cannot land ahead of the
 * schema it requires.
 *
 * AC2: the startup preflight runs before `app.listen(...)`, so a database
 * that is behind the generated Prisma client produces a loud startup
 * failure instead of a listener that 500s on every read.
 *
 * The behavioural counterpart — spawning the real server against a
 * drifted database — lives in `startupPreflight.integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = path.resolve(__dirname, '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(SERVICE_DIR, relativePath), 'utf8'));
}

/**
 * Strip comments so assertions can inspect executable code rather than
 * prose that merely mentions a pattern.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('tasks-api startup lifecycle scripts (AC1)', () => {
  const pkg = readJson('package.json');
  const scripts = pkg.scripts as Record<string, string>;

  it('runs `prisma migrate deploy` before `prisma generate` in predev', () => {
    const script = scripts.predev;
    expect(script, 'predev script must exist').toBeTruthy();

    const migrateIndex = script.indexOf('prisma migrate deploy');
    const generateIndex = script.indexOf('prisma generate');
    expect(migrateIndex, 'predev must apply pending migrations').toBeGreaterThanOrEqual(0);
    expect(generateIndex, 'predev must regenerate the client').toBeGreaterThanOrEqual(0);
    expect(migrateIndex, 'predev must migrate before generating').toBeLessThan(generateIndex);
  });

  it('keeps prestart free of migration side effects', () => {
    // `prestart` runs on every Fly machine start, restart and scale-up
    // (the image's CMD is `npm run start --workspace services/tasks-api`).
    // Migrating from inside the app container would add a boot-time
    // dependency on database write access; Fly's `release_command` already
    // owns migration for deploys.
    const script = scripts.prestart;
    expect(script, 'prestart script must exist').toBeTruthy();
    expect(script, 'prestart must not migrate at boot').not.toContain('migrate deploy');
    expect(script, 'prestart must still regenerate the client').toContain('prisma generate');
  });

  it('keeps the test lifecycle hooks free of migration side effects', () => {
    // Unit and integration suites run against a database that CI migrates
    // explicitly; applying migrations from a test hook would hide drift
    // instead of surfacing it.
    expect(scripts.pretest).not.toContain('migrate deploy');
    expect(scripts['pretest:integration']).not.toContain('migrate deploy');
  });
});

describe('tasks-api startup preflight wiring (AC2)', () => {
  const serverSource = readFileSync(path.join(SERVICE_DIR, 'src/server.ts'), 'utf8');
  const fatalStderrSource = readFileSync(path.join(SERVICE_DIR, 'src/lib/fatalStderr.ts'), 'utf8');

  it('runs the schema preflight before the HTTP listener opens', () => {
    const preflightIndex = serverSource.indexOf('await assertTaskApprovalSchema()');
    const listenIndex = serverSource.indexOf('app.listen(');

    expect(preflightIndex, 'server.ts must call the schema preflight').toBeGreaterThanOrEqual(0);
    expect(listenIndex, 'server.ts must open a listener').toBeGreaterThanOrEqual(0);
    expect(preflightIndex, 'the preflight must run before app.listen').toBeLessThan(listenIndex);
  });

  it('exits non-zero when the preflight fails', () => {
    expect(serverSource).toContain('schema_preflight_failed');
    expect(serverSource).toContain('process.exit(1)');
  });

  it('writes the fatal payload synchronously before exiting', () => {
    // Node writes to a pipe asynchronously on macOS, so `console.error`
    // followed by `process.exit(1)` can truncate the very payload AC2
    // exists to deliver. The server routes fatal output through the
    // synchronous writer instead — proven behaviourally in
    // `fatalStderr.test.ts`.
    const serverCode = stripComments(serverSource);
    const writerCode = stripComments(fatalStderrSource);

    expect(serverCode, 'the server must use the synchronous fatal writer').toContain(
      'writeFatalToStderr('
    );
    expect(writerCode, 'the fatal writer must write synchronously').toContain('fs.writeSync(');
    expect(serverCode).not.toMatch(/console\.error\([\s\S]{0,400}process\.exit\(1\)/);
  });
});
