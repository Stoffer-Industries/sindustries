#!/usr/bin/env node
/**
 * platform-environment-facts.mjs — the environment facts a SHELL caller
 * needs, in one machine-readable place (task fb1240c0, Slice B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The environment manifest (`platform-environments.mjs`) is the source of
 * truth for everything that differs between staging and production. It is
 * a Node module, and every Node caller can import it directly.
 *
 * The bootstrap scripts are shell. Before this slice, the shell path knew
 * the staging app name, the staging source names and the staging deploy
 * gate by HEARTBEAT (they were hard-coded in the script), so the moment a
 * production bootstrap existed it would have carried a second, hand-copied
 * copy of those facts — the exact drift the manifest exists to prevent.
 *
 * So this is a thin, read-only projection of the manifest for shell
 * callers: it imports the manifest, adds the two things a shell caller
 * genuinely needs that are NOT environment facts in the manifest (the local
 * env-file path and the artefact paths), and prints JSON. It never mutates
 * anything and never reads a secret.
 *
 * WHAT IS DERIVED HERE (and why it is not in the manifest)
 * -------------------------------------------------------
 * `deployGateVariable` is DERIVED from the environment id:
 *
 *   staging    -> STAGING_PLATFORM_DEPLOY_ENABLED
 *   production -> PRODUCTION_PLATFORM_DEPLOY_ENABLED
 *
 * The staging name is not invented: it is the variable the existing
 * staging deploy workflow already gates on, and
 * `infra/cloud/scripts/tests/bootstrap-platform.test.sh` asserts that the
 * workflow and this derivation still agree. A derived name cannot be
 * edited in one place and left stale in another, which is the failure
 * mode a stored constant would allow.
 *
 * The artefact paths are the local file layout (where the env file and the
 * Fly configs live), not environment policy, so they live beside the
 * projection rather than in the manifest.
 *
 * Usage:
 *   node infra/cloud/platform/platform-environment-facts.mjs --environment production
 *   node infra/cloud/platform/platform-environment-facts.mjs --environment production \
 *     --field sourceNames.tasksDatabaseUrl
 *   node infra/cloud/platform/platform-environment-facts.mjs --environment production --json
 *
 * Exit codes:
 *   0 = facts printed
 *   2 = usage error, unknown environment, or an unreadable field
 */

import process from 'node:process';

import {
  DEFAULT_ENVIRONMENT_ID,
  getPlatformEnvironment,
  requiredSourceNames,
} from './platform-environments.mjs';

/**
 * The Fly org used when neither the env file nor the environment variable
 * names one. The local operator path is run by a maintainer whose personal
 * Fly org owns the apps.
 */
const DEFAULT_FLY_ORG = 'personal';

/**
 * The local file layout for each environment.
 *
 * `overlay` is null for staging: the shared config IS the staging config.
 * `rendered` is where the effective config is written when an overlay
 * exists. The rendered file is written NEXT TO the shared config on
 * purpose: Fly resolves the relative paths in a config (the Dockerfile
 * path, the build context) against the config file's own directory, so a
 * rendered config in a different directory would deploy a different image.
 * The rendered path is gitignored.
 */
const ARTEFACTS = {
  staging: {
    envFile: 'infra/cloud/.env.local',
    flyConfig: {
      shared: 'infra/cloud/fly/platform.fly.toml',
      overlay: '',
      rendered: 'infra/cloud/fly/platform.fly.toml',
    },
    healthProbeFlyConfig: {
      shared: 'infra/cloud/observability/health-probe/fly.toml',
      overlay: '',
      rendered: 'infra/cloud/observability/health-probe/fly.toml',
    },
  },
  production: {
    envFile: 'infra/cloud/.env.production.local',
    flyConfig: {
      shared: 'infra/cloud/fly/platform.fly.toml',
      overlay: 'infra/cloud/fly/platform.production.overlay.toml',
      rendered: 'infra/cloud/fly/platform.production.fly.toml',
    },
    healthProbeFlyConfig: {
      shared: 'infra/cloud/observability/health-probe/fly.toml',
      overlay: 'infra/cloud/observability/health-probe/fly.production.overlay.toml',
      rendered: 'infra/cloud/observability/health-probe/fly.production.fly.toml',
    },
  },
};

/**
 * Build the facts projection for one environment.
 *
 * @param {string} id
 * @returns {object}
 */
export function buildEnvironmentFacts(id = DEFAULT_ENVIRONMENT_ID) {
  const environment = getPlatformEnvironment(id);
  const artefacts = ARTEFACTS[environment.id];
  if (!artefacts) {
    throw new Error(`no local artefact layout is defined for environment "${environment.id}"`);
  }

  return {
    id: environment.id,
    label: environment.label,
    platformApp: environment.platformApp,
    healthProbeApp: environment.healthProbeApp,
    githubEnvironment: environment.githubEnvironment,
    /** The repository variable that names this environment's Fly org. */
    flyOrgVariable: environment.flyOrgVariable,
    /**
     * The variable that must be `true` before a deploy of this
     * environment's platform may run. Derived from the environment id.
     */
    deployGateVariable: `${environment.id.toUpperCase()}_PLATFORM_DEPLOY_ENABLED`,
    defaultFlyOrg: DEFAULT_FLY_ORG,
    sourceNames: environment.sourceNames,
    requiredSourceKeys: environment.requiredSourceNames ?? [],
    requiredSourceNames: requiredSourceNames(environment),
    schemas: environment.schemas,
    corsAllowedOrigins: environment.corsAllowedOrigins,
    apiBaseUrls: environment.apiBaseUrls,
    approvalActors: environment.approvalActors,
    artefacts,
  };
}

/**
 * Read a dotted path out of the facts object.
 *
 * @param {object} facts
 * @param {string} path
 * @returns {string|number|boolean|object|null}
 */
export function readFactPath(facts, path) {
  return path
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), facts);
}

/**
 * Parse the CLI arguments.
 *
 * @param {string[]} argv
 * @returns {{environment: string, field: string|null, json: boolean}}
 */
export function parseArgs(argv) {
  const args = { environment: DEFAULT_ENVIRONMENT_ID, field: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--environment') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--environment requires a value');
      args.environment = value;
      index += 1;
      continue;
    }
    if (arg === '--field') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--field requires a value');
      args.field = value;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(
      'Usage: node infra/cloud/platform/platform-environment-facts.mjs ' +
        '[--environment staging|production] [--field dotted.path] [--json]\n',
    );
    return 0;
  }

  let facts;
  try {
    facts = buildEnvironmentFacts(args.environment);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    return 2;
  }

  if (args.field) {
    const value = readFactPath(facts, args.field);
    if (value === undefined || value === null) {
      process.stderr.write(`::error::unknown fact: ${args.field}\n`);
      return 2;
    }
    process.stdout.write(
      `${typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)}\n`,
    );
    return 0;
  }

  process.stdout.write(`${JSON.stringify(facts, null, args.json ? 2 : 0)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
