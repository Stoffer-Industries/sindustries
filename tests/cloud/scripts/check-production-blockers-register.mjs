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
//   1. DNS table coverage — the §1 DNS table (the table an operator
//      actually follows) has exactly one row per surface with a
//      production hostname, and that row's hostname cell holds the
//      matrix hostname as an exact code span.
//   2. Contract identifier — that same DNS row names the surface's
//      contract identifier (vercelProject for a Vercel frontend, flyApp
//      for a Fly app) as an exact code span in its "Required DNS record"
//      cell, and names no other project/app identifier there. Exactness
//      matters: `sindustries-tasks` and `sindustries-tasks-api` are
//      different projects/apps, and a substring match would let the
//      Tasks app row satisfy the Tasks API surface and vice versa.
//   3. Identifier set — every row anywhere in the register that names
//      the production hostname carries that same identifier and no other
//      project/app identifier. The one exception is the "actually bound"
//      column of the §3 table, which deliberately names the live
//      staging project because that divergence is what the register
//      exists to record.
//   4. CNAME target — the DNS row records the matrix's
//      `cnameTargets.production` value as an exact code span, so the
//      operator is never left with a stale provider-host note.
//   5. Non-public surfaces — a surface the matrix records as
//      publicUrl:false is recorded in the register as having no public
//      hostname, and no row gives it one.
//
// Hostnames are matched as exact code spans, never as substrings: a row
// for `eu.health-probe.sindustries.co.nz` must not satisfy the
// `health-probe.sindustries.co.nz` surface, and the apex
// `sindustries.co.nz` must not satisfy every hostname in the document.
//
// The failure this catches is the one that already happened once: the
// matrix and the register both name Vercel projects that do not exist in
// the Vercel team, while the live staging deployments sit under
// different project names. The register is what the operator reads, so
// the divergence has to be carried in both files until the project-model
// decision lands.
//
// Pure Node, no deps (the CI job that runs this check does not pin a
// Node version). Exits 0 on success, 1 on any violation.
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

// The operator-facing DNS table lives under this heading.
const DNS_SECTION_RE = /^###\s+1\.\s+DNS\b/;

// Markers that record "this surface has no public hostname" in a register
// row. Compared against the row's normalised text, so the markers are
// normalised too — a literal comparison would only ever match the bare
// token `none`.
const NO_HOSTNAME_MARKERS = [
  'no public url',
  'no public hostname',
  'no production hostname',
  'no hostname',
  'not applicable',
  'none',
];

// A code span shaped like a project/app identifier (`sindustries-tasks-api`):
// no dots, no underscores, no spaces.
const IDENTIFIER_SPAN_RE = /^[a-z0-9][a-z0-9-]*$/i;

// A code span shaped like a hostname (`mission-control.sindustries.co.nz`).
const HOSTNAME_SPAN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

// Code spans that are environment labels rather than identifiers.
const NON_IDENTIFIER_SPANS = new Set([
  'preview',
  'production',
  'staging',
  'none',
  'na',
  'notapplicable',
  'pending',
  'closed',
]);

// The §3 table records the live staging project in a column of its own.
// That column is the one place a row may legitimately name a project
// other than the matrix contract value.
const BOUND_COLUMN_RE = /actually bound/i;

/** Normalise a label so `Tasks app`, `tasks-app` and `TASKS_APP` compare equal. */
function normalise(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Extract the exact contents of every `code span` in a table cell. */
function codeSpans(cellText) {
  const spans = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(cellText)) !== null) spans.push(m[1]);
  return spans;
}

/** Split a markdown table row into its cells. */
function splitCells(line) {
  return line.slice(1, -1).split('|').map((c) => c.trim());
}

/** True for the `| --- | --- |` separator row under a table header. */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/**
 * Parse every markdown table in `lines` into `{ header, rows }`, where each
 * row carries its cells, the code spans per cell, and the normalised row
 * text. The header row is the header, not a data row.
 */
function parseTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|') && i + 1 < lines.length) {
      const sepLine = lines[i + 1].trim();
      if (sepLine.startsWith('|') && sepLine.endsWith('|') && isSeparatorRow(splitCells(sepLine))) {
        const header = splitCells(line);
        const rows = [];
        let j = i + 2;
        while (j < lines.length) {
          const rowLine = lines[j].trim();
          if (!rowLine.startsWith('|') || !rowLine.endsWith('|')) break;
          const cells = splitCells(rowLine);
          rows.push({
            cells,
            cellSpans: cells.map(codeSpans),
            text: normalise(rowLine),
          });
          j += 1;
        }
        tables.push({ header, rows });
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return tables;
}

