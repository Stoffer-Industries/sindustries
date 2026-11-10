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

describe('tasks-api startup lifecycle scripts (AC1)', () => {
  const pkg = readJson('package.json');
  const scripts = pkg.scripts as Record<string, string>;

  it('runs `prisma migrate deploy` before `prisma generate` in predev and prestart', () => {
    for (const hook of ['predev', 'prestart']) {
      const script = scripts[hook];
      expect(script, `${hook} script must exist`).toBeTruthy();

      const migrateIndex = script.indexOf('prisma migrate deploy');
      const generateIndex = script.indexOf('prisma generate');
      expect(migrateIndex, `${hook} must apply pending migrations`).toBeGreaterThanOrEqual(0);
      expect(generateIndex, `${hook} must regenerate the client`).toBeGreaterThanOrEqual(0);
      expect(migrateIndex, `${hook} must migrate before generating`).toBeLessThan(generateIndex);
    }
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
});
