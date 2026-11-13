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
 * The workflow's steps, as text blocks.
 *
 * The checker is pure Node with no deps, so the YAML is read line-wise:
 * a step starts at `      - name:` and runs until the next step. That
 * is enough to ask the questions that matter here — does this step run
 * before that one, does this step carry this variable — without a YAML
 * parser.
 *
 * @param {string} text
 * @returns {{name: string, text: string}[]}
 */
function readSteps(text) {
  const steps = [];
  let current = null;
  for (const line of text.split('\n')) {
    const start = /^ {6}- name:\s*(.*)$/.exec(line);
    if (start) {
      current = { name: start[1].trim(), text: '' };
      steps.push(current);
      continue;
    }
    if (current && !line.trim().startsWith('#')) current.text += `${line}\n`;
  }
  return steps;
}

/**
 * The environment variable names a step declares.
 *
 * Only the `env:` block of the step is read, and only its keys. The
 * indentation is measured rather than assumed: a hard-coded column made
 * the check vacuous the moment the workflow was re-indented.
 *
 * @param {string} stepText
 * @returns {string[]}
 */
function stepEnvNames(stepText) {
  const names = [];
  let inEnv = false;
  let envIndent = 0;
  for (const rawLine of stepText.split('\n')) {
    if (!inEnv) {
      const envMatch = /^(\s*)env:\s*$/.exec(rawLine);
      if (envMatch) {
        inEnv = true;
        envIndent = envMatch[1].length;
      }
      continue;
    }
    if (rawLine.trim() === '') continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent <= envIndent) {
      inEnv = false;
      continue;
    }
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (match) names.push(match[1]);
  }
  return names;
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
      provisionGateVariable: facts.buildEnvironmentFacts('production').provisionGateVariable,
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
  const steps = readSteps(text);
  const deploySteps = steps.filter((step) => step.text.includes('flyctl deploy'));
  if (deploySteps.length === 0) {
    fail(`${path}: has no "flyctl deploy" step`);
    return;
  }
  const renderSteps = steps.filter((step) => step.text.includes('render-fly-config.mjs'));
  if (renderSteps.length === 0) {
    fail(`${path}: has no step that renders the ${label} Fly config`);
    return;
  }
  const renderStep = renderSteps[0];

  for (const step of deploySteps) {
    const deployLine = step.text.split('\n').find((line) => line.includes('flyctl deploy')) ?? '';

    // The deploy must name the RENDERED config, and never the shared
    // one. A comment cannot satisfy this: the line must BE the command.
    if (!deployLine.includes('$FLY_CONFIG_RENDERED')) {
      fail(
        `${path}: deploys the ${label} config that is not the rendered production config — ` +
          `a shared-config deploy sends the staging app name to production: ${deployLine.trim()}`,
      );
    }
    if (deployLine.includes('$FLY_CONFIG_SHARED')) {
      fail(
        `${path}: the deploy names the SHARED Fly config — a shared-config deploy sends the ` +
          `staging app name to production: ${deployLine.trim()}`,
      );
    }

    // The deploy must come AFTER the render: a deploy that runs first
    // deploys whatever config was left on disk.
    if (steps.indexOf(step) <= steps.indexOf(renderStep)) {
      fail(
        `${path}: the deploy runs BEFORE the ${label} Fly config is rendered — the deploy ` +
          'would use whatever config was left on disk',
      );
    }

    // The deploy's config must be the file the render step writes.
    const renderOut = /--out\s+"(\$[A-Z_]+)"/.exec(renderStep.text)?.[1] ?? null;
    const deployConfig = /--config\s+"(\$[A-Z_]+)"/.exec(deployLine)?.[1] ?? null;
    if (!renderOut || !deployConfig) {
      fail(
        `${path}: the render step's --out and the deploy's --config must name variables ` +
          '(`--out "$VAR"`, `--config "$VAR"`) so the check can prove they are the same file',
      );
    } else if (renderOut !== deployConfig) {
      fail(
        `${path}: the deploy uses ${deployConfig} but the render step writes ${renderOut} — ` +
          'the deploy must use the file the render step produced',
      );
    }

    // The deploy must name the app explicitly. The rendered config
    // carries the app name too, but a stale rendered file would carry a
    // stale app name with it.
    if (!/--app\s+"?\$\{?\{?/.test(deployLine)) {
      fail(
        `${path}: the deploy does not name the target app explicitly (--app) — a rendered ` +
          'config left over from another environment would otherwise decide the target',
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
    // The manifest owns the probe's base URL (the deploy workflow
    // resolves it at runtime), so the two must agree.
    if (environment.healthProbeBaseUrl) {
      const probeOrigin = new URL(environment.healthProbeBaseUrl).origin;
      const expectedOrigin = `https://${probe.production}`;
      if (probeOrigin !== expectedOrigin) {
        fail(
          `the production manifest's healthProbeBaseUrl resolves to ${probeOrigin}, but the ` +
            `hostname matrix names the production host "${probe.production}"`,
        );
      }
    } else {
      fail('the production manifest has no healthProbeBaseUrl for the probe deploy workflow');
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
      const key = `PLATFORM_${secretName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_CORS_ALLOWED_ORIGINS`;
      const expected = origins.join(',');
      if (env[key] === undefined) {
        fail(
          `${PLATFORM_OVERLAY_PATH}: does not set ${key} — an omitted CORS value inherits the ` +
            'SHARED (staging) one, because the merge keeps every shared value the overlay does ' +
            'not own',
        );
      } else if (env[key] !== expected) {
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

  // Command tracing prints every command, with its arguments: a traced
  // `flyctl secrets set KEY=$VALUE` prints the value. `set -x`,
  // `set -eux` and `set -o xtrace` are all tracing.
  if (/set\s+-[a-z]*x/.test(commands) || /set\s+-o\s+xtrace/.test(commands)) {
    fail(`${path}: enables command tracing ("set -x") — command tracing can print a secret value`);
  }

  // The secret names the workflow itself references are included, so a
  // workflow that references NO manifest source name is still checked
  // against its own credentials.
  const referenced = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  const names = new Set([...secretNames, ...referenced]);

  // Anything that PRINTS a value is a leak: echo, printf, printenv, env
  // and cat all write to stdout.
  const printing = /\b(echo|printf|printenv|env|cat)\b/;
  for (const line of commands.split('\n')) {
    if (!printing.test(line)) continue;
    for (const name of names) {
      const forms = [
        '${' + name + '}',
        '$' + name,
        '${' + name + ':-',
        '${' + name + ':+',
        '${' + name + '%%',
        '$' + name + ':-',
      ];
      if (forms.some((form) => line.includes(form))) {
        fail(`${path}: prints ${name} — a secret value must never be printed`);
      }
    }
    // The GitHub Actions expression form: `${{ secrets.NAME }}` inside a
    // printing command.
    const expression = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/.exec(line);
    if (expression) {
      fail(`${path}: prints ${expression[1]} — a secret value must never be printed`);
    }
  }
}

/**
 * The provisioning gate must be evaluated BEFORE the provisioning step,
 * and the provisioning step must be gated on it.
 *
 * A secret write restarts the app's Machines, so provisioning is a
 * production mutation and not a no-op. A workflow that provisions
 * before it checks its gate mutates production whatever the gate says.
 *
 * @param {string} text
 * @param {string} path
 * @param {string} provisionGateVariable
 */
function checkProvisionGateOrdering(text, path, provisionGateVariable) {
  const steps = readSteps(text);
  const gateStep = steps.find(
    (step) =>
      /id:\s*provision\b/.test(step.text) && step.text.includes(provisionGateVariable),
  );
  if (!gateStep) {
    fail(`${path}: does not evaluate the provisioning gate "${provisionGateVariable}"`);
    return;
  }
  const provisionStep = steps.find((step) => step.text.includes('platform-provision-secrets.mjs'));
  if (!provisionStep) {
    fail(`${path}: has no provisioning step`);
    return;
  }
  if (steps.indexOf(gateStep) >= steps.indexOf(provisionStep)) {
    fail(
      `${path}: the provisioning gate is evaluated AFTER the provisioning step — a production ` +
        'mutation would happen before its gate',
    );
  }
  if (!/if:[^\n]*steps\.provision\.outputs\.enabled/.test(provisionStep.text)) {
    fail(
      `${path}: the provisioning step is not gated on the provisioning gate ` +
        `(steps.provision.outputs.enabled)`,
    );
  }
}

/**
 * The Fly org must be REQUIRED before the first Fly call.
 *
 * `vars.PRODUCTION_FLY_ORG` expands to the empty string when it is
 * unset, and an empty `--org` makes flyctl act on the CLI's default
 * org — which may not own the production app.
 *
 * @param {string} text
 * @param {string} path
 * @param {string} flyOrgVariable
 */
function checkFlyOrgRequired(text, path, flyOrgVariable) {
  const steps = readSteps(text);
  const orgStep = steps.find((step) => stepEnvNames(step.text).includes(flyOrgVariable));
  if (!orgStep) {
    fail(`${path}: does not reference "${flyOrgVariable}"`);
    return;
  }
  if (!/exit 1/.test(orgStep.text) || !/if \[ -z/.test(orgStep.text)) {
    fail(
      `${path}: does not FAIL when "${flyOrgVariable}" is unset — an empty org makes flyctl ` +
        'act on its default org',
    );
  }
  const firstFlyCall = steps.findIndex(
    (step) =>
      step.text.includes('flyctl deploy') || step.text.includes('platform-provision-secrets.mjs'),
  );
  if (firstFlyCall !== -1 && steps.indexOf(orgStep) > firstFlyCall) {
    fail(
      `${path}: the "${flyOrgVariable}" check runs AFTER the first Fly call — the org must be ` +
        'required before anything is created, written or deployed',
    );
  }
}

/**
 * The probe smoke check must resolve its hostname at runtime.
 *
 * A hard-coded hostname in the workflow is a second copy of a fact the
 * manifest owns, and the old check only asserted that the hostname
 * appeared SOMEWHERE in the file — a comment satisfied it.
 *
 * @param {string} text
 * @param {string} path
 */
function checkProbeSmokeUrl(text, path) {
  const steps = readSteps(text);
  const smokeStep = steps.find((step) => step.name.includes('Smoke check'));
  if (!smokeStep) {
    fail(`${path}: has no smoke-check step`);
    return;
  }
  if (!smokeStep.text.includes('healthProbeOrigin')) {
    fail(
      `${path}: the smoke check does not resolve the probe origin from the environment ` +
        'manifest (healthProbeOrigin) — a hard-coded hostname is a second copy of a fact ' +
        'that drifts',
    );
  }
  if (!/URL="\$\{PROBE_ORIGIN\}\/healthz"/.test(smokeStep.text)) {
    fail(
      `${path}: the smoke check does not build its URL from the resolved probe origin in an ` +
        'executable assignment (URL="${PROBE_ORIGIN}/healthz")',
    );
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
  // The names are read from the steps' `env:` blocks: a source name
  // mentioned only in a COMMENT is not a source the workflow carries.
  const sourceNames = Object.values(manifest.environment.sourceNames);
  const steps = readSteps(text);
  const declaredNames = new Set(steps.flatMap((step) => stepEnvNames(step.text)));
  for (const name of sourceNames) {
    if (!declaredNames.has(name)) {
      fail(`${PLATFORM_WORKFLOW_PATH}: does not provide the source "${name}"`);
    }
  }
  const allowedEnvNames = new Set([
    ...sourceNames,
    'FLY_API_TOKEN',
    'FLY_ORG',
    manifest.deployGateVariable,
    manifest.provisionGateVariable,
    manifest.environment.flyOrgVariable,
  ]);
  for (const step of steps) {
    for (const name of stepEnvNames(step.text)) {
      if (!allowedEnvNames.has(name)) {
        fail(
          `${PLATFORM_WORKFLOW_PATH}: step "${step.name}" declares "${name}", which is not a ` +
            'production source name in the environment manifest',
        );
      }
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
    if (!surface) {
      fail(`${MATRIX_PATH}: has no "${id}" surface — its origin agreement cannot be checked`);
      continue;
    }
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
  checkProvisionGateOrdering(text, PLATFORM_WORKFLOW_PATH, manifest.provisionGateVariable);
  checkFlyOrgRequired(text, PLATFORM_WORKFLOW_PATH, manifest.environment.flyOrgVariable);
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
  if (!probe) {
    fail(`${MATRIX_PATH}: has no "health-probe" surface`);
  }
  if (text.includes('staging.sindustries.co.nz')) {
    fail(`${PROBE_WORKFLOW_PATH}: references a staging hostname`);
  }

  checkNoSecretLogging(text, PROBE_WORKFLOW_PATH, []);
  checkProbeSmokeUrl(text, PROBE_WORKFLOW_PATH);
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
