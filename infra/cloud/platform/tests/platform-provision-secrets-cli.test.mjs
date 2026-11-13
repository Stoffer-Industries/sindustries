#!/usr/bin/env node
/**
 * platform-provision-secrets-cli.test.mjs — CLI-level tests for the platform
 * secret provisioning (task 219fb673).
 *
 * The unit tests beside this file cover the mapping helpers. THIS file
 * drives the real command path — `main()` with a stubbed `flyctl` — and
 * asserts the two things the mapping tests cannot see:
 *
 *   1. The ARGV the script hands to flyctl is executable by the pinned
 *      CLI. The workflow pins flyctl 0.4.102, whose `apps create` accepts
 *      `--name`, `--generate-name`, `--network`, `--machines`, `--yes`,
 *      `--save`, `--org` and `--json` — and NO `--region`, so a `--region`
 *      flag fails on the unknown flag before the app is created and before
 *      a single secret is registered.
 *   2. No secret value reaches stdout/stderr. GitHub masks the source
 *      environment secrets in the CI log, but it does NOT mask the values
 *      this script DERIVES: a schema-rewritten DSN, a JSON-wrapped
 *      approval token. So the assertions here cover the source values AND
 *      the derived values AND whatever the `flyctl` child process prints.
 *
 * No real secret appears in this file: every fixture is obviously fake.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-provision-secrets-cli.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLATFORM_APP,
  SOURCE_NAMES,
  main,
  redactOutput,
} from '../platform-provision-secrets.mjs';

const TASKS_DSN = 'postgresql://tasks_user:tasks_password@db.example.test/neondb?sslmode=require';
const BUDGET_DSN = 'postgresql://budget_user:budget_password@db.example.test/neondb?sslmode=require';
const REDIS_URL = 'rediss://default:redis_password@redis.example.test:6379';
const TASKS_TOKEN = 'tasks-approval-token-value-0123456789';
const SCHEDULER_TOKEN = 'scheduler-approval-token-value-9876543210';

/**
 * A complete staging environment of obviously fake values.
 *
 * @param {object} [overrides]
 * @returns {Record<string, string>}
 */
function stagingEnv(overrides = {}) {
  return {
    [SOURCE_NAMES.tasksDatabaseUrl]: TASKS_DSN,
    [SOURCE_NAMES.budgetDatabaseUrl]: BUDGET_DSN,
    [SOURCE_NAMES.redisUrl]: `content-scheduler=${REDIS_URL}`,
    [SOURCE_NAMES.tasksApprovalToken]: TASKS_TOKEN,
    [SOURCE_NAMES.schedulerApprovalToken]: SCHEDULER_TOKEN,
    ...overrides,
  };
}

/**
 * A stubbed `flyctl` that records every argv it is handed.
 *
 * @param {object} [options]
 * @param {string[]} [options.existingApps] apps that `apps list` reports
 * @param {boolean} [options.failCreate]
 * @param {boolean} [options.failSecrets]
 * @param {string} [options.childOutput] what the child prints on failure
 * @returns {{spawn: Function, calls: {command: string, args: string[]}[]}}
 */
