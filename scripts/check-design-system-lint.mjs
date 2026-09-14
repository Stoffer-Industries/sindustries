#!/usr/bin/env node
// scripts/check-design-system-lint.mjs
//
// Smoke test for the dormant @shadcn/lint install (task da86ccd8).
//
// What this script does:
//   1. Asserts `.oxlintrc.json` exists and parses.
//   2. Asserts `components.json` exists.
//   3. Asserts the @shadcn/lint jsPlugin is registered in oxlintrc.json.
//   4. Asserts `rulesEnabled: false` (dormant install contract).
//   5. Asserts `oxlint --print-config` succeeds — proves oxlint can load
//      the jsPlugin entry and resolve it from node_modules.
//
// The actual lint pass is NOT run. In dormant mode, oxlint's default rule
// set (correctness, etc.) surfaces unrelated offences on real frontend
// code, which would be a false-signal. AC3 + active rule enablement are
// owned by follow-up task 7986eb43-dc85-4512-b76a-1cfecefd8be7 (Adopt
// Tailwind v4 in @sindustries/ui). See docs/systems/design-system.md
// "Design-system linting" section.
//
// Usage:
//   node scripts/check-design-system-lint.mjs
//
// Exit codes:
//   0 — install verified, plugin registered, --print-config clean
//   1 — install configuration missing or contract violated
//   2 — invocation / IO error

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Use process.cwd() so the wrapper is callable from any working
// directory (the wrapper is run from the repo root in CI, and from
// arbitrary temp dirs in unit tests). Tests stub .oxlintrc.json and
// components.json in cwd; the wrapper reads them relative to cwd.
const REPO_ROOT = process.cwd();
const OXLINTRC = resolve(REPO_ROOT, '.oxlintrc.json');
const COMPONENTS_JSON = resolve(REPO_ROOT, 'components.json');

function banner(text) {
  const line = '═'.repeat(Math.max(40, text.length + 4));
  console.error(`\n${line}\n  ${text}\n${line}\n`);
}

function loadConfig() {
  if (!existsSync(OXLINTRC)) {
    console.error(`::error::.oxlintrc.json missing at ${OXLINTRC}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(OXLINTRC, 'utf8'));
  } catch (err) {
    console.error(`::error::.oxlintrc.json parse failed — ${err.message}`);
    return null;
  }
}

function configSummary(cfg) {
  const jsPlugins = cfg.jsPlugins ?? [];
  const shadcn = jsPlugins.find((p) => {
    const name = typeof p === 'string' ? p : p?.name;
    return name === '@shadcn/lint';
  });
  const rulesEnabled = cfg?.settings?.['shadcn-lint']?.rulesEnabled;
  const rulesDisplay = typeof shadcn === 'string' ? '(string specifier)' : shadcn?.specifier ?? '(unspecified)';
  return [
    `  oxlintrc: ${OXLINTRC.replace(REPO_ROOT + '/', '')} (loaded)`,
    `  @shadcn/lint plugin: ${shadcn ? `registered ${rulesDisplay}` : 'NOT REGISTERED — dormant install REQUIRES this plugin'}`,
    `  rulesEnabled: ${rulesEnabled === undefined ? '(unknown)' : rulesEnabled}`,
    `  components.json: ${existsSync(COMPONENTS_JSON) ? 'present' : 'MISSING'}`,
  ].join('\n');
}

function runOxlintPrintConfig() {
  return spawnSync(
    'npx',
    ['--no-install', 'oxlint', '--config', '.oxlintrc.json', '--print-config'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

banner('check-design-system-lint — DORMANT smoke test (task da86ccd8)');

const cfg = loadConfig();
if (!cfg) {
  process.exit(1);
}
console.error(configSummary(cfg));
console.error(
  '\n  Note: this script asserts the install + plugin registration. Rules\n' +
    '  are intentionally NOT enabled — see docs/systems/design-system.md\n' +
    '  "Design-system linting" and follow-up task 7986eb43.\n',
);

const jsPlugins = cfg.jsPlugins ?? [];
const shadcnRegistered = jsPlugins.some((p) => {
  const name = typeof p === 'string' ? p : p?.name;
  return name === '@shadcn/lint';
});
if (!shadcnRegistered) {
  console.error(
    `::error::@shadcn/lint plugin not registered in .oxlintrc.json jsPlugins. Dormant install REQUIRES registration.`,
  );
  process.exit(1);
}

if (cfg?.settings?.['shadcn-lint']?.rulesEnabled !== false) {
  console.error(
    `::error::.oxlintrc.json settings.shadcn-lint.rulesEnabled is not explicitly false. Dormant install REQUIRES rulesEnabled:false until follow-up task 7986eb43 lands.`,
  );
  process.exit(1);
}

if (!existsSync(COMPONENTS_JSON)) {
  console.error(`::error::components.json missing at ${COMPONENTS_JSON}`);
  process.exit(1);
}

const printConfig = runOxlintPrintConfig();
if (printConfig.error) {
  console.error(
    `::error::oxlint --print-config invocation failed: ${printConfig.error.message}`,
  );
  process.exit(2);
}
if (printConfig.status !== 0) {
  const stderr = printConfig.stderr ?? '';
  const stdout = printConfig.stdout ?? '';
  console.error(
    `::error::oxlint --print-config exited with status ${printConfig.status}. Plugin load likely failed.`,
  );
  if (stderr.trim().length > 0) {
    console.error('--- oxlint stderr ---');
    console.error(stderr);
  }
  if (stdout.trim().length > 0) {
    console.error('--- oxlint stdout ---');
    console.error(stdout);
  }
  process.exit(2);
}

console.error(
  '  result: PASS — @shadcn/lint plugin registered, rulesEnabled=false, oxlint --print-config clean.',
);
process.exit(0);
