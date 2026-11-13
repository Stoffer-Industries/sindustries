#!/usr/bin/env node
// check-production-deploy-contract.mjs — task fb1240c0 (Slice C) static
// check.
//
// The production deploy path is the first thing in this task that can
// touch real production. Every fact it depends on is owned somewhere
// else:
//
//   - the Fly app names              -> the environment manifest
//   - the secret SOURCE names        -> the environment manifest
//   - the deploy gate variable names -> derived from the environment id
//   - the hostnames it smoke-checks  -> infra/cloud/hostname-matrix.json
//   - the Fly config it deploys      -> the shared config + the overlay
//
// Those owners and the two production workflows are separate files, so
// they can drift. This check is the drift check the tech design's Slice C
// asks for:
//
//   "production app names and hostnames agree across the hostname
//    matrix, Fly configs, workflows, and environment manifest"
//
// WHAT A DRIFT MEANS HERE
// ----------------------
// A production app name that disagrees with the manifest does not fail
// loudly. It provisions an app nobody is watching, or smoke-checks a
// hostname that points somewhere else. A production workflow that
// deploys the SHARED Fly config instead of the rendered one deploys the
// STAGING app name and the STAGING CORS origins to production, and the
// deploy succeeds. A workflow that forgets a source name registers
// fifteen app-level secrets with one source missing and the supervisor
// refuses to start. A source name carrying a staging marker registers a
// staging database on a production app.
//
// Every one of those is invisible until production is already wrong, so
// they are checked statically, on every PR, with no credentials.
//
// The check is pure Node with no deps (the CI job that runs it does not
// pin a Node version). Exits 0 on success, 1 on any violation.
//
// Usage:
//   node tests/cloud/scripts/check-production-deploy-contract.mjs [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, '..', '..', '..'));

const MATRIX_PATH = 'infra/cloud/hostname-matrix.json';
const PLATFORM_OVERLAY_PATH = 'infra/cloud/fly/platform.production.overlay.toml';
const PLATFORM_SHARED_PATH = 'infra/cloud/fly/platform.fly.toml';
const PROBE_OVERLAY_PATH =
  'infra/cloud/observability/health-probe/fly.production.overlay.toml';
const PROBE_SHARED_PATH = 'infra/cloud/observability/health-probe/fly.toml';
const PLATFORM_WORKFLOW_PATH = '.github/workflows/deploy-production-platform.yml';
const PROBE_WORKFLOW_PATH = '.github/workflows/deploy-production-health-probe.yml';

const API_SURFACE_IDS = ['tasks-api', 'budget-api', 'content-scheduler-api'];
const HEALTH_PATH = '/health';

// The topology the production platform overlay must NOT be able to
// redefine. The renderer refuses these too; this check proves the
// overlay has not started trying.
const TOPOLOGY_KEYS = ['[processes]', '[http_service]', '[[vm]]', '[build]', 'release_command'];

const errors = [];

function fail(message) {
  errors.push(message);
}

