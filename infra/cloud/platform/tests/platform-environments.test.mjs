#!/usr/bin/env node
/**
 * platform-environments.test.mjs — contract tests for the platform
 * environment manifest and the production separation guards (task fb1240c0).
 *
 * The manifest is the place where "which environment is this?" becomes a
 * fact instead of a hard-coded string, so the tests here cover the two
 * directions that matter:
 *
 *   1. STAGING MUST NOT CHANGE. Every existing call site means staging, so
 *      the default environment has to keep behaving exactly as it did.
 *   2. PRODUCTION MUST BE SEPARATE. A production payload that carries a
 *      staging hostname, a placeholder or a localhost address must be
 *      refused BEFORE it reaches Fly — that value would be
 *      indistinguishable from a correct one at runtime.
 *
 * No secret value appears in this file: every fixture is obviously fake.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-environments.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEFAULT_ENVIRONMENT_ID,
  PLATFORM_ENVIRONMENTS,
  assertEnvironmentManifest,
  assertEnvironmentValues,
  findForbiddenValues,
  getPlatformEnvironment,
  requiredDatabaseSourceNames,
} from '../platform-environments.mjs';
import { buildPlatformSecretPayload, main } from '../platform-provision-secrets.mjs';

const STAGING = PLATFORM_ENVIRONMENTS.staging;
const PRODUCTION = PLATFORM_ENVIRONMENTS.production;
const HOSTNAME_MATRIX = JSON.parse(
  readFileSync(new URL('../../hostname-matrix.json', import.meta.url), 'utf8'),
);
const STAGING_PLATFORM_FLY_TOML = readFileSync(
  new URL('../../fly/platform.fly.toml', import.meta.url),
  'utf8',
);
const STAGING_HEALTH_PROBE_FLY_TOML = readFileSync(
  new URL('../../observability/health-probe/fly.toml', import.meta.url),
  'utf8',
);
const TASKS_APPROVAL_AUTH_SOURCE = readFileSync(
  new URL('../../../../services/tasks-api/src/middleware/approvalAuth.ts', import.meta.url),
  'utf8',
);
const PRODUCTION_BLOCKERS = readFileSync(
  new URL('../../../../docs/cloud/production-blockers.md', import.meta.url),
  'utf8',
);

const PRODUCTION_TASKS_DSN =
  'postgresql://prod_user:***@ep-production.example.test/neondb?sslmode=require';
const PRODUCTION_BUDGET_DSN =
  'postgresql://prod_user:***@ep-production.example.test/neondb?sslmode=require';
const PRODUCTION_REDIS_URL = 'rediss://default:***@redis-production.example.test:6379';

/**
 * A complete production environment of obviously fake values.
 *
 * @param {object} [overrides]
 * @returns {Record<string, string>}
 */
function productionEnv(overrides = {}) {
  return {
    [PRODUCTION.sourceNames.tasksDatabaseUrl]: PRODUCTION_TASKS_DSN,
    [PRODUCTION.sourceNames.budgetDatabaseUrl]: PRODUCTION_BUDGET_DSN,
    [PRODUCTION.sourceNames.redisUrl]: `content-scheduler=${PRODUCTION_REDIS_URL}`,
    [PRODUCTION.sourceNames.tasksApprovalToken]: 'p'.repeat(32),
    [PRODUCTION.sourceNames.schedulerApprovalToken]: 'q'.repeat(32),
    ...overrides,
  };
}

/**
 * A stubbed `flyctl` that records the argv it is handed.
 *
 * @returns {{spawn: Function, calls: {command: string, args: string[]}[]}}
 */
