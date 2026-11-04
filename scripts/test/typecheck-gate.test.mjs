// scripts/test/typecheck-gate.test.mjs
//
// Unit tests for scripts/typecheck-gate.mjs. Run with:
//   node --test scripts/test/typecheck-gate.test.mjs
//
// The gate tool invokes `npm run typecheck --workspace services/<service>`,
// which resolves by path rather than requiring the workspace to be
// pre-linked via `npm ci` — so each test creates a real, disposable
// workspace member under `services/__tcgate_test_<id>__/` (a minimal
// package.json + tsconfig.json + one .ts file), runs the actual CLI
// against it, and removes it in a `finally` block. This exercises the
// real `tsc` binary and the real npm-workspace invocation, not a mock, so
// the fixture tests prove the tool works against genuine tsc output —
// not just hand-written sample text.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normaliseDiagnosticPath, normaliseMessage } from '../typecheck-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'typecheck-gate.mjs');

function runGate(args) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * Create a disposable workspace member under services/ with one .ts file.
 * Returns { service, dir, write(content) } — `write` lets a test mutate
 * the source file and re-run the gate without recreating the fixture.
 */
function makeServiceFixture(sourceContent, compilerOptions = {}) {
  const service = `__tcgate_test_${randomUUID().slice(0, 8)}__`;
  const dir = resolve(REPO_ROOT, 'services', service);
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@sindustries/${service}`,
        private: true,
        scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { noEmit: true, strict: false, skipLibCheck: true, ...compilerOptions },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(dir, 'src', 'index.ts'), sourceContent);
  return {
    service,
    dir,
    write: (content) => writeFileSync(resolve(dir, 'src', 'index.ts'), content),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('--write-baseline records the current diagnostic count and fingerprints', () => {
  const fixture = makeServiceFixture("const x: number = 'nope';\n");
  try {
    const write = runGate(['--service', fixture.service, '--write-baseline']);
    assert.equal(write.status, 0, `expected exit 0\nstdout: ${write.stdout}\nstderr: ${write.stderr}`);
    assert.match(write.stdout, /wrote baseline — 1 diagnostic/);

    const baseline = JSON.parse(readFileSync(resolve(fixture.dir, 'typecheck-baseline.json'), 'utf8'));
    assert.equal(baseline.service, fixture.service);
    assert.equal(baseline.totalDiagnostics, 1);
    assert.equal(Object.keys(baseline.fingerprints).length, 1);
    const [fingerprint] = Object.keys(baseline.fingerprints);
    assert.match(fingerprint, /^src\/index\.ts:TS2322:/);
    assert.equal(baseline.fingerprints[fingerprint], 1);
    assert.ok(baseline.tscVersion, 'tscVersion should be recorded');
  } finally {
    fixture.cleanup();
  }
});

test('gate mode passes when current diagnostics match the committed baseline exactly', () => {
  const fixture = makeServiceFixture("const x: number = 'nope';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 0, `expected exit 0\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stdout, /within baseline of 1/);
  } finally {
    fixture.cleanup();
  }
});

test('AC3 fixture — an intentional new type error fails the gate and is named in the output', () => {
  // Generate a clean baseline (0 diagnostics), then introduce one
  // intentional type error and assert the gate fails with that error
  // identified — the exact scenario AC3 requires the gate to catch.
  const fixture = makeServiceFixture('const ok: number = 1;\n');
  try {
    const baselineWrite = runGate(['--service', fixture.service, '--write-baseline']);
    assert.equal(baselineWrite.status, 0);
    assert.match(baselineWrite.stdout, /wrote baseline — 0 diagnostic/);

    fixture.write("const ok: number = 1;\nconst intentional: number = 'boom';\n");
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1, `expected exit 1\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stderr, /R1: count ratchet/);
    assert.match(gate.stderr, /R2.*TS2322/);
    assert.match(gate.stderr, /not assignable to type 'number'/);
  } finally {
    fixture.cleanup();
  }
});

test('R1 — gate fails when the total diagnostic count rises above baseline', () => {
  const fixture = makeServiceFixture("const a: number = 'x';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    fixture.write("const a: number = 'x';\nconst b: number = 'y';\n");
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /rose from 1 to 2/);
  } finally {
    fixture.cleanup();
  }
});

test('R2 — gate fails on a new fingerprint even when the total count does not grow', () => {
  // Swap one error for a different one: same total (1), but a fingerprint
  // the baseline never recorded. A count-only gate would pass this; R2
  // must not.
  const fixture = makeServiceFixture("const a: number = 'x';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    fixture.write('const a: string = 123;\n');
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1, `expected exit 1\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stderr, /new diagnostic fingerprint/);
    assert.doesNotMatch(gate.stderr, /count ratchet/);
  } finally {
    fixture.cleanup();
  }
});

