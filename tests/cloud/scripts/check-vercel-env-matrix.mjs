#!/usr/bin/env node
// check-vercel-env-matrix.mjs — task 5cb4a8fe slice 5 static check (AC3 Vercel half).
//
// AC3: "Vercel domains, Fly custom domains, CORS/origin configuration, frontend
// build-time API URLs, and service-to-service base URLs are updated consistently
// for both environments." This script enforces the Vercel half of AC3: every
// VITE_* value in infra/cloud/vercel-env-matrix.json must be derived from the
// staging or production hostname recorded in infra/cloud/hostname-matrix.json.
//
// Pure Node 22, no deps. Exits 0 on full success, 1 if any value's host is
// not in the matrix, or if a production env var references a staging hostname
// (or vice versa). The matching
// `tests/cloud/tests/check-vercel-env-matrix.test.mjs` exercises the script's
// exit code via execFile on synthetic fixtures trees.
//
// Usage:
//   node scripts/check-vercel-env-matrix.mjs [<repo-root>]
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
const VERCEL_ENV_MATRIX_PATH = 'infra/cloud/vercel-env-matrix.json';

// Explicit mapping from VITE_* env var name → matrix surface id. We use an
// allow-list rather than regex-derived parsing so non-matrix env vars
// (e.g. VITE_BOOKMARK_STATE_BASE_URL, VITE_AUTH_PROVIDER) are skipped
// silently instead of being flagged as matrix-drift. Add an entry here
// when a new matrix-derived VITE_* env var ships; the static check
// enforces the host is the matrix value for the relevant environment.
const ENV_VAR_TO_SURFACE = Object.freeze({
  VITE_TASKS_API_BASE_URL: 'tasks-api',
  VITE_CONTENT_SCHEDULER_API_BASE_URL: 'content-scheduler-api',
  VITE_BUDGET_API_BASE_URL: 'budget-api',
  VITE_HEALTH_PROBE_BASE_URL: 'health-probe',
});

function loadMatrix(repoRoot) {
  const p = join(repoRoot, MATRIX_PATH);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  // surface id -> hostname: used to look up the expected hostname for a
  // matrix-derived VITE_* env var.
  const staging = new Map();
  const production = new Map();
  // hostname -> surface id: used to validate a committed customDomain is
  // actually in the matrix.
  const stagingByHost = new Map();
  const productionByHost = new Map();
  // Vercel project id -> the surface it belongs to, the environment it
  // serves and the hostname that environment binds. The hostname matrix
  // records a frontend surface's production project (`vercelProject`)
  // and its staging project (`vercelStagingProject`) separately, and
  // each project serves its own environment's hostname. This map is what
  // binds a project in this matrix to a surface: without it, a project
  // that no frontend surface references could claim ANY hostname in the
  // matrix — an API surface's hostname included — and both this check
  // and the CI-wired hostname-matrix check would stay green.
  const frontendProjects = new Map();
  for (const s of raw.surfaces ?? []) {
    if (typeof s.staging === 'string') {
      staging.set(s.id, s.staging);
      stagingByHost.set(s.staging, s.id);
    }
    if (typeof s.production === 'string') {
      production.set(s.id, s.production);
      productionByHost.set(s.production, s.id);
    }
    if (s.kind !== 'frontend') continue;
    if (typeof s.vercelProject === 'string') {
      frontendProjects.set(s.vercelProject, {
        surfaceId: s.id,
        environment: 'production',
        host: typeof s.production === 'string' ? s.production : null,
      });
    }
    if (typeof s.vercelStagingProject === 'string') {
      frontendProjects.set(s.vercelStagingProject, {
        surfaceId: s.id,
        environment: 'staging',
        host: typeof s.staging === 'string' ? s.staging : null,
      });
    }
  }
  return { staging, production, stagingByHost, productionByHost, frontendProjects };
}

