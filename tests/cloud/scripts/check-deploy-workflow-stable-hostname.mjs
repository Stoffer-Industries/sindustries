#!/usr/bin/env node
// check-deploy-workflow-stable-hostname.mjs — task 5cb4a8fe static check
// (AC4 — CI deploy workflows use the stable hostnames; slice 3 scope).
//
// Reads infra/cloud/hostname-matrix.json and asserts each api/worker
// surface owns a .github/workflows/deploy-staging-<service>.yml file
// whose smoke-check step targets the matrix's stable staging hostname
// (not the provider-shaped *.fly.dev URL). The four in-scope workflows
// (tasks-api, budget-api, content-scheduler-api, health-probe) are
// asserted explicitly; health-probe is permitted to be a no-op until
// its deploy surface lands (the matrix records the planned Fly app).
//
// Pure Node 22, no deps. Exits 0 on full success, 1 if any assertion
// fails. The matching
// `tests/cloud/tests/check-deploy-workflow-stable-hostname.test.mjs`
// exercises the script's exit code via execFile on a synthetic
// fixtures tree.
//
// Usage:
//   node scripts/check-deploy-workflow-stable-hostname.mjs [<repo-root>]
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

// api/worker surfaces whose deploy workflow must smoke-check the
// matrix stable staging hostname. Frontend surfaces are Vercel
// projects; they have no GitHub deploy-staging-*.yml smoke step.
// health-probe is permitted to be a no-op (the matrix records a
// planned Fly app; the deploy surface may not yet be in tree).
const REQUIRED_API_WORKFLOWS = [
  { surfaceId: 'tasks-api', workflow: 'deploy-staging-tasks-api.yml', healthPath: '/health' },
  { surfaceId: 'budget-api', workflow: 'deploy-staging-budget-api.yml', healthPath: '/health' },
  { surfaceId: 'content-scheduler-api', workflow: 'deploy-staging-content-scheduler-api.yml', healthPath: '/health' },
];
const OPTIONAL_API_WORKFLOWS = [
  { surfaceId: 'health-probe', workflow: 'deploy-staging-health-probe.yml', healthPath: '/healthz' },
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function main() {
  const { repoRoot } = parseArgs();
  const matrixPath = join(repoRoot, 'infra/cloud/hostname-matrix.json');
  const workflowsDir = join(repoRoot, '.github/workflows');

  const errors = [];
  const notes = [];

  let matrix;
  try { matrix = loadJson(matrixPath); }
  catch (err) {
    stderr.write(`deploy-workflow stable-hostname check failed: could not read ${matrixPath}: ${err.message}\n`);
    exit(1);
  }

  const surfaceById = new Map(matrix.surfaces.map((s) => [s.id, s]));

  for (const req of [...REQUIRED_API_WORKFLOWS, ...OPTIONAL_API_WORKFLOWS]) {
    const workflowPath = join(workflowsDir, req.workflow);
    let exists = true;
    try { statSync(workflowPath); } catch { exists = false; }
    if (!exists) {
      // Optional workflows may be absent; the deploy surface for
      // health-probe is planned but not yet landed. Skip them entirely
      // — no need to require a matching matrix surface, and no need
      // to require the workflow file.
      const isOptional = OPTIONAL_API_WORKFLOWS.includes(req);
      if (isOptional) {
        notes.push(`${req.workflow} not present yet (planned; deploy surface lands in a follow-up)`);
        continue;
      }
      errors.push(`${req.workflow} not found at .github/workflows/${req.workflow}`);
      continue;
    }
    const surface = surfaceById.get(req.surfaceId);
    if (!surface) {
      errors.push(`matrix missing required surface "${req.surfaceId}" (referenced by ${req.workflow})`);
      continue;
    }

    const text = readText(workflowPath);
    const expectedUrl = `https://${surface.staging}${req.healthPath}`;

    // The active smoke URL must be the matrix stable staging hostname.
    if (!text.includes(expectedUrl)) {
      errors.push(`${req.workflow}: smoke check does not target matrix stable URL "${expectedUrl}" (current deploys would smoke through the provider URL, violating AC4)`);
    }
    // Every provider-shaped URL in the workflow must be a DOCUMENTED
    // fallback for THIS surface (AC4).
    //
    // `providerFallback` is the PRODUCTION provider host. The staging
    // provider host the workflows actually document is the Fly app the
    // workflow itself deploys to (`FLY_APP:`), which is what its own
    // provider-shaped URL has to be. The old check compared one
    // hard-coded `https://<providerFallback><healthPath>` string — a
    // production host that no workflow contains — so the branch never
    // fired and the provider URL that DOES appear went unchecked. This
    // block reads the URLs that are actually there instead.
    const flyAppMatch = text.match(/^\s*FLY_APP:\s*(\S+)\s*$/m);
    const declaredStagingApp = flyAppMatch ? flyAppMatch[1] : null;
    const allowedProviderHosts = new Set(
      [
        surface.providerFallback,
        declaredStagingApp ? `${declaredStagingApp}.fly.dev` : null,
        surface.cnameTargets?.staging,
        surface.cnameTargets?.production,
        ...(surface.stagingRoutes ?? []).map((route) => route?.host),
      ]
        .filter((host) => typeof host === 'string' && host.length > 0)
        .map((host) => host.toLowerCase()),
    );
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const providerHosts = [
        ...line.matchAll(/https?:\/\/([a-z0-9.-]+\.(?:fly\.dev|vercel\.app))/gi),
      ].map((match) => match[1].toLowerCase());
      if (providerHosts.length === 0) continue;
      const window = [lines[i - 1] ?? '', lines[i - 2] ?? '', line, lines[i + 1] ?? ''];
      const annotated = window.some((l) => /<!--\s*stable-fallback\b/.test(l) || /<!--\s*documented-migration\b/.test(l));
      for (const host of providerHosts) {
        if (!allowedProviderHosts.has(host)) {
          errors.push(`${req.workflow}: provider URL host "${host}" is not a provider host of matrix surface "${surface.id}" — a deploy workflow must not reference another surface's provider host (AC4)`);
          continue;
        }
        if (!annotated) {
          errors.push(`${req.workflow}: provider URL "https://${host}" appears without a \`<!-- stable-fallback -->\` or \`<!-- documented-migration -->\` annotation on the same or an adjacent line (AC4)`);
        }
      }
    }
    // The 20-attempt retry loop must be present on the multi-attempt smoke
    // workflows (design §risks-3). health-probe uses a single-curl pattern
    // (exit non-zero on non-200) that predates the cert-latency mitigation;
    // it is not in scope for the 20-attempt loop requirement.
    if (req.surfaceId !== 'health-probe') {
      if (!text.includes('19 20') && !text.includes('1..20') && !text.includes('1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20')) {
        errors.push(`${req.workflow}: smoke loop does not appear to use 20 attempts (design §risks-3 mandates 20 for cert-issuance latency)`);
      }
    }
  }

  if (errors.length > 0) {
    stderr.write(`deploy-workflow stable-hostname check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  for (const n of notes) stdout.write(`note: ${n}\n`);
  stdout.write(`deploy-workflow stable-hostname check passed (${REQUIRED_API_WORKFLOWS.length} required + ${OPTIONAL_API_WORKFLOWS.length} optional workflow${OPTIONAL_API_WORKFLOWS.length === 1 ? '' : 's'} inspected)\n`);
}

main();
