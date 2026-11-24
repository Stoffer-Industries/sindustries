#!/usr/bin/env node
/**
 * verify-platform-approval-credentials.test.mjs — unit tests for the
 * post-deploy approval-credential verifier (task 3c004590).
 *
 * The verifier is the only value-level proof in the delivery: Fly
 * exposes secret NAMES and digests, never values, so the provisioner
 * can prove what it WROTE but not what the running service ACCEPTS.
 * The verifier closes that gap by presenting each credential to its own
 * service and requiring the service to report the intended actor.
 *
 * These tests drive the verifier with a fake fetch, so they assert the
 * VERDICT LOGIC — an exact actor match, an aggregated failure list, and
 * no token in any message — without touching a network.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/verify-platform-approval-credentials.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLATFORM_ENVIRONMENTS } from '../platform-environments.mjs';
import {
  PRINCIPAL_PATH,
  principalUrl,
  verifyApprovalCredentials,
  verifyOneCredential,
} from '../verify-platform-approval-credentials.mjs';

const PRODUCTION = PLATFORM_ENVIRONMENTS.production;
const TASKS_CONTRACT = PRODUCTION.approvalCredentials.tasks;

/**
 * The operator credential array for a contract, with obvious fake tokens.
 *
 * @param {object} contract
 * @returns {string} the JSON array
 */
function operatorArray(contract) {
  return JSON.stringify(
    contract.operatorActors.map((entry) => ({
      token: ('operator-' + entry.actor + '-token-0000000000').slice(0, 32),
      actor: entry.actor,
      approvalTypes: [...entry.approvalTypes],
    })),
  );
}

/**
 * A fake fetch that answers per Bearer token.
 *
 * @param {Record<string, {status?: number, body?: object}>} responses
 * @returns {Function}
 */
function fakeFetch(responses) {
  return async (url, options) => {
    const token = String(options?.headers?.authorization ?? '').replace(/^Bearer\s+/, '');
    const entry = responses[token];
    if (!entry) {
      return {
        status: 401,
        text: async () => JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }),
      };
    }
    return {
      status: entry.status ?? 200,
      text: async () => JSON.stringify(entry.body ?? {}),
    };
  };
}

describe('principalUrl', () => {
  it('appends the identity path to the service base URL', () => {
    assert.equal(
      principalUrl('https://tasks-api.sindustries.co.nz/api/v1'),
      'https://tasks-api.sindustries.co.nz/api/v1' + PRINCIPAL_PATH,
    );
  });

  it('does not double the slash when the base URL ends with one', () => {
    assert.equal(
      principalUrl('https://tasks-api.sindustries.co.nz/api/v1/'),
      'https://tasks-api.sindustries.co.nz/api/v1' + PRINCIPAL_PATH,
    );
  });
});