function stubFlyctl(options = {}) {
  const {
    existingApps = [],
    failCreate = false,
    failSecrets = false,
    failList = false,
    listOutput = null,
    childOutput = 'flyctl: something went wrong',
  } = options;

  const calls = [];
  const registered = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'apps' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify(existingApps.map((Name) => ({ Name }))),
        stderr: '',
      };
    }
    if (args[0] === 'apps' && args[1] === 'create') {
      return failCreate
        ? { status: 1, stdout: '', stderr: childOutput }
        : { status: 0, stdout: 'New app created', stderr: '' };
    }
    if (args[0] === 'secrets' && args[1] === 'set') {
      if (failSecrets) return { status: 1, stdout: '', stderr: childOutput };
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0) registered.push(arg.slice(0, eq));
      }
      return { status: 0, stdout: 'Secrets were updated', stderr: '' };
    }
    if (args[0] === 'secrets' && args[1] === 'list') {
      if (failList) return { status: 1, stdout: '', stderr: childOutput };
      const names = listOutput ?? registered;
      return {
        status: 0,
        stdout: JSON.stringify(names.map((name) => ({ name, digest: 'x', status: 'Deployed' }))),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected flyctl call: ${args.join(' ')}` };
  };

  return { spawn, calls };
}

/**
 * Run `main()` against a stubbed flyctl and capture everything it printed.
 *
 * @param {object} [options]
 * @returns {{code: number, output: string, calls: {command: string, args: string[]}[]}}
 */
function runCli(options = {}) {
  const { env = stagingEnv(), ...flyctlOptions } = options;
  const { spawn, calls } = stubFlyctl(flyctlOptions);
  const lines = [];
  const code = main(['--app', PLATFORM_APP, '--org', 'personal'], {
    env,
    spawn,
    log: (message) => lines.push(message),
    errorLog: (message) => lines.push(message),
  });
  return { code, output: lines.join('\n'), calls };
}

/**
 * The argv of the first call that starts with the given prefix.
 *
 * @param {{command: string, args: string[]}[]} calls
 * @param {string[]} prefix
 * @returns {string[]|undefined}
 */
function callStartingWith(calls, prefix) {
  const call = calls.find(
    (entry) => entry.args.slice(0, prefix.length).join(' ') === prefix.join(' ')
  );
  return call?.args;
}

describe('platform provisioning CLI', () => {
  it('creates the app with the arguments the pinned flyctl accepts', () => {
    const { code, calls } = runCli();
    assert.equal(code, 0);
    const create = callStartingWith(calls, ['apps', 'create']);
    assert.ok(create, 'the app should be created when it is absent');
    // Positional app name, --org, --yes. NO --region: flyctl 0.4.102 has
    // no such flag, so passing it fails before the app is created.
    assert.deepEqual(create, ['apps', 'create', PLATFORM_APP, '--org', 'personal', '--yes']);
    assert.ok(!create.includes('--region'));
    assert.ok(!create.includes('--name'));
  });

  it('registers the secrets directly, without --stage', () => {
    const { code, calls } = runCli();
    assert.equal(code, 0);
    const secrets = callStartingWith(calls, ['secrets', 'set']);
    assert.ok(secrets, 'the secrets should be registered');
    assert.deepEqual(secrets.slice(0, 4), ['secrets', 'set', '--app', PLATFORM_APP]);
    assert.ok(
      !secrets.includes('--stage'),
      '--stage holds the values for the next release; on the live deploy the canary Machine still ran with the placeholder that had been registered out of band',
    );
    const names = secrets.slice(4).filter((entry) => entry.includes('=')).map((entry) => entry.split('=')[0]);
    assert.equal(names.length, 15);
    for (const name of [
      'PLATFORM_TASKS_API_DATABASE_URL',
      'PLATFORM_BUDGET_API_DATABASE_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      'PLATFORM_TASKS_API_REDIS_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
      'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
      'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
      'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
      'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
      'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
      'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
    ]) {
      assert.ok(names.includes(name), `${name} should be registered`);
    }
  });

  it('writes the secrets detached, so the write is not health-gated on the running image', () => {
    const { code, calls } = runCli();
    assert.equal(code, 0);
    const secrets = callStartingWith(calls, ['secrets', 'set']);
    assert.ok(secrets, 'the secrets should be registered');
    // `flyctl secrets set` also restarts the app's Machines, and in the
    // pinned flyctl (0.4.102) that restart is a Machine deployment whose
    // progress flyctl follows. When the running image is unhealthy --
    // exactly the state a deploy is meant to repair -- the follow fails,
    // the command exits non-zero, and the workflow aborts BEFORE the
    // canary deploy that carries the fix (main CI run 42366203146 on
    // merge commit 27269dbb). `--detach` sets SkipHealthChecks in the
    // restart-only deployment, so the write cannot be failed by the
    // health of the image it is about to be replaced by.
    assert.ok(
      secrets.includes('--detach'),
      'the secret write must be detached so a health-gated restart cannot abort the deploy that fixes it',
    );
    // The payload is NAME=VALUE pairs; the flags come first so a value
    // that contains an '=' is still one argument.
    const firstPayloadIndex = secrets.findIndex((entry) => entry.includes('='));
    assert.ok(firstPayloadIndex > 0, 'the payload follows the flags');
    assert.ok(
      secrets.slice(0, firstPayloadIndex).every((entry) => entry.startsWith('--') || !entry.includes('=')),
      'every flag must precede the payload',
    );
  });

  it('does not create the app when it already exists', () => {
    const { code, calls } = runCli({ existingApps: [PLATFORM_APP] });
    assert.equal(code, 0);
    assert.equal(callStartingWith(calls, ['apps', 'create']), undefined);
    assert.ok(callStartingWith(calls, ['secrets', 'set']));
  });

  it('registers no secrets when the app cannot be created', () => {
    const { code, calls, output } = runCli({ failCreate: true });
    assert.notEqual(code, 0);
    assert.equal(callStartingWith(calls, ['secrets', 'set']), undefined);
    assert.match(output, /apps create/);
  });

  it('fails closed when a write-capable database source is missing', () => {
    const env = stagingEnv();
    delete env[SOURCE_NAMES.tasksDatabaseUrl];
    const { code, output, calls } = runCli({ env });
    assert.equal(code, 1);
    assert.match(output, /STAGING_TASKS_API_DATABASE_URL/);
    assert.match(output, /WRITE-CAPABLE/i);
    // Nothing was created and nothing was registered.
    assert.deepEqual(calls, []);
  });

  it('fails closed before Fly when the Redis source is not a usable URL', () => {
    const env = stagingEnv({
      [SOURCE_NAMES.redisUrl]: 'content-scheduler=REPLACE_ME_SEE_QUINN_NOTES',
    });
    const { code, output, calls } = runCli({ env });
    assert.equal(code, 1);
    assert.match(output, /HEALTH_PROBE_REDIS/);
    assert.match(output, /usable redis:\/\/ or rediss:\/\/ URL/);
    assert.equal(callStartingWith(calls, ['secrets', 'set']), undefined);
  });

  it('never prints a source or derived secret value', () => {
    const { code, output, calls } = runCli();
    assert.equal(code, 0);

    // The source values, as they arrive from the staging environment.
    for (const value of [TASKS_DSN, BUDGET_DSN, REDIS_URL, TASKS_TOKEN, SCHEDULER_TOKEN]) {
      assert.ok(!output.includes(value), `the output must not contain a source value: ${value}`);
    }
    // The password parts on their own.
    for (const value of ['tasks_password', 'budget_password', 'redis_password']) {
      assert.ok(!output.includes(value), `the output must not contain a password: ${value}`);
    }
    // The DERIVED values — the ones GitHub does NOT mask.
    const secrets = callStartingWith(calls, ['secrets', 'set']) ?? [];
    for (const entry of secrets.slice(5)) {
      const value = entry.slice(entry.indexOf('=') + 1);
      assert.ok(!output.includes(value), 'the output must not contain a derived secret value');
    }
  });

  it('does not echo a value the flyctl child process printed', () => {
    // A future flyctl, or a debug line in this script, must not be able to
    // publish a derived value: the child's output is redacted before it
    // is logged.
    const { code, output } = runCli({
      failSecrets: true,
      childOutput: `failed to set TASKS_API_APPROVAL_SERVICE_CREDENTIALS=${TASKS_TOKEN}`,
    });
    assert.notEqual(code, 0);
    assert.ok(!output.includes(TASKS_TOKEN));
    assert.match(output, /\[redacted\]/);
  });

  it('reports the missing source by name without naming a value', () => {
    const env = stagingEnv();
    delete env[SOURCE_NAMES.budgetDatabaseUrl];
    const { code, output } = runCli({ env });
    assert.equal(code, 1);
    assert.match(output, /STAGING_BUDGET_API_DATABASE_URL/);
    assert.ok(!output.includes(BUDGET_DSN));
  });

  it('dry-runs without touching flyctl', () => {
    const { spawn, calls } = stubFlyctl();
    const lines = [];
    const code = main(['--app', PLATFORM_APP, '--dry-run'], {
      env: stagingEnv(),
      spawn,
      log: (message) => lines.push(message),
      errorLog: (message) => lines.push(message),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    const output = lines.join('\n');
    assert.match(output, /PLATFORM_TASKS_API_DATABASE_URL <- STAGING_TASKS_API_DATABASE_URL/);
    assert.ok(!output.includes(TASKS_DSN));
  });
});

describe('secret application', () => {
  it('sets the secrets directly, so the Machine the deploy creates gets them', () => {
    const { code, calls } = runCli();
    assert.equal(code, 0);

    const setCall = calls.find((entry) => entry.args[0] === 'secrets' && entry.args[1] === 'set');
    assert.ok(setCall, 'the secrets must be set');
    assert.ok(
      !setCall.args.includes('--stage'),
      'staged secrets never reached the canary Machine on the live deploy; set them directly',
    );
  });

  it('reads the secret list back and confirms every name landed', () => {
    const { code, output } = runCli();
    assert.equal(code, 0);
    assert.match(output, /Verified \d+ secret name\(s\) registered/);
  });

  it('fails loudly when a secret did not register', () => {
    const { code, output } = runCli({ listOutput: ['PLATFORM_TASKS_API_DATABASE_URL'] });
    assert.equal(code, 1);
    assert.match(output, /did not register/);
  });

  it('fails loudly when the secret list cannot be read back', () => {
    const { code, output } = runCli({ failList: true });
    assert.equal(code, 1);
    assert.match(output, /could not read the secret list back/);
  });
});

describe('redactOutput', () => {
  it('masks URL credentials', () => {
    assert.equal(
      redactOutput('connecting to postgres://user:hunter2@db.example.test/neondb'),
      'connecting to postgres://[redacted]@db.example.test/neondb'
    );
  });

  it('masks secret assignments', () => {
    assert.equal(
      redactOutput('TASKS_API_APPROVAL_SERVICE_CREDENTIALS=abc123'),
      'TASKS_API_APPROVAL_SERVICE_CREDENTIALS=[redacted]'
    );
  });

  it('masks JSON credential fields', () => {
    assert.equal(
      redactOutput('{"token":"abc123","actor":"staging"}'),
      '{"token":"[redacted]","actor":"staging"}'
    );
  });

  it('leaves ordinary text alone', () => {
    assert.equal(redactOutput('Fly app sindustries-platform-staging already exists'), 'Fly app sindustries-platform-staging already exists');
  });
});
