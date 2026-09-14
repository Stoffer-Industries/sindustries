#!/usr/bin/env node
// scripts/check-design-system-lint.mjs
//
// Smoke test for the dormant @shadcn/lint install (task da86ccd8).
// Runs `oxlint` against the configured web/React frontend surfaces with the
// `@shadcn/lint` jsPlugin loaded, and asserts the plugin loads cleanly.
//
// Rules are intentionally NOT enabled in this PR — @shadcn/lint ships
// Tailwind-class-string rules (no-restyle, no-raw-colors, no-arbitrary-values,
// no-unknown-classes, require-static-classes, no-leaked-tailwind-classes) and
// reads theme tokens from Tailwind v4 @theme blocks. SIndustries frontend
// uses BEM-style CSS with @sindustries/design-tokens via CSS custom
// properties. Enabling rules before Tailwind v4 lands in @sindustries/ui
// produces zero findings — a false-signal that proves nothing.
//
// Rule enablement + AC3 + baseline triage are owned by follow-up task
// 7986eb43-dc85-4512-b76a-1cfecefd8be7 (Adopt Tailwind v4 in @sindustries/ui).
// See docs/systems/design-system.md 'Design-system linting' section.
//
// Usage:
//   node scripts/check-design-system-lint.mjs           # smoke test
//
// Exit codes:
//   0 — config loaded cleanly, no offences reported
//   1 — oxlint reported offences (unexpected in dormant install; investigate)
//   2 — invocation / IO error (config not found, plugin load failure, etc.)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const OXLINTRC = resolve(REPO_ROOT, '.oxlintrc.json');
const COMPONENTS_JSON = resolve(REPO_ROOT, 'components.json');

// Frontend surfaces in scope for design-system linting (mirrors the
// tech design's file/module scope). Each is a relative-to-REPO_ROOT
// glob pattern that oxlint understands.
const SCAN_GS = [
  'apps/website/src',
  'apps/tasks/src',
  'apps/mission-control/src',
  'apps/gymtrack/src',
  'packages/ui/src/react',
];

function banner(text) {
  const line = '═'.repeat(Math.max(40, text.length + 4));
  console.error(`\n${line}\n  ${text}\n${line}\n`);
}

function configSummary() {
  const lines = [];
  if (existsSync(OXLINTRC)) {
    try {
      const cfg = JSON.parse(readFileSync(OXLINTRC, 'utf8'));
      const shadcn = (cfg.jsPlugins ?? []).find((p) => p?.name === '@shadcn/lint');
      lines.push(`  oxlintrc: ${OXLINTRC.replace(REPO_ROOT + '/', '')} (loaded)`);
      lines.push(
        `  @shadcn/lint plugin: ${shadcn ? `registered @ ${shadcn.specifier ?? 'latest'}` : 'NOT REGISTERED'}`,
      );
      lines.push(
        `  rulesEnabled: ${cfg?.settings?.['shadcn-lint']?.rulesEnabled ?? '(unknown — see .oxlintrc.json settings)'}`,
      );
    } catch (err) {
      lines.push(`  oxlintrc: parse failed — ${err.message}`);
    }
  } else {
    lines.push(`  oxlintrc: NOT FOUND at ${OXLINTRC}`);
  }
  lines.push(
    `  components.json: ${existsSync(COMPONENTS_JSON) ? `present` : 'MISSING'}`,
  );
  lines.push(`  scan roots: ${SCAN_GS.join(', ')}`);
  return lines.join('\n');
}

function runOxlint() {
  return spawnSync(
    'npx',
    [
      '--yes',
      'oxlint@1.83.0',
      '--config',
      '.oxlintrc.json',
      '--js-plugins',
      '@shadcn/lint',
      ...SCAN_GS,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

banner('check-design-system-lint — DORMANT smoke test (task da86ccd8)');
console.error(configSummary());
console.error(
  '\n  Note: this script asserts the @shadcn/lint plugin loads cleanly. Rules\n' +
    '  are intentionally NOT enabled — see docs/systems/design-system.md\n' +
    '  "Design-system linting" and follow-up task 7986eb43.\n',
);

if (!existsSync(OXLINTRC)) {
  console.error(`::error::.oxlintrc.json missing at ${OXLINTRC}`);
  process.exit(2);
}
if (!existsSync(COMPONENTS_JSON)) {
  console.error(`::error::components.json missing at ${COMPONENTS_JSON}`);
  process.exit(2);
}

const result = runOxlint();
const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';

if (stderr.trim().length > 0) {
  console.error('--- oxlint stderr ---');
  console.error(stderr);
}

if (result.error) {
  console.error(`::error::oxlint invocation failed: ${result.error.message}`);
  process.exit(2);
}

if (result.status === 0) {
  console.error('  result: PASS — plugin loaded, no offences reported.');
  process.exit(0);
}

if (result.status === 1) {
  // oxlint returns 1 on offences. In dormant install we expect zero — any
  // offence here likely means rules were enabled by mistake.
  console.error(
    `::error::oxlint reported offences (status=1) — dormant install expected zero. Inspect stdout and .oxlintrc.json.`,
  );
  if (stdout.trim().length > 0) {
    console.error('--- oxlint stdout ---');
    console.error(stdout);
  }
  process.exit(1);
}

console.error(
  `::error::oxlint exited with unexpected status ${result.status}. Plugin may have failed to load — check .oxlintrc.json and components.json.`,
);
process.exit(2);
