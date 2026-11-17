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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOperatorEvidence,
  readFlyAppEnv,
  readFlyAppMachines,
  readFlyAppPlatformConfig,
  readFlyRedisAddon,
  readHealthProbeTargets,
  readFlySecretNames,
  readNeonBranchEndpointFingerprints,
  resolveOperatorEvidencePath,
} from '../../../infra/cloud/scripts/capture-production-provisioning-state.mjs';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

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

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test('the Fly-managed Redis add-on is recorded without its URL or password', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, {
        data: {
          addOn: {
            name: 'sindustries-production',
            publicUrl: 'redis://default:super-secret@production-redis.example.test:6379',
            status: 'created',
            primaryRegion: 'syd',
            addOnPlan: { displayName: 'Pay-as-you-go' },
            organization: { slug: 'personal' },
          },
        },
      }),
    () =>
      readFlyRedisAddon(
        { name: 'sindustries-production', provider: 'upstash_redis' },
        'token-abc',
      ),
  );
  assert.equal(result.captured, true);
  assert.equal(result.exists, true);
  assert.equal(result.plan, 'Pay-as-you-go');
  assert.equal(result.primaryRegion, 'syd');
  assert.match(result.endpointHostFingerprint, /^[0-9a-f]{16}$/);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('example.test'), false);
  assert.equal(serialized.includes('redis://'), false);
});

test('an absent Fly-managed Redis add-on is distinct from an unreadable one', async () => {
  const absent = await withFetch(
    () => jsonResponse(200, { data: { addOn: null } }),
    () =>
      readFlyRedisAddon(
        { name: 'sindustries-production', provider: 'upstash_redis' },
        'token-abc',
      ),
  );
  assert.deepEqual(absent, {
    captured: true,
    exists: false,
    name: 'sindustries-production',
  });

  const unreadable = await withFetch(
    () => jsonResponse(503, {}),
    () =>
      readFlyRedisAddon(
        { name: 'sindustries-production', provider: 'upstash_redis' },
        'token-abc',
      ),
  );
  assert.equal(unreadable.captured, false);
  assert.match(unreadable.error, /HTTP 503/);
});

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
      assert.equal(result.inventoryReadError, undefined);
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
  assert.match(result.inventoryReadError, /does not exist/);
});

test('an unreadable inventory is reported with the status that stopped it', async () => {
  const result = await withFetch(
    () => jsonResponse(500, { error: 'boom' }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.inventoryReadError, /HTTP 500/);
});

test('a response with no secrets array is reported as unreadable', async () => {
  // A shape the capture does not recognise must not read as an app with
  // zero secrets.
  const result = await withFetch(
    () => jsonResponse(200, { unexpected: true }),
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.inventoryReadError, /no secrets array/);
});

test('a transport failure is reported as unreadable and never throws', async () => {
  const result = await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND api.machines.dev');
    },
    () => readFlySecretNames('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.secretNames, null);
  assert.match(result.inventoryReadError, /could not be read/);
  assert.match(result.inventoryReadError, /ENOTFOUND/);
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
    () => readFlyAppEnv('sindustries-health-probe-production', 'token-abc', [
      'FLY_APP_PROBE_INTERVAL_SECONDS',
    ]),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /could not be read/);
  assert.match(result.error, /ENOTFOUND/);
});

// --- The deployment-state read (AC1) ------------------------------------
//
// The AC1 gate asks whether the production Fly apps exist and carry a
// deployed release. Until now the capture took presence from the
// organisation listing GraphQL offers — a listing capped at 50 apps — and
// coerced a null app to the requested name, so an app that exists could
// be reported as one that does not, and an app that does not exist was
// reported as one with no release.
//
// The Machine inventory answers the same question with a 404 for an app
// that is not there, so the read is authoritative and uncapped. These
// cases prove it can go red, and that the three outcomes stay apart: an
// app that exists, an app that does not, and a read that could not be
// made.

test('the deployment-state read reports the app and its Machine states', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        { name: 'lively-frog-6651', state: 'started' },
        { name: 'quiet-otter-1122', state: 'stopped' },
      ]),
    async (calls) => {
      const read = await readFlyAppMachines('sindustries-platform-production', 'token-abc');

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        'https://api.machines.dev/v1/apps/sindustries-platform-production/machines',
      );
      assert.equal(calls[0].init.headers.Authorization, 'Bearer token-abc');
      assert.equal(read.exists, true);
      assert.deepEqual(read.machineStates, ['started', 'stopped']);
      assert.equal(read.machineCount, 2);
      assert.equal(read.error, undefined);
    },
  );
});

