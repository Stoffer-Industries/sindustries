#!/usr/bin/env node
/**
 * platform-provision-secrets.test.mjs — unit tests for the platform secret
 * provisioning (task 219fb673).
 *
 * The provisioning step is the one place where a wrong mapping silently
 * points a staging child at the wrong database or the wrong Redis
 * instance, so the mapping itself is tested here rather than only the
 * happy path of the CLI. No secret value appears in this file: every
 * fixture is obviously fake.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-provision-secrets.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONTENT_SCHEDULER_API_BASE_URL,
  SOURCE_NAMES,
  buildPlatformSecretPayload,
  buildServiceCredentials,
  deriveDatabaseUrl,
  parseLabeledEntries,
  pickRedisUrl,
} from '../platform-provision-secrets.mjs';

const TASKS_DSN = 'postgresql://user:pa$$word@db.example.test/neondb?sslmode=require';
const BUDGET_DSN = 'postgresql://user:pa$$word@db.example.test/neondb?sslmode=require';
const REDIS_URL = 'rediss://default:token@redis.example.test:6379';

/**
 * A complete staging environment.
 *
 * @param {object} [overrides]
 * @returns {Record<string, string>}
 */
function stagingEnv(overrides = {}) {
  return {
    [SOURCE_NAMES.tasksDatabaseUrl]: TASKS_DSN,
    [SOURCE_NAMES.budgetDatabaseUrl]: BUDGET_DSN,
    [SOURCE_NAMES.redisUrl]: `content-scheduler=${REDIS_URL}`,
    [SOURCE_NAMES.tasksApprovalToken]: 'a'.repeat(32),
    [SOURCE_NAMES.schedulerApprovalToken]: 'b'.repeat(32),
    ...overrides,
  };
}

describe('parseLabeledEntries', () => {
  it('parses a label=value list', () => {
    assert.deepEqual(parseLabeledEntries('tasks-api=postgres://a,budget-api=postgres://b'), [
      { label: 'tasks-api', value: 'postgres://a' },
      { label: 'budget-api', value: 'postgres://b' },
    ]);
  });

  it('accepts a bare value with no label', () => {
    assert.deepEqual(parseLabeledEntries('postgres://a'), [{ label: '', value: 'postgres://a' }]);
  });

  it('returns nothing for an empty value', () => {
    assert.deepEqual(parseLabeledEntries(''), []);
    assert.deepEqual(parseLabeledEntries('   '), []);
  });

  it('keeps an = inside the value', () => {
    const entries = parseLabeledEntries('content-scheduler=rediss://default:tok=1@redis.test:6379');
    assert.equal(entries[0].value, 'rediss://default:tok=1@redis.test:6379');
  });
});

describe('pickRedisUrl', () => {
  it('returns the URL from a labelled secret', () => {
    assert.equal(pickRedisUrl(`content-scheduler=${REDIS_URL}`), REDIS_URL);
  });

  it('returns the URL when the secret is unlabelled', () => {
    assert.equal(pickRedisUrl(REDIS_URL), REDIS_URL);
  });

  it('accepts several labels that all carry the same URL', () => {
    assert.equal(pickRedisUrl(`a=${REDIS_URL},b=${REDIS_URL}`), REDIS_URL);
  });

  it('refuses to guess between distinct URLs', () => {
    assert.throws(
      () => pickRedisUrl(`a=${REDIS_URL},b=rediss://default:other@other.test:6379`),
      /distinct URLs/
    );
  });

  it('fails on an empty secret', () => {
    assert.throws(() => pickRedisUrl(''), /no Redis URL/);
  });

  it('fails when the labelled value is not a Redis URL', () => {
    assert.throws(
      () => pickRedisUrl('content-scheduler=REPLACE_ME_SEE_QUINN_NOTES'),
      /usable redis:\/\/ or rediss:\/\/ URL/,
    );
  });

  it('fails when identical labelled values are not Redis URLs', () => {
    assert.throws(
      () => pickRedisUrl('tasks-api=placeholder,content-scheduler=placeholder'),
      /usable redis:\/\/ or rediss:\/\/ URL/,
    );
  });
});

