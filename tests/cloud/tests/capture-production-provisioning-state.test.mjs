// Sentinel cases for the production provisioning capture (task fb1240c0).
//
// WHAT THIS PROVES
//
// The capture reads the secret inventory of each Fly app so the Slice D
// step 5 gate can decide whether the production app carries the secrets
// AC4 requires. The read is the one part of the capture that reaches a
// second API — the Machines API — and it has a shape the GraphQL API
// cannot provide: GraphQL answers `secrets: []` for an app that does carry
// secrets (verified against the staging platform app on 2026-11-16), so a
// read built on it would report "no secrets" for an app that has them.
//
// These cases prove the read can go red. A capture that cannot fail
// asserts nothing, and an inventory read that cannot fail would report an
// empty inventory for an app whose inventory it never looked at.
//
// The fetch is stubbed: the cases must never touch a live provider.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  readFlyAppEnv,
  readFlySecretNames,
} from '../../../infra/cloud/scripts/capture-production-provisioning-state.mjs';

/**
 * Run `fn` with `globalThis.fetch` replaced by a stub.
 *
 * @param {(url: string, init: object) => unknown} handler
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('the secret inventory is read from the Machines API for the named app', async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        secrets: [
          { name: 'PLATFORM_TASKS_API_REDIS_URL', digest: 'aaaa1111' },
          { name: 'PLATFORM_TASKS_API_DATABASE_URL', digest: 'bbbb2222' },
        ],
      }),
    async (calls) => {
      const result = await readFlySecretNames('sindustries-platform-production', 'token-abc');

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        'https://api.machines.dev/v1/apps/sindustries-platform-production/secrets',
      );
      assert.equal(calls[0].init.headers.Authorization, 'Bearer token-abc');
      assert.deepEqual(result.secretNames, [
        'PLATFORM_TASKS_API_DATABASE_URL',
        'PLATFORM_TASKS_API_REDIS_URL',
      ]);
      assert.equal(result.secretInventoryError, undefined);
    },
  );
});

test('only names are recorded — never a digest and never a value', async () => {
  // The artifact carries names, flags and counts only. A digest is none of
  // those, so the read must drop it rather than widen the artifact's
  // surface.
  const result = await withFetch(
    () =>
      jsonResponse(200, {
        secrets: [{ name: 'PLATFORM_TASKS_API_REDIS_URL', digest: 'deadbeefdeadbeef' }],
      }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.deepEqual(Object.keys(result).sort(), ['secretNames']);
  assert.deepEqual(result.secretNames, ['PLATFORM_TASKS_API_REDIS_URL']);
  assert.equal(JSON.stringify(result).includes('deadbeef'), false);
});

test('an app that does not exist is reported as unreadable, not as empty', async () => {
  // "No secrets" and "no app" are different facts, and the gate names the
  // owner differently for each.
  const result = await withFetch(
    () => jsonResponse(404, { error: 'app not found' }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.secretInventoryError, /does not exist/);
});

test('an unreadable inventory is reported with the status that stopped it', async () => {
  const result = await withFetch(
    () => jsonResponse(500, { error: 'boom' }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.secretInventoryError, /HTTP 500/);
});

test('a response with no secrets array is reported as unreadable', async () => {
  // A shape the capture does not recognise must not read as an app with
  // zero secrets.
  const result = await withFetch(
    () => jsonResponse(200, { unexpected: true }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.secretInventoryError, /no secrets array/);
});

test('a transport failure is reported as unreadable and never throws', async () => {
  const result = await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND api.machines.dev');
    },
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.secretInventoryError, /could not be read/);
  assert.match(result.secretInventoryError, /ENOTFOUND/);
});

// --- The deployed probe-cadence read (AC6) ---------------------------------
//
// The cadence read is a different read from the secret inventory: it looks
// at the ENVIRONMENT the deployed Machines carry, and it answers AC6 — the
// production probe must run the production cadence, not the staging daily
// one. The read is narrow on purpose (only the two cadence keys are kept),
// so these cases prove both halves of that: that the right values are read
// and that nothing else is.

test('the cadence read takes the named keys from the deployed environment', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          name: 'lively-frog-6651',
          state: 'started',
          config: {
            env: {
              FLY_APP_PROBE_INTERVAL_SECONDS: '120',
              DB_PROBE_INTERVAL_SECONDS: '3600',
            },
          },
        },
      ]),
    async (calls) => {
      const read = await readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      );

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        'https://api.machines.dev/v1/apps/sindustries-health-probe-production/machines',
      );
      assert.equal(calls[0].init.headers.Authorization, 'Bearer token-abc');
      assert.equal(read.captured, true);
      assert.deepEqual(read.env, {
        FLY_APP_PROBE_INTERVAL_SECONDS: '120',
        DB_PROBE_INTERVAL_SECONDS: '3600',
      });
      assert.deepEqual(read.conflictingKeys, []);
      assert.equal(read.machineCount, 1);
    },
  );
});

test('only the named keys are recorded — every other environment value is dropped', async () => {
  // The production health-probe app's environment also carries the
  // production database and Redis URLs. Recording the whole map would
  // write credential-shaped values into an artifact that is committed and
  // pasted into task comments, so the read must drop them at the source.
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          name: 'lively-frog-6651',
          config: {
            env: {
              FLY_APP_PROBE_INTERVAL_SECONDS: '120',
              DB_PROBE_INTERVAL_SECONDS: '3600',
              DATABASE_URL: 'postgresql://user:password@prod.neon.tech/db',
              REDIS_URL: 'rediss://user:password@prod.upstash.io:6379',
            },
          },
        },
      ]),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.deepEqual(Object.keys(result.env).sort(), [
    'DB_PROBE_INTERVAL_SECONDS',
    'FLY_APP_PROBE_INTERVAL_SECONDS',
  ]);
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.equal(JSON.stringify(result).includes('DATABASE_URL'), false);
});

test('a cadence key the app does not carry stays absent', async () => {
  // "The app does not carry this variable" is a different fact from "the
  // read could not look", and the gate names the owner differently.
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          name: 'lively-frog-6651',
          config: { env: { FLY_APP_PROBE_INTERVAL_SECONDS: '86400' } },
        },
      ]),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, true);
  assert.equal('DB_PROBE_INTERVAL_SECONDS' in result.env, false);
});

test('machines that disagree on a cadence are reported as a conflict, not a winner', async () => {
  // A rolling deploy leaves two Machine generations with different values.
  // Picking either one would prove nothing, so the key is reported as
  // conflicting and the gate must go red.
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          name: 'lively-frog-6651',
          config: { env: { FLY_APP_PROBE_INTERVAL_SECONDS: '120' } },
        },
        {
          name: 'quiet-otter-1122',
          config: { env: { FLY_APP_PROBE_INTERVAL_SECONDS: '86400' } },
        },
      ]),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.deepEqual(result.conflictingKeys, ['FLY_APP_PROBE_INTERVAL_SECONDS']);
  assert.equal('FLY_APP_PROBE_INTERVAL_SECONDS' in result.env, false);
  assert.equal(result.machineCount, 2);
});

test('a health-probe app that does not exist is reported as unreadable, not as empty', async () => {
  const result = await withFetch(
    () => jsonResponse(404, { error: 'app not found' }),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /does not exist/);
  assert.equal('env' in result, false);
});

test('an unreadable cadence read is reported with the status that stopped it', async () => {
  const result = await withFetch(
    () => jsonResponse(500, { error: 'boom' }),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /HTTP 500/);
});

test('a response with no machines is reported as unreadable, not as an empty environment', async () => {
  const result = await withFetch(
    () => jsonResponse(200, { unexpected: true }),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /no machines/);
});

test('a health-probe app with no Machine is reported as unreadable', async () => {
  // There is no deployed environment to read from an app that has never
  // been deployed, and that is not the same as an app with no cadence set.
  const result = await withFetch(
    () => jsonResponse(200, []),
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /no Machine/);
});

test('a transport failure is reported as unreadable and never throws', async () => {
  const result = await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND api.machines.dev');
    },
    () =>
      readFlyAppEnv(
        'sindustries-health-probe-production',
        'token-abc',
        ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'],
      ),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /could not be read/);
  assert.match(result.error, /ENOTFOUND/);
});
