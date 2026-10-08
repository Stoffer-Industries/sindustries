#!/usr/bin/env node
// check-cors-origin-matrix.mjs — task 5cb4a8fe slice 2 static check (AC3).
//
// AC3: "CORS/origin configuration, frontend build-time API URLs, and
// service-to-service base URLs are updated consistently for both
// environments." This script enforces the CORS half of AC3: every
// CORS_ALLOWED_ORIGINS value declared in an in-scope fly.toml must be a
// stable hostname from infra/cloud/hostname-matrix.json. Catches drift
// between the deploy config and the matrix without redeploying.
//
// Pure Node 22, no deps. Exits 0 on full success, 1 if any non-matrix
// origin is found, or if a staging fly.toml references a production
// hostname (or vice versa). The matching
// `tests/cloud/tests/check-cors-origin-matrix.test.mjs` exercises the
// script's exit code via execFile on a synthetic fixtures tree.
//
// Usage:
//   node scripts/check-cors-origin-matrix.mjs [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

function parseArgs() {
  const args = process.argv.slice(2);
  return { repoRoot: args[0] ? resolve(args[0]) : DEFAULTS };
}

const SCAN_ROOT = 'infra/cloud/fly';
const MATRIX_PATH = 'infra/cloud/hostname-matrix.json';
// CORS_ALLOWED_ORIGINS is per-service; only the api/frontend surfaces
// that take browser-originated requests are in scope. auto-post-worker
// has no HTTP surface (matrix records publicUrl=false) and is
// intentionally excluded.
const IN_SCOPE_FLY_TOML = new Set([
  'tasks-api.fly.toml',
  'budget-api.fly.toml',
  'content-scheduler-api.fly.toml',
]);
const CORS_ENV_KEY = 'CORS_ALLOWED_ORIGINS';
// Staging fly.toml files all use the `-staging` Fly app suffix. Match
// the Fly app name line, not the filename, so a future rename doesn't
// silently move a staging config to the production-check path or vice
// versa.
const STAGING_APP_SUFFIX = '-staging';

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

function loadMatrix(repoRoot) {
  const p = join(repoRoot, MATRIX_PATH);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const staging = new Set();
  const production = new Set();
  for (const s of raw.surfaces ?? []) {
    if (typeof s.staging === 'string') staging.add(s.staging);
    if (typeof s.production === 'string') production.add(s.production);
  }
  return { staging, production };
}

function parseAppName(text) {
  // TOML top-level: `app = 'value'`. We only care about the first match.
  const m = text.match(/^\s*app\s*=\s*['"]([^'"]+)['"]/m);
  return m ? m[1] : null;
}

function parseCorsOrigins(text) {
  // Match the CORS_ALLOWED_ORIGINS env value within a [env] block. Keep
  // it simple — single-quoted, comma-separated list, no multiline
  // values in current scope. If we ever need those, this parser will
  // need to be extended.
  const m = text.match(new RegExp(`^\\s*${CORS_ENV_KEY}\\s*=\\s*'([^']*)'`, 'm'));
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOrigin(origin) {
  // Accept either a full origin (scheme://host[:port]) or a bare
  // hostname. CORS_ALLOWED_ORIGINS in the CsvList parser is compared
  // against req.headers.origin, which browsers always send with a
  // scheme — but a deploy-config author may write either shape, and
  // the matrix values themselves are bare hostnames. Normalize so both
  // pass the host-in-matrix check.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
    try { return Boolean(new URL(origin).host); } catch { return false; }
  }
  // Bare hostname: must look like a domain (letters/digits/dots/hyphens).
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?$/.test(origin);
}

function main() {
  const { repoRoot } = parseArgs();
  const errors = [];
  const { staging, production } = loadMatrix(repoRoot);

  const absRoot = join(repoRoot, SCAN_ROOT);
  let st;
  try { st = statSync(absRoot); } catch {
    stderr.write(`cors-origin-matrix check skipped: ${SCAN_ROOT} not found\n`);
    exit(0);
  }
  if (!st.isDirectory()) exit(0);

  const files = listFiles(absRoot).filter((p) => IN_SCOPE_FLY_TOML.has(relative(absRoot, p)));
  let checked = 0;
  let originsChecked = 0;

  for (const file of files) {
    const rel = relative(repoRoot, file);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const appName = parseAppName(text);
    const origins = parseCorsOrigins(text);
    if (!origins) continue; // no CORS env var; nothing to enforce
    checked += 1;
    const isStaging = appName ? appName.endsWith(STAGING_APP_SUFFIX) : null;
    for (const origin of origins) {
      originsChecked += 1;
      if (!isOrigin(origin)) {
        errors.push(`${rel}: CORS origin ${JSON.stringify(origin)} is not a valid origin or hostname`);
        continue;
      }
      let hostnameOnly;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
        let host;
        try { host = new URL(origin).host; } catch { continue; }
        hostnameOnly = host.split(':')[0];
      } else {
        hostnameOnly = origin.split(':')[0];
      }
      const inStaging = staging.has(hostnameOnly);
      const inProduction = production.has(hostnameOnly);
      if (!inStaging && !inProduction) {
        errors.push(`${rel}: CORS origin host ${JSON.stringify(hostnameOnly)} is not in ${MATRIX_PATH}; add it to the matrix first (or fix a typo)`);
        continue;
      }
      if (isStaging === true && !inStaging) {
        errors.push(`${rel}: CORS origin ${JSON.stringify(origin)} references a production hostname but the Fly app ${JSON.stringify(appName)} is a staging app`);
      } else if (isStaging === false && !inProduction) {
        errors.push(`${rel}: CORS origin ${JSON.stringify(origin)} references a staging hostname but the Fly app ${JSON.stringify(appName)} is a production app`);
      }
    }
  }

  if (errors.length > 0) {
    stderr.write(`cors-origin-matrix check failed (${errors.length} issue${errors.length === 1 ? '' : 's'} across ${checked} fly.toml${checked === 1 ? '' : 's'}):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  stdout.write(`cors-origin-matrix check passed (${originsChecked} origin${originsChecked === 1 ? '' : 's'} across ${checked} fly.toml${checked === 1 ? '' : 's'} all matrix-derived)\n`);
}

main();
