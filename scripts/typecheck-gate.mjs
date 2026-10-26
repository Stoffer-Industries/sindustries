#!/usr/bin/env node
// scripts/typecheck-gate.mjs
//
// Ratcheting TypeScript compiler gate for a backend API service. Runs the
// service's own `typecheck` script (`tsc --noEmit`), parses the diagnostics,
// and compares them against a committed per-service baseline
// (`services/<service>/typecheck-baseline.json`). See
// docs/specs/backend-typecheck-gate-tech-design.md (Decision 2) for the
// rules this enforces (R1-R4) and why a bare count is not enough.
//
// Usage:
//   node scripts/typecheck-gate.mjs --service tasks-api           # gate mode
//   node scripts/typecheck-gate.mjs --service tasks-api --write-baseline
//
// Exit codes:
//   0 — within baseline (gate mode) / baseline written (write mode)
//   1 — gate violation (R1 or R2) or missing/unparseable baseline (R3)
//   2 — invocation error, tsc failed without emitting diagnostics, or a
//       toolchain/environment problem (missing Prisma client, tscVersion
//       mismatch)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Matches the start of a tsc diagnostic, e.g.:
//   services/tasks-api/src/routes/tasks.ts(219,42): error TS2362: The left-hand side...
// Continuation lines (indented detail for multi-line messages) do not match
// and are ignored — the fingerprint is path + code + the diagnostic's own
// first-line message, deliberately excluding line/column (see Decision 2:
// "Fingerprint granularity").
const DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function parseArgs(argv) {
  const args = { service: null, writeBaseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') {
      args.service = argv[i + 1];
      i += 1;
    } else if (arg === '--write-baseline') {
      args.writeBaseline = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.service) {
    throw new Error('Usage: typecheck-gate.mjs --service <name> [--write-baseline]');
  }
  return args;
}

function baselinePath(service) {
  return resolve(REPO_ROOT, 'services', service, 'typecheck-baseline.json');
}

function getTscVersion() {
  const tscBin = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(tscBin, ['--version'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const match = /Version\s+(\S+)/.exec(result.stdout ?? '');
  return match ? match[1] : null;
}

function runTypecheck(service) {
  return spawnSync('npm', ['run', 'typecheck', '--workspace', `services/${service}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function parseDiagnostics(output) {
  const diagnostics = [];
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC_RE.exec(line);
    if (!match) continue;
    const [, file, , , code, message] = match;
    diagnostics.push({ file: file.trim(), code, message: message.trim() });
  }
  return diagnostics;
}

function buildFingerprints(diagnostics) {
  const fingerprints = {};
  for (const d of diagnostics) {
    const key = `${d.file}:${d.code}:${d.message}`;
    fingerprints[key] = (fingerprints[key] ?? 0) + 1;
  }
  const sorted = {};
  for (const key of Object.keys(fingerprints).sort()) {
    sorted[key] = fingerprints[key];
  }
  return sorted;
}

function main() {
  const { service, writeBaseline } = parseArgs(process.argv.slice(2));
  const serviceDir = resolve(REPO_ROOT, 'services', service);
  if (!existsSync(serviceDir)) {
    console.error(`✗ typecheck-gate: no such service directory services/${service}`);
    process.exit(2);
  }

  const result = runTypecheck(service);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const diagnostics = parseDiagnostics(output);
  const tscVersion = getTscVersion();

  // tsc exits non-zero on diagnostics, but also on a bad invocation (e.g. a
  // malformed tsconfig). Zero parsed diagnostics on a non-zero exit means
  // something other than a type error went wrong — that must not be
  // silently treated as "0 diagnostics, gate passes".
  if (result.status !== 0 && diagnostics.length === 0) {
    console.error(`✗ typecheck-gate (${service}): tsc failed without emitting diagnostics`);
    console.error(output.trim());
    process.exit(2);
  }

  // Covers both ways a service in this repo imports its Prisma client: the
  // bare `@prisma/client` package specifier (content-scheduler-api), and a
  // relative import of a custom `output` path under `generated/prisma`
  // (tasks-api, budget-api — see each service's prisma/schema.prisma).
  // Either one is unresolvable with no client generated.
  const missingPrismaClient = diagnostics.some(
    (d) => d.code === 'TS2307' && /@prisma\/client|generated\/prisma/.test(d.message),
  );
  if (missingPrismaClient) {
    console.error(
      `✗ typecheck-gate (${service}): diagnostics include a missing Prisma client module.\n` +
        `  Run \`npm run prisma:generate --workspace services/${service}\` before the gate.`,
    );
    process.exit(2);
  }

  const fingerprints = buildFingerprints(diagnostics);
  const totalDiagnostics = diagnostics.length;

  if (writeBaseline) {
    const baseline = {
      service,
      generatedAt: new Date().toISOString().slice(0, 10),
      generatedBy: `npm run typecheck:baseline --workspace services/${service}`,
      tscVersion,
      totalDiagnostics,
      fingerprints,
    };
    writeFileSync(baselinePath(service), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `✓ typecheck-gate (${service}): wrote baseline — ${totalDiagnostics} diagnostic(s) at tsc ${tscVersion}`,
    );
    process.exit(0);
  }

  const path = baselinePath(service);
  if (!existsSync(path)) {
    console.error(
      `✗ typecheck-gate (${service}): missing baseline at services/${service}/typecheck-baseline.json\n` +
        `  A missing baseline must not silently disable the gate (R3). Generate one with\n` +
        `  \`npm run typecheck:baseline --workspace services/${service}\` and commit it.`,
    );
    process.exit(1);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(
      `✗ typecheck-gate (${service}): unparseable baseline at services/${service}/typecheck-baseline.json (${err.message})`,
    );
    process.exit(1);
  }

  if (baseline.tscVersion !== tscVersion) {
    console.error(
      `✗ typecheck-gate (${service}): tsc version mismatch — baseline recorded ${baseline.tscVersion}, ` +
        `current is ${tscVersion} (R4).\n` +
        `  A TypeScript upgrade can move diagnostics; regenerate the baseline deliberately with\n` +
        `  \`npm run typecheck:baseline --workspace services/${service}\` and review the diff.`,
    );
    process.exit(2);
  }

  const baselineFingerprints = baseline.fingerprints ?? {};
  const violations = [];

  if (totalDiagnostics > baseline.totalDiagnostics) {
    violations.push(
      `total diagnostics rose from ${baseline.totalDiagnostics} to ${totalDiagnostics} (R1: count ratchet)`,
    );
  }

  for (const [fingerprint, count] of Object.entries(fingerprints)) {
    const baselineCount = baselineFingerprints[fingerprint] ?? 0;
    if (count > baselineCount) {
      violations.push(
        `${baselineCount === 0 ? 'new' : 'grew'} diagnostic fingerprint (R2): ${fingerprint} ` +
          `(current ${count}, baseline ${baselineCount})`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`✗ typecheck-gate (${service}): ${violations.length} violation(s)`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log(
    `✓ typecheck-gate (${service}): ${totalDiagnostics} diagnostic(s), within baseline of ${baseline.totalDiagnostics}`,
  );
  process.exit(0);
}

main();