test('only the Machine states are recorded — never the deployed environment', async () => {
  // The Machine object carries the deployed environment, which holds
  // credential-shaped values. The artifact must not inherit them.
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          name: 'lively-frog-6651',
          state: 'started',
          config: {
            env: {
              DATABASE_URL: 'postgresql://user:***@prod.neon.tech/db',
              FLY_APP_PROBE_INTERVAL_SECONDS: '120',
            },
          },
        },
      ]),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.deepEqual(Object.keys(result).sort(), ['exists', 'machineCount', 'machineStates']);
  assert.equal(JSON.stringify(result).includes('DATABASE_URL'), false);
  assert.equal(JSON.stringify(result).includes('password'), false);
});

test('an app that does not exist is reported as absent, not as unreadable', async () => {
  // "The app does not exist" and "the read could not look" name different
  // owners: the first is the operator's to close, the second is a capture
  // problem. Collapsing them would accuse the operator for a read that
  // never happened.
  const result = await withFetch(
    () => jsonResponse(404, { error: 'app not found' }),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, false);
  assert.equal(result.machineCount, 0);
  assert.deepEqual(result.machineStates, []);
  assert.match(result.error, /does not exist/);
});

test('an unreadable deployment-state read is reported as unreadable, not as absent', async () => {
  const result = await withFetch(
    () => jsonResponse(500, { error: 'boom' }),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, null);
  assert.match(result.error, /HTTP 500/);
});

test('a response with no machines array is reported as unreadable, not as empty', async () => {
  const result = await withFetch(
    () => jsonResponse(200, { unexpected: true }),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, null);
  assert.match(result.error, /no machines/);
});

test('an app that exists with no Machine is not reported as absent', async () => {
  // An app that was created but never deployed is a real state the gate
  // must be able to report: it exists, and nothing runs on it.
  const result = await withFetch(
    () => jsonResponse(200, []),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, true);
  assert.equal(result.machineCount, 0);
  assert.deepEqual(result.machineStates, []);
  assert.equal(result.error, undefined);
});

test('the object form of the Machine list is accepted as well', async () => {
  // The Machines API answers this path with a bare array (verified
  // 2026-11-16 against the staging health-probe app). The object form is
  // accepted too, so a provider change does not read as "no Machines".
  const result = await withFetch(
    () => jsonResponse(200, { machines: [{ name: 'lively-frog-6651', state: 'started' }] }),
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, true);
  assert.deepEqual(result.machineStates, ['started']);
});

