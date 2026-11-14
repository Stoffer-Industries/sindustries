#!/usr/bin/env node
// check-stable-hostname-matrix.test.mjs — task 5cb4a8fe static check.
//
// Pure Node 22, no deps (uses node:test + node:assert). Exercises
// scripts/check-stable-hostname-matrix.mjs via execFile on these cases:
//   1. The real repo tree passes (no synthetic fixture needed; the matrix
//      and the per-hostname fly.toml comment blocks are in the working
//      tree).
//   2. A synthetic matrix missing a required public surface fails with a
//      recognisable error.
//   3. A synthetic matrix without cnameTargets fails with a recognisable
//      error.
//   4. A synthetic matrix whose staging CNAME target aliases a production
//      provider host fails with a recognisable error.
//   5. A synthetic matrix whose staging CNAME target aliases a surface's
//      OWN providerFallback while cnameTargets.production has diverged
//      from it fails — the AC2 leak guard must be built from the UNION of
//      cnameTargets.production and providerFallback, not from one of them.
//   6. A synthetic matrix that binds the staging and production stable
//      hostnames to the SAME Vercel environment fails (AC2 for the two
//      frontends).
//   7. A synthetic matrix whose cnameTargets.production drifts from the
//      production Fly app host named by flyApp fails.
//   8. A synthetic fly.toml whose comment block omits the staging
//      hostname fails with a recognisable error.
//
// Run with: node --test tests/cloud/tests/check-stable-hostname-matrix.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-stable-hostname-matrix.mjs');
const REAL_MATRIX = join(REPO_ROOT, 'infra/cloud/hostname-matrix.json');
const REAL_FLY_DIR = join(REPO_ROOT, 'infra/cloud/fly');

test('real repo tree: check-stable-hostname-matrix exits 0 on the committed matrix + fly.toml comment blocks', async () => {
  const { stdout, stderr } = await exec('node', [SCRIPT], { cwd: REPO_ROOT });
  // The script writes its pass message to stdout; ensure no error text on stderr.
  assert.match(stdout, /hostname matrix check passed/, `expected pass line on stdout, got: ${stdout}`);
  assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
});

