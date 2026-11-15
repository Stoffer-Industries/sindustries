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

import { readFlySecretNames } from '../../../infra/cloud/scripts/capture-production-provisioning-state.mjs';

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