function readText(relativePath) {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  } catch (error) {
    fail(`${relativePath}: cannot be read (${error.message})`);
    return null;
  }
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${relativePath}: is not valid JSON (${error.message})`);
    return null;
  }
}

/**
 * The `[env]` table of a Fly config, as plain key/value pairs.
 *
 * Only the `[env]` table is read: it is the one table that carries
 * environment-owned values, and it is the only one this check compares
 * across files.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function readEnvTable(text) {
  const env = {};
  let table = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch) {
      table = tableMatch[1];
      continue;
    }
    const assignment = /^([A-Za-z0-9_]+)\s*=\s*'([^']*)'\s*$/.exec(line);
    if (assignment && table === 'env') env[assignment[1]] = assignment[2];
  }
  return env;
}

/**
 * The top-level `app` of a Fly config.
 *
 * @param {string} text
 * @returns {string|null}
 */
function readTopLevelApp(text) {
  const match = /^app\s*=\s*'([^']*)'\s*$/m.exec(text);
  return match ? match[1] : null;
}

/**
 * The environment manifest and its derived facts.
 *
 * @returns {Promise<object|null>}
 */
async function loadManifest() {
  try {
    const environments = await import(
      pathToFileURL(join(REPO_ROOT, 'infra/cloud/platform/platform-environments.mjs')).href
    );
    const facts = await import(
      pathToFileURL(join(REPO_ROOT, 'infra/cloud/platform/platform-environment-facts.mjs')).href
    );
    const environment = environments.getPlatformEnvironment('production');
    return {
      environment,
      requiredSourceNames: environments.requiredSourceNames(environment),
      deployGateVariable: facts.buildEnvironmentFacts('production').deployGateVariable,
      healthProbeDeployGateVariable:
        facts.buildEnvironmentFacts('production').healthProbeDeployGateVariable,
    };
  } catch (error) {
    fail(`the environment manifest could not be loaded (${error.message})`);
    return null;
  }
}

/**
 * Every `flyctl deploy` in a production workflow must deploy the
 * RENDERED config.
 *
 * The rendered config is the shared config with the environment overlay
 * merged onto it, so it carries the production app name and the
 * production CORS origins. The shared config carries the STAGING ones.
 * A deploy that names the shared config therefore deploys staging values
 * to production, and it succeeds — which is why this is a static check
 * and not a runtime one.
 *
 * @param {string} text
 * @param {string} path
 * @param {string} label
 */
function checkDeployUsesRenderedConfig(text, path, label) {
  const deployLines = text
    .split('\n')
    .filter((line) => line.includes('flyctl deploy'));
  if (deployLines.length === 0) {
    fail(`${path}: has no "flyctl deploy" step`);
    return;
  }
  for (const line of deployLines) {
    const usesRendered =
      line.includes('$FLY_CONFIG_RENDERED') || line.includes('.production.fly.toml');
    if (!usesRendered) {
      fail(
        `${path}: deploys the ${label} config that is not the rendered production config — ` +
          `a shared-config deploy sends the staging app name to production: ${line.trim()}`,
      );
    }
  }
}

function checkMatrixAgreement(matrix, manifest) {
  if (!matrix || !manifest) return;
  const { environment } = manifest;
  const surfaces = new Map((matrix.surfaces ?? []).map((surface) => [surface.id, surface]));

  for (const id of API_SURFACE_IDS) {
    const surface = surfaces.get(id);
    if (!surface) {
      fail(`${MATRIX_PATH}: has no "${id}" surface`);
      continue;
    }
    if (surface.flyApp !== environment.platformApp) {
      fail(
        `${MATRIX_PATH}: surface "${id}" names flyApp "${surface.flyApp}", but the production ` +
          `manifest names "${environment.platformApp}"`,
      );
    }
    const expectedCname = `${environment.platformApp}.fly.dev`;
    if (surface.cnameTargets?.production !== expectedCname) {
      fail(
        `${MATRIX_PATH}: surface "${id}" has production CNAME target ` +
          `"${surface.cnameTargets?.production}", expected "${expectedCname}"`,
      );
    }
    const stagingHost = String(surface.staging ?? '');
    if (stagingHost.includes('staging') && surface.production === stagingHost) {
      fail(`${MATRIX_PATH}: surface "${id}" has the same hostname in staging and production`);
    }
  }

  const probe = surfaces.get('health-probe');
  if (!probe) {
    fail(`${MATRIX_PATH}: has no "health-probe" surface`);
  } else {
    if (probe.flyApp !== environment.healthProbeApp) {
      fail(
        `${MATRIX_PATH}: surface "health-probe" names flyApp "${probe.flyApp}", but the production ` +
          `manifest names "${environment.healthProbeApp}"`,
      );
    }
    const expectedCname = `${environment.healthProbeApp}.fly.dev`;
    if (probe.cnameTargets?.production !== expectedCname) {
      fail(
        `${MATRIX_PATH}: surface "health-probe" has production CNAME target ` +
          `"${probe.cnameTargets?.production}", expected "${expectedCname}"`,
      );
    }
  }
}

function checkOverlayAgreement(manifest) {
  if (!manifest) return;
  const { environment } = manifest;

  const platformOverlay = readText(PLATFORM_OVERLAY_PATH);
  if (platformOverlay !== null) {
    const app = readTopLevelApp(platformOverlay);
    if (app !== environment.platformApp) {
      fail(
        `${PLATFORM_OVERLAY_PATH}: names app "${app}", but the production manifest names ` +
          `"${environment.platformApp}"`,
      );
    }
    for (const key of TOPOLOGY_KEYS) {
      if (platformOverlay.includes(key)) {
        fail(
          `${PLATFORM_OVERLAY_PATH}: defines ${key} — the production overlay owns the ` +
            'environment values only; the platform topology is owned by the shared config',
        );
      }
    }
    const env = readEnvTable(platformOverlay);
    for (const [secretName, origins] of Object.entries(environment.corsAllowedOrigins)) {
      const key = `PLATFORM_${secretName.toUpperCase()}_CORS_ALLOWED_ORIGINS`;
      const expected = origins.join(',');
      if (env[key] !== undefined && env[key] !== expected) {
        fail(
          `${PLATFORM_OVERLAY_PATH}: ${key} is "${env[key]}", but the production manifest's ` +
            `CORS origins are "${expected}"`,
        );
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (value.includes('staging')) {
        fail(`${PLATFORM_OVERLAY_PATH}: ${key} carries a staging value`);
      }
    }
  }

  const probeOverlay = readText(PROBE_OVERLAY_PATH);
  if (probeOverlay !== null) {
    const app = readTopLevelApp(probeOverlay);
    if (app !== environment.healthProbeApp) {
      fail(
        `${PROBE_OVERLAY_PATH}: names app "${app}", but the production manifest names ` +
          `"${environment.healthProbeApp}"`,
      );
    }
  }
}