test('R2 — gate fails when one fingerprint grows even if the overall total is unchanged', () => {
  // Two distinct errors in the baseline (count 1 each); current run drops
  // one entirely but doubles the other. Total stays at 2 (R1 would pass),
  // but one fingerprint's count exceeds its baseline count — R2 must catch it.
  const fixture = makeServiceFixture("const a: number = 'x';\nconst b: string = 1;\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    fixture.write("const a: number = 'x';\nconst a2: number = 'y';\n");
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /grew diagnostic fingerprint/);
  } finally {
    fixture.cleanup();
  }
});

test('gate mode passes when the fixed diagnostic count drops below baseline (ratchet allows shrinkage)', () => {
  const fixture = makeServiceFixture("const a: number = 'x';\nconst b: number = 'y';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    fixture.write("const a: number = 'x';\n");
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 0, `expected exit 0\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stdout, /within baseline of 2/);
  } finally {
    fixture.cleanup();
  }
});

test('R3 — a missing baseline file is a hard failure, not a silently-passing gate', () => {
  const fixture = makeServiceFixture('const ok: number = 1;\n');
  try {
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /missing baseline/);
  } finally {
    fixture.cleanup();
  }
});

test('R3 — an unparseable baseline file is a hard failure', () => {
  const fixture = makeServiceFixture('const ok: number = 1;\n');
  try {
    writeFileSync(resolve(fixture.dir, 'typecheck-baseline.json'), '{ not valid json');
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /unparseable baseline/);
  } finally {
    fixture.cleanup();
  }
});

test('R3 — an internally inconsistent baseline is a hard failure', () => {
  const fixture = makeServiceFixture("const x: number = 'nope';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    const baselinePath = resolve(fixture.dir, 'typecheck-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.totalDiagnostics = 99;
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /invalid baseline/);
  } finally {
    fixture.cleanup();
  }
});

test('R4 — a tscVersion mismatch is a hard failure that asks for a deliberate regenerate', () => {
  const fixture = makeServiceFixture('const ok: number = 1;\n');
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    const baselinePath = resolve(fixture.dir, 'typecheck-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.tscVersion = '0.0.0-not-the-real-version';
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 2);
    assert.match(gate.stderr, /tsc version mismatch/);
    assert.match(gate.stderr, /regenerate the baseline deliberately/);
  } finally {
    fixture.cleanup();
  }
});

test('an installed but ungenerated @prisma/client is a pointed hard failure, not a baseline comparison', () => {
  // Checked before any baseline read/write — a service whose Prisma
  // client was never generated must fail with this specific hint in both
  // gate and --write-baseline mode, not fall through to R3's "missing
  // baseline" message. The package includes the real ungenerated public
  // `index.d.ts` re-export shape; its resolved default declaration exposes
  // no PrismaClient, producing the real import-site TS2305 rather than the
  // old fixture's proxy TS2307 for an entirely absent package.
  const fixture = makeServiceFixture(
    "import { PrismaClient } from '@prisma/client';\nnew PrismaClient();\n",
    {
      module: 'ESNext',
      moduleResolution: 'bundler',
      baseUrl: '.',
      paths: { '@prisma/client': ['./node_modules/@prisma/client/default.d.ts'] },
    },
  );
  try {
    const prismaPackage = resolve(fixture.dir, 'node_modules', '@prisma', 'client');
    mkdirSync(prismaPackage, { recursive: true });
    writeFileSync(resolve(prismaPackage, 'package.json'), JSON.stringify({
      name: '@prisma/client',
      version: '0.0.0-test',
      types: 'default.d.ts',
      exports: { '.': { types: './default.d.ts', default: './default.js' } },
    }));
    writeFileSync(
      resolve(prismaPackage, 'default.d.ts'),
      'export type __UngeneratedClientStub = never;\n',
    );
    writeFileSync(resolve(prismaPackage, 'index.d.ts'), "export * from '.prisma/client/default';\n");

    const gate = runGate(['--service', fixture.service, '--write-baseline']);
    assert.equal(gate.status, 2, `expected exit 2\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stderr, /missing Prisma client module/);
    assert.match(gate.stderr, /prisma:generate/);
  } finally {
    fixture.cleanup();
  }
});

