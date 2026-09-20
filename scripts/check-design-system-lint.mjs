#!/usr/bin/env node
// scripts/check-design-system-lint.mjs
//
// Lint pass for the ACTIVE @shadcn/lint install (task 7986eb43, slice 5).
//
// What this script does:
//   1. Asserts `.oxlintrc.json` exists and parses.
//   2. Asserts `components.json` exists.
//   3. Asserts the @shadcn/lint jsPlugin is registered in oxlintrc.json.
//   4. Asserts the slice-4 contract is in place:
//        - `settings.shadcn` exists (not `settings.shadcn-lint` — the
//          dormant-install key path was the wrong one; @shadcn/lint 0.1.0
//          reads `settings.shadcn` per its README + index.js).
//        - At least one `shadcn/*` rule is listed in the top-level
//          `rules` block (the dormant install registered the plugin but
//          listed no rules, so it ran with zero shadcn/* rules active).
//   5. Runs `oxlint --print-config` to prove oxlint can load the jsPlugin
//      from node_modules and resolve it cleanly.
//   6. Runs the actual lint pass on packages/ui/src/react + the four
//      frontend apps using `--format=json`, parses the diagnostic array,
//      separates shadcn/* errors from warnings, and exits based on
//      severity:
//        - exit 1 if any shadcn/* diagnostic has severity `error`
//          (i.e. an error-level rule fired — merge-blocking)
//        - exit 0 if all shadcn/* diagnostics are at severity `warning`
//          (Accepted baseline; rules active locally so devs see the
//          offences but CI doesn't block on them)
//        - exit 0 if zero diagnostics
//      The slice-5 closeout of task 7986eb43 promotes the zero-offence
//      rules (`shadcn/no-raw-colors`, `shadcn/no-arbitrary-values`) to
//      `error`; the rules with Accepted baseline stay at `warn` and
//      promote only after the kit CSS retirement task collapses the
//      BEM/legacy class emissions.
//
// The dormant-install contract (`rulesEnabled: false`, exit 1 if not
// false) is GONE. The wrapper asserts ACTIVE state and surfaces the
// per-rule shadcn/* offence counts grouped by severity.
//
// Usage:
//   node scripts/check-design-system-lint.mjs
//
// Exit codes:
//   0 — install valid, rules active, zero shadcn/* errors (warnings allowed)
//   1 — shadcn/* error-level offence(s) present OR install contract violated
//   2 — invocation / IO error
//
// Refs: docs/systems/design-system.md 'Design-system linting' section
// (status flipped DORMANT → ACTIVE in slice 4; baseline triage landed in
// slice 5). Task 7986eb43 slice 5.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Use process.cwd() so the wrapper is callable from any working
// directory. Tests stub .oxlintrc.json and components.json in cwd; the
// wrapper reads them relative to cwd. The lint pass targets are pinned
// (not derived from cwd) so a stale cwd does not produce a misleading
// pass — they reflect the canonical SIndustries layout.
const REPO_ROOT = process.cwd();
const OXLINTRC = resolve(REPO_ROOT, '.oxlintrc.json');
const COMPONENTS_JSON = resolve(REPO_ROOT, 'components.json');
const LINT_TARGETS = [
  'packages/ui/src/react',
  'apps/website/src',
  'apps/tasks/src',
  'apps/mission-control/src',
  'apps/gymtrack/src',
];

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

function isShadcnRule(name) {
  return typeof name === 'string' && name.startsWith('shadcn/');
}

