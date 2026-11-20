#!/usr/bin/env node
/**
 * check-production-hostnames.mjs — refuse a manifest that names a
 * PRODUCTION hostname (task 020f423e).
 *
 * Usage:
 *   node scripts/cloud/cutover/check-production-hostnames.mjs <manifest.json>
 *
 * Exit codes:
 *   0  the manifest names no production hostname
 *   1  it names at least one; the offending hosts are named on stderr
 *   2  invalid usage
 *
 * WHY IT IS ITS OWN FILE
 *   The rehearsal and the harness test must agree on exactly which
 *   hosts count as production, and they must agree without either of
 *   them restating the rule. This file is the ONE implementation of
 *   that rule, and the rule itself lives with the manifest contract in
 *   infra/cloud/cutover/manifest.mjs, where it is unit tested.
 *
 *   It lives here, next to the manifest contract and the route
 *   adapter, because it is cutover machinery — not an operator shell
 *   script. The operator scripts under scripts/cloud/cutover/ can be
 *   overridden wholesale by the harness (CUTOVER_SCRIPTS_DIR_OVERRIDE),
 *   and a guard that disappears with the override is not a guard.
 *
 * WHY THE RULE IS NOT A PLAIN SUFFIX TEST
 *   The stable production hostnames are the bare per-service names
 *   (`tasks-api.sindustries.co.nz`) and the stable STAGING hostnames
 *   are the per-service names under the environment label
 *   (`tasks-api.staging.sindustries.co.nz`). The staging hosts END WITH
 *   the production domain, so a plain suffix test reads the rehearsal's
 *   own target as a production hostname and refuses it. That is the
 *   defect this checker exists to fix: it made AC4's rehearsal
 *   impossible to run against the real staging domain (2026-11-20).
 */

import {
  findProductionHostnames,
  loadManifest,
} from './manifest.mjs';

const manifestPath = process.argv[2];

if (!manifestPath) {
  process.stderr.write(
    'usage: check-production-hostnames.mjs <manifest.json>\n',
  );
  process.exit(2);
}

let manifest;
try {
  manifest = loadManifest(manifestPath);
} catch (error) {
  // The validator's message is the reason. A node stack trace is not a
  // reason, and it carries absolute paths that have no business in a
  // task comment.
  process.stderr.write('the manifest is invalid: ' + error.message + '\n');
  process.exit(1);
}

const offenders = findProductionHostnames(manifest);

if (offenders.length > 0) {
  process.stderr.write(
    'the rehearsal refuses production hostnames: ' +
      offenders.map((offender) => offender.id + ':' + offender.host).join(', ') +
      '\n',
  );
  process.exit(1);
}

process.exit(0);