describe('deriveDatabaseUrl', () => {
  it('adds the schema parameter when the DSN has none', () => {
    assert.equal(
      deriveDatabaseUrl('postgresql://u:p@h.test/db', 'tasks_api'),
      'postgresql://u:p@h.test/db?schema=tasks_api'
    );
  });

  it('replaces an existing schema parameter', () => {
    assert.equal(
      deriveDatabaseUrl('postgresql://u:p@h.test/db?schema=public&sslmode=require', 'budget_api'),
      'postgresql://u:p@h.test/db?sslmode=require&schema=budget_api'
    );
  });

  it('keeps every other query parameter', () => {
    const derived = deriveDatabaseUrl('postgresql://u:p@h.test/db?sslmode=require&connect_timeout=5', 'content_scheduler');
    assert.match(derived, /sslmode=require/);
    assert.match(derived, /connect_timeout=5/);
    assert.match(derived, /schema=content_scheduler/);
  });

  it('does not re-encode the password', () => {
    const derived = deriveDatabaseUrl(TASKS_DSN, 'tasks_api');
    assert.match(derived, /pa\$\$word/);
    assert.ok(!derived.includes('%24'));
  });

  it('rejects a non-postgres URL', () => {
    assert.throws(() => deriveDatabaseUrl('mysql://u:p@h.test/db', 'tasks_api'), /not a postgres/);
  });

  it('rejects an empty DSN', () => {
    assert.throws(() => deriveDatabaseUrl('', 'tasks_api'), /empty database URL/);
  });
});

describe('buildServiceCredentials', () => {
  it('wraps a token in the JSON array the services parse', () => {
    const value = buildServiceCredentials('a'.repeat(32), 'staging-cloud-validate', []);
    assert.deepEqual(JSON.parse(value), [
      { token: 'a'.repeat(32), actor: 'staging-cloud-validate', approvalTypes: [] },
    ]);
  });

  it('rejects an empty token', () => {
    assert.throws(() => buildServiceCredentials('', 'staging-cloud-validate', []), /empty approval token/);
  });
});