function configSummary(cfg) {
  const jsPlugins = cfg.jsPlugins ?? [];
  const shadcnRegistered = jsPlugins.some((p) => {
    const name = typeof p === 'string' ? p : p?.name;
    return name === '@shadcn/lint';
  });
  const rules = cfg.rules ?? {};
  const shadcnRules = Object.keys(rules).filter(isShadcnRule);
  const shadcnSettings = cfg?.settings?.shadcn;
  const legacyShadcnLint = cfg?.settings?.['shadcn-lint'];
  return [
    `  oxlintrc: ${OXLINTRC.replace(REPO_ROOT + '/', '')} (loaded)`,
    `  @shadcn/lint plugin: ${shadcnRegistered ? 'registered' : 'NOT REGISTERED — ACTIVE install REQUIRES this plugin'}`,
    `  shadcn/* rule entries: ${shadcnRules.length} ${shadcnRules.length ? `(${shadcnRules.join(', ')})` : '(NONE — slice 4 requires at least one)'}`,
    `  settings.shadcn: ${shadcnSettings ? 'present' : 'MISSING — slice 4 uses settings.shadcn, not settings.shadcn-lint'}`,
    `  settings.shadcn-lint: ${legacyShadcnLint ? 'PRESENT (legacy dormant-install key; should be removed)' : 'absent (correct)'}`,
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

function runOxlintLint() {
  return spawnSync(
    'npx',
    ['--no-install', 'oxlint', '--config', '.oxlintrc.json', '--format=json', ...LINT_TARGETS],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

banner('check-design-system-lint — ACTIVE lint pass (task 7986eb43, slice 5)');

const cfg = loadConfig();
if (!cfg) {
  process.exit(1);
}
console.error(configSummary(cfg));
console.error(
  '\n  Targets: ' + LINT_TARGETS.join(', ') + '\n',
);

const jsPlugins = cfg.jsPlugins ?? [];
const shadcnRegistered = jsPlugins.some((p) => {
  const name = typeof p === 'string' ? p : p?.name;
  return name === '@shadcn/lint';
});
if (!shadcnRegistered) {
  console.error(
    `::error::@shadcn/lint plugin not registered in .oxlintrc.json jsPlugins. ACTIVE install REQUIRES registration.`,
  );
  process.exit(1);
}

const rules = cfg.rules ?? {};
const shadcnRules = Object.keys(rules).filter(isShadcnRule);
if (shadcnRules.length === 0) {
  console.error(
    `::error::.oxlintrc.json rules block contains zero shadcn/* entries. ACTIVE install REQUIRES at least one shadcn/* rule.`,
  );
  process.exit(1);
}

if (!cfg?.settings?.shadcn || typeof cfg.settings.shadcn !== 'object') {
  console.error(
    `::error::.oxlintrc.json settings.shadcn is missing or not an object. Slice 4 uses settings.shadcn (the @shadcn/lint 0.1.0 key); the dormant install used the legacy settings.shadcn-lint key path.`,
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

const lintResult = runOxlintLint();
if (lintResult.error) {
  console.error(
    `::error::oxlint lint invocation failed: ${lintResult.error.message}`,
  );
  process.exit(2);
}

const lintStdout = lintResult.stdout ?? '';
const lintStderr = lintResult.stderr ?? '';

// Parse the JSON diagnostic stream. `--format=json` emits a single
// object on stdout: `{ "diagnostics": [...], "number_of_files": N,
// "number_of_rules": N, ... }`. Each diagnostic carries
// `severity: "warning" | "error"`, `code: "shadcn(rule-name)"`,
// `filename`, `message`, and `labels`.
let shadcnDiagnostics = [];
let lintParseError = null;
try {
  const parsed = JSON.parse(lintStdout);
  const diagnostics = Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [];
  shadcnDiagnostics = diagnostics.filter(
    (d) => typeof d?.code === 'string' && d.code.startsWith('shadcn('),
  );
} catch (err) {
  lintParseError = err;
}

// Group shadcn diagnostics by rule + severity so the summary surfaces
// both the merge-blocking errors and the Accepted-baseline warnings.
const errorsByRule = new Map();
const warningsByRule = new Map();
for (const d of shadcnDiagnostics) {
  const rule = d.code; // already `shadcn(rule-name)` form
  if (d.severity === 'error') {
    errorsByRule.set(rule, (errorsByRule.get(rule) ?? 0) + 1);
  } else if (d.severity === 'warning') {
    warningsByRule.set(rule, (warningsByRule.get(rule) ?? 0) + 1);
  }
}

const errorCount = [...errorsByRule.values()].reduce((a, b) => a + b, 0);
const warningCount = [...warningsByRule.values()].reduce((a, b) => a + b, 0);

if (lintParseError) {
  console.error(
    `::error::oxlint --format=json parse failed: ${lintParseError.message}`,
  );
  console.error('--- oxlint stdout (first 4 KB) ---');
  console.error(lintStdout.slice(0, 4096));
  if (lintStderr.trim().length > 0) {
    console.error('--- oxlint stderr ---');
    console.error(lintStderr);
  }
  process.exit(2);
}

if (errorCount > 0) {
  console.error(
    `  result: FAIL — ${errorCount} shadcn/* error(s) and ${warningCount} shadcn/* warning(s).`,
  );
  for (const [rule, count] of [...errorsByRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`    - ${rule}: ${count} (error)`);
  }
  for (const [rule, count] of [...warningsByRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`    - ${rule}: ${count} (warning)`);
  }
  console.error(
    '\n  Error-level shadcn/* offences are merge-blocking. ' +
      'See docs/systems/design-system.md "Design-system linting" section for the rule policy.\n',
  );
  if (lintStderr.trim().length > 0) {
    process.stderr.write(lintStderr);
  }
  process.exit(1);
}

if (warningCount > 0) {
  console.error(
    `  result: PASS — ${shadcnRules.length} shadcn/* rule(s) active; ${warningCount} Accepted-baseline warning(s), zero errors.`,
  );
  for (const [rule, count] of [...warningsByRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`    - ${rule}: ${count} (warning)`);
  }
  console.error(
    '\n  Warnings reflect the Accepted baseline documented in ' +
      'docs/systems/design-system.md "Design-system linting" section. ' +
      'They surface locally for visibility but do not block CI.\n',
  );
  if (lintStderr.trim().length > 0) {
    process.stderr.write(lintStderr);
  }
  process.exit(0);
}

console.error(`  result: PASS — ${shadcnRules.length} shadcn/* rule(s) active, zero offences.`);
process.exit(0);