/** The lines of the `### 1. DNS …` section, or null when it is missing. */
function dnsSectionLines(lines) {
  const start = lines.findIndex((line) => DNS_SECTION_RE.test(line.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/** Index of the first header cell matching one of `patterns`, or -1. */
function columnIndex(header, patterns) {
  for (let i = 0; i < header.length; i += 1) {
    if (patterns.some((p) => p.test(header[i]))) return i;
  }
  return -1;
}

/** The matrix's contract identifier for a surface, or null for an unknown kind. */
function contractIdentifierFor(surface) {
  if (surface.kind === 'frontend') {
    // The staging project is load-bearing under the per-project model:
    // it is the project that actually serves the staging hostname, so
    // the "actually bound" column of the §3 table is checked against it.
    return {
      field: 'vercelProject',
      value: surface.vercelProject ?? null,
      stagingField: 'vercelStagingProject',
      stagingValue: surface.vercelStagingProject ?? null,
    };
  }
  if (surface.kind === 'api') {
    return { field: 'flyApp', value: surface.flyApp ?? null };
  }
  return null;
}

/** Identifier-like code spans in a row, minus the "actually bound" column. */
function identifierSpansInRow(row) {
  const spans = [];
  row.header.forEach((heading, idx) => {
    if (BOUND_COLUMN_RE.test(heading)) return;
    for (const span of row.cellSpans[idx] ?? []) {
      if (!IDENTIFIER_SPAN_RE.test(span)) continue;
      if (NON_IDENTIFIER_SPANS.has(normalise(span))) continue;
      spans.push(span);
    }
  });
  return spans;
}

/** Hostname-like code spans in a row. */
function hostnameSpansInRow(row) {
  return row.cellSpans.flat().filter((span) => HOSTNAME_SPAN_RE.test(span));
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

  const lines = registerText.split('\n');
  const tables = parseTables(lines);
  const allRows = tables.flatMap((table) => table.rows.map((row) => ({ ...row, header: table.header })));
  const surfaces = matrix.surfaces ?? [];

  // Every hostname the matrix knows about, so a cross-reference to another
  // surface is not mistaken for a hostname assigned to a non-public one,
  // and a provider host the matrix records as a CNAME target is not
  // mistaken for an unknown hostname.
  const knownHostnames = new Set();
  for (const surface of surfaces) {
    for (const key of ['staging', 'production']) {
      if (typeof surface[key] === 'string') knownHostnames.add(surface[key]);
    }
    for (const target of Object.values(surface.cnameTargets ?? {})) {
      if (typeof target === 'string') knownHostnames.add(target);
    }
  }
  if (typeof matrix.apexDomain === 'string') knownHostnames.add(matrix.apexDomain);

  // A hostname in the production namespace that the matrix does not record
  // is drift in the operator-facing document. Staging hostnames and
  // provider hosts are a different namespace and are left alone.
  const apex = typeof matrix.apexDomain === 'string' ? matrix.apexDomain : null;
  const stagingSuffix = typeof matrix.stagingSubdomainSuffix === 'string' ? matrix.stagingSubdomainSuffix : null;
  function isProductionShapedHostname(hostname) {
    if (!apex) return false;
    if (!hostname.endsWith(`.${apex}`)) return false;
    if (stagingSuffix && hostname.endsWith(`.${stagingSuffix}`)) return false;
    return true;
  }

  // (6) No row may name a production hostname the matrix does not record.
  for (const row of allRows) {
    for (const span of hostnameSpansInRow(row)) {
      if (knownHostnames.has(span)) continue;
      if (!isProductionShapedHostname(span)) continue;
      errors.push(
        `a row in ${REGISTER_PATH} names the production hostname ${span}, which ${MATRIX_PATH} does not record — the register and the matrix disagree about the production hostname set`
      );
    }
  }

  // (1) The operator-facing DNS table.
  const section = dnsSectionLines(lines);
  let dnsTable = null;
  let dnsSurfaceCol = -1;
  let dnsHostnameCol = -1;
  let dnsRecordCol = -1;
  let dnsCnameCol = -1;
  if (!section) {
    errors.push(`${REGISTER_PATH} has no "### 1. DNS" section — the operator-facing DNS table is missing`);
  } else {
    dnsTable = parseTables(section)[0] ?? null;
    if (!dnsTable) {
      errors.push(`${REGISTER_PATH} section "### 1. DNS" has no table — the operator-facing DNS table is missing`);
    } else {
      dnsSurfaceCol = columnIndex(dnsTable.header, [/surface/i]);
      dnsHostnameCol = columnIndex(dnsTable.header, [/production\s+hostname/i]);
      dnsRecordCol = columnIndex(dnsTable.header, [/dns\s+record/i]);
      dnsCnameCol = columnIndex(dnsTable.header, [/cname\s+target/i]);
      for (const [label, idx] of [
        ['Surface', dnsSurfaceCol],
        ['Production hostname', dnsHostnameCol],
        ['Required DNS record', dnsRecordCol],
        ['CNAME target', dnsCnameCol],
      ]) {
        if (idx === -1) {
          errors.push(`the §1 DNS table in ${REGISTER_PATH} has no "${label}" column`);
        }
      }
    }
  }

  let publicSurfaces = 0;
  let nonPublicSurfaces = 0;

  for (const surface of surfaces) {
    const id = surface.id ?? '(unnamed surface)';

    if (surface.publicUrl === false) {
      // (5) Non-public surface: recorded as hostname-less, and given no hostname.
      nonPublicSurfaces += 1;
      const wanted = normalise(id);
      const surfaceRows = allRows.filter((r) => r.text.includes(wanted));
      const marked = surfaceRows.find((r) =>
        NO_HOSTNAME_MARKERS.some((m) => r.text.includes(normalise(m)))
      );
      if (!marked) {
        errors.push(
          `${id}: the matrix records publicUrl:false, so ${REGISTER_PATH} must record that it has no public hostname (no row names it as hostname-less)`
        );
      }

      for (const row of surfaceRows) {
        for (const span of hostnameSpansInRow(row)) {
          if (knownHostnames.has(span)) continue;
          errors.push(
            `${id}: the matrix records publicUrl:false, but a row in ${REGISTER_PATH} pairs it with the hostname ${span} — a non-public surface must not be given a hostname`
          );
        }
      }

      if (dnsTable && dnsHostnameCol !== -1) {
        for (const row of dnsTable.rows) {
          if (!row.text.includes(wanted)) continue;
          const hostSpans = (row.cellSpans[dnsHostnameCol] ?? []).filter((span) =>
            HOSTNAME_SPAN_RE.test(span)
          );
          if (hostSpans.length > 0) {
            errors.push(
              `${id}: the matrix records publicUrl:false, but the §1 DNS table row for ${id} gives it the hostname ${hostSpans.join(', ')} — a non-public surface must not have a DNS row`
            );
          }
        }
      }
      continue;
    }

    if (typeof surface.production !== 'string') {
      errors.push(`${id}: the matrix has no production hostname and no publicUrl:false flag — the register cannot classify it`);
      continue;
    }

    publicSurfaces += 1;
    const hostname = surface.production;

    const identifier = contractIdentifierFor(surface);
    if (!identifier) {
      errors.push(
        `${id}: the matrix records surface kind "${surface.kind}" with a production hostname, but this check has no contract-identifier rule for that kind — the register cannot be verified against it`
      );
      continue;
    }
    if (!identifier.value) {
      errors.push(`${id}: the matrix records no ${identifier.field} for this ${surface.kind} surface — the register cannot name the project/app it points at`);
      continue;
    }

    // (1) DNS table coverage: exactly one row, and the hostname cell must
    // hold the matrix hostname as an exact code span.
    const dnsRows =
      dnsTable && dnsHostnameCol !== -1
        ? dnsTable.rows.filter((r) => (r.cellSpans[dnsHostnameCol] ?? []).includes(hostname))
        : [];
    if (!dnsTable || dnsHostnameCol === -1) {
      // The missing table/column is already reported above.
    } else if (dnsRows.length === 0) {
      errors.push(
        `${id}: no row in the §1 DNS table of ${REGISTER_PATH} names the production hostname ${hostname} — the hostname cell must hold exactly \`${hostname}\``
      );
    } else if (dnsRows.length > 1) {
      errors.push(
        `${id}: the §1 DNS table of ${REGISTER_PATH} has ${dnsRows.length} rows naming the production hostname ${hostname} — exactly one is expected`
      );
    }

    for (const row of dnsRows) {
      // (2) The DNS row an operator follows names the matrix identifier,
      // and names no other project/app.
      if (dnsRecordCol !== -1) {
        const recordSpans = row.cellSpans[dnsRecordCol] ?? [];
        if (!recordSpans.includes(identifier.value)) {
          errors.push(
            `${id}: the §1 DNS row for ${hostname} must name the matrix ${identifier.field} \`${identifier.value}\` as an exact code span in its "Required DNS record" cell — the operator follows this row, so it must name the project/app the matrix names`
          );
        }
        const extras = recordSpans.filter(
          (span) =>
            IDENTIFIER_SPAN_RE.test(span) &&
            span !== identifier.value &&
            !NON_IDENTIFIER_SPANS.has(normalise(span))
        );
        if (extras.length > 0) {
          errors.push(
            `${id}: the §1 DNS row for ${hostname} names more than one project/app identifier in its "Required DNS record" cell (${extras
              .map((s) => `\`${s}\``)
              .join(', ')}) — the operator must be pointed at exactly one project/app`
          );
        }
      }

      // (4) CNAME target: the matrix's production DNS target.
      const cnameTarget = surface.cnameTargets?.production;
      if (cnameTarget && dnsCnameCol !== -1) {
        const cnameSpans = row.cellSpans[dnsCnameCol] ?? [];
        if (!cnameSpans.includes(cnameTarget)) {
          errors.push(
            `${id}: the §1 DNS row for ${hostname} must record the matrix cnameTargets.production \`${cnameTarget}\` as an exact code span in its "CNAME target" cell`
          );
        }
        const otherTargets = cnameSpans.filter(
          (span) => HOSTNAME_SPAN_RE.test(span) && span !== cnameTarget
        );
        if (otherTargets.length > 0) {
          errors.push(
            `${id}: the §1 DNS row for ${hostname} records a CNAME target other than the matrix cnameTargets.production value (${otherTargets
              .map((s) => `\`${s}\``)
              .join(', ')})`
          );
        }
      }
    }

    // (3) Identifier set: every row that names the production hostname
    // carries the matrix identifier and no other project/app.
    const namingRows = allRows.filter((r) => r.cellSpans.some((spans) => spans.includes(hostname)));
    if (namingRows.length === 0) {
      errors.push(
        `${id}: no row in ${REGISTER_PATH} names the production hostname ${hostname} as an exact code span`
      );
      continue;
    }
    const union = new Set();
    for (const row of namingRows) {
      const spans = identifierSpansInRow(row);
      for (const span of spans) union.add(span);
      const extras = spans.filter((span) => span !== identifier.value);
      if (extras.length > 0) {
        errors.push(
          `${id}: a row in ${REGISTER_PATH} that names ${hostname} also names a different project/app identifier (${extras
            .map((s) => `\`${s}\``)
            .join(', ')}) — every row that names this hostname must point at the matrix ${identifier.field} \`${identifier.value}\``
        );
      }
    }
    if (!union.has(identifier.value)) {
      errors.push(
        `${id}: no row naming ${hostname} carries the matrix ${identifier.field} \`${identifier.value}\` as an exact code span — the register and ${MATRIX_PATH} disagree about which ${identifier.field} this hostname belongs to`
      );
    }

    // (6) The "actually bound" column names the live staging project.
    // Under the per-project model that column is load-bearing: it is
    // where an operator learns WHICH project serves the staging
    // hostname. The matrix records the staging project beside the
    // production one, so the cell must carry the matrix's
    // vercelStagingProject exactly — a rename in the matrix cannot leave
    // the register pointing an operator at a project that does not exist.
    if (identifier.stagingValue) {
      for (const row of namingRows) {
        const boundIdx = row.header.findIndex((heading) => BOUND_COLUMN_RE.test(heading));
        if (boundIdx === -1) continue;
        const spans = row.cellSpans[boundIdx] ?? [];
        if (!spans.includes(identifier.stagingValue)) {
          errors.push(
            `${id}: the "actually bound" cell of the row naming ${hostname} must name the matrix ${identifier.stagingField} ` +
              `\`${identifier.stagingValue}\` as an exact code span — the operator follows that cell to the live project`
          );
        }
        const extras = spans.filter(
          (span) =>
            IDENTIFIER_SPAN_RE.test(span) &&
            span !== identifier.stagingValue &&
            !NON_IDENTIFIER_SPANS.has(normalise(span))
        );
        if (extras.length > 0) {
          errors.push(
            `${id}: the "actually bound" cell of the row naming ${hostname} names more than one project/app identifier ` +
              `(${extras.map((s) => `\`${s}\``).join(', ')}) — it must name exactly the matrix ${identifier.stagingField}`
          );
        }
      }
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