function stubFlyctl() {
  const calls = [];
  const registered = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'apps' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    }
    if (args[0] === 'apps' && args[1] === 'create') {
      return { status: 0, stdout: 'New app created', stderr: '' };
    }
    if (args[0] === 'secrets' && args[1] === 'set') {
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0) registered.push(arg.slice(0, eq));
      }
      return { status: 0, stdout: 'Secrets were updated', stderr: '' };
    }
    if (args[0] === 'secrets' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify(registered.map((name) => ({ name, digest: 'x' }))),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected flyctl call: ${args.join(' ')}` };
  };
  return { spawn, calls };
}

/**
 * Run the CLI against a stubbed flyctl.
 *
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {{code: number, output: string, calls: {command: string, args: string[]}[]}}
 */
function runCli(argv, env) {
  const { spawn, calls } = stubFlyctl();
  const lines = [];
  const code = main(argv, {
    env,
    spawn,
    log: (message) => lines.push(message),
    errorLog: (message) => lines.push(message),
  });
  return { code, output: lines.join('\n'), calls };
}

describe('platform environment manifest', () => {
  it('ships a manifest for every environment the platform is provisioned for', () => {
    assert.deepEqual(Object.keys(PLATFORM_ENVIRONMENTS).sort(), ['production', 'staging']);
    assert.equal(DEFAULT_ENVIRONMENT_ID, 'staging');
  });

  it('gives every environment the facts that differ between them', () => {
    for (const environment of Object.values(PLATFORM_ENVIRONMENTS)) {
      assert.ok(environment.platformApp, `${environment.id} needs a platform app name`);
      assert.ok(environment.healthProbeApp, `${environment.id} needs a health-probe app name`);
      assert.ok(environment.githubEnvironment, `${environment.id} needs a GitHub environment`);
      assert.ok(environment.schemas.tasks, `${environment.id} needs a tasks schema`);
      assert.ok(environment.schemas.budget, `${environment.id} needs a budget schema`);
      assert.ok(
        environment.schemas.contentScheduler,
        `${environment.id} needs a content-scheduler schema`,
      );
      assert.ok(
        environment.apiBaseUrls.contentSchedulerApi,
        `${environment.id} needs a content-scheduler base URL`,
      );
      assert.ok(
        environment.approvalActors.tasks,
        `${environment.id} needs a tasks approval actor`,
      );
      for (const key of environment.requiredSourceNames) {
        assert.ok(
          environment.sourceNames[key],
          `${environment.id} needs a source name for ${key}`,
        );
      }
    }
  });

  it('gives production its own app names and hostnames', () => {
    assert.equal(PRODUCTION.platformApp, 'sindustries-platform-production');
    assert.equal(PRODUCTION.healthProbeApp, 'sindustries-health-probe-production');
    assert.notEqual(PRODUCTION.platformApp, STAGING.platformApp);
    assert.notEqual(PRODUCTION.healthProbeApp, STAGING.healthProbeApp);
    for (const url of Object.values(PRODUCTION.apiBaseUrls)) {
      assert.ok(!url.includes('staging'), `${url} must not be a staging URL`);
      assert.ok(url.startsWith('https://'), `${url} must be an https URL`);
    }
  });

  it('matches the deployed staging health-probe app and hostname matrix', () => {
    assert.equal(STAGING.healthProbeApp, 'sindustries-health-probe-staging');
    assert.match(
      STAGING_HEALTH_PROBE_FLY_TOML,
      /^app = 'sindustries-health-probe-staging'$/m,
    );
    const healthProbe = HOSTNAME_MATRIX.surfaces.find((surface) => surface.id === 'health-probe');
    assert.equal(
      healthProbe.cnameTargets.staging,
      `${STAGING.healthProbeApp}.fly.dev`,
    );
  });

  it('maps the production health probe to the manifest app while retaining only the legacy fallback', () => {
    const healthProbe = HOSTNAME_MATRIX.surfaces.find((surface) => surface.id === 'health-probe');
    assert.equal(healthProbe.flyApp, PRODUCTION.healthProbeApp);
    assert.equal(
      healthProbe.cnameTargets.production,
      `${PRODUCTION.healthProbeApp}.fly.dev`,
    );
    // stable-fallback: the legacy provider host remains migration evidence.
    assert.equal(healthProbe.providerFallback, 'sindustries-health-probe.fly.dev');
  });

  it('keeps the forward-looking production register on the manifest app names', () => {
    const sectionFive = PRODUCTION_BLOCKERS.split('### 5.')[1].split('### 6.')[0];
    assert.ok(sectionFive.includes(`\`${PRODUCTION.platformApp}\``));
    assert.ok(sectionFive.includes(`\`${PRODUCTION.healthProbeApp}\``));
    for (const retiredApp of [
      'sindustries-tasks-api',
      'sindustries-budget-api',
      'sindustries-content-scheduler-api',
      'sindustries-health-probe',
      'sindustries-auto-post-worker',
    ]) {
      assert.ok(!sectionFive.includes(`\`${retiredApp}\``));
    }
  });

  it('preserves the observed legacy app names in section 9 as history', () => {
    const sectionNine = PRODUCTION_BLOCKERS.split('### 9.')[1];
    assert.match(sectionNine, /`sindustries-tasks-api`/);
    assert.match(sectionNine, /`sindustries-health-probe`/);
  });

  it('maps every production API hostname to the consolidated production app', () => {
    for (const id of ['tasks-api', 'budget-api', 'content-scheduler-api']) {
      const surface = HOSTNAME_MATRIX.surfaces.find((entry) => entry.id === id);
      assert.equal(surface.flyApp, PRODUCTION.platformApp, `${id} Fly app drifted`);
      assert.equal(
        surface.cnameTargets.production,
        `${PRODUCTION.platformApp}.fly.dev`,
        `${id} production CNAME drifted`,
      );
    }
    const scheduler = HOSTNAME_MATRIX.surfaces.find(
      (surface) => surface.id === 'content-scheduler-api',
    );
    assert.equal(
      new URL(PRODUCTION.apiBaseUrls.contentSchedulerApi).hostname,
      scheduler.production,
    );
  });

  it('reads production sources from the production GitHub environment', () => {
    assert.equal(PRODUCTION.githubEnvironment, 'production');
    for (const name of Object.values(PRODUCTION.sourceNames)) {
      assert.ok(
        name.startsWith('PRODUCTION_'),
        `${name} must carry the PRODUCTION_ label`,
      );
    }
  });

  it('never reuses a staging source name in production', () => {
    const stagingSources = new Set(Object.values(STAGING.sourceNames));
    for (const name of Object.values(PRODUCTION.sourceNames)) {
      assert.ok(!stagingSources.has(name), `${name} is a staging source name`);
    }
  });

  it('keeps the optional content-scheduler source out of the required list', () => {
    // The content-scheduler schema lives in the same database as tasks_api,
    // so its DSN is derived rather than required — in BOTH environments.
    assert.ok(!PRODUCTION.requiredSourceNames.includes('contentSchedulerDatabaseUrl'));
    assert.ok(!STAGING.requiredSourceNames.includes('contentSchedulerDatabaseUrl'));
    assert.deepEqual(requiredDatabaseSourceNames(PRODUCTION), [
      PRODUCTION.sourceNames.tasksDatabaseUrl,
      PRODUCTION.sourceNames.budgetDatabaseUrl,
    ]);
  });

  it('resolves an environment by id and refuses an unknown one', () => {
    assert.equal(getPlatformEnvironment('production').id, 'production');
    assert.equal(getPlatformEnvironment('PRODUCTION').id, 'production');
    assert.equal(getPlatformEnvironment().id, 'staging');
    assert.throws(() => getPlatformEnvironment('prod'), /unknown platform environment/);
  });
});