function loadVercelMatrix(repoRoot) {
  const p = join(repoRoot, VERCEL_ENV_MATRIX_PATH);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Extract the host portion of a URL or bare hostname. The env var values
// committed in vercel-env-matrix.json are always full https://<host>/<path>
// URLs, but the parser accepts either shape so a future refactor to bare
// hostnames still works.
function hostOf(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).host.split(':')[0];
    } catch {
      return null;
    }
  }
  return value.split(':')[0];
}

function main() {
  const { repoRoot } = parseArgs();
  const errors = [];
  const { staging, production, stagingByHost, productionByHost, frontendProjects } = loadMatrix(repoRoot);
  const vercel = loadVercelMatrix(repoRoot);

  let projectCount = 0;
  let envCount = 0;
  let envVarCount = 0;
  let matrixDerivedCount = 0;

  const listedProjects = new Set();

  for (const project of vercel.vercelProjects ?? []) {
    projectCount += 1;
    const pid = project.vercelProjectId;
    listedProjects.add(pid);
    // The matrix records whether the project exists in the Vercel team
    // yet. Its whole point is to match reality, so the flag is required
    // and must be a boolean: a production project that has not been
    // created must not be able to read as a live one.
    if (typeof project.provisioned !== 'boolean') {
      errors.push(
        `${pid}: provisioned must be a boolean (found ${JSON.stringify(project.provisioned ?? null)}) — ` +
          `the env matrix records the contract, and a project that does not exist in the Vercel team yet must say so`,
      );
      continue;
    }
    const envEntries = Object.entries(project.environments ?? {});
    // One project, one environment. The project-model decision (task
    // 5cb4a8fe, Quinn 2026-11-13) makes the PROJECT the environment
    // separator: the staging project has no `preview` target, so a
    // project that carried two environments would be a project whose
    // environment identity is ambiguous again.
    if (envEntries.length !== 1) {
      errors.push(
        `${pid}: must carry exactly one Vercel environment (found ${envEntries.length}) — ` +
          `the project is the environment separator, not the Vercel environment`,
      );
      continue;
    }
    // A project may only exist in this matrix if the hostname matrix
    // records it as one of a frontend surface's projects.
    const binding = frontendProjects.get(pid);
    if (!binding) {
      errors.push(
        `${pid}: is not referenced by any frontend surface in ${MATRIX_PATH} — every project in this matrix must be ` +
          `the vercelProject or the vercelStagingProject of a frontend surface, so a project cannot claim a hostname ` +
          `that is not a frontend's`,
      );
      continue;
    }
    for (const [envName, envDef] of envEntries) {
      envCount += 1;
      // The datasource fetch below uses the matrix, not the Vercel
      // environment name: the staging project's single environment is its
      // production deployment target, so `envName` carries no
      // environment identity at all.
      const cdHost = hostOf(envDef.customDomain);
      if (!cdHost) {
        errors.push(`${pid}/${envName}: customDomain ${JSON.stringify(envDef.customDomain)} is not a valid hostname`);
        continue;
      }
      // The committed customDomain must match the staging or production
      // hostname for the matching surface in the matrix.
      const isProductionHost = productionByHost.has(cdHost);
      const isStagingHost = stagingByHost.has(cdHost);
      if (!isProductionHost && !isStagingHost) {
        errors.push(`${pid}/${envName}: customDomain ${JSON.stringify(cdHost)} is not a hostname in ${MATRIX_PATH}`);
        continue;
      }
      // The customDomain must also be the hostname of the surface this
      // project belongs to. The project id says which surface the
      // project is; the hostname matrix records the production project
      // and the staging project separately, and each serves its own
      // environment's hostname.
      if (binding.host && cdHost !== binding.host) {
        errors.push(
          `${pid}/${envName}: customDomain ${JSON.stringify(cdHost)} is not the ${binding.environment} hostname of the ` +
            `${binding.surfaceId} surface in ${MATRIX_PATH} (expected ${JSON.stringify(binding.host)}) — a project may ` +
            `only claim its own surface's hostname`,
        );
        continue;
      }
      const servesEnvironment = binding.environment;
      if (envDef.servesEnvironment !== servesEnvironment) {
        errors.push(
          `${pid}/${envName}: servesEnvironment ${JSON.stringify(envDef.servesEnvironment ?? null)} does not match ` +
            `the customDomain (${cdHost} is the ${servesEnvironment} hostname of the ${binding.surfaceId} surface in ${MATRIX_PATH})`,
        );
        continue;
      }
      // The branch the project builds from, recorded as an OBSERVED fact
      // (the branch the live deployment was built from). It must be
      // present and non-empty: an absent branch is how the recorded
      // `mission-control-vercel` branch — which does not exist in the
      // repository — stayed invisible to every check.
      if (typeof envDef.branch !== 'string' || envDef.branch.trim() === '') {
        errors.push(
          `${pid}/${envName}: branch must be a non-empty string — the env matrix records the branch the live ` +
            `deployment is built from, and an absent branch cannot be checked against the repository`,
        );
        continue;
      }
      const isProduction = servesEnvironment === 'production';
      for (const [envVarName, envVarValue] of Object.entries(envDef.env ?? {})) {
        envVarCount += 1;
        const actualHost = hostOf(envVarValue);
        if (!actualHost) {
          errors.push(`${pid}/${envName}/${envVarName}: value ${JSON.stringify(envVarValue)} is not a valid URL or hostname`);
          continue;
        }
        const surface = ENV_VAR_TO_SURFACE[envVarName];
        if (!surface) {
          // Not a matrix-derived env var (e.g. VITE_BOOKMARK_STATE_BASE_URL);
          // the contract is operator-owned and the static check intentionally
          // does not enforce. Tally but do not validate.
          continue;
        }
        matrixDerivedCount += 1;
        const expected = isProduction ? production.get(surface) : staging.get(surface);
        if (!expected) {
          errors.push(`${pid}/${envName}/${envVarName}: ${MATRIX_PATH} has no ${servesEnvironment} hostname for surface ${JSON.stringify(surface)}; add the surface to the matrix first`);
          continue;
        }
        // Cross-environment drift: a production env var value referencing
        // a staging hostname (or vice versa) is a sign the author mixed up
        // the Vercel environment when copying the URL. Check this first
        // so the error message tells the reviewer exactly what they did
        // wrong (mixed up environments) instead of the generic
        // "does not match" error.
        const otherEnvHost = isProduction ? staging.get(surface) : production.get(surface);
        const otherEnvName = isProduction ? 'staging' : 'production';
        if (otherEnvHost && actualHost === otherEnvHost) {
          errors.push(`${pid}/${envName}/${envVarName}: value references a ${otherEnvName} hostname (${actualHost}) but this project serves ${servesEnvironment}`);
          continue;
        }
        if (actualHost !== expected) {
          errors.push(`${pid}/${envName}/${envVarName}: host ${JSON.stringify(actualHost)} does not match the ${servesEnvironment} hostname in ${MATRIX_PATH} (expected ${JSON.stringify(expected)})`);
          continue;
        }
      }
    }
  }

  // Completeness: every frontend project the hostname matrix records
  // must appear here. A frontend surface's production project and its
  // staging project are the two halves of the separation; dropping one
  // would leave a surface with a contract that no project implements.
  for (const [pid, binding] of frontendProjects) {
    if (!listedProjects.has(pid)) {
      errors.push(
        `${pid}: the ${binding.environment} project of the ${binding.surfaceId} surface in ${MATRIX_PATH} is not listed ` +
          `in ${VERCEL_ENV_MATRIX_PATH} — every frontend project the hostname matrix records must appear here`,
      );
    }
  }

  if (errors.length > 0) {
    stderr.write(`vercel-env-matrix check failed (${errors.length} issue${errors.length === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'} / ${envCount} environment${envCount === 1 ? '' : 's'} / ${envVarCount} env var${envVarCount === 1 ? '' : 's'}, ${matrixDerivedCount} matrix-derived):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  stdout.write(`vercel-env-matrix check passed (${envVarCount} env var${envVarCount === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'} / ${envCount} environment${envCount === 1 ? '' : 's'}, ${matrixDerivedCount} matrix-derived all match ${MATRIX_PATH})\n`);
}

main();
