#!/usr/bin/env node
// check-stable-hostname-matrix.mjs — task 5cb4a8fe static check.
//
// Validates infra/cloud/hostname-matrix.json (the source of truth for the
// stable hostname matrix) and asserts that every per-hostname comment block
// at the top of each infra/cloud/fly/<service>.fly.toml names the same
// staging + production hostnames the matrix records.
//
// Pure Node 22, no deps. Exits 0 on full success, 1 if any assertion fails.
// Intended to be invoked from the merge gate (`node --test …`); the matching
// `tests/cloud/tests/check-stable-hostname-matrix.test.mjs` exercises the
// script's exit code via execFile.
//
// Usage:
//   node scripts/check-stable-hostname-matrix.mjs [<matrix.json> [<fly-dir> [<repo-root>]]]
//
// Defaults:
//   matrix    = <repo-root>/infra/cloud/hostname-matrix.json
//   fly-dir   = <repo-root>/infra/cloud/fly
//   repo-root = three parents up from this script (tests/cloud/scripts -> tests/cloud -> tests -> repo)

import { readFileSync, readdirSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..');
  return {
    matrix: join(repoRoot, 'infra/cloud/hostname-matrix.json'),
    flyDir: join(repoRoot, 'infra/cloud/fly'),
    repoRoot,
  };
})();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { matrix: DEFAULTS.matrix, flyDir: DEFAULTS.flyDir, repoRoot: DEFAULTS.repoRoot };
  let i = 0;
  if (args[i]) { out.matrix = args[i]; i += 1; }
  if (args[i]) { out.flyDir = args[i]; i += 1; }
  if (args[i]) { out.repoRoot = args[i]; i += 1; }
  return out;
}

const errors = [];

function fail(message) {
  errors.push(message);
}