describe('verifyOneCredential', () => {
  const url = 'https://tasks-api.sindustries.co.nz/api/v1' + PRINCIPAL_PATH;

  it('passes when the service reports the intended actor', async () => {
    const result = await verifyOneCredential({
      url,
      token: 'a-valid-token-value-00000',
      expectedActor: 'Rowan',
      fetchImpl: fakeFetch({
        'a-valid-token-value-00000': { body: { actor: 'Rowan', kind: 'service' } },
      }),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, true);
  });

  it('fails when the service reports a DIFFERENT actor', async () => {
    const result = await verifyOneCredential({
      url,
      token: 'a-valid-token-value-00000',
      expectedActor: 'Rowan',
      fetchImpl: fakeFetch({
        'a-valid-token-value-00000': { body: { actor: 'Quinn', kind: 'service' } },
      }),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /reported actor "Quinn" where "Rowan" was expected/);
  });

  it('fails when the service rejects the credential', async () => {
    const result = await verifyOneCredential({
      url,
      token: 'a-revoked-token-value-0000',
      expectedActor: 'Rowan',
      fetchImpl: fakeFetch({}),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /answered HTTP 401/);
  });

  it('fails when the service answers 200 without an actor', async () => {
    const result = await verifyOneCredential({
      url,
      token: 'a-valid-token-value-00000',
      expectedActor: 'Rowan',
      fetchImpl: fakeFetch({ 'a-valid-token-value-00000': { body: { kind: 'service' } } }),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /without an actor/);
  });

  it('never puts the token in the failure message', async () => {
    const result = await verifyOneCredential({
      url,
      token: 'super-secret-token-value-000',
      expectedActor: 'Rowan',
      fetchImpl: fakeFetch({}),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.detail.includes('super-secret-token-value-000'));
  });
});

describe('verifyApprovalCredentials', () => {
  /**
   * The source values for EVERY service in the environment.
   *
   * The verifier walks every service the manifest declares, so a fixture
   * that covered only one of them would fail for the wrong reason: the
   * uncovered service would report an unbuildable credential set rather
   * than the verdict under test.
   *
   * @returns {Record<string, string>}
   */
  function productionEnv() {
    const values = {};
    for (const contract of Object.values(PRODUCTION.approvalCredentials)) {
      values[contract.platformTokenSource] = 'platform-token-value-00000000';
      values[contract.operatorCredentialsSource] = operatorArray(contract);
    }
    return values;
  }

  /**
   * A fetch that answers every declared actor with its own name.
   *
   * @param {string} [skipActor]  an actor whose token is NOT registered
   * @returns {Function}
   */
  function authenticatingFetch(skipActor = null) {
    const responses = {};
    for (const contract of Object.values(PRODUCTION.approvalCredentials)) {
      responses['platform-token-value-00000000'] = {
        body: { actor: contract.platformActor, kind: 'service' },
      };
      for (const entry of contract.operatorActors) {
        if (entry.actor === skipActor) continue;
        responses[('operator-' + entry.actor + '-token-0000000000').slice(0, 32)] = {
          body: { actor: entry.actor, kind: 'service' },
        };
      }
    }
    return fakeFetch(responses);
  }

  it('checks every merged credential of every service and reports the count', async () => {
    const expected = Object.values(PRODUCTION.approvalCredentials).reduce(
      (total, contract) => total + contract.operatorActors.length + 1,
      0,
    );

    const result = await verifyApprovalCredentials({
      environment: PRODUCTION,
      env: productionEnv(),
      fetch: authenticatingFetch(),
      log: () => {},
      errorLog: () => {},
    });

    // The platform actor plus every declared operator actor, per service.
    assert.equal(result.checked, expected);
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  it('aggregates the failures so one bad actor cannot hide another', async () => {
    const result = await verifyApprovalCredentials({
      environment: PRODUCTION,
      env: productionEnv(),
      fetch: authenticatingFetch('Ash'),
      log: () => {},
      errorLog: () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /tasks:/);
    assert.match(result.failures[0], /"Ash"/);
  });

  it('fails when the operator credential array cannot even be built', async () => {
    const result = await verifyApprovalCredentials({
      environment: PRODUCTION,
      env: { ...productionEnv(), [TASKS_CONTRACT.operatorCredentialsSource]: '[]' },
      fetch: authenticatingFetch(),
      log: () => {},
      errorLog: () => {},
    });

    assert.equal(result.ok, false);
    assert.match(result.failures[0], /empty array/);
  });

  it('never puts a token in a failure message', async () => {
    const result = await verifyApprovalCredentials({
      environment: PRODUCTION,
      env: {
        ...productionEnv(),
        [TASKS_CONTRACT.operatorCredentialsSource]: 'not json at all',
      },
      fetch: authenticatingFetch(),
      log: () => {},
      errorLog: () => {},
    });

    assert.equal(result.ok, false);
    for (const failure of result.failures) {
      assert.ok(!failure.includes('platform-token-value-00000000'));
    }
  });
});
