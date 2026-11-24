#!/usr/bin/env node
/**
 * verify-platform-approval-credentials.mjs — the value-level proof that a
 * platform deployment kept every approval credential it should have
 * (task 3c004590).
 *
 * WHY THIS EXISTS
 * ---------------
 * `flyctl secrets set` replaces a secret, and Fly exposes only secret
 * NAMES and digests — never values. So the provisioner can prove that it
 * wrote a complete array, but nothing in the Fly API can prove that the
 * running service AUTHENTICATES each of those credentials as the actor
 * it claims to be.
 *
 * That gap is exactly where the production incident lived: the live
 * credential set was replaced by a one-actor array, the deploy stayed
 * green, and every agent write failed later with `401 AUTH_REQUIRED`.
 * Reads kept working, so the break surfaced long after the merge that
 * caused it.
 *
 * This script closes the gap from the other side. It reads the SAME
 * manifest contract and the SAME source values the provisioner used,
 * rebuilds the merged arrays with the SAME helper, and then presents
 * every token to its own service and requires the service to report the
 * intended actor:
 *
 *   GET {service base URL}/auth/principal
 *   Authorization: Bearer <token>
 *
 * A 200 with the expected actor is the proof. A 401, a timeout, a
 * transport error, a 200 with the WRONG actor, or a body that is not the
 * expected shape all fail — and every failure is reported, so one bad
 * actor cannot hide another.
 *
 * WHAT IT NEVER DOES
 * -------------------
 * It never prints a token, a credential array, or a response body that
 * could carry one. Diagnostics go through the shared redactor, and the
 * log lines name only the SERVICE and the ACTOR.
 *
 * It runs AFTER the canary deploy: the identity endpoint exists only
 * once the new code is serving. Every input-membership and scope check
 * still happens BEFORE the secret write, in the provisioner, so a bad
 * credential set never reaches Fly at all.
 *
 * Usage:
 *   node infra/cloud/platform/verify-platform-approval-credentials.mjs \
 *     [--environment staging|production]
 */

import { pathToFileURL } from 'node:url';

import { redactOutput } from './redact-output.mjs';
import {
  DEFAULT_ENVIRONMENT_ID,
  approvalCredentialContracts,
  assertEnvironmentManifest,
  getPlatformEnvironment,
} from './platform-environments.mjs';
import { buildMergedApprovalCredentials } from './platform-approval-credentials.mjs';

/** How long one identity request may take before it counts as a failure. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The path of the identity endpoint, relative to a service's base URL.
 *
 * The base URLs in the manifest already carry the `/api/v1` prefix, so
 * the endpoint is the base URL plus this path.
 */
export const PRINCIPAL_PATH = '/auth/principal';

/**
 * Build the IO seam: the log sinks and the fetch implementation.
 *
 * The fetch implementation is injectable so the unit test can drive the
 * real code path without a network.
 *
 * @param {object} [overrides]
 * @returns {{env: Record<string, string|undefined>, fetch: Function, log: Function, errorLog: Function}}
 */
export function createIo(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? globalThis.fetch,
    log: overrides.log ?? ((message) => console.log(message)),
    errorLog: overrides.errorLog ?? ((message) => console.error(message)),
  };
}

/**
 * The identity endpoint URL of a service.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function principalUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return `${trimmed}${PRINCIPAL_PATH}`;
}

/**
 * Read the JSON body of a response, tolerating an empty body.
 *
 * @param {Response} response
 * @returns {Promise<object|null>}
 */
async function readJson(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Present one credential to its service and check the reported actor.
 *
 * @param {object} options
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function verifyOneCredential(options) {
  const { url, token, expectedActor, fetchImpl, timeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const status = response.status;
    if (status !== 200) {
      return {
        ok: false,
        detail: `the service answered HTTP ${status} for actor "${expectedActor}"`,
      };
    }
    const body = await readJson(response);
    const actor = body?.actor;
    if (typeof actor !== 'string' || actor === '') {
      return {
        ok: false,
        detail: `the service answered HTTP 200 without an actor for "${expectedActor}"`,
      };
    }
    if (actor !== expectedActor) {
      return {
        ok: false,
        detail: `the service reported actor "${actor}" where "${expectedActor}" was expected`,
      };
    }
    return { ok: true, detail: `actor "${expectedActor}" authenticated` };
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? 'timed out'
        : redactOutput(String(error?.message ?? error));
    return {
      ok: false,
      detail: `the request for actor "${expectedActor}" failed: ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify every configured credential of every service.
 *
 * @param {object} options
 * @param {object} options.environment  the environment manifest entry
 * @param {Record<string, string|undefined>} options.env  the source values
 * @param {Function} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.log]
 * @param {Function} [options.errorLog]
 * @returns {Promise<{ok: boolean, checked: number, failures: string[]}>}
 */
export async function verifyApprovalCredentials(options) {
  const { environment, env } = options;
  const io = createIo(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures = [];
  let checked = 0;

  for (const [service, contract] of Object.entries(
    approvalCredentialContracts(environment),
  )) {
    const baseUrl = environment.apiBaseUrls?.[contract.apiBaseUrlKey];
    const url = principalUrl(baseUrl);

    let merged;
    try {
      merged = buildMergedApprovalCredentials({
        contract,
        platformToken: env[contract.platformTokenSource],
        operatorRaw: env[contract.operatorCredentialsSource],
        serviceLabel: service,
      });
    } catch (error) {
      // A credential set that cannot even be built is a failure of the
      // same kind as one that does not authenticate: the service would
      // not accept these credentials.
      failures.push(`${service}: ${error.message}`);
      continue;
    }

    for (const entry of merged.entries) {
      const result = await verifyOneCredential({
        url,
        token: entry.token,
        expectedActor: entry.actor,
        fetchImpl: io.fetch,
        timeoutMs,
      });
      checked += 1;
      if (result.ok) {
        io.log(`${service}: ${result.detail}`);
      } else {
        failures.push(`${service}: ${result.detail}`);
      }
    }
  }

  return { ok: failures.length === 0, checked, failures };
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @param {object} [overrides]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), overrides = {}) {
  const io = createIo(overrides);

  let environmentId = DEFAULT_ENVIRONMENT_ID;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--environment') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        io.errorLog('::error::--environment requires a value');
        return 2;
      }
      environmentId = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      io.log(
        'Usage: node infra/cloud/platform/verify-platform-approval-credentials.mjs ' +
          '[--environment staging|production]',
      );
      return 0;
    }
    io.errorLog(`::error::Unknown argument ${arg}`);
    return 2;
  }

  let environment;
  try {
    environment = getPlatformEnvironment(environmentId);
    assertEnvironmentManifest(environment);
  } catch (error) {
    io.errorLog(`::error::${error.message}`);
    return 2;
  }

  const result = await verifyApprovalCredentials({
    environment,
    env: io.env,
    fetch: io.fetch,
    log: io.log,
    errorLog: io.errorLog,
  });

  if (!result.ok) {
    io.errorLog(
      `::error::${result.failures.length} approval credential(s) did not authenticate as their ` +
        'intended actor:',
    );
    for (const failure of result.failures) io.errorLog(`  - ${failure}`);
    return 1;
  }

  io.log(
    `All ${result.checked} approval credential(s) authenticated as their intended actor`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main());
}