test('a missing relative generated/prisma import is a pointed hard failure (tasks-api/budget-api output path)', () => {
  // tasks-api and budget-api declare a custom Prisma `output` path and
  // import it by relative path (`../../generated/prisma/index.js`), not
  // the bare `@prisma/client` package — the detection must cover both
  // shapes, not just the package-specifier one.
  const fixture = makeServiceFixture(
    "import { PrismaClient } from '../../generated/prisma/index.js';\nnew PrismaClient();\n",
  );
  try {
    const gate = runGate(['--service', fixture.service, '--write-baseline']);
    assert.equal(gate.status, 2, `expected exit 2\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
    assert.match(gate.stderr, /missing Prisma client module/);
    assert.match(gate.stderr, /prisma:generate/);
  } finally {
    fixture.cleanup();
  }
});

test('fingerprint normalisation collapses module-resolution-dependent rendered model order', () => {
  const first = normaliseMessage(
    "Argument of type '{ id: string; status: string; nested: { a: number; }; ... 16 more ...; }' " +
      "is not assignable to parameter of type 'Pick<{ status: string; id: string; ... 16 more ...; }, \"status\">'.",
  );
  const second = normaliseMessage(
    "Argument of type '{ status: string; id: string; nested: { b: number; }; ... 22 more ...; }' " +
      "is not assignable to parameter of type 'Pick<{ id: string; status: string; ... 22 more ...; }, \"status\">'.",
  );
  assert.equal(first, second);
  assert.match(first, /Pick<\{…\}/);
});

test('diagnostic paths are normalised relative to the service directory', () => {
  const serviceDir = resolve(REPO_ROOT, 'services', 'tasks-api');
  assert.equal(
    normaliseDiagnosticPath(resolve(serviceDir, 'src', 'routes', 'tasks.ts'), serviceDir),
    'src/routes/tasks.ts',
  );
  assert.equal(
    normaliseDiagnosticPath('services/tasks-api/src/routes/tasks.ts', serviceDir),
    'src/routes/tasks.ts',
  );
});

test('a typecheck script that does not invoke tsc --noEmit fails closed', () => {
  const fixture = makeServiceFixture('const ok: number = 1;\n');
  try {
    const packagePath = resolve(fixture.dir, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    packageJson.scripts.typecheck = 'true';
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 2);
    assert.match(gate.stderr, /must invoke tsc with --noEmit/);
  } finally {
    fixture.cleanup();
  }
});

test('no such service directory fails fast with exit 2', () => {
  const gate = runGate(['--service', '__definitely_not_a_real_service__']);
  assert.equal(gate.status, 2);
  assert.match(gate.stderr, /no such service directory/);
});

test('fingerprints exclude line/column so an unrelated edit above an error does not invalidate the baseline', () => {
  const fixture = makeServiceFixture("const a: number = 'x';\n");
  try {
    assert.equal(runGate(['--service', fixture.service, '--write-baseline']).status, 0);
    // Insert blank lines above the error, shifting its line number, with
    // no change to the error itself.
    fixture.write("\n\n\nconst a: number = 'x';\n");
    const gate = runGate(['--service', fixture.service]);
    assert.equal(gate.status, 0, `expected exit 0\nstdout: ${gate.stdout}\nstderr: ${gate.stderr}`);
  } finally {
    fixture.cleanup();
  }
});