test('synthetic matrix missing a required public surface fails the check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = {
      taskId: 'test',
      apexDomain: 'sindustries.co.nz',
      stagingSubdomainSuffix: 'staging.sindustries.co.nz',
      productionApex: 'sindustries.co.nz',
      surfaces: [
        { id: 'tasks-api', kind: 'api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz', providerFallback: 'sindustries-tasks-api.fly.dev', cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-tasks-api.fly.dev' } },
        { id: 'budget-api', kind: 'api', staging: 'budget-api.staging.sindustries.co.nz', production: 'budget-api.sindustries.co.nz', providerFallback: 'sindustries-budget-api.fly.dev', cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-budget-api.fly.dev' } },
        { id: 'auto-post-worker', kind: 'worker', staging: null, production: null, providerFallback: null, cnameTargets: null, publicUrl: false, rationale: 'no public URL' },
      ],
    };
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    // No fly-dir passed; the script defaults to <repo-root>/infra/cloud/fly —
    // but the synthetic matrix has surfaces whose fly.toml files DO exist
    // there (tasks-api, budget-api, auto-post-worker), and the test is
    // specifically checking the matrix-shape error path before the toml
    // check runs. To make that explicit, point the script at an empty
    // fly-dir so the surface-row error fires first.
    const emptyFlyDir = join(dir, 'fly');
    mkdirSync(emptyFlyDir);
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, emptyFlyDir]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a matrix missing required public surfaces');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /surfaces must include public surface "mission-control"|surfaces must include public surface "tasks-app"|surfaces must include public surface "content-scheduler-api"|surfaces must include public surface "health-probe"/, `expected a missing-surface error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic matrix without cnameTargets fails the check', async () => {
  // The CNAME target per environment is what the live harness asserts
  // against. A matrix row without it cannot be checked, so the static
  // check must reject the row rather than let the harness fall back to
  // the production provider host.
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const surface = matrix.surfaces.find((s) => s.id === 'tasks-api');
    delete surface.cnameTargets;
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, REAL_FLY_DIR, REPO_ROOT]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a surface without cnameTargets');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /tasks-api\)\.cnameTargets must be an object/, `expected a missing-cnameTargets error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic matrix whose staging CNAME target aliases a production provider host fails the check', async () => {
  // AC2: "Staging hostnames resolve only to staging deployments and
  // production hostnames resolve only to production deployments." A
  // staging CNAME pointing at a production provider host is a
  // cross-environment leak, even when the matrix row itself is
  // otherwise well-formed.
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const surface = matrix.surfaces.find((s) => s.id === 'tasks-api');
    surface.cnameTargets.staging = 'sindustries-tasks-api.fly.dev';
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, REAL_FLY_DIR, REPO_ROOT]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a staging CNAME target that aliases production');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /cross-environment alias|must not alias its production provider host/, `expected a cross-environment alias error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic matrix whose staging CNAME target aliases the surface own providerFallback fails the check', async () => {
  // AC2 guard regression (C1). The production-target set must be the
  // UNION of `cnameTargets.production` and `providerFallback`.
  //
  // `cnameTargets.production` and `providerFallback` are deliberately
  // allowed to diverge — task 020f423e will rename the production apps,
  // so the CNAME target moves while the documented provider fallback
  // stays. Guarding on `cnameTargets.production` alone lets a staging
  // hostname alias `providerFallback` the moment they diverge, and the
  // `owner !== surface.id` exemption let a surface alias its OWN
  // production host besides.
  //
  // The mutation below keeps the flyApp rule satisfied (flyApp is
  // updated to the renamed production app alongside
  // `cnameTargets.production`) so the ONLY rule that can catch the leak
  // is the union guard itself.
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const surface = matrix.surfaces.find((s) => s.id === 'health-probe');
    surface.flyApp = 'sindustries-health-probe-prod';
    surface.cnameTargets.production = 'sindustries-health-probe-prod.fly.dev';
    // providerFallback stays on the old host — the divergence.
    assert.equal(surface.providerFallback, 'sindustries-health-probe.fly.dev', 'fixture assumes the provider fallback stays put');
    // The staging target now aliases the surface's OWN provider fallback.
    surface.cnameTargets.staging = 'sindustries-health-probe.fly.dev';
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, REAL_FLY_DIR, REPO_ROOT]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a staging CNAME target that aliases the surface own providerFallback');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /cross-environment alias/, `expected a cross-environment alias error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic matrix that binds the staging and production hostnames to the same Vercel project fails the check', async () => {
  // AC2 for the two Vercel frontends. A Vercel custom domain CNAMEs to
  // the same shared managed target in every project, so the DNS shape
  // carries no environment identity — the separation lives in which
  // Vercel PROJECT owns each stable hostname. Binding both stable
  // hostnames to the same project would serve one environment under
  // both hostnames.
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const surface = matrix.surfaces.find((s) => s.id === 'mission-control');
    surface.vercelStagingProject = surface.vercelProject;
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, REAL_FLY_DIR, REPO_ROOT]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail when both stable hostnames bind to the same Vercel project');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /must be different Vercel projects/, `expected a Vercel project-binding error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic matrix whose cnameTargets.production drifts from the production Fly app host fails the check', async () => {
  // `flyApp` is the PRODUCTION Fly app name. The matrix carries two
  // views of the deployment topology — flyApp and cnameTargets — and
  // they must not drift: when task 020f423e renames the production apps,
  // the CNAME target has to move in the same change.
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = JSON.parse(readFileSync(REAL_MATRIX, 'utf8'));
    const surface = matrix.surfaces.find((s) => s.id === 'budget-api');
    surface.cnameTargets.production = 'sindustries-budget-api-prod.fly.dev';
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, REAL_FLY_DIR, REPO_ROOT]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail when cnameTargets.production drifts from the flyApp production host');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /must be the production Fly app host/, `expected a flyApp drift error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic fly.toml whose comment block omits the staging hostname fails the check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-stable-hostname-matrix-'));
  try {
    const matrix = {
      taskId: 'test',
      apexDomain: 'sindustries.co.nz',
      stagingSubdomainSuffix: 'staging.sindustries.co.nz',
      productionApex: 'sindustries.co.nz',
      surfaces: [
        { id: 'tasks-api', kind: 'api', flyApp: 'sindustries-tasks-api', staging: 'tasks-api.staging.sindustries.co.nz', production: 'tasks-api.sindustries.co.nz', providerFallback: 'sindustries-tasks-api.fly.dev', cnameTargets: { staging: 'sindustries-platform-staging.fly.dev', production: 'sindustries-tasks-api.fly.dev' } },
      ],
    };
    const matrixPath = join(dir, 'hostname-matrix.json');
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
    // The fly.toml comment block names the production hostname but omits
    // the staging hostname; the script should report the missing-staging
    // assertion.
    const flyDir = join(dir, 'fly');
    mkdirSync(flyDir);
    writeFileSync(join(flyDir, 'tasks-api.fly.toml'),
      '# tasks-api\n# Source of truth: infra/cloud/hostname-matrix.json\n# production: tasks-api.sindustries.co.nz\n\napp = "sindustries-tasks-api-staging"\n');
    let err;
    try {
      await exec('node', [SCRIPT, matrixPath, flyDir]);
    } catch (e) { err = e; }
    assert.ok(err, 'expected the script to fail on a fly.toml missing the staging hostname in its comment block');
    const stderr = (err.stderr || '') + (err.stdout || '');
    assert.match(stderr, /tasks-api\.fly\.toml: leading comment block must mention staging hostname/, `expected a missing-staging-hostname error, got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