describe('assertEnvironmentManifest', () => {
  it('accepts the shipped manifests', () => {
    assert.doesNotThrow(() => assertEnvironmentManifest(STAGING));
    assert.doesNotThrow(() => assertEnvironmentManifest(PRODUCTION));
  });

  it('refuses a production manifest that reads a staging source', () => {
    const broken = {
      ...PRODUCTION,
      sourceNames: { ...PRODUCTION.sourceNames, tasksDatabaseUrl: STAGING.sourceNames.tasksDatabaseUrl },
    };
    assert.throws(() => assertEnvironmentManifest(broken), /must not read staging source names/);
  });

  it('refuses a production manifest that reuses the staging app name', () => {
    const broken = { ...PRODUCTION, platformApp: STAGING.platformApp };
    assert.throws(() => assertEnvironmentManifest(broken), /must not reuse the staging platform app/);
  });

  it('refuses a production manifest that reuses a staging base URL', () => {
    const broken = {
      ...PRODUCTION,
      apiBaseUrls: { ...PRODUCTION.apiBaseUrls, tasksApi: STAGING.apiBaseUrls.tasksApi },
    };
    assert.throws(() => assertEnvironmentManifest(broken), /must not reuse staging base URLs/);
  });

  it('refuses a production source name without the production label', () => {
    const broken = {
      ...PRODUCTION,
      sourceNames: { ...PRODUCTION.sourceNames, redisUrl: 'HEALTH_PROBE_REDIS_PROD' },
    };
    assert.throws(() => assertEnvironmentManifest(broken), /must carry the PRODUCTION_ label/);
  });

  it('refuses a manifest without a required CORS allow-list', () => {
    const broken = {
      ...PRODUCTION,
      corsAllowedOrigins: { ...PRODUCTION.corsAllowedOrigins, budgetApi: [] },
    };
    assert.throws(() => assertEnvironmentManifest(broken), /has no CORS origins for budgetApi/);
  });

  it('refuses a production manifest that drops a forbidden host environment label', () => {
    const broken = {
      ...PRODUCTION,
      forbiddenHostLabels: (PRODUCTION.forbiddenHostLabels ?? []).filter(
        (label) => label !== 'dev',
      ),
    };
    assert.throws(
      () => assertEnvironmentManifest(broken),
      /must forbid these host environment labels: dev/,
    );
  });
});