function expect(cond, message) {
  if (!cond) fail(message);
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read ${path}: ${err.message}`);
    return null;
  }
}

function flyTomlForSurfaceId(surfaceId, flyFiles) {
  // Per-id mapping: tasks-api -> tasks-api.fly.toml etc. The auto-post-worker
  // row uses auto-post-worker.fly.toml; the matrix already records flyApp and
  // surface id matches the toml file name for every current row.
  const expected = `${surfaceId}.fly.toml`;
  const found = flyFiles.find((f) => f === expected);
  return found ? expected : null;
}

function readTomlCommentBlock(tomlPath) {
  // Returns the contiguous leading comment block (lines starting with `#`)
  // at the top of the file, joined with newlines. Used to assert that the
  // stable-hostname comment block names both the staging and production
  // hostname the matrix records.
  const text = readFileSync(tomlPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const block = [];
  for (const line of lines) {
    if (line.startsWith('#')) block.push(line);
    else if (line.trim() === '') continue;
    else break;
  }
  return block.join('\n');
}

function main() {
  const args = parseArgs();
  const matrix = loadJson(args.matrix);
  if (matrix === null) {
    stderr.write(`schema check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }

  // Top-level shape.
  expect(typeof matrix.taskId === 'string' && matrix.taskId.length > 0, 'matrix.taskId must be a non-empty string');
  expect(typeof matrix.apexDomain === 'string' && matrix.apexDomain.length > 0, 'matrix.apexDomain must be a non-empty string');
  expect(typeof matrix.stagingSubdomainSuffix === 'string' && matrix.stagingSubdomainSuffix.length > 0, 'matrix.stagingSubdomainSuffix must be a non-empty string');
  expect(typeof matrix.productionApex === 'string' && matrix.productionApex.length > 0, 'matrix.productionApex must be a non-empty string');
  expect(Array.isArray(matrix.surfaces), 'matrix.surfaces must be an array');
  expect(matrix.surfaces.length > 0, 'matrix.surfaces must contain at least one entry');

  // Required fields per surface; type-specific rules apply below.
  for (const [idx, surface] of matrix.surfaces.entries()) {
    const path = `surfaces[${idx}]`;
    expect(typeof surface.id === 'string' && /^[a-z0-9-]+$/.test(surface.id), `${path}.id must match /^[a-z0-9-]+$/`);
    expect(['frontend', 'api', 'worker'].includes(surface.kind), `${path}.kind must be one of frontend|api|worker`);
  }

  // One row per public surface + the explicit non-public worker row.
  const ids = matrix.surfaces.map((s) => s.id);
  const requiredPublic = ['mission-control', 'tasks-app', 'tasks-api', 'budget-api', 'content-scheduler-api', 'health-probe'];
  for (const req of requiredPublic) {
    expect(ids.includes(req), `surfaces must include public surface "${req}" (per docs/specs/add-stable-app-name-hostnames-tech-design.md Hostname matrix)`);
  }
  expect(ids.includes('auto-post-worker'), 'surfaces must include the auto-post-worker row (the matrix records the explicit non-public nature)');

  // Per-kind hostnames.
  for (const [idx, surface] of matrix.surfaces.entries()) {
    const path = `surfaces[${idx}] (${surface.id})`;
    if (surface.kind === 'worker') {
      expect(surface.publicUrl === false, `${path}.publicUrl must be false for a worker surface`);
      expect(typeof surface.rationale === 'string' && surface.rationale.length > 0, `${path}.rationale must be a non-empty string for a worker surface`);
      expect(surface.staging === null && surface.production === null, `${path} must have staging=null and production=null (worker has no public URL)`);
      expect(surface.providerFallback === null, `${path} must have providerFallback=null (worker has no public URL)`);
    } else {
      expect(typeof surface.staging === 'string' && surface.staging.length > 0, `${path}.staging must be a non-empty string`);
      expect(typeof surface.production === 'string' && surface.production.length > 0, `${path}.production must be a non-empty string`);
      expect(surface.staging.endsWith(`.${matrix.stagingSubdomainSuffix}`), `${path}.staging must end with ".${matrix.stagingSubdomainSuffix}"`);
      expect(surface.production.endsWith(`.${matrix.productionApex}`), `${path}.production must end with ".${matrix.productionApex}"`);
      expect(typeof surface.providerFallback === 'string' && surface.providerFallback.length > 0, `${path}.providerFallback must be a non-empty string`);
      if (surface.kind === 'frontend') {
        expect(surface.providerFallback.endsWith('.vercel.app'), `${path}.providerFallback must end with ".vercel.app" for a frontend surface`);
      } else if (surface.kind === 'api') {
        expect(surface.providerFallback.endsWith('.fly.dev'), `${path}.providerFallback must end with ".fly.dev" for an api surface`);
      }
    }
  }

  // Cross-row uniqueness for surface ids + hostnames.
  const seen = new Set();
  for (const [idx, surface] of matrix.surfaces.entries()) {
    const path = `surfaces[${idx}] (${surface.id})`;
    expect(!seen.has(surface.id), `${path}.id must be unique (duplicate "${surface.id}")`);
    seen.add(surface.id);
    if (surface.kind !== 'worker') {
      expect(!seen.has(surface.staging), `${path}.staging must be unique across the matrix (duplicate "${surface.staging}")`);
      expect(!seen.has(surface.production), `${path}.production must be unique across the matrix (duplicate "${surface.production}")`);
      seen.add(surface.staging);
      seen.add(surface.production);
    }
  }

  // Now read the fly.toml files and assert the comment block names the same
  // hostnames the matrix records. Worker surface is exempt — it has no
  // hostnames by design — but its comment block must still record the
  // "(none)" rule so the no-public-URL property is auditable from the
  // fly.toml itself.
  let flyFiles;
  try {
    flyFiles = readdirSync(args.flyDir).filter((f) => f.endsWith('.fly.toml')).sort();
  } catch (err) {
    fail(`could not read fly-dir ${args.flyDir}: ${err.message}`);
  }

  if (flyFiles) {
    for (const surface of matrix.surfaces) {
      // Per design §hostname matrix: only api/worker surfaces own a Fly
      // app and therefore a fly.toml. Frontend surfaces (mission-control,
      // tasks-app) are Vercel projects — the matrix records
      // vercelProject, not flyApp, and they have no fly.toml. Worker
      // surfaces still need a fly.toml because Fly supervises the
      // process even though there is no public URL.
      if (surface.kind === 'frontend') continue;
      const tomlName = flyTomlForSurfaceId(surface.id, flyFiles);
      if (tomlName === null) {
        // The health-probe surface is a planned Fly app (the design records
        // it as a hosted observability public endpoint). Until the deploy
        // surface lands, we don't fail the check on the missing toml —
        // but we do report the gap so reviewers see it.
        if (surface.id === 'health-probe') {
          stdout.write(`note: health-probe fly.toml not present yet (planned; see design §architecture)\n`);
          continue;
        }
        fail(`fly.toml for surface "${surface.id}" not found in ${args.flyDir} (expected ${surface.id}.fly.toml)`);
        continue;
      }
      const tomlPath = join(args.flyDir, tomlName);
      const block = readTomlCommentBlock(tomlPath);
      if (surface.kind === 'worker') {
        expect(block.includes('Stable hostname'), `${tomlName}: leading comment block must mention "Stable hostname" so the no-public-URL property is auditable from the toml itself`);
        expect(block.includes('(none)') || block.includes('NONE'), `${tomlName}: leading comment block must record "(none)" for staging and production (worker has no public URL)`);
        continue;
      }
      expect(block.includes('hostname-matrix.json'), `${tomlName}: leading comment block must reference the matrix source of truth (infra/cloud/hostname-matrix.json)`);
      expect(block.includes(surface.staging), `${tomlName}: leading comment block must mention staging hostname "${surface.staging}"`);
      expect(block.includes(surface.production), `${tomlName}: leading comment block must mention production hostname "${surface.production}"`);
    }
  }

  if (errors.length > 0) {
    stderr.write(`hostname matrix check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  stdout.write(`hostname matrix check passed (${matrix.surfaces.length} surface${matrix.surfaces.length === 1 ? '' : 's'})\n`);
}

main();
