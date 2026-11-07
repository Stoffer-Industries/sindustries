#!/usr/bin/env node
// check-staging-target-preflight.mjs — task 219fb673, PR #936.
//
// The staging-validation preflight must reject a target that is NOT the
// surface it claims to be. The prior check derived ONE allow-list from
// every staging hostname in the matrix and applied it to all three
// target variables, so:
//
//   STAGING_TASKS_API_URL=https://budget-api.staging.sindustries.co.nz
//
// passed. Every service exposes /health, so the harness probed the WRONG
// service, got 200, and reported `tasks.health: pass` — a wrong-service
// validation reported as a success. A platform-host URL with the wrong
// path prefix passed for the same reason.
//
// This checker resolves the allowed (host, pathPrefix) pairs PER TARGET
// from infra/cloud/hostname-matrix.json (`stagingRoutes`), so a target is
// only accepted if its host AND its path belong to its own surface.
//
// It NEVER resolves DNS. The stable staging hostnames do not resolve yet
// (the CNAME gap on task 5cb4a8fe) and must remain valid targets, so
// this is a pure string check on the configured value.
//
// Usage:
//   node tests/cloud/scripts/check-staging-target-preflight.mjs \
//     --target <label> <surface-id> <url> [--target ...]
//
// Exits 0 when every target is valid, 1 with one `::error::` line per
// rejected target otherwise.
//
// The exported functions are unit-tested directly by
// tests/cloud/tests/check-staging-target-preflight.test.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MATRIX_PATH = join(REPO_ROOT, 'infra/cloud/hostname-matrix.json');

/**
 * Parse a target URL into its scheme, host and path.
 *
 * Deliberately hand-rolled rather than using `new URL()`: WHATWG URL
 * lowercases the host and normalises the path on its own, and this
 * checker must be able to REPORT a wrong-case host as accepted-after-
 * normalisation without hiding the original text from the error message.
 */
export function parseTargetUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') {
    return { ok: false, reason: 'the value is empty' };
  }
  const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/);
  if (!schemeMatch) {
    return { ok: false, reason: 'the value is not an absolute URL (an https:// scheme is required)' };
  }
  const scheme = schemeMatch[1].toLowerCase();
  const remainder = schemeMatch[2];
  const slash = remainder.indexOf('/');
  const authority = slash === -1 ? remainder : remainder.slice(0, slash);
  const path = slash === -1 ? '' : remainder.slice(slash);
  // Strip any query/fragment; only the path selects the route.
  const pathOnly = path.split(/[?#]/)[0];
  if (authority === '') {
    return { ok: false, reason: 'the URL has no host' };
  }
  // Strip a port; the allow-list is host-based.
  const host = authority.replace(/:\d+$/, '');
  return { ok: true, scheme, host, hostLower: host.toLowerCase(), path: pathOnly };
}

/**
 * The staging routes a surface may be reached at.
 *
 * `stagingRoutes` is the source of truth: the stable hostname at the
 * root, and the consolidated platform host at that surface's path
 * prefix. A surface without `stagingRoutes` has no staging route at all.
 */
export function routesForSurface(matrix, surfaceId) {
  const surface = (matrix.surfaces ?? []).find((s) => s.id === surfaceId);
  if (!surface) return [];
  return surface.stagingRoutes ?? [];
}

/**
 * Whether a path belongs to a route's path prefix.
 *
 * An empty prefix means the root: only "" and "/" belong to it. A
 * non-empty prefix matches the prefix itself and anything under it.
 */
export function pathMatchesPrefix(path, pathPrefix) {
  if (pathPrefix === '') {
    return path === '' || path === '/';
  }
  return path === pathPrefix || path.startsWith(`${pathPrefix}/`);
}

/**
 * Check one configured target against its own surface's routes.
 *
 * Returns { ok: true } or { ok: false, reason } with a reason that names
 * the surface the host actually belongs to, so a cross-wired variable is
 * diagnosed rather than merely rejected.
 */
export function checkTarget(matrix, surfaceId, rawUrl) {
  const routes = routesForSurface(matrix, surfaceId);
  if (routes.length === 0) {
    return { ok: false, reason: `the hostname matrix records no staging route for the "${surfaceId}" surface` };
  }
  const parsed = parseTargetUrl(rawUrl);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  if (parsed.scheme !== 'https') {
    return { ok: false, reason: `the scheme is "${parsed.scheme}"; an https:// scheme is required` };
  }
  const allowed = routes.map((r) => `${r.host} (path ${r.pathPrefix === '' ? '/' : r.pathPrefix})`).join(' or ');

  const matching = routes.filter((r) => r.host.toLowerCase() === parsed.hostLower);
  if (matching.length === 0) {
    // Name the surface this host DOES belong to, if the matrix knows it.
    let owner = null;
    for (const surface of matrix.surfaces ?? []) {
      for (const route of surface.stagingRoutes ?? []) {
        if (route.host.toLowerCase() === parsed.hostLower) {
          owner = surface.id;
          break;
        }
      }
      if (owner) break;
    }
    const ownership = owner
      ? `; host ${parsed.host} is the ${owner} surface`
      : `; host ${parsed.host} is not a staging host of this project`;
    return { ok: false, reason: `host ${parsed.host} is not a route of the ${surfaceId} surface${ownership}. Allowed: ${allowed}` };
  }
  const route = matching.find((r) => pathMatchesPrefix(parsed.path, r.pathPrefix));
  if (!route) {
    // The host is right but the path is not. Report the prefix the host
    // DOES serve under, so the operator can see what to fix.
    const prefixes = matching.map((r) => `"${r.pathPrefix || '/'}"`).join(' or ');
    return {
      ok: false,
      reason: `host ${parsed.host} is a route of the ${surfaceId} surface, but the path "${parsed.path || '/'}" is not under its prefix. The ${surfaceId} surface is served at ${prefixes} on that host. Allowed: ${allowed}`,
    };
  }
  return { ok: true };
}

export function loadMatrix(path = MATRIX_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Parse `--target <label> <surface-id> <url>` triples.
 */
export function parseArgs(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--target') {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
    const label = argv[i + 1];
    const surfaceId = argv[i + 2];
    const url = argv[i + 3];
    if (label === undefined || surfaceId === undefined || url === undefined) {
      throw new Error('--target requires three values: <label> <surface-id> <url>');
    }
    targets.push({ label, surfaceId, url });
    i += 3;
  }
  return targets;
}

function main() {
  let targets;
  try {
    targets = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(2);
  }
  if (targets.length === 0) {
    process.stderr.write('::error::no --target arguments were given\n');
    process.exit(2);
  }

  const matrix = loadMatrix();
  let failed = 0;
  for (const { label, surfaceId, url } of targets) {
    const result = checkTarget(matrix, surfaceId, url);
    if (result.ok) {
      process.stdout.write(`ok: ${label} -> ${surfaceId} (${url})\n`);
    } else {
      failed += 1;
      process.stderr.write(`::error::${label} -> ${result.reason}\n`);
    }
  }
  if (failed > 0) {
    process.stderr.write(
      '::error::the staging targets must each point at their own surface. Point them at the stable staging hostname for that surface, or at the consolidated platform host with that surface\'s path prefix. The per-service staging apps were destroyed at the 2026-11-07 consolidation (task 219fb673).\n'
    );
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, so the unit test can import the
// exported functions without executing the CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