test('a transport failure is reported as unreadable and never throws', async () => {
  const result = await withFetch(
    () => {
      throw new Error('getaddrinfo ENOTFOUND api.machines.dev');
    },
    () => readFlyAppMachines('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.exists, null);
  assert.match(result.error, /could not be read/);
  assert.match(result.error, /ENOTFOUND/);
});

// --- AC6: deployed target facts come from the running probe's metrics ---

test('the deployed probe target metric is recorded as labels and fingerprints', async () => {
  const metrics = [
    'sindustries_health_probe_target_info{app="health-probe",kind="fly-app",target="platform",host_fingerprint="1111111111111111"} 1',
    'sindustries_health_probe_target_info{app="health-probe",kind="database",target="tasks_api",host_fingerprint="2222222222222222"} 1',
    'sindustries_health_probe_target_info{app="health-probe",kind="redis",target="content_scheduler",host_fingerprint="3333333333333333"} 1',
  ].join('\n');
  const result = await withFetch(
    () => textResponse(200, metrics),
    () => readHealthProbeTargets('https://health-probe.sindustries.co.nz'),
  );

  assert.equal(result.captured, true);
  assert.deepEqual(result.conflictingKeys, []);
  assert.equal(result.targets.HEALTH_PROBE_FLY_APPS[0].label, 'platform');
  assert.equal(result.targets.HEALTH_PROBE_DATABASES[0].hostFingerprint, '2222222222222222');
  assert.equal(result.targets.HEALTH_PROBE_REDIS[0].label, 'content_scheduler');
  assert.equal(JSON.stringify(result).includes('postgresql://'), false);
  assert.equal(JSON.stringify(result).includes('rediss://'), false);
});

test('conflicting fingerprints for one deployed target fail closed', async () => {
  const metrics = [
    'sindustries_health_probe_target_info{kind="redis",target="content_scheduler",host_fingerprint="3333333333333333"} 1',
    'sindustries_health_probe_target_info{kind="redis",target="content_scheduler",host_fingerprint="4444444444444444"} 1',
  ].join('\n');
  const result = await withFetch(
    () => textResponse(200, metrics),
    () => readHealthProbeTargets('https://health-probe.sindustries.co.nz'),
  );
  assert.deepEqual(result.conflictingKeys, ['HEALTH_PROBE_REDIS']);
  assert.deepEqual(result.targets.HEALTH_PROBE_REDIS, []);
});

test('malformed target metrics are counted and never trusted', async () => {
  const result = await withFetch(
    () =>
      textResponse(
        200,
        'sindustries_health_probe_target_info{kind="redis",target="content_scheduler",host_fingerprint="not-a-fingerprint"} 1',
      ),
    () => readHealthProbeTargets('https://health-probe.sindustries.co.nz'),
  );
  assert.equal(result.malformedTargets, 1);
  assert.deepEqual(result.targets, {});
});

test('an unreachable deployed metrics route is reported as unreadable', async () => {
  const result = await withFetch(
    () => textResponse(404, 'not found'),
    () => readHealthProbeTargets('https://health-probe.sindustries.co.nz'),
  );
  assert.equal(result.captured, false);
  assert.match(result.error, /HTTP 404/);
});

// --- The Neon branch's serving hosts (AC6, the database target) ---
//
// The Neon v2 API does not put a branch's host on the BRANCH: it puts it
// on the branch's ENDPOINTS, a separate resource. A capture that reads
// `branch.host` reads a field the API never sends, so its fingerprint is
// always null and the AC6 "the deployed probe points at the production
// database" gate carries an empty expectation set — permanently
// unsatisfiable, and indistinguishable from a real deployment failure.
// These cases pin the read to the resource that actually carries the
// host.

test('the branch host is read from the branch ENDPOINTS, not from the branch', async () => {
  const calls = [];
  const result = await withFetch(
    (url) => {
      calls.push(url);
      return jsonResponse(200, {
        endpoints: [
          {
            type: 'read_write',
            host: 'ep-abc12345.ap-southeast-2.aws.neon.tech',
            hosts: {
              read_write_host: 'ep-abc12345.ap-southeast-2.aws.neon.tech',
              read_write_pooled_host: 'ep-abc12345-pooler.ap-southeast-2.aws.neon.tech',
            },
          },
        ],
      });
    },
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  assert.equal(result.captured, true);
  assert.equal(result.hostFingerprints.length, 1);
  assert.match(result.hostFingerprints[0], /^[0-9a-f]{16}$/);
  assert.ok(
    calls.some((url) => url.endsWith('/projects/proj-1/branches/br-1/endpoints')),
    `the endpoints resource is read, got: ${calls.join(', ')}`,
  );
});

test('the pooled and the direct host of one Neon endpoint share one fingerprint', async () => {
  // The probe may be configured with either hostname for the same
  // database, so both must compare equal to the production branch.
  const direct = await withFetch(
    () =>
      jsonResponse(200, {
        endpoints: [{ type: 'read_write', host: 'ep-abc12345.ap-southeast-2.aws.neon.tech' }],
      }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );
  const pooled = await withFetch(
    () =>
      jsonResponse(200, {
        endpoints: [
          {
            type: 'read_write',
            host: 'ep-abc12345-pooler.ap-southeast-2.aws.neon.tech',
          },
        ],
      }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );
  const other = await withFetch(
    () =>
      jsonResponse(200, {
        endpoints: [{ type: 'read_write', host: 'ep-zzz99999.ap-southeast-2.aws.neon.tech' }],
      }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  assert.equal(direct.hostFingerprints[0], pooled.hostFingerprints[0]);
  assert.notEqual(direct.hostFingerprints[0], other.hostFingerprints[0]);
});

test('a branch that serves no endpoint is reported as an empty list, not as an error', async () => {
  // "The branch serves nothing" is a real fact about the environment and
  // names the operator; "the read could not look" names the capture.
  const result = await withFetch(
    () => jsonResponse(200, { endpoints: [] }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  assert.equal(result.captured, true);
  assert.deepEqual(result.hostFingerprints, []);
  assert.equal(result.error, undefined);
});

test('an unreadable endpoint read is reported as an error, not as an empty list', async () => {
  // An empty list would silently become "the branch serves no endpoint",
  // which blames the operator for a read the capture never managed.
  const result = await withFetch(
    () => jsonResponse(401, { message: 'unauthorized' }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  assert.equal(result.captured, false);
  assert.ok(result.error.length > 0, 'the failure carries a reason');
  assert.equal(result.hostFingerprints, undefined);
});

test('a transport failure is reported as unreadable and never throws', async () => {
  const result = await withFetch(
    () => {
      throw new Error('socket hang up');
    },
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  assert.equal(result.captured, false);
  assert.match(result.error, /socket hang up/);
});

test('no host ever reaches the artifact from the Neon endpoint read', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, {
        endpoints: [
          {
            type: 'read_write',
            host: 'ep-abc12345.ap-southeast-2.aws.neon.tech',
            password: 'super-secret-value',
          },
        ],
      }),
    () => readNeonBranchEndpointFingerprints('proj-1', 'br-1', 'neon-key'),
  );

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('neon.tech'), false);
  assert.equal(serialized.includes('super-secret-value'), false);
});

// --- The deployed platform app's configuration (task fb1240c0, AC1/AC4)
//
// FLY MASKS SECRETS: the Machines API returns an app's NON-SECRET
// environment only, so the deployed database and Redis URLs cannot be read
// at all. The plain [env] values are the readable part, and they are the
// ones that say which environment the running app was deployed as.

test('the deployed configuration is read from the named keys and nothing else', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          id: 'machine-1',
          state: 'started',
          config: {
            env: {
              FLY_PROCESS_GROUP: 'platform',
              PLATFORM_ENVIRONMENT_ID: 'production',
              PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS:
                'https://tasks.sindustries.co.nz,https://mission-control.sindustries.co.nz',
              PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS:
                'https://mission-control.sindustries.co.nz',
              PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS:
                'https://mission-control.sindustries.co.nz',
              // A secret and an unrelated value: neither may be recorded.
              PLATFORM_TASKS_API_DATABASE_URL: 'postgresql://user:supersecret@db.example/db',
              NODE_ENV: 'production',
            },
          },
        },
      ]),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.captured, true);
  assert.equal(result.environmentId, 'production');
  assert.equal(result.processGroup, 'platform');
  assert.deepEqual(result.corsOrigins.PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS, [
    'https://tasks.sindustries.co.nz',
    'https://mission-control.sindustries.co.nz',
  ]);
  assert.deepEqual(result.corsOrigins.PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS, [
    'https://mission-control.sindustries.co.nz',
  ]);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('supersecret'), false);
  assert.equal(serialized.includes('postgresql'), false);
  assert.equal(serialized.includes('NODE_ENV'), false);
});

test('a deployed value that is not an https origin is dropped and counted', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        {
          id: 'machine-1',
          config: {
            env: {
              PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS:
                'https://mission-control.sindustries.co.nz,postgresql://user:pw@db/db,not-a-url',
            },
          },
        },
      ]),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.malformedOrigins, 2);
  assert.deepEqual(result.corsOrigins.PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS, [
    'https://mission-control.sindustries.co.nz',
  ]);
  assert.equal(JSON.stringify(result).includes('postgresql'), false);
});

