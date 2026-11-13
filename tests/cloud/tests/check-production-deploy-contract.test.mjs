#!/usr/bin/env node
// check-production-deploy-contract.test.mjs — task fb1240c0 (Slice C)
// static-check test.
//
// Pure Node, no deps (node:test + node:assert). The checker
// (tests/cloud/scripts/check-production-deploy-contract.mjs) is the
// contract that keeps the production deploy path honest, and a checker
// that cannot go red is worse than no checker: it would sit in the
// merge gate asserting nothing while the production path drifted.
//
// Every case below is a SENTINEL: a copy of the real repository tree
// with exactly one fact changed, and the assertion that the checker
// notices. The tree is copied rather than fabricated so the cases stay
// honest about the real files: the real manifest, the real overlays,
// the real workflows.
//
//   1. The unmodified tree passes.
//   2. A matrix API surface naming a different Fly app fails.
//   3. A matrix production CNAME target that does not point at the
//      platform app fails.
//   4. A production overlay naming a different app fails.
//   5. A production overlay that defines the topology ([processes])
//      fails.
//   6. A health-probe overlay naming a different app fails.
//   7. A health-probe production cadence left at the staging daily
//      cadence fails.
//   8. A production workflow that declares the wrong GitHub
//      environment fails.
//   9. A production workflow that deploys the SHARED Fly config
//      fails.
//  10. A production workflow that drops a manifest source name fails.
//  11. A production workflow that renames the deploy gate fails.
//  12. A production workflow that enables shell tracing fails.
//  13. A production workflow that echoes a secret value fails.
//  14. A production workflow that smoke-checks a manifest surface it
//      does not own fails.
//  15. A production workflow that omits a manifest surface fails.
//  16. A health-probe workflow that deploys the shared probe config
//      fails.
//  17. A manifest whose production base URL no longer matches the
//      matrix's production hostname fails.
//  18. A production overlay that OMITS a CORS value fails — an omitted
//      value inherits the shared (staging) one.
//  19. A production workflow that deploys BEFORE it renders the config
//      fails.
//  20. A production workflow that deploys a config the render step did
//      not write fails.
//  21. A production workflow that does not name the target app on the
//      deploy fails.
//  22. A production workflow that evaluates the provisioning gate
//      AFTER the provisioning step fails.
//  23. A production workflow that does not FAIL when the Fly org is
//      unset fails.
//  24. A production workflow that declares an unknown env var fails —
//      whatever the indentation.
//  25. A production workflow that mentions a source name only in a
//      comment fails.
//  26. A health-probe workflow that prints a secret fails.
//  27. A health-probe workflow with a hard-coded probe URL fails.
//
// Run with: node --test tests/cloud/tests/check-production-deploy-contract.test.mjs

import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-deploy-contract.mjs');

// Every file the checker reads. The checker imports the manifest, the
// facts projection and the renderer from the tree it is given, so all
// three are copied too — the modules import nothing but node builtins,
// so a copied tree behaves exactly like the real one.
const COPIED_FILES = [
  'infra/cloud/hostname-matrix.json',
  'infra/cloud/fly/platform.fly.toml',
  'infra/cloud/fly/platform.production.overlay.toml',
  'infra/cloud/observability/health-probe/fly.toml',
  'infra/cloud/observability/health-probe/fly.production.overlay.toml',
  'infra/cloud/platform/platform-environments.mjs',
  'infra/cloud/platform/platform-environment-facts.mjs',
  'infra/cloud/platform/render-fly-config.mjs',
  '.github/workflows/deploy-production-platform.yml',
  '.github/workflows/deploy-production-health-probe.yml',
];

/**
 * A copy of the real tree in a temp directory.
 *
 * @returns {string} the temp tree root
 */
function copyTree() {
  const root = mkdtempSync(join(tmpdir(), 'production-deploy-contract-'));
  for (const relative of COPIED_FILES) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO_ROOT, relative), target);
  }
  return root;
}

/**
 * Replace a file's contents in a temp tree.
 *
 * @param {string} root
 * @param {string} relative
 * @param {string} next
 */
function write(root, relative, next) {
  writeFileSync(join(root, relative), next, 'utf8');
}

/**
 * Replace a file's contents by transforming the current ones.
 *
 * @param {string} root
 * @param {string} relative
 * @param {(text: string) => string} transform
 */
function edit(root, relative, transform) {
  const path = join(root, relative);
  write(root, relative, transform(readFileSync(path, 'utf8')));
}

