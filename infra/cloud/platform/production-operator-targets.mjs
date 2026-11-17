// production-operator-targets.mjs — task fb1240c0 (Slice D)
//
// The production surfaces each operator read-back must cover.
//
// WHY THIS EXISTS
//
// The operator evidence record is compared against a set of expected
// production surfaces: the production app scope for the Fly spend-limit
// read-back, the production health-probe app for the probe interval, the
// three production API hostnames for the health responses, every
// production hostname for the DNS/TLS read-back, and the production
// branch with the staging and dev credentials for the Neon denial proof.
//
// Those surfaces were derived inside the checker, so the OPERATOR had no
// way to learn which strings a correct record must name. The checker's
// answer to a wrong string was "it does not name X" — after a full
// re-capture of five provider APIs, because the record is merged by the
// capture. Guessing the exact surface string is not a discovery, it is a
// typo, and a typo that reads like a discovery is the worst of both.
//
// This module owns the derivation instead, so the SAME facts produce both
// the gate's expectation and the template the operator fills in. The
// record and the gate can therefore no longer disagree about what a
// correct record looks like.
//
// The sources are the environment manifest (the app names and the API base
// URLs) and the hostname matrix (the production hostnames) — the same
// sources of truth the checker's other gates compare against. Nothing is
// restated here: a module that carries its own copy of the production
// topology can agree with a drifted manifest.
//
// Usage:
//   import {
//     loadHostnameMatrix,
//     productionDnsSurfaces,
//     loadOperatorTargetExpectations,
//   } from './production-operator-targets.mjs';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostOfTargetValue } from './probe-target-facts.mjs';

/** The Neon branch the production data lives in. */
export const PRODUCTION_NEON_BRANCH = 'production';

/**
 * The stable hostname matrix — the source of truth for the production
 * hostnames and their CNAME targets.
 *
 * @param {string} repoRoot
 * @returns {object}
 */
export function loadHostnameMatrix(repoRoot) {
  return JSON.parse(
    readFileSync(join(repoRoot, 'infra/cloud/hostname-matrix.json'), 'utf8'),
  );
}

/**
 * The production DNS surfaces: the hostnames whose production target is a
 * Fly app.
 *
 * These are the surfaces AC3's read-back covers, so the operator's
 * DNS/TLS record must name every one of them — and the DNS gates compare
 * against the very same list, so a hostname production does not use can
 * never enter the expected set.
 *
 * @param {object} matrix the parsed hostname matrix
 * @returns {Array<{id: string, productionHostname: string|null, productionTarget: string, stagingHostname: string|null, stagingTarget: string|null}>}
 */
export function productionDnsSurfaces(matrix) {
  return (matrix?.surfaces ?? [])
    .filter(
      (surface) =>
        typeof surface?.cnameTargets?.production === 'string' &&
        surface.cnameTargets.production.endsWith('.fly.dev'),
    )
    .map((surface) => ({
      id: surface.id,
      productionHostname: surface.production ?? null,
      productionTarget: surface.cnameTargets.production,
      stagingHostname: surface.staging ?? null,
      stagingTarget: surface.cnameTargets.staging ?? null,
    }));
}

/**
 * The production surfaces each operator obligation must have been read
 * back against.
 *
 * The keys are the `coverage` values declared by
 * `production-operator-evidence.mjs` — the contract that names which
 * surfaces prove which obligation.
 *
 * @param {string} repoRoot
 * @returns {Promise<Record<string, string[]>>}
 */
export async function loadOperatorTargetExpectations(repoRoot) {
  const manifestUrl = pathToFileURL(
    join(repoRoot, 'infra/cloud/platform/platform-environments.mjs'),
  ).href;
  const manifest = await import(manifestUrl);
  const environment = manifest.getPlatformEnvironment('production');

  const dnsSurfaces = productionDnsSurfaces(loadHostnameMatrix(repoRoot));

  // The health responses must come from all three production APIs.
  const productionApiHostnames = [
    ...new Set(
      Object.values(environment.apiBaseUrls ?? {})
        .map((url) => hostOfTargetValue(url))
        .filter((host) => typeof host === 'string' && host.length > 0),
    ),
  ];

  // The DNS/TLS read-back must cover every production hostname.
  const productionHostnames = [
    ...new Set(
      dnsSurfaces
        .map((surface) => surface.productionHostname)
        .filter((hostname) => typeof hostname === 'string' && hostname.length > 0),
    ),
  ];

  return {
    // AC5 sets the limit on the PRODUCTION APP scope, so the read-back
    // must name that app.
    platformAppScope: [environment.platformApp],
    // The interval must have been observed on the production probe app.
    healthProbeApp: [environment.healthProbeApp],
    productionApiHostnames,
    productionHostnames,
    // The surfaces a spend-bound ORDERING deviation is accepted for: the
    // production hostnames that were published, the production
    // health-probe app that was running while production spend was still
    // unbounded, and the consolidated production PLATFORM app.
    //
    // The platform app belongs in this set because it IS public
    // exposure: every production API hostname points at it, and Fly
    // gives it its own public .fly.dev hostname, so it is reachable
    // before a single DNS record is published. An acceptance that named
    // the hostnames and the probe but not the app serving all of them
    // would cover only part of the exposure it claims to accept.
    //
    // The acceptance is a statement about the exposure that happened, so
    // it must name every exposed surface — the same rule every other
    // slot follows.
    productionExposure: [
      ...productionHostnames,
      environment.healthProbeApp,
      environment.platformApp,
    ],
    // The denial proof must cover the production branch and BOTH the
    // staging and the dev credential: AC2 names the staging/dev
    // separation, so one refused credential does not prove it. These
    // are credential KINDS from the Neon contract, not hostnames or
    // credential values.
    neonSeparation: [PRODUCTION_NEON_BRANCH, 'staging', 'dev'],
  };
}