/**
 * The production probe must watch more often than the staging probe.
 *
 * The staging probe runs once a day because staging is a dev artifact.
 * A production probe left at the daily cadence passes every check while
 * watching nothing, so the comparison is a hard failure, not a warning.
 */
function checkProbeCadence(manifest) {
  if (!manifest) return;
  const shared = readText(PROBE_SHARED_PATH);
  const overlay = readText(PROBE_OVERLAY_PATH);
  if (shared === null || overlay === null) return;

  const stagingEnv = readEnvTable(shared);
  const productionEnv = readEnvTable(overlay);

  for (const key of ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS']) {
    const stagingValue = Number(stagingEnv[key]);
    const productionValue = Number(productionEnv[key]);
    if (!Number.isFinite(stagingValue) || !Number.isFinite(productionValue)) {
      fail(`${PROBE_OVERLAY_PATH}: ${key} is missing or not a number`);
      continue;
    }
    if (productionValue >= stagingValue) {
      fail(
        `${PROBE_OVERLAY_PATH}: ${key} is ${productionValue}s, which is not tighter than the ` +
          `staging cadence of ${stagingValue}s`,
      );
    }
  }
}

/**
 * The rendered production platform config must still be ONE app with ONE
 * process group.
 */
async function checkRenderedTopology(manifest) {
  if (!manifest) return;
  let renderFlyConfig;
  try {
    ({ renderFlyConfig } = await import(
      pathToFileURL(join(REPO_ROOT, 'infra/cloud/platform/render-fly-config.mjs')).href
    ));
  } catch (error) {
    fail(`the Fly config renderer could not be loaded (${error.message})`);
    return;
  }
  let rendered;
  try {
    ({ rendered } = renderFlyConfig({
      sharedPath: join(REPO_ROOT, PLATFORM_SHARED_PATH),
      overlayPath: join(REPO_ROOT, PLATFORM_OVERLAY_PATH),
      environment: 'production',
    }));
  } catch (error) {
    fail(`the production platform config could not be rendered (${error.message})`);
    return;
  }
  const app = readTopLevelApp(rendered);
  if (app !== manifest.environment.platformApp) {
    fail(
      `the rendered production platform config names app "${app}", expected ` +
        `"${manifest.environment.platformApp}"`,
    );
  }
  const processTables = rendered.match(/^\[processes\]\s*$/gm) ?? [];
  if (processTables.length !== 1) {
    fail(
      `the rendered production platform config has ${processTables.length} [processes] tables, ` +
        'expected exactly 1 — the platform is one app, one process group',
    );
  }
  const env = readEnvTable(rendered);
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith('CORS_ALLOWED_ORIGINS') && value.includes('staging')) {
      fail(`the rendered production platform config carries staging CORS origins in ${key}`);
    }
  }
}

/**
 * A workflow must not echo a secret value, and must not trace its own
 * commands (which would print the values it was given).
 *
 * Comment lines are stripped first: the workflow header documents that it
 * never enables `set -x`, and a naive substring search would fail on its
 * own documentation.
 */
