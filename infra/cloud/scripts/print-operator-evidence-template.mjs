#!/usr/bin/env node
// print-operator-evidence-template.mjs — task fb1240c0 (Slice D)
//
// The blank operator read-back record.
//
// WHY THIS EXISTS
//
// Five Slice D obligations can only be closed by a person: the Fly
// spend-limit read-back (Fly exposes no limit API), the staging/dev Neon
// denial proof (it needs credentials), one successful production probe
// interval (it is time-based), the production API health responses (they
// are network-bound) and the DNS resolution/TLS read-back (also
// network-bound). The repository owns the record for those five — the
// `operatorEvidence` section of the captured artifact — and the checker
// compares a recorded slot against the production surfaces it must cover.
//
// Without a template the operator had to guess those surface strings. The
// checker then answered "it does not name sindustries-platform-production",
// and every attempt cost a full re-capture of five provider APIs because
// the record is merged by the capture. A surface name is not a discovery:
// it is a fact the repository already owns.
//
// So this script prints the SAME record, with every slot's surfaces
// pre-filled from the repository's own facts — the environment manifest
// and the hostname matrix — and every slot marked `recorded: false`. The
// operator fills in WHEN the read-back happened, WHAT it covered and
// WHERE the read-back lives, and the capture merges the result.
//
// THE TEMPLATE IS NOT A RECORD
//
// Every slot starts at `recorded: false`. The capture merges the file
// (it is a well-formed operator evidence section), but an unrecorded slot
// closes nothing: the checker still reports all five obligations as
// operator-required, and the ordering gate still fails while production
// is exposed. So the template can never be mistaken for an attestation —
// and it fails closed too: if any slot's expected surface set is empty,
// this script refuses to print, because a template that names no surface
// would produce a record that proves nothing.
//
// Usage:
//   node infra/cloud/scripts/print-operator-evidence-template.mjs [--repo-root <path>] [--out <path>]
//
// The JSON goes to stdout, or to --out. The human guidance for each slot
// goes to stderr, so stdout stays pipeable.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPERATOR_EVIDENCE_SLOTS,
  operatorEvidenceTemplate,
} from '../platform/production-operator-evidence.mjs';
import { loadOperatorTargetExpectations } from '../platform/production-operator-targets.mjs';

const REPO_ROOT_DEFAULT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{repoRoot: string, out: string|null}}
 */
export function parseArgs(argv) {
  const options = { repoRoot: REPO_ROOT_DEFAULT, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--repo-root':
        options.repoRoot = resolve(value);
        index += 1;
        break;
      case '--out':
        options.out = resolve(value);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Which slots cannot be printed because the repository names no surface
 * for them.
 *
 * @param {Record<string, string[]>} expectedTargets
 * @returns {Array<{slot: string, coverage: string, step: string, owner: string}>}
 */
export function slotsWithoutSurfaces(expectedTargets) {
  return OPERATOR_EVIDENCE_SLOTS.filter((entry) => {
    const targets = expectedTargets?.[entry.coverage];
    return !Array.isArray(targets) || targets.length === 0;
  }).map((entry) => ({
    slot: entry.slot,
    coverage: entry.coverage,
    step: entry.step,
    owner: entry.owner,
  }));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(
      'usage: node infra/cloud/scripts/print-operator-evidence-template.mjs [--repo-root <path>] [--out <path>]\n',
    );
    process.exit(2);
  }

  const expectedTargets = await loadOperatorTargetExpectations(options.repoRoot);

  const empty = slotsWithoutSurfaces(expectedTargets);
  if (empty.length > 0) {
    process.stderr.write(
      'refusing to print an operator evidence template: the repository names no production surface for ' +
        `${empty.map((entry) => `"${entry.slot}" (${entry.coverage}, ${entry.step}, owner ${entry.owner})`).join(', ')}\n`,
    );
    process.exit(1);
  }

  const template = operatorEvidenceTemplate(expectedTargets);
  const json = `${JSON.stringify(template, null, 2)}\n`;

  if (options.out) {
    writeFileSync(options.out, json);
  } else {
    process.stdout.write(json);
  }

  process.stderr.write('Operator read-backs to record (a template is not a record — every slot starts unrecorded):\n');
  for (const entry of OPERATOR_EVIDENCE_SLOTS) {
    const targets = expectedTargets[entry.coverage];
    process.stderr.write(`\n- ${entry.slot} — ${entry.label}\n`);
    process.stderr.write(`  step ${entry.step}, owner ${entry.owner}\n`);
    process.stderr.write(`  surfaces: ${targets.join(', ')}\n`);
    process.stderr.write(`  what to do: ${entry.hint}\n`);
    process.stderr.write('  fill in: readBackAt (ISO-8601), scope, evidenceRef (a pointer, never the value)\n');
  }
}

main().catch((error) => {
  process.stderr.write(`failed to print the operator evidence template: ${error.message}\n`);
  process.exit(1);
});