/**
 * Run the checker against a tree.
 *
 * @param {string} root
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runCheck(root) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, root]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * Assert the checker rejects a tree, naming the expected reason.
 *
 * @param {string} root
 * @param {string} expected
 */
async function expectRejected(root, expected) {
  const result = await runCheck(root);
  assert.equal(result.code, 1, `expected the checker to fail; stderr was:\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test('the real repository tree passes the production deploy contract', async () => {
  const result = await runCheck(REPO_ROOT);
  assert.equal(result.code, 0, `expected the real tree to pass; stderr was:\n${result.stderr}`);
});

test('a copied tree passes', async () => {
  const root = copyTree();
  try {
    const result = await runCheck(root);
    assert.equal(result.code, 0, `expected the copied tree to pass; stderr was:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a matrix API surface naming a different Fly app fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/hostname-matrix.json', (text) =>
      text.replace('"flyApp": "sindustries-platform-production"', '"flyApp": "sindustries-platform-staging"'),
    );
    await expectRejected(root, 'names flyApp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a matrix production CNAME target that misses the platform app fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/hostname-matrix.json', (text) =>
      text.replace(
        '"production": "sindustries-platform-production.fly.dev"',
        '"production": "sindustries-tasks-api.fly.dev"',
      ),
    );
    await expectRejected(root, 'CNAME target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production overlay naming a different app fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/fly/platform.production.overlay.toml', (text) =>
      text.replace("app = 'sindustries-platform-production'", "app = 'sindustries-platform-staging'"),
    );
    await expectRejected(root, 'names app');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production overlay that defines the topology fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/fly/platform.production.overlay.toml', (text) =>
      `${text}\n[processes]\n  app = "node apps/tasks-api/dist/main.js"\n`,
    );
    await expectRejected(root, 'the platform topology is owned by the shared config');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a health-probe overlay naming a different app fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/observability/health-probe/fly.production.overlay.toml', (text) =>
      text.replace(
        "app = 'sindustries-health-probe-production'",
        "app = 'sindustries-health-probe-staging'",
      ),
    );
    await expectRejected(root, 'names app');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a health-probe production cadence left at the staging daily cadence fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/observability/health-probe/fly.production.overlay.toml', (text) =>
      text.replace("FLY_APP_PROBE_INTERVAL_SECONDS = '120'", "FLY_APP_PROBE_INTERVAL_SECONDS = '86400'"),
    );
    await expectRejected(root, 'not tighter than the staging cadence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that declares the wrong GitHub environment fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace('    environment: production', '    environment: staging'),
    );
    await expectRejected(root, 'does not declare "environment: production"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that deploys the shared Fly config fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '--config "$FLY_CONFIG_RENDERED" --strategy canary',
        '--config "$FLY_CONFIG_SHARED" --strategy canary',
      ),
    );
    await expectRejected(root, 'not the rendered production config');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that drops a manifest source name fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '          PRODUCTION_BUDGET_API_DATABASE_URL: ${{ secrets.PRODUCTION_BUDGET_API_DATABASE_URL }}\n',
        '',
      ),
    );
    await expectRejected(root, 'does not provide the source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that renames the deploy gate fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(/PRODUCTION_PLATFORM_DEPLOY_ENABLED/g, 'PLATFORM_PRODUCTION_DEPLOY_ENABLED'),
    );
    await expectRejected(root, 'derived deploy gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that enables shell tracing fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace('          set -euo pipefail', '          set -euo pipefail\n          set -x'),
    );
    await expectRejected(root, 'set -x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that echoes a secret value fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '          set -euo pipefail\n          node infra/cloud/platform/platform-provision-secrets.mjs',
        '          set -euo pipefail\n          echo "${PRODUCTION_HEALTH_PROBE_REDIS}"\n          node infra/cloud/platform/platform-provision-secrets.mjs',
      ),
    );
    await expectRejected(root, 'never be printed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that smoke-checks a surface it does not own fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace('for surface in tasksApi budgetApi contentSchedulerApi; do', 'for surface in tasksApi budgetApi someOtherApi; do'),
    );
    await expectRejected(root, 'smoke-checks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that omits a manifest surface fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace('for surface in tasksApi budgetApi contentSchedulerApi; do', 'for surface in tasksApi budgetApi; do'),
    );
    await expectRejected(root, 'smoke-checks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a health-probe workflow that deploys the shared probe config fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-health-probe.yml', (text) =>
      text.replace(
        '--config "$FLY_CONFIG_RENDERED" --strategy canary',
        '--config "$FLY_CONFIG_SHARED" --strategy canary',
      ),
    );
    await expectRejected(root, 'not the rendered production config');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest whose production base URL drifts from the matrix fails', async () => {
  const root = copyTree();
  try {
    edit(root, 'infra/cloud/platform/platform-environments.mjs', (text) =>
      text.replace(
        "tasksApi: 'https://tasks-api.sindustries.co.nz/api/v1'",
        "tasksApi: 'https://tasks-api.sindustries.dev/api/v1'",
      ),
    );
    await expectRejected(root, 'resolves to');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production overlay that omits a CORS value fails', async () => {
  const root = copyTree();
  try {
    // An omitted CORS value inherits the SHARED (staging) one, because
    // the merge keeps every shared value the overlay does not own.
    edit(root, 'infra/cloud/fly/platform.production.overlay.toml', (text) =>
      text.replace(/^\s*PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS\s*=.*$/m, ''),
    );
    await expectRejected(root, 'does not set PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that deploys before it renders fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) => {
      const renderBlock = text.match(
        /      - name: Render the production Fly config[\s\S]*?\n\n/,
      )?.[0];
      if (!renderBlock) throw new Error('the render step was not found');
      // Move the render step AFTER the deploy step.
      return text.replace(renderBlock, '').replace(
        '      # Smoke check 1 — each production API hostname answers its own',
        `${renderBlock}      # Smoke check 1 — each production API hostname answers its own`,
      );
    });
    await expectRejected(root, 'runs BEFORE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that deploys a config the render step did not write fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '--config "$FLY_CONFIG_RENDERED" --strategy canary',
        '--config "$FLY_CONFIG_OTHER" --strategy canary',
      ),
    );
    await expectRejected(root, 'the deploy uses');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that does not name the target app on the deploy fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace('flyctl deploy --app "${{ steps.facts.outputs.app }}"', 'flyctl deploy'),
    );
    await expectRejected(root, 'does not name the target app explicitly');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that provisions before its gate fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) => {
      const gateBlock = text.match(/      # Gate 1 — PROVISIONING[\s\S]*?\n\n/)?.[0];
      if (!gateBlock) throw new Error('the provisioning gate step was not found');
      const withoutGate = text.replace(gateBlock, '');
      return withoutGate.replace(
        '      - name: Render the production Fly config',
        `${gateBlock}      - name: Render the production Fly config`,
      );
    });
    await expectRejected(root, 'the provisioning gate is evaluated AFTER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that does not fail on an unset Fly org fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '            echo "::error::PRODUCTION_FLY_ORG is not configured for the production GitHub environment. Set it through Settings > Environments > production > Environment variables. A missing org makes flyctl act on its default org, which may not own the production app."\n            exit 1\n',
        '',
      ),
    );
    await expectRejected(root, 'does not FAIL when "PRODUCTION_FLY_ORG" is unset');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that declares an unknown env var fails at any indentation', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '          FLY_ORG: ${{ steps.org.outputs.org }}\n',
        '          FLY_ORG: ${{ steps.org.outputs.org }}\n            FLY_SOME_OTHER_VAR: ${{ vars.SOMETHING }}\n',
      ),
    );
    await expectRejected(root, 'which is not a production source name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a production workflow that mentions a source name only in a comment fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-platform.yml', (text) =>
      text.replace(
        '          PRODUCTION_BUDGET_API_DATABASE_URL: ${{ secrets.PRODUCTION_BUDGET_API_DATABASE_URL }}\n',
        '          # PRODUCTION_BUDGET_API_DATABASE_URL is documented here\n',
      ),
    );
    await expectRejected(root, 'does not provide the source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a health-probe workflow that prints a secret fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-health-probe.yml', (text) =>
      text.replace(
        '          set -euo pipefail\n          PROBE_ORIGIN=',
        '          set -euo pipefail\n          echo "${{ secrets.FLY_API_TOKEN }}"\n          PROBE_ORIGIN=',
      ),
    );
    await expectRejected(root, 'never be printed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a health-probe workflow with a hard-coded probe URL fails', async () => {
  const root = copyTree();
  try {
    edit(root, '.github/workflows/deploy-production-health-probe.yml', (text) =>
      text.replace(
        '          PROBE_ORIGIN="$(node infra/cloud/platform/platform-environment-facts.mjs --environment production --field healthProbeOrigin)"\n          URL="${PROBE_ORIGIN}/healthz"',
        '          URL="https://health-probe.sindustries.co.nz/healthz"',
      ),
    );
    await expectRejected(root, 'does not resolve the probe origin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