test('an app that does not exist is reported as app-missing, not as empty', async () => {
  const result = await withFetch(
    () => jsonResponse(404, { error: 'app not found' }),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'app-missing');
  assert.match(result.error, /does not exist/);
});

test('a configuration read that could not be made is reported as unreadable', async () => {
  const result = await withFetch(
    () => jsonResponse(500, { message: 'boom' }),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'unreadable');
});

test('an app with no Machine is reported as no-machine, not as an empty configuration', async () => {
  const result = await withFetch(
    () => jsonResponse(200, []),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'no-machine');
});

test('machines that disagree on the environment id are reported as a conflict', async () => {
  const result = await withFetch(
    () =>
      jsonResponse(200, [
        { id: 'machine-1', config: { env: { PLATFORM_ENVIRONMENT_ID: 'production' } } },
        { id: 'machine-2', config: { env: { PLATFORM_ENVIRONMENT_ID: 'staging' } } },
      ]),
    () => readFlyAppPlatformConfig('sindustries-platform-production', 'token-abc'),
  );

  assert.equal(result.captured, true);
  assert.deepEqual(result.conflictingKeys, ['PLATFORM_ENVIRONMENT_ID']);
  // The gate must not pick a winner between two generations.
  assert.equal(result.environmentId, null);
});

