#!/usr/bin/env node
// check-production-blockers-register.mjs — task 5cb4a8fe AC6 static check.
//
// `docs/cloud/production-blockers.md` is the AC6 evidence register: the
// operator-facing list of the DNS records, TLS certificates, provider
// bindings and env vars that must exist before a production hostname
// resolves to a real deployment. It is the ONLY place that tells an
// operator which Vercel project or Fly app a hostname must point at, so
// a stale identifier in it is not a documentation nit — it is a
// wrong-deployment instruction.
//
// This check asserts the register still agrees with
// `infra/cloud/hostname-matrix.json`, the source of truth:
//
//   1. Coverage — every surface in the matrix that has a production
//      hostname has a row in the register that names that hostname.
//   2. Contract identifier — one of those rows also names the surface's
//      contract identifier (vercelProject for a Vercel frontend, flyApp
//      for a Fly app) as an EXACT code span. Exactness matters:
//      `sindustries-tasks` and `sindustries-tasks-api` are different
//      projects/apps, and a substring match would let the Tasks app row
//      satisfy the Tasks API surface and vice versa.
//   3. Non-public surfaces — a surface the matrix records as
//      publicUrl:false is recorded in the register as having no public
//      hostname, so it never gets a DNS row by accident.
//
// The failure this catches is the one that already happened once: the
// matrix and the register both name Vercel projects that do not exist in
// the Vercel team, while the live staging deployments sit under
// different project names. The register is what the operator reads, so
// the divergence has to be carried in both files until the project-model
// decision lands.
//
// Pure Node 22, no deps. Exits 0 on success, 1 on any violation.
//
// Usage:
//   node tests/cloud/scripts/check-production-blockers-register.mjs [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

function parseArgs() {
  const args = process.argv.slice(2);
  return { repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

const MATRIX_PATH = 'infra/cloud/hostname-matrix.json';
const REGISTER_PATH = 'docs/cloud/production-blockers.md';

// Markers that record "this surface has no public hostname" in a register
// row. Matched case-insensitively against the row's normalised text.
const NO_HOSTNAME_MARKERS = [
  'no public url',
  'no production hostname',
  'no hostname',
  'not applicable',
  'none',
];

/** Normalise a label so `Tasks app`, `tasks-app` and `TASKS_APP` compare equal. */
function normalise(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Extract the exact contents of every `code span` in a table row. */
function codeSpans(cellText) {
  const spans = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(cellText)) !== null) spans.push(m[1]);
  return spans;
}

/** Table rows in the register: lines that start and end with a pipe. */
function tableRows(registerText) {
  const rows = [];
  for (const line of registerText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    // Skip the `| --- | --- |` separator rows.
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^-{2,}$/.test(c))) continue;
    rows.push({ line: trimmed, cells, text: normalise(trimmed), spans: codeSpans(trimmed) });
  }
  return rows;
}

function contractIdentifierFor(surface) {
  if (surface.kind === 'frontend') {
    return surface.vercelProject ? { field: 'vercelProject', value: surface.vercelProject } : null;
  }
  if (surface.kind === 'api') {
    return surface.flyApp ? { field: 'flyApp', value: surface.flyApp } : null;
  }
  return null;
}

function main() {
  const { repoRoot } = parseArgs();
  const errors = [];

  let matrix;
  let registerText;
  try {
    matrix = JSON.parse(readFileSync(join(repoRoot, MATRIX_PATH), 'utf8'));
    registerText = readFileSync(join(repoRoot, REGISTER_PATH), 'utf8');
  } catch (err) {
    stderr.write(`production-blockers-register check failed (cannot read inputs): ${err.message}\n`);
    exit(1);
  }

  const rows = tableRows(registerText);
  const surfaces = matrix.surfaces ?? [];

  let publicSurfaces = 0;
  let nonPublicSurfaces = 0;

  for (const surface of surfaces) {
    const id = surface.id ?? '(unnamed surface)';

    if (surface.publicUrl === false) {
      // (3) Non-public surface: the register must say so explicitly.
      nonPublicSurfaces += 1;
      const wanted = normalise(id);
      const row = rows.find((r) => r.text.includes(wanted) && NO_HOSTNAME_MARKERS.some((m) => r.text.includes(m)));
      if (!row) {
        errors.push(
          `${id}: the matrix records publicUrl:false, so ${REGISTER_PATH} must record that it has no public hostname (no row names it as hostname-less)`
        );
      }
      continue;
    }

    if (typeof surface.production !== 'string') {
      errors.push(`${id}: the matrix has no production hostname and no publicUrl:false flag — the register cannot classify it`);
      continue;
    }

    publicSurfaces += 1;
    const hostname = surface.production;

    // (1) Coverage: at least one register row names the production hostname.
    const namingRows = rows.filter((r) => r.text.includes(normalise(hostname)));
    if (namingRows.length === 0) {
      errors.push(`${id}: no row in ${REGISTER_PATH} names the production hostname ${hostname}`);
      continue;
    }

    // (2) Contract identifier: one of those rows must also carry the exact
    // identifier the matrix records, so the operator is pointed at the same
    // project/app the matrix names.
    const identifier = contractIdentifierFor(surface);
    if (!identifier) continue; // No identifier recorded for this surface kind.
    const carries = namingRows.some((r) => r.spans.includes(identifier.value));
    if (!carries) {
      errors.push(
        `${id}: the ${REGISTER_PATH} row(s) naming ${hostname} do not carry the matrix ${identifier.field} \`${identifier.value}\` as an exact code span — the register and ${MATRIX_PATH} disagree about which ${identifier.field} this hostname belongs to`
      );
    }
  }

  if (errors.length > 0) {
    stderr.write(
      `production-blockers-register check failed (${errors.length} issue${errors.length === 1 ? '' : 's'} across ${publicSurfaces} public surface${publicSurfaces === 1 ? '' : 's'} / ${nonPublicSurfaces} non-public surface${nonPublicSurfaces === 1 ? '' : 's'}):\n`
    );
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }

  stdout.write(
    `production-blockers-register check passed (${publicSurfaces} public surface${publicSurfaces === 1 ? '' : 's'} / ${nonPublicSurfaces} non-public surface${nonPublicSurfaces === 1 ? '' : 's'} recorded in ${REGISTER_PATH}, all identifiers matching ${MATRIX_PATH})\n`
  );
}

main();