describe('buildPlatformSecretPayload', () => {
  it('maps the staging environment onto the twelve platform secret names', () => {
    const { secrets, missing } = buildPlatformSecretPayload(stagingEnv());
    assert.deepEqual(missing, []);
    assert.deepEqual(
      secrets.map((secret) => secret.name).sort(),
      [
        'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
        'PLATFORM_AUTO_POST_WORKER_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
        'PLATFORM_BUDGET_API_DATABASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
        'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
        'PLATFORM_TASKS_API_CONTENT_SCHEDULER_REDIS_URL',
        'PLATFORM_TASKS_API_DATABASE_URL',
        'PLATFORM_TASKS_API_REDIS_URL',
        'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
      ]
    );
  });

  it('sets the schema on each database URL', () => {
    const { secrets } = buildPlatformSecretPayload(stagingEnv());
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.match(byName.PLATFORM_TASKS_API_DATABASE_URL, /schema=tasks_api/);
    assert.match(byName.PLATFORM_BUDGET_API_DATABASE_URL, /schema=budget_api/);
    assert.match(byName.PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL, /schema=content_scheduler/);
  });

  it('derives the content-scheduler database from the tasks database when no dedicated DSN exists', () => {
    const { secrets, notes } = buildPlatformSecretPayload(stagingEnv());
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    const tasks = byName.PLATFORM_TASKS_API_DATABASE_URL;
    const scheduler = byName.PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL;
    assert.equal(
      scheduler.replace('schema=content_scheduler', ''),
      tasks.replace('schema=tasks_api', '')
    );
    assert.ok(notes.some((note) => note.includes('content_scheduler')));
  });

  it('uses a dedicated content-scheduler DSN when one is registered', () => {
    const { secrets, notes } = buildPlatformSecretPayload(
      stagingEnv({ [SOURCE_NAMES.contentSchedulerDatabaseUrl]: 'postgresql://u:p@other.test/db' })
    );
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.match(byName.PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL, /other\.test/);
    assert.match(byName.PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL, /schema=content_scheduler/);
    assert.equal(notes.length, 0);
  });

  it('never falls back to the read-only drill source DSNs', () => {
    // The drill's *_SOURCE_DSN secrets are read-only by contract: the
    // platform runs `prisma migrate deploy` and the services write, so a
    // read-only role must fail closed rather than be discovered on the
    // first live deploy.
    const env = stagingEnv();
    delete env[SOURCE_NAMES.tasksDatabaseUrl];
    delete env[SOURCE_NAMES.budgetDatabaseUrl];
    env.TASKS_API_SOURCE_DSN = 'postgresql://u:readonly@source.test/db';
    env.BUDGET_API_SOURCE_DSN = 'postgresql://u:readonly@source.test/db';
    const { secrets, missing } = buildPlatformSecretPayload(env);
    assert.ok(missing.includes(SOURCE_NAMES.tasksDatabaseUrl));
    assert.ok(missing.includes(SOURCE_NAMES.budgetDatabaseUrl));
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.equal(byName.PLATFORM_TASKS_API_DATABASE_URL, undefined);
    assert.equal(byName.PLATFORM_BUDGET_API_DATABASE_URL, undefined);
  });

  it('maps only write-capable staging DSNs as the database sources', () => {
    // The source names are the contract with the staging GitHub
    // environment: they must never be the drill's read-only source DSNs.
    assert.equal(SOURCE_NAMES.tasksDatabaseUrl, 'STAGING_TASKS_API_DATABASE_URL');
    assert.equal(SOURCE_NAMES.budgetDatabaseUrl, 'STAGING_BUDGET_API_DATABASE_URL');
    assert.equal(
      SOURCE_NAMES.contentSchedulerDatabaseUrl,
      'STAGING_CONTENT_SCHEDULER_API_DATABASE_URL'
    );
    assert.ok(!Object.values(SOURCE_NAMES).some((name) => name.endsWith('_SOURCE_DSN')));
  });

  it('gives every Redis name the single live Redis value', () => {
    const { secrets } = buildPlatformSecretPayload(stagingEnv());
    const redis = secrets.filter((secret) => secret.name.includes('REDIS_URL'));
    assert.equal(redis.length, 6);
    for (const secret of redis) assert.equal(secret.value, REDIS_URL);
  });

  it('wraps the approval tokens in the JSON shape the services parse', () => {
    const { secrets } = buildPlatformSecretPayload(stagingEnv());
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    const tasks = JSON.parse(byName.TASKS_API_APPROVAL_SERVICE_CREDENTIALS);
    const scheduler = JSON.parse(byName.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS);
    assert.equal(tasks[0].token, 'a'.repeat(32));
    assert.deepEqual(tasks[0].approvalTypes, []);
    assert.equal(scheduler[0].token, 'b'.repeat(32));
    assert.deepEqual(scheduler[0].approvalTypes, ['any']);
  });

  it('reports every missing source secret by name', () => {
    const { missing } = buildPlatformSecretPayload({});
    assert.ok(missing.includes(SOURCE_NAMES.tasksDatabaseUrl));
    assert.ok(missing.includes(SOURCE_NAMES.budgetDatabaseUrl));
    assert.ok(missing.includes(SOURCE_NAMES.redisUrl));
    assert.ok(missing.includes(SOURCE_NAMES.tasksApprovalToken));
    assert.ok(missing.includes(SOURCE_NAMES.schedulerApprovalToken));
  });

  it('never puts a source value into the note text', () => {
    const { notes } = buildPlatformSecretPayload(stagingEnv());
    for (const note of notes) {
      assert.ok(!note.includes('pa$$word'));
      assert.ok(!note.includes(REDIS_URL));
    }
  });

  it('registers the public content-scheduler base URL as a plain value', () => {
    const { secrets } = buildPlatformSecretPayload(stagingEnv());
    const byName = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
    assert.equal(byName.PLATFORM_CONTENT_SCHEDULER_API_BASE_URL, DEFAULT_CONTENT_SCHEDULER_API_BASE_URL);
  });
});