/**
 * Write an operator evidence file in a temp directory.
 *
 * @param {unknown} contents
 * @returns {{path: string, cleanup: () => void}}
 */
function writeOperatorEvidence(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-evidence-'));
  const path = join(dir, 'operator-evidence.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the committed operator evidence is the default capture input', () => {
  const path = resolveOperatorEvidencePath({ repoRoot: REPO_ROOT });
  assert.equal(
    path,
    join(REPO_ROOT, 'infra/cloud/evidence/production-operator-evidence.json'),
  );

  const { evidence, problems } = loadOperatorEvidence(path, {
    capturedAt: '2026-11-17T09:00:00.000Z',
  });
  assert.deepEqual(problems, []);
  assert.equal(evidence.flySpendLimit.recorded, true);
  assert.equal(
    evidence.flySpendLimit.control,
    'prepaid-capped-billing-method',
  );
});

test('an explicit operator evidence path overrides the committed default', () => {
  const path = resolveOperatorEvidencePath({
    repoRoot: REPO_ROOT,
    operatorEvidence: '/tmp/operator-evidence.json',
  });
  assert.equal(path, '/tmp/operator-evidence.json');
});

test('a recorded operator read-back is carried into the artifact', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'personal organization',
      control: 'prepaid-capped-billing-method',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.deepEqual(problems, []);
    assert.equal(evidence.flySpendLimit.recorded, true);
    assert.equal(evidence.flySpendLimit.readBackAt, '2026-11-16T00:00:00.000Z');
  } finally {
    file.cleanup();
  }
});


test('an operator evidence file without an inspectable pointer is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'personal organization',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path, {
      capturedAt: '2026-11-16T01:00:00.000Z',
    });
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /evidenceRef/);
  } finally {
    file.cleanup();
  }
});

test('an operator evidence file stamped after the capture is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T01:00:01.000Z',
      scope: 'personal organization',
      control: 'prepaid-capped-billing-method',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path, {
      capturedAt: '2026-11-16T01:00:00.000Z',
    });
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /after the artifact was captured/);
  } finally {
    file.cleanup();
  }
});

test('a recorded spend read-back that names no control is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'personal organization',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /without naming the control/);
  } finally {
    file.cleanup();
  }
});

test('a recorded spend read-back that names an unknown control is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'personal organization',
      control: 'wishful-thinking',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /unknown control/);
  } finally {
    file.cleanup();
  }
});

test('a control on a slot that declares none is refused', () => {
  const file = writeOperatorEvidence({
    dnsResolutionAndTlsReadback: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'production',
      control: 'prepaid-capped-billing-method',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: [
        'tasks-api.sindustries.co.nz',
        'budget-api.sindustries.co.nz',
        'content-scheduler-api.sindustries.co.nz',
        'health-probe.sindustries.co.nz',
      ],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /a "control" the contract does not define/);
  } finally {
    file.cleanup();
  }
});

test('an operator evidence file that cannot be read is refused', () => {
  const { evidence, problems } = loadOperatorEvidence('/tmp/does-not-exist-operator-evidence.json');
  assert.equal(evidence, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read the operator evidence file/);
});

test('an operator evidence file that is not JSON is refused', () => {
  const file = writeOperatorEvidence('not json at all');
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.equal(problems.length, 1);
  } finally {
    file.cleanup();
  }
});

test('an operator evidence file that records nothing is refused', () => {
  const file = writeOperatorEvidence(null);
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /records no operator evidence/);
  } finally {
    file.cleanup();
  }
});

test('an operator evidence slot with no read-back time is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      scope: 'personal organization',
      targets: ['sindustries-platform-production'],
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /readBackAt/);
  } finally {
    file.cleanup();
  }
});

test('a recorded operator read-back with no production surface is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      scope: 'personal organization',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /targets/);
  } finally {
    file.cleanup();
  }
});

test('an operator evidence slot with an unknown field is refused', () => {
  const file = writeOperatorEvidence({
    flySpendLimit: {
      recorded: true,
      readBackAt: '2026-11-16T00:00:00.000Z',
      targets: ['sindustries-platform-production'],
      monthlyLimit: '50',
    },
  });
  try {
    const { evidence, problems } = loadOperatorEvidence(file.path);
    assert.equal(evidence, null);
    assert.match(problems.join(' '), /unknown field/);
  } finally {
    file.cleanup();
  }
});