function checkNoSecretLogging(text, path, secretNames) {
  const commands = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  if (commands.includes('set -x')) {
    fail(`${path}: enables "set -x" — command tracing can print a secret value`);
  }
  for (const line of commands.split('\n')) {
    if (!/\becho\b/.test(line)) continue;
    for (const name of secretNames) {
      if (line.includes(`\${${name}}`) || line.includes(`$${name}`)) {
        fail(`${path}: echoes ${name} — a secret value must never be printed`);
      }
    }
  }
}

function checkPlatformWorkflow(manifest, matrix) {
  if (!manifest || !matrix) return;
  const text = readText(PLATFORM_WORKFLOW_PATH);
  if (text === null) return;

  if (!/^\s*environment:\s*production\s*$/m.test(text)) {
    fail(`${PLATFORM_WORKFLOW_PATH}: does not declare "environment: production"`);
  }
  if (!text.includes('secrets.FLY_API_TOKEN')) {
    fail(`${PLATFORM_WORKFLOW_PATH}: does not reference secrets.FLY_API_TOKEN`);
  }
  if (!text.includes(manifest.deployGateVariable)) {
    fail(
      `${PLATFORM_WORKFLOW_PATH}: does not use the derived deploy gate ` +
        `"${manifest.deployGateVariable}"`,
    );
  }
  if (!/platform-provision-secrets\.mjs\s*\\\s*\n\s*--environment production/.test(text)) {
    fail(`${PLATFORM_WORKFLOW_PATH}: does not provision with "--environment production"`);
  }

  // Every manifest source name must be carried by the workflow, and the
  // workflow must not carry a source name the manifest does not know.
  const sourceNames = Object.values(manifest.environment.sourceNames);
  for (const name of sourceNames) {
    if (!text.includes(name)) {
      fail(`${PLATFORM_WORKFLOW_PATH}: does not provide the source "${name}"`);
    }
  }
  const allowedEnvNames = new Set([
    ...sourceNames,
    'FLY_API_TOKEN',
    'FLY_ORG',
    manifest.deployGateVariable,
  ]);
  const declared = text.match(/^\s{10}([A-Z][A-Z0-9_]+):\s*\$\{\{/gm) ?? [];
  for (const line of declared) {
    const name = line.trim().split(':')[0];
    if (!allowedEnvNames.has(name)) {
      fail(
        `${PLATFORM_WORKFLOW_PATH}: declares "${name}", which is not a production source name in ` +
          'the environment manifest',
      );
    }
  }

  // The deploy must use the RENDERED production config. A workflow that
  // deploys the shared config deploys the staging app name and the
  // staging CORS origins to production, and it succeeds.
  if (!text.includes('infra/cloud/fly/platform.production.fly.toml')) {
    fail(
      `${PLATFORM_WORKFLOW_PATH}: does not deploy the rendered production config ` +
        '(infra/cloud/fly/platform.production.fly.toml)',
    );
  }
  if (!text.includes('render-fly-config.mjs')) {
    fail(`${PLATFORM_WORKFLOW_PATH}: does not render the production Fly config`);
  }
  checkDeployUsesRenderedConfig(text, PLATFORM_WORKFLOW_PATH, 'platform');

  // The smoke checks must target the production hostnames the matrix
  // names. The workflow resolves them from the environment manifest
  // (the owner of the production base URLs) rather than writing them
  // out, so the check asserts the resolution AND that the manifest's
  // origins agree with the matrix.
  const surfaces = new Map((matrix.surfaces ?? []).map((surface) => [surface.id, surface]));
  const manifestOrigins = manifest.environment.apiBaseUrls ?? {};
  const smokeSurfaces = [];
  const surfaceListMatch = /for surface in ([A-Za-z0-9 ]+); do/.exec(text);
  const surfaceList = surfaceListMatch
    ? surfaceListMatch[1].trim().split(/\s+/).filter(Boolean)
    : null;
  if (!surfaceList) {
    fail(`${PLATFORM_WORKFLOW_PATH}: does not iterate the manifest's production API surfaces`);
  }
  for (const id of API_SURFACE_IDS) {
    const surface = surfaces.get(id);
    if (!surface) continue;
    const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const baseUrl = manifestOrigins[key];
    if (!baseUrl) {
      fail(
        `the production manifest has no apiBaseUrls.${key}, so the deploy workflow has no ` +
          `production origin to smoke-check for "${id}"`,
      );
      continue;
    }
    const origin = new URL(baseUrl).origin;
    const expectedOrigin = `https://${surface.production}`;
    if (origin !== expectedOrigin) {
      fail(
        `the production manifest's apiBaseUrls.${key} resolves to ${origin}, but the hostname ` +
          `matrix names the production host "${surface.production}"`,
      );
    }
    if (!text.includes('apiOrigins.${surface}')) {
      fail(
        `${PLATFORM_WORKFLOW_PATH}: does not resolve the production origins from the manifest ` +
          '(apiOrigins.${surface})',
      );
    }
    smokeSurfaces.push(...(surfaceList ?? []));
  }

  // The workflow iterates a fixed list of manifest surfaces. That list
  // must be exactly the manifest's own set: a missing surface is a
  // service that is never smoke-checked, and an extra one is a surface
  // the manifest does not own.
  const manifestSurfaceKeys = Object.keys(manifestOrigins);
  const uniqueSmoke = [...new Set(smokeSurfaces)].sort();
  const expectedSmoke = [...manifestSurfaceKeys].sort();
  if (uniqueSmoke.join(',') !== expectedSmoke.join(',')) {
    fail(
      `${PLATFORM_WORKFLOW_PATH}: smoke-checks [${uniqueSmoke.join(', ')}], but the production ` +
        `manifest's apiBaseUrls are [${expectedSmoke.join(', ')}]`,
    );
  }
  if (text.includes('staging.sindustries.co.nz')) {
    fail(`${PLATFORM_WORKFLOW_PATH}: references a staging hostname`);
  }

  checkNoSecretLogging(text, PLATFORM_WORKFLOW_PATH, sourceNames);
}

function checkProbeWorkflow(manifest, matrix) {
  if (!manifest || !matrix) return;
  const text = readText(PROBE_WORKFLOW_PATH);
  if (text === null) return;

  if (!/^\s*environment:\s*production\s*$/m.test(text)) {
    fail(`${PROBE_WORKFLOW_PATH}: does not declare "environment: production"`);
  }
  if (!text.includes('secrets.FLY_API_TOKEN')) {
    fail(`${PROBE_WORKFLOW_PATH}: does not reference secrets.FLY_API_TOKEN`);
  }
  if (!text.includes(manifest.healthProbeDeployGateVariable)) {
    fail(
      `${PROBE_WORKFLOW_PATH}: does not use the derived health-probe deploy gate ` +
        `"${manifest.healthProbeDeployGateVariable}"`,
    );
  }
  if (!text.includes('infra/cloud/observability/health-probe/fly.production.fly.toml')) {
    fail(
      `${PROBE_WORKFLOW_PATH}: does not deploy the rendered production probe config ` +
        '(infra/cloud/observability/health-probe/fly.production.fly.toml)',
    );
  }
  if (!text.includes('render-fly-config.mjs')) {
    fail(`${PROBE_WORKFLOW_PATH}: does not render the production probe Fly config`);
  }
  checkDeployUsesRenderedConfig(text, PROBE_WORKFLOW_PATH, 'health-probe');

  const probe = (matrix.surfaces ?? []).find((surface) => surface.id === 'health-probe');
  if (probe && !text.includes(probe.production)) {
    fail(
      `${PROBE_WORKFLOW_PATH}: does not smoke-check the production hostname ` +
        `"${probe.production}"`,
    );
  }
  if (text.includes('staging.sindustries.co.nz')) {
    fail(`${PROBE_WORKFLOW_PATH}: references a staging hostname`);
  }

  checkNoSecretLogging(text, PROBE_WORKFLOW_PATH, []);
}

async function main() {
  const manifest = await loadManifest();
  const matrix = readJson(MATRIX_PATH);

  checkMatrixAgreement(matrix, manifest);
  checkOverlayAgreement(manifest);
  checkProbeCadence(manifest);
  await checkRenderedTopology(manifest);
  checkPlatformWorkflow(manifest, matrix);
  checkProbeWorkflow(manifest, matrix);

  if (errors.length > 0) {
    stderr.write('production deploy contract check failed:\n');
    for (const error of errors) stderr.write(`  - ${error}\n`);
    exit(1);
  }
  stdout.write('production deploy contract check: ok\n');
  exit(0);
}

await main();