describe('findForbiddenValues', () => {
  it('finds a staging hostname in a production value', () => {
    const found = findForbiddenValues(PRODUCTION, {
      'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL':
        'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].marker, 'staging.sindustries.co.nz');
  });

  it('finds a placeholder and a localhost address', () => {
    assert.equal(findForbiddenValues(PRODUCTION, { A: 'REPLACE_ME_SEE_QUINN_NOTES' }).length, 1);
    assert.equal(
      findForbiddenValues(PRODUCTION, { A: 'postgresql://u:***@localhost:7432/sindustries_prodlike' })
        .length,
      1,
    );
  });

  it('accepts a clean production value', () => {
    assert.deepEqual(findForbiddenValues(PRODUCTION, { A: PRODUCTION_TASKS_DSN }), []);
  });

  it('rejects provider-style staging Neon and Upstash hostnames', () => {
    const found = findForbiddenValues(PRODUCTION, {
      DATABASE_URL: 'postgresql://u:***@ep-staging-blue-123.neon.tech/neondb',
      REDIS_URL: 'rediss://default:***@broad-staging-fox.upstash.io:6379',
    });
    assert.deepEqual(
      found.map((entry) => entry.label).sort(),
      ['DATABASE_URL', 'REDIS_URL'],
    );
    assert.ok(found.every((entry) => entry.marker === 'staging hostname segment'));
  });

  it('rejects provider-style dev Neon and Upstash endpoints', () => {
    const found = findForbiddenValues(PRODUCTION, {
      DATABASE_URL: 'postgresql://u:***@ep-dev-blue-123.us-east-2.aws.neon.tech/neondb',
      REDIS_URL: 'rediss://default:***@eu1-dev-redis.upstash.io:6379',
    });
    assert.deepEqual(
      found.map((entry) => entry.label).sort(),
      ['DATABASE_URL', 'REDIS_URL'],
    );
    assert.ok(found.every((entry) => entry.marker === 'environment label "dev"'));
  });

  it('rejects a host whose DNS label carries the environment word', () => {
    const found = findForbiddenValues(PRODUCTION, {
      DATABASE_URL: 'postgresql://u:***@staging-db.neon.tech/neondb',
      REDIS_URL: 'rediss://default:***@staging.upstash.io:6379',
    });
    assert.deepEqual(
      found.map((entry) => entry.label).sort(),
      ['DATABASE_URL', 'REDIS_URL'],
    );
    assert.ok(found.every((entry) => entry.marker === 'environment label "staging"'));
  });

  it('accepts a production endpoint whose provider label is not an environment word', () => {
    assert.deepEqual(
      findForbiddenValues(PRODUCTION, {
        DATABASE_URL: 'postgresql://u:***@ep-cool-blue-123.us-east-2.aws.neon.tech/neondb',
        REDIS_URL: 'rediss://default:***@eu1-cool-redis.upstash.io:6379',
      }),
      [],
    );
  });

  it('ignores a value that is not a host', () => {
    // The approval credential blob is JSON: it must never be read as a
    // hostname, or a token that happens to contain an environment word
    // would fail a production payload for no reason.
    assert.deepEqual(
      findForbiddenValues(PRODUCTION, {
        TASKS_API_APPROVAL_SERVICE_CREDENTIALS:
          '[{"token":"dev-elephant-quartz","actor":"production-cloud-validate","approvalTypes":[]}]',
      }),
      [],
    );
  });

  it('imposes no markers on staging, whose values carry staging hostnames', () => {
    assert.deepEqual(
      findForbiddenValues(STAGING, {
        A: 'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
      }),
      [],
    );
  });
});

describe('assertEnvironmentValues', () => {
  it('names the secret and the marker, never the value', () => {
    assert.throws(
      () =>
        assertEnvironmentValues(PRODUCTION, [
          {
            name: 'PLATFORM_TASKS_API_DATABASE_URL',
            value: 'postgresql://u:***@localhost:7432/sindustries_prodlike',
          },
        ]),
      /PLATFORM_TASKS_API_DATABASE_URL contains a forbidden marker \(localhost\)/,
    );
  });
});

describe('buildPlatformSecretPayload for production', () => {
  it('maps the production source names onto the same fifteen platform value names', () => {
    const { secrets, missing } = buildPlatformSecretPayload(productionEnv(), {
      environment: 'production',
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(
      secrets.map((secret) => secret.name).sort(),
      [
        'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
        'PLATFORM_AUTO_POST_WORKER_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
        'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
        'PLATFORM_BUDGET_API_DATABASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
        'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
        'PLATFORM_TASKS_API_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
        'PLATFORM_TASKS_API_DATABASE_URL',
        'PLATFORM_TASKS_API_REDIS_URL',
        'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
      ],
    );
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.match(byName.PLATFORM_TASKS_API_DATABASE_URL, /schema=tasks_api/);
    assert.match(byName.PLATFORM_BUDGET_API_DATABASE_URL, /schema=budget_api/);
    assert.match(byName.PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL, /schema=content_scheduler/);
  });

  it('registers the production content-scheduler base URL, not the staging one', () => {
    const { secrets } = buildPlatformSecretPayload(productionEnv(), { environment: 'production' });
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.equal(
      byName.PLATFORM_CONTENT_SCHEDULER_API_BASE_URL,
      'https://content-scheduler-api.sindustries.co.nz/api/v1',
    );
  });

  it('registers production CORS origins from the production manifest', () => {
    const { secrets } = buildPlatformSecretPayload(productionEnv(), { environment: 'production' });
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.equal(
      byName.PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS,
      PRODUCTION.corsAllowedOrigins.tasksApi.join(','),
    );
    assert.equal(
      byName.PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS,
      PRODUCTION.corsAllowedOrigins.budgetApi.join(','),
    );
    assert.equal(
      byName.PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS,
      PRODUCTION.corsAllowedOrigins.contentSchedulerApi.join(','),
    );
    assert.ok(!byName.PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS.includes('.staging.'));
  });

  it('keeps the staging Fly TOML CORS defaults in parity with the manifest', () => {
    for (const [name, origins] of [
      ['PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS', STAGING.corsAllowedOrigins.tasksApi],
      ['PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS', STAGING.corsAllowedOrigins.budgetApi],
      [
        'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
        STAGING.corsAllowedOrigins.contentSchedulerApi,
      ],
    ]) {
      const match = STAGING_PLATFORM_FLY_TOML.match(
        new RegExp(`^\\s*${name} = '([^']+)'$`, 'm'),
      );
      assert.ok(match, `${name} missing from staging Fly config`);
      assert.equal(match[1], origins.join(','), `${name} drifted from the manifest`);
    }
  });

  it('enforces requiredSourceNames added to a manifest', () => {
    const stricter = {
      ...PRODUCTION,
      requiredSourceNames: [
        ...PRODUCTION.requiredSourceNames,
        'contentSchedulerDatabaseUrl',
      ],
    };
    const { missing } = buildPlatformSecretPayload(productionEnv(), { environment: stricter });
    assert.deepEqual(missing, [PRODUCTION.sourceNames.contentSchedulerDatabaseUrl]);
  });

  it('acts as the production approval actor, not the staging one', () => {
    const { secrets } = buildPlatformSecretPayload(productionEnv(), { environment: 'production' });
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    const tasks = JSON.parse(byName.TASKS_API_APPROVAL_SERVICE_CREDENTIALS);
    assert.equal(tasks[0].actor, 'production-cloud-validate');
  });

  it('keeps production approval-row authority fail-closed', () => {
    const permissions = TASKS_APPROVAL_AUTH_SOURCE.match(
      /const ACTOR_PERMISSIONS:[^{]+\{([\s\S]*?)\n\};/,
    );
    assert.ok(permissions, 'Tasks API ACTOR_PERMISSIONS map must remain discoverable');
    assert.doesNotMatch(
      permissions[1],
      /production-cloud-validate\s*:/,
      'production-cloud-validate must not gain approval-row authority implicitly',
    );
  });

  it('fails closed when a production payload carries a staging value', () => {
    assert.throws(
      () =>
        buildPlatformSecretPayload(
          productionEnv({
            [PRODUCTION.sourceNames.tasksDatabaseUrl]:
              'postgresql://u:***@db.staging.example.test/neondb',
          }),
          { environment: 'production' },
        ),
      /refuses these values/,
    );
  });

  it('fails closed when a production payload carries a provider-style dev endpoint', () => {
    assert.throws(
      () =>
        buildPlatformSecretPayload(
          productionEnv({
            [PRODUCTION.sourceNames.tasksDatabaseUrl]:
              'postgresql://u:***@ep-dev-blue-123.us-east-2.aws.neon.tech/neondb',
            [PRODUCTION.sourceNames.redisUrl]:
              'content-scheduler=rediss://default:***@eu1-dev-redis.upstash.io:6379',
          }),
          { environment: 'production' },
        ),
      /refuses these values/,
    );
  });

  it('reports the missing production source by name', () => {
    const env = productionEnv();
    delete env[PRODUCTION.sourceNames.budgetDatabaseUrl];
    const { missing } = buildPlatformSecretPayload(env, { environment: 'production' });
    assert.deepEqual(missing, [PRODUCTION.sourceNames.budgetDatabaseUrl]);
  });

  it('defaults to staging, so every existing call site is unchanged', () => {
    const { secrets } = buildPlatformSecretPayload({
      [STAGING.sourceNames.tasksDatabaseUrl]: 'postgresql://u:***@db.example.test/neondb',
      [STAGING.sourceNames.budgetDatabaseUrl]: 'postgresql://u:***@db.example.test/neondb',
      [STAGING.sourceNames.redisUrl]: 'rediss://default:***@redis.example.test:6379',
      [STAGING.sourceNames.tasksApprovalToken]: 'a'.repeat(32),
      [STAGING.sourceNames.schedulerApprovalToken]: 'b'.repeat(32),
    });
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.equal(
      byName.PLATFORM_CONTENT_SCHEDULER_API_BASE_URL,
      'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
    );
  });
});

describe('the provisioning CLI with an environment', () => {
  it('provisions the production app when asked for production', () => {
    const { code, calls } = runCli(['--environment', 'production'], productionEnv());
    assert.equal(code, 0);
    const create = calls.find((entry) => entry.args[0] === 'apps' && entry.args[1] === 'create');
    assert.ok(create);
    assert.equal(create.args[2], 'sindustries-platform-production');
  });

  it('fails closed before Fly when a production value carries a staging marker', () => {
    const env = productionEnv({
      [PRODUCTION.sourceNames.redisUrl]:
        'content-scheduler=rediss://default:***@redis.staging.example.test:6379',
    });
    const { code, output, calls } = runCli(['--environment', 'production'], env);
    assert.equal(code, 1);
    assert.match(output, /refuses these values/);
    assert.deepEqual(calls, [], 'nothing may be created or registered');
  });

  it('fails closed when a production source is missing, before Fly', () => {
    const env = productionEnv();
    delete env[PRODUCTION.sourceNames.tasksApprovalToken];
    const { code, output, calls } = runCli(['--environment', 'production'], env);
    assert.equal(code, 1);
    assert.match(output, /PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN/);
    assert.deepEqual(calls, []);
  });

  it('refuses an app name that does not belong to the environment', () => {
    const { code, output, calls } = runCli(
      ['--environment', 'production', '--app', 'sindustries-platform-staging'],
      productionEnv(),
    );
    assert.equal(code, 2);
    assert.match(output, /does not match the production environment/);
    assert.deepEqual(calls, []);
  });

  it('refuses an unknown environment', () => {
    const { code, output, calls } = runCli(['--environment', 'prod'], productionEnv());
    assert.equal(code, 2);
    assert.match(output, /unknown platform environment/);
    assert.deepEqual(calls, []);
  });

  for (const option of ['--environment', '--app', '--org']) {
    it(`refuses ${option} without a value before Fly`, () => {
      const { code, output, calls } = runCli([option], productionEnv());
      assert.equal(code, 2);
      assert.match(output, new RegExp(`${option} requires a value`));
      assert.deepEqual(calls, []);
    });
  }

  it('does not consume the next flag as an environment value', () => {
    const { code, output, calls } = runCli(
      ['--environment', '--dry-run'],
      productionEnv(),
    );
    assert.equal(code, 2);
    assert.match(output, /--environment requires a value/);
    assert.deepEqual(calls, []);
  });

  it('dry-runs the production payload without touching flyctl', () => {
    const { code, output, calls } = runCli(['--environment', 'production', '--dry-run'], productionEnv());
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    assert.match(
      output,
      /PLATFORM_TASKS_API_DATABASE_URL <- PRODUCTION_TASKS_API_DATABASE_URL/,
    );
    assert.ok(!output.includes(PRODUCTION_TASKS_DSN));
  });
});
