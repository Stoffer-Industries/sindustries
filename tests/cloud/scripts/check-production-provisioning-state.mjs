#!/usr/bin/env node
// check-production-provisioning-state.mjs — task fb1240c0 (Slice D)
// Production provisioning state gate.
//
// WHY THIS EXISTS
//
// The approved design (§5, Slice D) lists the live evidence this task must
// produce: a Fly app/release/machine inventory, a Neon branch/role/connectivity
// proof, a secret-name inventory, a spend-limit read-back, and the health
// responses. Until now the repository owned the *contract* for one of them
// (the Neon AC2 evidence gate, `check-production-neon-evidence.mjs`) and
// nothing at all for the others, so every heartbeat re-read four provider
// APIs by hand and wrote the result into prose. A prose observation cannot
// fail CI, cannot be compared between runs, and cannot tell the reviewer
// which of the nine Slice D steps is still open.
//
// This check is the machine-verifiable half of that evidence. The operator
// captures a REDACTED state artifact (names, flags and counts only — never a
// value) with `infra/cloud/scripts/capture-production-provisioning-state.mjs`,
// and this checker decides, per Slice D step, whether the gate is met. It
// fails closed: an artifact that was not captured, a provider that could not
// be read, a missing app, an empty IP allowlist, a missing source secret, or
// a value-shaped credential in the artifact all fail with a named reason.
//
// The expected names are read from the environment manifest — the single
// source of truth — so the state cannot be green against a production
// topology the repository does not use.
//
// Three obligations are NOT machine-verifiable and are reported as
// `operator-required` rather than silently green: the Fly spend-limit
// read-back (Fly exposes no programmatic limit), the staging/dev separation
// denial proof (it needs credentials the capture never touches), and one
// successful production probe interval (it is time-based). A checker that
// cannot distinguish "proven" from "not provable here" is a checker that
// reports false comfort.
//
// Pure Node, no deps. Exits 0 when every machine-verifiable gate is met, 1
// on any unmet gate, 2 on a usage error.
//
// Usage:
//   node tests/cloud/scripts/check-production-provisioning-state.mjs <state-file> [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROBE_TARGET_KEYS,
  hostFingerprint,
  hostOfTargetValue,
} from '../../../infra/cloud/platform/probe-target-facts.mjs';
import {
  OPERATOR_EVIDENCE_SLOTS,
  operatorEvidenceCoverage,
  operatorEvidenceRecorded,
  operatorEvidenceSummary,
  validateOperatorEvidence,
} from '../../../infra/cloud/platform/production-operator-evidence.mjs';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

/** The artifact shape this checker understands. */
export const SUPPORTED_SCHEMA_VERSION = 8;

/** The operator obligation gate → the evidence slot that closes it. */
const OPERATOR_EVIDENCE_SLOT_BY_GATE = new Map(
  OPERATOR_EVIDENCE_SLOTS.map((entry) => [entry.gate, entry.slot]),
);

/** Neon's four default roles — they are not service roles. */
const NEON_DEFAULT_ROLES = new Set([
  'neondb_owner',
  'authenticator',
  'anonymous',
  'authenticated',
]);

/** The name of the production Neon branch. */
const PRODUCTION_NEON_BRANCH = 'production';

/**
 * Keys whose VALUE would carry a credential if it were ever populated.
 *
 * A `*Names` key is exempt: a list of secret NAMES is inventory, not a
 * secret, and the artifact exists to carry that inventory.
 */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|dsn|connection_?string|credential|private_?key|api_?key)/i;

/** Value shapes that are credentials regardless of the key they sit under. */
const SECRET_VALUE_PATTERNS = [
  { name: 'a credential-bearing connection URL', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s]*@/i },
  { name: 'a JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

/**
 * The gates, in Slice D order. `owner` names who can close the gate; the
 * point of naming it is that an unmet gate is never a mystery about who is
 * holding it up.
 */
const OPERATOR_REQUIRED_ROWS = [
  {
    gate: 'fly.spend-limit-readback',
    step: 'Slice D step 6',
    owner: 'Quinn / Tom',
    label: 'Fly organization spend limit',
    reason:
      'Fly exposes no programmatic spend-limit mutation or read-back, so AC5 cannot be machine-verified. The operator performs the Billing action and attaches the read-back.',
  },
  {
    gate: 'neon.separation-denial-proof',
    step: 'Slice D step 2',
    owner: 'Quinn (operator)',
    label: 'Staging/dev denial proof',
    reason:
      'The separation proof needs a connection attempt from a staging and a dev credential; the capture never touches credentials. The operator records it in the AC2 evidence artifact.',
  },
  {
    gate: 'health.production-probe-interval',
    step: 'Slice D step 7',
    owner: 'Quinn (operator)',
    label: 'One successful production probe interval',
    reason:
      'A successful probe interval is time-based and cannot be captured as a snapshot. The operator attaches the interval evidence.',
  },
  {
    gate: 'health.production-api-responses',
    step: 'Slice D step 9',
    owner: 'Quinn (operator)',
    label: 'Production API health responses',
    reason:
      'The per-surface health routes live in the staging preflight harness, and the production hostnames do not resolve until the DNS step; the operator records the HTTPS responses with the black-box smoke run.',
  },
  {
    gate: 'dns.resolution-and-tls-readback',
    step: 'Slice D step 8',
    owner: 'Quinn (operator)',
    label: 'Production DNS resolution and TLS read-back',
    reason:
      "AC3's verification also requires the production hostnames to resolve to the production app from two resolvers and to present a valid certificate. Resolution and TLS handshakes are network-bound and time-bound, so the operator attaches the read-back; this checker sees only the Cloudflare zone records.",
  },
];

/**
 * Does this DNS target name a staging deployment?
 *
 * The manifest's separation contract compares host labels as WORDS, so a
 * provider-style `ep-staging-…` endpoint and a `staging-db.neon.tech` shape
 * are both refused. The DNS gate uses the same rule: a production record
 * that names a staging label is a separation failure, whatever the record
 * type is.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
export function namesStagingTarget(content) {
  if (typeof content !== 'string' || content.trim().length === 0) return false;
  const host = content
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  return host
    .split('.')
    .some((label) => label === 'staging' || label.split('-').includes('staging'));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Find a credential-shaped value anywhere in the artifact.
 *
 * @param {unknown} node
 * @param {string} [path]
 * @returns {string[]} paths of offending values (paths only — never a value)
 */
export function findCredentialValues(node, path = '') {
  const found = [];
  if (typeof node === 'string') {
    for (const { name, pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(node)) {
        found.push(`${path || '<root>'} (${name})`);
      }
    }
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => {
      found.push(...findCredentialValues(entry, `${path}[${index}]`));
    });
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        SECRET_KEY_PATTERN.test(key) &&
        !/names$/i.test(key) &&
        isNonEmptyString(value)
      ) {
        found.push(`${childPath} (a credential-shaped field)`);
        continue;
      }
      found.push(...findCredentialValues(value, childPath));
    }
  }
  return found;
}

function row(gate, status, { step, owner, label, reason }) {
  return { gate, status, step, owner, label, reason };
}

/**
 * The process group names a rendered Fly config declares.
 *
 * The platform is ONE app with ONE process group — the cost model and the
 * shared-fate topology both depend on it — so the names are read from the
 * config Fly actually deploys rather than restated here: a checker that
 * carries its own copy of the expected topology can agree with a drifted
 * config.
 *
 * @param {string} configText
 * @returns {string[]}
 */
export function processGroupNames(configText) {
  const names = [];
  let inTable = false;

  for (const rawLine of String(configText ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch) {
      inTable = tableMatch[1] === 'processes';
      continue;
    }
    if (!inTable) continue;
    const assignment = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (assignment) names.push(assignment[1]);
  }

  return names;
}

/**
 * Decide whether a captured provisioning state satisfies the production
 * provisioning gates.
 *
 * @param {object} state the captured artifact
 * @param {object} [options]
 * @param {string} [options.platformApp]
 * @param {string} [options.healthProbeApp]
 * @param {string[]} [options.requiredSourceNames]
 * @param {string[]} [options.expectedSchemas]
 * @param {string} [options.expectedPlatformEnvironmentId]
 * @param {object} [options.expectedPlatformCorsOrigins]
 * @param {string[]} [options.expectedPlatformProcessGroups]
 * @param {object} [options.expectedRedisAddon]
 * @returns {{ok: boolean, failures: object[], rows: object[]}}
 */
export function evaluateProvisioningState(state, options = {}) {
  // The expected names are deliberately NOT restated here. This checker used
  // to carry its own copy of the production app names as a fallback, which
  // is the same defect class the DNS gates were fixed for: a checker that
  // carries its own copy of the expected facts can agree with a drifted
  // source of truth. The environment manifest is the only place that names
  // production, so a caller that supplies no names is a caller that has not
  // told us what to check — and an empty expectation set must never read as
  // "everything required is present".
  const platformApp = options.platformApp ?? null;
  const healthProbeApp = options.healthProbeApp ?? null;
  const requiredSourceNames = [...(options.requiredSourceNames ?? [])];
  const expectedSchemas = [...(options.expectedSchemas ?? [])];
  const expectedPlatformSecretNames = [...(options.expectedPlatformSecretNames ?? [])];
  const expectedProbeCadence = { ...(options.expectedProbeCadence ?? {}) };
  const expectedProductionHostFingerprints = [
    ...(options.expectedProductionHostFingerprints ?? []),
  ].filter((fingerprint) => typeof fingerprint === 'string' && fingerprint.length > 0);
  const dnsExpectations = options.dnsExpectations ?? { zoneName: null, surfaces: [] };
  const expectedRedisAddon = options.expectedRedisAddon ?? {};

  // The surfaces each operator obligation must have been read back
  // against. They are supplied by the caller — derived from the
  // environment manifest and the hostname matrix — and never read from
  // the artifact: a checker that derived the expected surfaces from the
  // evidence it is checking would agree with a drifted record.
  const operatorTargetExpectations = options.expectedOperatorTargets ?? {};
  const expectedTargetsForSlot = (slot) => {
    const definition = OPERATOR_EVIDENCE_SLOTS.find(
      (candidate) => candidate.slot === slot,
    );
    if (!definition?.coverage) return [];
    const targets = operatorTargetExpectations[definition.coverage];
    return Array.isArray(targets) ? targets : [];
  };

  const rows = [];
  const failures = [];

  const add = (entry) => {
    rows.push(entry);
    if (entry.status === 'unmet') failures.push(entry);
  };

  if (!state || typeof state !== 'object') {
    add(
      row('artifact.shape', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Captured state artifact',
        reason: 'the artifact is missing or is not an object',
      }),
    );
    return { ok: false, failures, rows };
  }

  if (state.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    add(
      row('artifact.schema-version', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Artifact schema version',
        reason: `expected schemaVersion ${SUPPORTED_SCHEMA_VERSION}, found ${JSON.stringify(state.schemaVersion)}`,
      }),
    );
  }

  if (state.environment !== 'production') {
    add(
      row('artifact.environment', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Artifact environment',
        reason: `expected environment "production", found ${JSON.stringify(state.environment)}`,
      }),
    );
  }

  if (!isIsoTimestamp(state.capturedAt)) {
    add(
      row('artifact.captured-at', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Capture timestamp',
        reason: 'capturedAt must be an ISO-8601 date-time with an explicit timezone',
      }),
    );
  }

  const credentialPaths = findCredentialValues(state);
  if (credentialPaths.length > 0) {
    add(
      row('artifact.redaction', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Artifact redaction',
        reason: `the artifact carries credential-shaped values at: ${credentialPaths.join(', ')}`,
      }),
    );
  }

  // The operator evidence section is optional, but it is not optional in
  // the shape it has when present: a read-back that cannot be read is not
  // a read-back. Dropping a malformed section would turn a recorded spend
  // limit into an unrecorded one and flip the ordering gate red with no
  // explanation of why.
  const operatorEvidenceValidation = validateOperatorEvidence(state.operatorEvidence);
  if (!operatorEvidenceValidation.ok) {
    add(
      row('artifact.operator-evidence', 'unmet', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Operator evidence section',
        reason: operatorEvidenceValidation.problems.join('; '),
      }),
    );
  } else if (!operatorEvidenceValidation.present) {
    add(
      row('artifact.operator-evidence', 'not-applicable', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Operator evidence section',
        reason:
          'the artifact records no operator evidence, so every operator obligation stays open',
      }),
    );
  } else {
    add(
      row('artifact.operator-evidence', 'met', {
        step: 'Slice D evidence',
        owner: 'Rowan',
        label: 'Operator evidence section',
        reason: 'the operator evidence section is present and well-formed',
      }),
    );
  }

  const providers = state.providers ?? {};

  /**
   * A provider that could not be read makes its gates unmet, not unknown.
   *
   * "Not captured" is not "fine" — an unreadable provider means the gate is
   * unproven, and an unproven gate is an open gate.
   */
  const providerCaptured = (name) => {
    const provider = providers[name];
    if (!provider || typeof provider !== 'object') {
      add(
        row(`${name}.captured`, 'unmet', {
          step: 'Slice D evidence',
          owner: 'Rowan',
          label: `${name} read`,
          reason: `the ${name} section is missing from the artifact`,
        }),
      );
      return false;
    }
    if (provider.captured !== true) {
      add(
        row(`${name}.captured`, 'unmet', {
          step: 'Slice D evidence',
          owner: 'Rowan',
          label: `${name} read`,
          reason: `the ${name} provider was not captured${
            provider.error ? `: ${provider.error}` : ''
          }`,
        }),
      );
      return false;
    }
    return true;
  };

  // --- Neon: AC2 — branch, service roles, connectivity restriction -------

  if (providerCaptured('neon')) {
    const neon = providers.neon;
    const branch = neon.branch ?? {};
    if (branch.name !== PRODUCTION_NEON_BRANCH) {
      add(
        row('neon.production-branch', 'unmet', {
          step: 'Slice D step 1',
          owner: 'Quinn (operator)',
          label: 'Production Neon branch',
          reason: `expected a branch named "${PRODUCTION_NEON_BRANCH}", found ${JSON.stringify(branch.name ?? null)}`,
        }),
      );
    } else if (branch.state !== 'ready') {
      add(
        row('neon.production-branch', 'unmet', {
          step: 'Slice D step 1',
          owner: 'Quinn (operator)',
          label: 'Production Neon branch',
          reason: `the production branch is not ready (state: ${JSON.stringify(branch.state ?? null)})`,
        }),
      );
    } else {
      add(
        row('neon.production-branch', 'met', {
          step: 'Slice D step 1',
          owner: 'Quinn (operator)',
          label: 'Production Neon branch',
          reason: 'the production branch exists and is ready',
        }),
      );
    }

    const roleNames = asArray(neon.roleNames);
    const serviceRoles = roleNames.filter((name) => !NEON_DEFAULT_ROLES.has(name));
    const missingSchemas = expectedSchemas.filter(
      (schema) =>
        !serviceRoles.some((role) => role.toLowerCase().includes(schema.toLowerCase())),
    );
    if (expectedSchemas.length === 0) {
      // Comparing the observed roles against no expected schema proves
      // nothing, so this gate cannot be met by an empty expectation set.
      add(
        row('neon.service-roles', 'unmet', {
          step: 'Slice D step 1',
          owner: 'Rowan',
          label: 'Production Neon service roles',
          reason:
            'the environment manifest supplied no expected schema, so the production service roles cannot be proven',
        }),
      );
    } else if (missingSchemas.length > 0) {
      add(
        row('neon.service-roles', 'unmet', {
          step: 'Slice D step 1',
          owner: 'Quinn (operator)',
          label: 'Production Neon service roles',
          reason: `no service role found for schema(s): ${missingSchemas.join(', ')} (roles present: ${
            roleNames.length > 0 ? roleNames.join(', ') : 'none'
          })`,
        }),
      );
    } else {
      add(
        row('neon.service-roles', 'met', {
          step: 'Slice D step 1',
          owner: 'Quinn (operator)',
          label: 'Production Neon service roles',
          reason: `one service role per schema (${expectedSchemas.join(', ')})`,
        }),
      );
    }

    const project = neon.project ?? {};
    const allowedIpCount = Number(project.allowedIpCount ?? 0);
    if (!Number.isFinite(allowedIpCount) || allowedIpCount < 1) {
      add(
        row('neon.ip-allowlist', 'unmet', {
          step: 'Slice D step 2',
          owner: 'Quinn / Tom (account plan decision)',
          label: 'Neon IP allowlist',
          reason:
            `the production project carries ${allowedIpCount} allowed IP address(es); AC2 requires a non-empty allowlist` +
            (neon.organization?.plan
              ? ` (Neon organization plan: ${neon.organization.plan})`
              : ''),
        }),
      );
    } else {
      add(
        row('neon.ip-allowlist', 'met', {
          step: 'Slice D step 2',
          owner: 'Quinn / Tom (account plan decision)',
          label: 'Neon IP allowlist',
          reason: `the production project carries ${allowedIpCount} allowed IP address(es)`,
        }),
      );
    }

    if (project.protectedBranchesOnly === true && branch.protected !== true) {
      add(
        row('neon.branch-protection', 'unmet', {
          step: 'Slice D step 2',
          owner: 'Quinn (operator)',
          label: 'Production branch protection',
          reason:
            'the project restricts the allowlist to protected branches, but the production branch is not protected',
        }),
      );
    } else {
      add(
        row('neon.branch-protection', 'not-applicable', {
          step: 'Slice D step 2',
          owner: 'Quinn (operator)',
          label: 'Production branch protection',
          reason:
            project.protectedBranchesOnly === true
              ? 'the production branch is protected'
              : 'the project does not scope the allowlist to protected branches',
        }),
      );
    }
  }

  // --- Fly: AC1/AC6 — the consolidated production app and its inventory --

  if (providerCaptured('fly')) {
    const fly = providers.fly;
    const apps = asArray(fly.apps);
    const byName = new Map(apps.map((app) => [app?.name, app]));

    for (const [gate, name, label] of [
      ['fly.production-platform-app', platformApp, 'Consolidated production platform app'],
      ['fly.production-health-probe-app', healthProbeApp, 'Production health-probe app'],
    ]) {
      if (!name) {
        // The manifest did not name the app, so its existence is not a fact
        // that can be checked. Saying "the app does not exist" would blame
        // the operator for a missing repository fact.
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason:
              'the environment manifest supplied no production app name, so the app cannot be proven to exist',
          }),
        );
        continue;
      }
      const app = byName.get(name);
      if (!app) {
        // The capture reads every production app the manifest names, on
        // its own, so a missing entry is not a missing app — it is a
        // capture that did not record what it was asked to record. The
        // operator is not the owner of that.
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason: `the capture recorded no state for the production app ${name}`,
          }),
        );
        continue;
      }
      // `exists` has three values, not two. An unreadable read is not an
      // absent app, and an absent app is not an app with no release: the
      // three name different owners, so they must not share a reason.
      if (app.exists === false) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the Fly app ${name} does not exist`,
          }),
        );
        continue;
      }
      if (app.exists !== true) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason: `the state of the Fly app ${name} could not be read: ${
              app.machineInventoryError ?? 'no reason recorded'
            }`,
          }),
        );
        continue;
      }
      const machines = asArray(app.machineStates);
      const started = machines.filter((state) => state === 'started');
      if (!app.releaseVersion) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: app.releaseError ? 'Rowan' : 'Quinn (operator)',
            label,
            reason: app.releaseError
              ? `the release of the Fly app ${name} could not be read: ${app.releaseError}`
              : `the Fly app ${name} exists but has no deployed release`,
          }),
        );
        continue;
      }
      if (started.length === 0) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the Fly app ${name} exists but carries no started Machine (0/${machines.length} started)`,
          }),
        );
        continue;
      }
      add(
        row(gate, 'met', {
          step: 'Slice D step 3',
          owner: 'Quinn (operator)',
          label,
          reason: `${name} runs release ${app.releaseVersion} on ${started.length} started Machine(s)`,
        }),
      );
    }

    // --- Fly: AC1/AC4 — the DEPLOYED platform app's CONFIGURATION
    //
    // The gates above prove the production platform app EXISTS, carries a
    // release and runs a started Machine. None of that says WHICH
    // configuration the running app was deployed with: an app deployed
    // from the shared staging config exists, has a release, carries the
    // right secret NAMES — and still serves staging's environment id,
    // staging's CORS allow-lists and staging's process group.
    //
    // FLY MASKS SECRETS, so the deployed database and Redis URLs are not
    // readable at all. The plain `[env]` values ARE readable, and they
    // are exactly the ones that say which environment the app runs as.
    const platformConfig = fly.platformConfig ?? null;
    const configFailure =
      !platformConfig || platformConfig.captured !== true
        ? (platformConfig?.error ??
          'the deployed production platform configuration was not captured')
        : null;
    // An app that does not exist and an app with no Machine are the
    // operator's to close; a read that could not be made is the
    // capture's, and blaming the operator for it would be wrong.
    const configOwner =
      platformConfig?.reason === 'unreadable' ? 'Rowan (capture)' : 'Quinn (operator)';
    const configConflicts = new Set(asArray(platformConfig?.conflictingKeys));

    // 1. The environment id the production overlay declares.
    {
      const gate = 'fly.production-platform-app-environment-id';
      const label = 'Deployed production platform environment id';
      const expectedId =
        typeof options.expectedPlatformEnvironmentId === 'string'
          ? options.expectedPlatformEnvironmentId.trim()
          : '';
      if (configFailure) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: configOwner,
            label,
            reason: configFailure,
          }),
        );
      } else if (expectedId === '') {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason:
              'the production platform overlay declares no environment id, so the deployed one cannot be proven',
          }),
        );
      } else if (configConflicts.has('PLATFORM_ENVIRONMENT_ID')) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason:
              'the deployed production platform app carries a different PLATFORM_ENVIRONMENT_ID on different Machines',
          }),
        );
      } else if (!platformConfig.environmentId) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason:
              'the deployed production platform app carries no PLATFORM_ENVIRONMENT_ID, so the environment it runs as is unknown',
          }),
        );
      } else if (platformConfig.environmentId !== expectedId) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the deployed production platform app runs as "${platformConfig.environmentId}", expected "${expectedId}"`,
          }),
        );
      } else {
        add(
          row(gate, 'met', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the deployed production platform app runs as ${expectedId}`,
          }),
        );
      }
    }

    // 2. The CORS allow-lists the production overlay declares.
    {
      const gate = 'fly.production-platform-app-cors-origins';
      const label = 'Deployed production platform CORS allow-lists';
      const expectedOrigins = options.expectedPlatformCorsOrigins ?? {};
      const expectedKeys = Object.keys(expectedOrigins);
      if (configFailure) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: configOwner,
            label,
            reason: configFailure,
          }),
        );
      } else if (expectedKeys.length === 0) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason:
              'the production platform overlay declares no CORS allow-lists, so the deployed ones cannot be proven',
          }),
        );
      } else {
        const problems = [];
        for (const key of expectedKeys) {
          const expected = asArray(expectedOrigins[key]).map((origin) =>
            String(origin).toLowerCase(),
          );
          const deployed = asArray(platformConfig.corsOrigins?.[key]);
          if (configConflicts.has(key)) {
            problems.push(`${key} differs between Machines`);
            continue;
          }
          if (deployed.length === 0) {
            problems.push(`${key} is not deployed`);
            continue;
          }
          const missing = expected.filter((origin) => !deployed.includes(origin));
          const extra = deployed.filter((origin) => !expected.includes(origin));
          if (missing.length > 0 || extra.length > 0) {
            problems.push(
              `${key} allows ${deployed.join(', ')} instead of ${expected.join(', ')}`,
            );
          }
        }
        const malformed = Number(platformConfig.malformedOrigins ?? 0);
        if (malformed > 0) {
          problems.push(
            `${malformed} deployed origin(s) are not an https origin and were not recorded`,
          );
        }
        if (problems.length > 0) {
          add(
            row(gate, 'unmet', {
              step: 'Slice D step 3',
              owner: 'Quinn (operator)',
              label,
              reason: problems.join('; '),
            }),
          );
        } else {
          add(
            row(gate, 'met', {
              step: 'Slice D step 3',
              owner: 'Quinn (operator)',
              label,
              reason: `the deployed production platform app allows exactly the production origins (${expectedKeys.length} allow-list(s))`,
            }),
          );
        }
      }
    }

    // 3. The one consolidated process group the shared config declares.
    {
      const gate = 'fly.production-platform-app-process-group';
      const label = 'Deployed production platform process group';
      const expectedGroups = asArray(options.expectedPlatformProcessGroups);
      if (configFailure) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: configOwner,
            label,
            reason: configFailure,
          }),
        );
      } else if (expectedGroups.length !== 1) {
        // The platform is ONE app with ONE process group. A rendered
        // config that declares anything else is a forked topology, and
        // that is a repository fact, not the operator's.
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Rowan',
            label,
            reason: `the rendered production platform config declares ${expectedGroups.length} process group(s), expected exactly 1 — the platform is one app, one process group`,
          }),
        );
      } else if (configConflicts.has('FLY_PROCESS_GROUP')) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason:
              'the deployed production platform app runs more than one process group — the consolidated platform runs one',
          }),
        );
      } else if (!platformConfig.processGroup) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason:
              'the deployed production platform app carries no FLY_PROCESS_GROUP, so the process group it runs cannot be proven',
          }),
        );
      } else if (platformConfig.processGroup !== expectedGroups[0]) {
        add(
          row(gate, 'unmet', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the deployed production platform app runs the "${platformConfig.processGroup}" process group, expected "${expectedGroups[0]}"`,
          }),
        );
      } else {
        add(
          row(gate, 'met', {
            step: 'Slice D step 3',
            owner: 'Quinn (operator)',
            label,
            reason: `the deployed production platform app runs the single "${expectedGroups[0]}" process group`,
          }),
        );
      }
    }
  }

  // --- GitHub: AC4 — the production Environment source secrets ------------

  if (providerCaptured('github')) {
    const github = providers.github;
    const secretNames = new Set(asArray(github.secretNames));
    const missing = requiredSourceNames.filter((name) => !secretNames.has(name));
    if (requiredSourceNames.length === 0) {
      // "All 0 required source secrets are present" is a vacuous pass: an
      // expectation set that names nothing cannot prove that the production
      // Environment carries the credentials AC4 requires.
      add(
        row('github.production-environment-sources', 'unmet', {
          step: 'Slice D step 4',
          owner: 'Rowan',
          label: 'Production Environment source secrets',
          reason:
            'the environment manifest supplied no required source secret name, so the production Environment sources cannot be proven',
        }),
      );
    } else if (missing.length > 0) {
      add(
        row('github.production-environment-sources', 'unmet', {
          step: 'Slice D step 4',
          owner: 'Quinn (operator)',
          label: 'Production Environment source secrets',
          reason: `the production Environment is missing source secret(s): ${missing.join(', ')}`,
        }),
      );
    } else {
      add(
        row('github.production-environment-sources', 'met', {
          step: 'Slice D step 4',
          owner: 'Quinn (operator)',
          label: 'Production Environment source secrets',
          reason: `all ${requiredSourceNames.length} required source secret(s) are present`,
        }),
      );
    }
  }

  // --- Fly-managed Upstash: AC4 — the dedicated production database ------

  if (providerCaptured('fly')) {
    const actual = providers.fly.redis ?? null;
    const expected = expectedRedisAddon;
    const mismatches = [];
    if (actual?.captured !== true) mismatches.push(actual?.error ?? 'the add-on read failed');
    if (actual?.exists !== true) mismatches.push('the add-on does not exist');
    for (const key of ['name', 'provider', 'plan', 'primaryRegion']) {
      if (actual?.[key] !== expected?.[key]) {
        mismatches.push(`${key} is ${JSON.stringify(actual?.[key] ?? null)}, expected ${JSON.stringify(expected?.[key] ?? null)}`);
      }
    }
    if (actual?.status !== 'created') mismatches.push(`status is ${JSON.stringify(actual?.status ?? null)}, expected "created"`);
    if (mismatches.length > 0) {
      add(
        row('fly.production-redis-database', 'unmet', {
          step: 'Slice D step 4',
          owner: 'Quinn (operator)',
          label: 'Fly-managed production Redis database',
          reason: mismatches.join('; '),
        }),
      );
    } else {
      add(
        row('fly.production-redis-database', 'met', {
          step: 'Slice D step 4',
          owner: 'Quinn (operator)',
          label: 'Fly-managed production Redis database',
          reason: `${actual.name} exists on ${actual.plan} in ${actual.primaryRegion}`,
        }),
      );
    }
  }

  // --- Fly: AC4 — the secret inventory the production app actually carries --

  //
  // The design's expected live evidence names a "Fly secret-name inventory
  // and digest read-back, not values" (Slice D step 5). Until now the
  // repository could prove the GitHub Environment carried the SOURCE
  // secrets, but not that those values ever landed on the production app
  // as Fly secrets — so AC4's registration half was prose.
  //
  // The expected names come from the provisioner that registers them, not
  // from a copy kept here: a checker that carries its own copy of the
  // expected names can agree with a drifted provisioner.
  if (providerCaptured('fly')) {
    const fly = providers.fly;
    const apps = asArray(fly.apps);
    const platformAppEntry = apps.find((app) => app?.name === platformApp);

    if (expectedPlatformSecretNames.length === 0) {
      // "All 0 required secret(s) are registered" is a vacuous pass: an
      // expectation set that names nothing cannot prove that the
      // production app carries the credentials AC4 requires.
      add(
        row('fly.production-platform-app-secrets', 'unmet', {
          step: 'Slice D step 5',
          owner: 'Rowan',
          label: 'Production app secret inventory',
          reason:
            'the provisioner supplied no expected secret name, so the production app secret inventory cannot be proven',
        }),
      );
    } else if (!platformAppEntry) {
      add(
        row('fly.production-platform-app-secrets', 'unmet', {
          step: 'Slice D step 5',
          owner: 'Quinn (operator)',
          label: 'Production app secret inventory',
          reason:
            'the production platform app does not exist, so its secret inventory cannot be read',
        }),
      );
    } else if (!Array.isArray(platformAppEntry.secretNames)) {
      // An unreadable inventory is not an empty inventory. Reporting "no
      // secrets" here would name the operator for a read that never
      // happened.
      add(
        row('fly.production-platform-app-secrets', 'unmet', {
          step: 'Slice D step 5',
          owner: 'Quinn (operator)',
          label: 'Production app secret inventory',
          reason: `the production platform app's secret inventory could not be read: ${
            platformAppEntry.inventoryReadError ?? 'no reason recorded'
          }`,
        }),
      );
    } else {
      const registered = new Set(platformAppEntry.secretNames);
      const missing = expectedPlatformSecretNames.filter((name) => !registered.has(name));
      if (missing.length > 0) {
        add(
          row('fly.production-platform-app-secrets', 'unmet', {
            step: 'Slice D step 5',
            owner: 'Quinn (operator)',
            label: 'Production app secret inventory',
            reason: `the production platform app is missing secret(s): ${missing.join(', ')}`,
          }),
        );
      } else {
        add(
          row('fly.production-platform-app-secrets', 'met', {
            step: 'Slice D step 5',
            owner: 'Quinn (operator)',
            label: 'Production app secret inventory',
            reason: `the production platform app carries all ${expectedPlatformSecretNames.length} required secret name(s)`,
          }),
        );
      }
    }
  }

  // --- AC6: the DEPLOYED production probe cadence (Slice D step 7) --------

  // The repository already declared the production cadence (the production
  // health-probe overlay) and asserted, in CI, that it is tighter than the
  // staging daily cadence. What it could not prove is that the DEPLOYED
  // production probe carries it: a production probe left at the staging
  // 86400s passes every check the repository owns while watching nothing,
  // which is exactly what AC6 says must not happen.
  //
  // The expected values are read from the overlay that declares them, not
  // from a copy kept here: a checker that carries its own copy of the
  // expected cadence can agree with a drifted overlay.
  if (providerCaptured('fly')) {
    const expectedKeys = Object.entries(expectedProbeCadence).filter(
      ([, value]) => isNonEmptyString(value) || typeof value === 'number',
    );

    if (expectedKeys.length === 0) {
      // An expectation set that names nothing cannot prove that the
      // deployed probe runs the production cadence. This is a missing
      // repository fact, so it is owned here rather than by the operator.
      add(
        row('health.production-probe-cadence', 'unmet', {
          step: 'Slice D step 7',
          owner: 'Rowan',
          label: 'Deployed production probe cadence',
          reason:
            'the production probe overlay declares no expected cadence, so the deployed cadence cannot be proven',
        }),
      );
    } else {
      const probeEnv = providers.fly.healthProbeEnv ?? null;
      if (!probeEnv || probeEnv.captured !== true) {
        add(
          row('health.production-probe-cadence', 'unmet', {
            step: 'Slice D step 7',
            owner: 'Quinn (operator)',
            label: 'Deployed production probe cadence',
            reason:
              probeEnv?.error ??
              'the deployed production health-probe environment was not captured',
          }),
        );
      } else {
        const deployed = probeEnv.env ?? {};
        const conflicting = new Set(asArray(probeEnv.conflictingKeys));
        const problems = [];

        for (const [key, expectedValue] of expectedKeys) {
          if (conflicting.has(key)) {
            problems.push(`${key} is set to different values on different Machines`);
            continue;
          }
          const actual = deployed?.[key];
          if (actual === undefined || actual === null) {
            problems.push(`${key} is not set on the deployed production health-probe app`);
            continue;
          }
          const actualNumber = Number(actual);
          const expectedNumber = Number(expectedValue);
          if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
            problems.push(
              `${key} is not a number on the deployed production health-probe app (${JSON.stringify(actual)})`,
            );
            continue;
          }
          if (actualNumber !== expectedNumber) {
            problems.push(
              `${key} is ${actualNumber}s on the deployed production health-probe app, not the declared ${expectedNumber}s`,
            );
          }
        }

        if (problems.length > 0) {
          add(
            row('health.production-probe-cadence', 'unmet', {
              step: 'Slice D step 7',
              owner: 'Quinn (operator)',
              label: 'Deployed production probe cadence',
              reason: problems.join('; '),
            }),
          );
        } else {
          add(
            row('health.production-probe-cadence', 'met', {
              step: 'Slice D step 7',
              owner: 'Quinn (operator)',
              label: 'Deployed production probe cadence',
              reason: `the deployed production health-probe app carries ${expectedKeys
                .map(([key]) => key)
                .join(' and ')} at the declared production cadence`,
            }),
          );
        }
      }
    }
  }

  // --- AC6: the DEPLOYED production probe is pointed at production targets

  //
  // AC6 has two halves: the probe must run the production cadence, and it
  // must be pointed at the NEW PRODUCTION TARGETS. The cadence gate above
  // proves the first. Nothing proved the second: a production probe
  // carrying the production cadence while still pointed at the staging
  // database and the staging Redis passes every check the repository owns
  // while watching the wrong environment.
  //
  // The comparison runs on a FINGERPRINT of the target's host, so the
  // artifact never carries a DSN, a Redis URL or a database hostname — only
  // the fact that the deployed probe points at the same service the capture
  // read.
  if (providerCaptured('fly')) {
    const probeTargets = providers.fly.healthProbeTargets ?? null;
    const conflicting = new Set(asArray(probeTargets?.conflictingKeys));

    // The production branch's serving hosts, as FINGERPRINTS. A v3 artifact
    // carried a single `branch.hostFingerprint`, but the Neon v2 branch
    // resource has no `host` field — the host lives on the branch's
    // ENDPOINTS — so that value was always null and this expectation set
    // was always empty. The AC6 database-target gate was therefore
    // unsatisfiable no matter how correctly production was provisioned.
    const neonBranchFingerprints = asArray(providers.neon?.branch?.endpointHostFingerprints)
      .filter((fingerprint) => typeof fingerprint === 'string' && fingerprint.length > 0);
    const neonEndpointHostsReadError =
      providers.neon?.branch?.endpointHostsReadError ?? null;
    const productionRedisFingerprints = [providers.fly.redis?.endpointHostFingerprint]
      .filter((fingerprint) => typeof fingerprint === 'string' && fingerprint.length > 0);

    const targetSpecs = [
      {
        key: 'HEALTH_PROBE_FLY_APPS',
        gate: 'health.production-probe-fly-targets',
        label: 'Deployed production probe Fly targets',
        expected: new Set(expectedProductionHostFingerprints),
        expectationOwner: 'Rowan',
        expectationReason:
          'the environment manifest names no production host, so the deployed probe targets cannot be proven',
      },
      {
        key: 'HEALTH_PROBE_DATABASES',
        gate: 'health.production-probe-database-targets',
        label: 'Deployed production probe database targets',
        expected: new Set(neonBranchFingerprints),
        expectationOwner: 'Rowan',
        expectationReason: neonEndpointHostsReadError
          ? `the production Neon branch's endpoint hosts could not be read (${neonEndpointHostsReadError}), so the deployed probe targets cannot be proven`
          : 'the production Neon branch exposes no endpoint host, so the deployed probe targets cannot be proven',
      },
      {
        key: 'HEALTH_PROBE_REDIS',
        gate: 'health.production-probe-redis-targets',
        label: 'Deployed production probe Redis targets',
        expected: new Set(productionRedisFingerprints),
        expectationOwner: 'Quinn (operator)',
        expectationReason:
          'no production Redis database was found, so the deployed probe targets cannot be proven',
      },
    ];

    for (const spec of targetSpecs) {
      const captureFailure =
        !probeTargets || probeTargets.captured !== true
          ? (probeTargets?.error ??
            'the deployed production health-probe targets were not captured')
          : null;

      if (captureFailure) {
        add(
          row(spec.gate, 'unmet', {
            step: 'Slice D step 7',
            owner: 'Quinn (operator)',
            label: spec.label,
            reason: captureFailure,
          }),
        );
        continue;
      }

      const targetRows = asArray(probeTargets.targets?.[spec.key]);
      if (targetRows.length === 0) {
        add(
          row(spec.gate, 'unmet', {
            step: 'Slice D step 7',
            owner: 'Quinn (operator)',
            label: spec.label,
            reason: `the deployed production health-probe app carries no ${spec.key} target`,
          }),
        );
        continue;
      }

      if (conflicting.has(spec.key)) {
        add(
          row(spec.gate, 'unmet', {
            step: 'Slice D step 7',
            owner: 'Quinn (operator)',
            label: spec.label,
            reason: `the deployed production health-probe app carries different ${spec.key} targets on different Machines`,
          }),
        );
        continue;
      }

      if (spec.expected.size === 0) {
        // An expectation set that names nothing cannot prove anything: this
        // is a missing repository or provider fact, and it is owned here
        // rather than by the operator.
        add(
          row(spec.gate, 'unmet', {
            step: 'Slice D step 7',
            owner: spec.expectationOwner,
            label: spec.label,
            reason: spec.expectationReason,
          }),
        );
        continue;
      }

      const offTarget = targetRows.filter(
        (target) => !spec.expected.has(target?.hostFingerprint),
      );
      if (offTarget.length > 0) {
        add(
          row(spec.gate, 'unmet', {
            step: 'Slice D step 7',
            owner: 'Quinn (operator)',
            label: spec.label,
            reason:
              `the deployed production health-probe app points ${offTarget.length} of its ` +
              `${spec.key} target(s) somewhere other than production: ` +
              offTarget.map((target) => target?.label ?? 'an unlabelled target').join(', '),
          }),
        );
        continue;
      }

      add(
        row(spec.gate, 'met', {
          step: 'Slice D step 7',
          owner: 'Quinn (operator)',
          label: spec.label,
          reason: `the deployed production health-probe app points its ${targetRows.length} ${spec.key} target(s) at production`,
        }),
      );
    }
  }

  // --- Cloudflare DNS: AC3 — production records point at the production apps

  if (providerCaptured('cloudflare')) {
    const cloudflare = providers.cloudflare;
    const records = asArray(cloudflare.records);
    const byName = new Map();
    for (const record of records) {
      const name = record?.name;
      if (!name) continue;
      byName.set(name, [...(byName.get(name) ?? []), record]);
    }

    const surfaces = asArray(dnsExpectations.surfaces);
    if (surfaces.length === 0) {
      add(
        row('cloudflare.dns-expectations', 'unmet', {
          step: 'Slice D step 8',
          owner: 'Rowan',
          label: 'Production DNS expectations',
          reason:
            'the hostname matrix declares no Fly-hosted production surface, so no DNS target can be verified',
        }),
      );
    } else {
      /**
       * Why a production hostname's DNS record is not yet the one AC3 wants.
       *
       * @returns {string|null} null when the record is correct
       */
      const productionProblem = (surface) => {
        const hostname = surface.productionHostname;
        if (!hostname) {
          return `the hostname matrix declares no production hostname for "${surface.id}"`;
        }
        const entries = byName.get(hostname) ?? [];
        if (entries.length === 0) return `no DNS record exists for ${hostname}`;
        const matching = entries.find(
          (record) => record?.content === surface.productionTarget,
        );
        if (!matching) {
          const observed = entries
            .map((record) => `${record?.type ?? 'record'} → ${record?.content ?? 'no target'}`)
            .join(', ');
          return `${hostname} is ${observed}, expected CNAME → ${surface.productionTarget}`;
        }
        if (matching.proxied === true) {
          return (
            `${hostname} is proxied (orange cloud); the CNAME to ${surface.productionTarget} ` +
            'must stay DNS-only for Fly to validate its certificate'
          );
        }
        return null;
      };

      const apiSurfaces = surfaces.filter((surface) => surface.id !== 'health-probe');
      const probeSurface = surfaces.find((surface) => surface.id === 'health-probe');

      const apiProblems = apiSurfaces
        .map((surface) => ({ surface, problem: productionProblem(surface) }))
        .filter((entry) => entry.problem);
      if (apiProblems.length > 0) {
        add(
          row('cloudflare.production-api-dns-records', 'unmet', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Production API DNS records',
            reason: apiProblems
              .map((entry) => `${entry.surface.productionHostname}: ${entry.problem}`)
              .join('; '),
          }),
        );
      } else {
        add(
          row('cloudflare.production-api-dns-records', 'met', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Production API DNS records',
            reason: `${apiSurfaces.length} production API hostname(s) CNAME to their production app`,
          }),
        );
      }

      if (!probeSurface) {
        add(
          row('cloudflare.production-probe-dns-record', 'unmet', {
            step: 'Slice D step 8',
            owner: 'Rowan',
            label: 'Production health-probe DNS record',
            reason:
              'the hostname matrix declares no "health-probe" surface, so the probe record cannot be verified',
          }),
        );
      } else {
        const probeProblem = productionProblem(probeSurface);
        if (probeProblem) {
          add(
            row('cloudflare.production-probe-dns-record', 'unmet', {
              step: 'Slice D step 8',
              owner: 'Quinn (operator)',
              label: 'Production health-probe DNS record',
              reason: probeProblem,
            }),
          );
        } else {
          add(
            row('cloudflare.production-probe-dns-record', 'met', {
              step: 'Slice D step 8',
              owner: 'Quinn (operator)',
              label: 'Production health-probe DNS record',
              reason: `${probeSurface.productionHostname} CNAMEs to ${probeSurface.productionTarget}`,
            }),
          );
        }
      }

      // AC3 says "with staging/dev domains unaffected": a production record
      // that names a staging deployment is a separation failure even when it
      // also happens to carry the right record type.
      const separationFailures = [];
      for (const surface of surfaces) {
        const hostname = surface.productionHostname;
        if (!hostname) continue;
        for (const record of byName.get(hostname) ?? []) {
          if (!namesStagingTarget(record?.content)) continue;
          separationFailures.push(
            `${hostname} → ${record?.content ?? 'no target'} (a staging deployment)`,
          );
        }
      }
      if (separationFailures.length > 0) {
        add(
          row('cloudflare.production-dns-separation', 'unmet', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Production DNS separation',
            reason: `production hostname(s) point at a staging deployment: ${separationFailures.join('; ')}`,
          }),
        );
      } else {
        add(
          row('cloudflare.production-dns-separation', 'met', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Production DNS separation',
            reason: `no production hostname points at a staging deployment (${surfaces.length} surface(s) checked)`,
          }),
        );
      }

      const stagingProblems = [];
      for (const surface of surfaces) {
        const hostname = surface.stagingHostname;
        if (!hostname || !surface.stagingTarget) continue;
        const entries = byName.get(hostname) ?? [];
        if (entries.length === 0) {
          stagingProblems.push(`no DNS record exists for ${hostname}`);
          continue;
        }
        if (!entries.some((record) => record?.content === surface.stagingTarget)) {
          const observed = entries
            .map((record) => `${record?.type ?? 'record'} → ${record?.content ?? 'no target'}`)
            .join(', ');
          stagingProblems.push(
            `${hostname} is ${observed}, expected it to stay on ${surface.stagingTarget}`,
          );
        }
      }
      if (stagingProblems.length > 0) {
        add(
          row('cloudflare.staging-dns-unchanged', 'unmet', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Staging DNS unchanged',
            reason: `AC3 requires the staging hostnames to be unaffected: ${stagingProblems.join('; ')}`,
          }),
        );
      } else {
        add(
          row('cloudflare.staging-dns-unchanged', 'met', {
            step: 'Slice D step 8',
            owner: 'Quinn (operator)',
            label: 'Staging DNS unchanged',
            reason: 'every staging hostname still resolves to its staging deployment',
          }),
        );
      }
    }
  }

  // --- AC5: the Fly spend limit BEFORE any public exposure --------------
  //
  // The approved design makes the spend limit a HARD gate: step 6 sets it
  // and captures the read-back "before the health probe or any public
  // hostname is enabled". Nothing in the chain enforced that ORDER. The
  // spend-limit read-back was reported as an operator obligation — an
  // advisory line that never blocked — so an operator could publish the
  // production DNS records and deploy the production health probe while
  // the limit was still unset, and every machine-verifiable gate would
  // still be met.
  //
  // This gate closes the hole. Public exposure is read from the artifact
  // (a production hostname published in DNS, or the production health-probe
  // app running) and the recorded spend-limit read-back is required before
  // it. Before any exposure exists the gate is not applicable — the limit
  // is still owed, but nothing is exposed yet.
  {
    const gate = 'fly.spend-limit-before-public-exposure';
    const label = 'Fly spend limit before public exposure';

    const productionHostnames = new Set(
      asArray(dnsExpectations.surfaces)
        .map((surface) => surface?.productionHostname)
        .filter((hostname) => typeof hostname === 'string' && hostname.length > 0),
    );
    const publishedHostnames = [
      ...new Set(
        asArray(providers.cloudflare?.records)
          .map((record) => record?.name)
          .filter((name) => typeof name === 'string' && productionHostnames.has(name)),
      ),
    ];

    const probeApp = asArray(providers.fly?.apps).find(
      (app) => app?.name === healthProbeApp,
    );
    const probeRunning = asArray(probeApp?.machineStates).some(
      (machineState) => machineState === 'started',
    );

    const exposure = [];
    if (publishedHostnames.length > 0) {
      exposure.push(`the production hostname(s) ${publishedHostnames.join(', ')} are published`);
    }
    if (probeRunning) {
      exposure.push(`the production health-probe app ${healthProbeApp ?? '(unnamed)'} is running`);
    }

    const spendLimitSummary = operatorEvidenceSummary(state.operatorEvidence, 'flySpendLimit');
    const spendLimitCoverage = operatorEvidenceCoverage(
      state.operatorEvidence,
      'flySpendLimit',
      expectedTargetsForSlot('flySpendLimit'),
    );
    if (exposure.length === 0) {
      add(
        row(gate, 'not-applicable', {
          step: 'Slice D step 6',
          owner: 'Quinn / Tom (account plan decision)',
          label,
          reason:
            'nothing is publicly exposed yet; the Fly spend limit must be set and read back before the production health probe is deployed or a production DNS record is published',
        }),
      );
    } else if (spendLimitCoverage.expected.length === 0) {
      add(
        row(gate, 'unmet', {
          step: 'Slice D step 6',
          owner: 'Rowan',
          label,
          reason:
            'the repository supplies no expected production app scope for the Fly spend-limit read-back, so the read-back cannot be proven',
        }),
      );
    } else if (!spendLimitCoverage.recorded) {
      add(
        row(gate, 'unmet', {
          step: 'Slice D step 6',
          owner: 'Quinn / Tom (account plan decision)',
          label,
          reason:
            `${exposure.join('; ')}, but no Fly spend-limit read-back is recorded. ` +
            'The approved design makes the limit a hard gate before any public exposure, so the exposure must not stand until the read-back is recorded.',
        }),
      );
    } else if (!spendLimitCoverage.covered) {
      add(
        row(gate, 'unmet', {
          step: 'Slice D step 6',
          owner: 'Quinn / Tom (account plan decision)',
          label,
          reason:
            `${exposure.join('; ')}, and the recorded Fly spend-limit read-back is not bound to the ` +
            `production app scope it must cover: ${describeCoverageGap(spendLimitCoverage)}`,
        }),
      );
    } else {
      add(
        row(gate, 'met', {
          step: 'Slice D step 6',
          owner: 'Quinn / Tom (account plan decision)',
          label,
          reason: `the spend limit was read back (${spendLimitSummary}) and ${exposure.join('; ')}`,
        }),
      );
    }
  }

  for (const entry of OPERATOR_REQUIRED_ROWS) {
    const slot = OPERATOR_EVIDENCE_SLOT_BY_GATE.get(entry.gate);
    const summary = slot ? operatorEvidenceSummary(state.operatorEvidence, slot) : null;
    if (summary) {
      const coverage = operatorEvidenceCoverage(
        state.operatorEvidence,
        slot,
        expectedTargetsForSlot(slot),
      );
      if (coverage.expected.length === 0) {
        add(
          row(entry.gate, 'unmet', {
            step: entry.step,
            owner: 'Rowan',
            label: entry.label,
            reason:
              `the operator recorded this read-back (${summary}), but the repository supplies no ` +
              'expected surface for this obligation, so the read-back cannot be proven',
          }),
        );
        continue;
      }
      if (!coverage.covered) {
        add(
          row(entry.gate, 'unmet', {
            step: entry.step,
            owner: entry.owner,
            label: entry.label,
            reason:
              `the operator recorded this read-back (${summary}), but it is not bound to the ` +
              `production surfaces it must prove: ${describeCoverageGap(coverage)}`,
          }),
        );
        continue;
      }
      add(
        row(entry.gate, 'met', {
          step: entry.step,
          owner: entry.owner,
          label: entry.label,
          reason: `the operator recorded this read-back: ${summary}`,
        }),
      );
      continue;
    }
    add(
      row(entry.gate, 'operator-required', {
        step: entry.step,
        owner: entry.owner,
        label: entry.label,
        reason:
          `${entry.reason} Record it in the artifact's operatorEvidence section` +
          (slot ? ` (slot "${slot}").` : '.'),
      }),
    );
  }

  return { ok: failures.length === 0, failures, rows };
}

/**
 * Why a recorded read-back does not cover what it must prove.
 *
 * @param {{expected: string[], missing: string[], extra: string[]}} coverage
 * @returns {string}
 */
export function describeCoverageGap(coverage) {
  const parts = [];
  if (coverage.missing.length > 0) {
    parts.push(`it does not name ${coverage.missing.join(', ')}`);
  }
  if (coverage.extra.length > 0) {
    parts.push(`it names ${coverage.extra.join(', ')}, which production does not use`);
  }
  return parts.join('; ') || 'it names no expected production surface';
}

/**
 * Read the expected production facts from the environment manifest.
 *
 * @param {string} repoRoot
 * @returns {Promise<{platformApp: string, healthProbeApp: string, requiredSourceNames: string[], expectedSchemas: string[], expectedPlatformSecretNames: string[]}>}
 */
export async function loadProductionExpectations(repoRoot = DEFAULTS) {
  const manifestUrl = pathToFileURL(
    join(repoRoot, 'infra/cloud/platform/platform-environments.mjs'),
  ).href;
  const manifest = await import(manifestUrl);
  const environment = manifest.getPlatformEnvironment('production');

  // The app-level secret names come from the provisioner that registers
  // them. The list is not restated here: a checker that carries its own
  // copy of the expected names can agree with a drifted provisioner, which
  // is the same defect class the DNS gates were fixed for.
  const provisionerUrl = pathToFileURL(
    join(repoRoot, 'infra/cloud/platform/platform-provision-secrets.mjs'),
  ).href;
  const provisioner = await import(provisionerUrl);

  // The hostname matrix owns the stable hostnames and their CNAME targets, so
  // the DNS expectations are read from it rather than restated here: a
  // checker that carries its own copy of the expected targets can agree with
  // a drifted matrix.
  const matrix = JSON.parse(
    readFileSync(join(repoRoot, 'infra/cloud/hostname-matrix.json'), 'utf8'),
  );
  const dnsSurfaces = (matrix.surfaces ?? [])
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

  // The production probe cadence is declared by the production health-probe
  // overlay — the file Fly actually deploys — so the expected values are
  // read from it rather than restated here: a checker that carries its own
  // copy of the expected cadence can agree with a drifted overlay.
  //
  // The overlay is parsed with the renderer's own parser, so the keys a
  // checker compares are the keys the deployment contract allows an
  // overlay to set. A parse failure is not a crash: it becomes an empty
  // expectation set, and an empty expectation set fails the gate as a
  // missing repository fact.
  let expectedProbeCadence = {};
  try {
    const rendererUrl = pathToFileURL(
      join(repoRoot, 'infra/cloud/platform/render-fly-config.mjs'),
    ).href;
    const renderer = await import(rendererUrl);
    const overlay = renderer.parseOverlay(
      readFileSync(
        join(
          repoRoot,
          'infra/cloud/observability/health-probe/fly.production.overlay.toml',
        ),
        'utf8',
      ),
    );
    expectedProbeCadence = {
      FLY_APP_PROBE_INTERVAL_SECONDS: overlay.env.FLY_APP_PROBE_INTERVAL_SECONDS ?? null,
      DB_PROBE_INTERVAL_SECONDS: overlay.env.DB_PROBE_INTERVAL_SECONDS ?? null,
    };
  } catch {
    expectedProbeCadence = {};
  }

  // The production hosts a deployed probe is allowed to point at: the
  // consolidated production app's own hostname and the stable production
  // API hostnames the manifest publishes. They are derived from the
  // manifest rather than restated here — a checker that carries its own
  // copy of the expected hosts can agree with a drifted manifest.
  const productionTargetHosts = [
    `${environment.platformApp}.fly.dev`,
    ...Object.values(environment.apiBaseUrls ?? {}).map((url) => hostOfTargetValue(url)),
  ].filter((host) => typeof host === 'string' && host.length > 0);
  const expectedProductionHostFingerprints = [
    ...new Set(
      productionTargetHosts.map((host) => hostFingerprint(host)).filter(Boolean),
    ),
  ];

  // The production platform OVERLAY is the file Fly deploys for the
  // production platform app, so the expected environment id and CORS
  // allow-lists are read from it rather than restated here: a checker
  // that carries its own copy of the expected values can agree with a
  // drifted overlay. The manifest and the overlay are bound together by
  // the renderer's contract test, so the two cannot drift apart.
  //
  // The rendered config — the shared config with the overlay merged onto
  // it — is what Fly actually deploys, so the expected process group is
  // read from it.
  //
  // A parse or render failure is not a crash: it becomes an empty
  // expectation set, and an empty expectation set fails the gate as a
  // missing repository fact rather than passing vacuously.
  let expectedPlatformEnvironmentId = '';
  let expectedPlatformCorsOrigins = {};
  let expectedPlatformProcessGroups = [];
  try {
    const rendererUrl = pathToFileURL(
      join(repoRoot, 'infra/cloud/platform/render-fly-config.mjs'),
    ).href;
    const renderer = await import(rendererUrl);
    const overlay = renderer.parseOverlay(
      readFileSync(join(repoRoot, 'infra/cloud/fly/platform.production.overlay.toml'), 'utf8'),
    );
    expectedPlatformEnvironmentId = overlay.env.PLATFORM_ENVIRONMENT_ID ?? '';
    for (const [key, value] of Object.entries(overlay.env)) {
      if (!key.endsWith('CORS_ALLOWED_ORIGINS')) continue;
      expectedPlatformCorsOrigins[key] = String(value)
        .split(',')
        .map((origin) => origin.trim().toLowerCase())
        .filter(Boolean);
    }
    const sharedText = readFileSync(join(repoRoot, 'infra/cloud/fly/platform.fly.toml'), 'utf8');
    expectedPlatformProcessGroups = processGroupNames(
      renderer.mergeFlyConfig(sharedText, overlay),
    );
  } catch {
    expectedPlatformEnvironmentId = '';
    expectedPlatformCorsOrigins = {};
    expectedPlatformProcessGroups = [];
  }

  // The surfaces each operator obligation must have been read back
  // against. They come from the same source-of-truth facts the other
  // gates compare against — the environment manifest for the app names
  // and the API hostnames, the hostname matrix for the Fly-hosted
  // production hostnames — so a read-back cannot be recorded against a
  // surface production does not use, and a surface production DOES use
  // cannot be left out of the record.
  const productionApiHostnames = [
    ...new Set(
      Object.values(environment.apiBaseUrls ?? {})
        .map((url) => hostOfTargetValue(url))
        .filter((host) => typeof host === 'string' && host.length > 0),
    ),
  ];
  const productionHostnames = [
    ...new Set(
      dnsSurfaces
        .map((surface) => surface.productionHostname)
        .filter((hostname) => typeof hostname === 'string' && hostname.length > 0),
    ),
  ];

  return {
    platformApp: environment.platformApp,
    healthProbeApp: environment.healthProbeApp,
    requiredSourceNames: manifest.requiredSourceNames(environment),
    expectedSchemas: Object.values(environment.schemas ?? {}),
    expectedPlatformSecretNames: [...provisioner.PLATFORM_SECRET_NAMES],
    expectedProbeCadence,
    expectedProductionHostFingerprints,
    expectedPlatformEnvironmentId,
    expectedPlatformCorsOrigins,
    expectedPlatformProcessGroups,
    expectedRedisAddon: { ...environment.redisAddon },
    expectedOperatorTargets: {
      // AC5 sets the limit on the PRODUCTION APP scope, so the read-back
      // must name that app.
      platformAppScope: [environment.platformApp],
      // The interval must have been observed on the production probe app.
      healthProbeApp: [environment.healthProbeApp],
      // The health responses must come from all three production APIs.
      productionApiHostnames,
      // The DNS/TLS read-back must cover every production hostname.
      productionHostnames,
      // The denial proof must cover the production branch and BOTH the
      // staging and the dev credential: AC2 names the staging/dev
      // separation, so one refused credential does not prove it. These
      // are credential KINDS from the Neon contract, not hostnames or
      // credential values.
      neonSeparation: [PRODUCTION_NEON_BRANCH, 'staging', 'dev'],
    },
    dnsExpectations: {
      zoneName: matrix.apexDomain ?? null,
      surfaces: dnsSurfaces,
    },
  };
}

function formatRow(entry) {
  const marker =
    entry.status === 'met'
      ? 'PASS'
      : entry.status === 'unmet'
        ? 'FAIL'
        : entry.status === 'operator-required'
          ? 'OPER'
          : 'N/A ';
  return `${marker}  ${entry.gate}\n      ${entry.label}: ${entry.reason}`;
}

async function main(argv) {
  const [statePath, repoRootArg] = argv;
  if (!statePath) {
    stderr.write(
      'usage: node tests/cloud/scripts/check-production-provisioning-state.mjs <state-file> [<repo-root>]\n',
    );
    return 2;
  }

  const repoRoot = resolve(repoRootArg ?? DEFAULTS);
  let state;
  try {
    state = JSON.parse(readFileSync(resolve(statePath), 'utf8'));
  } catch (error) {
    stderr.write(`cannot read the state artifact ${statePath}: ${error.message}\n`);
    return 2;
  }

  const expectations = await loadProductionExpectations(repoRoot);
  const { ok, failures, rows } = evaluateProvisioningState(state, expectations);

  stdout.write(`Production provisioning state — ${state.capturedAt ?? 'no capture time'}\n\n`);
  for (const entry of rows) stdout.write(`${formatRow(entry)}\n\n`);

  if (ok) {
    // An operator obligation backed by a recorded read-back is a CLOSED
    // obligation, not a machine gate: the count has to say which is which,
    // or "all gates are met" would hide an obligation nobody recorded.
    const operatorGates = new Set(OPERATOR_REQUIRED_ROWS.map((entry) => entry.gate));
    const machineMet = rows.filter(
      (entry) => entry.status === 'met' && !operatorGates.has(entry.gate),
    ).length;
    const operatorBacked = rows.filter(
      (entry) => operatorGates.has(entry.gate) && entry.status === 'met',
    ).length;
    const operatorOpen = rows.filter((entry) => entry.status === 'operator-required').length;
    stdout.write(
      `All ${machineMet} machine-verifiable gate(s) are met; ` +
        `${operatorBacked} operator obligation(s) are backed by a recorded read-back` +
        (operatorOpen > 0 ? `; ${operatorOpen} still need operator evidence.` : '.') +
        '\n',
    );
    return 0;
  }

  stdout.write(`${failures.length} gate(s) are not met:\n`);
  for (const entry of failures) {
    stdout.write(`  - ${entry.gate} [${entry.step}, owner: ${entry.owner}]: ${entry.reason}\n`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => exit(code),
    (error) => {
      stderr.write(`${error?.stack ?? error}\n`);
      exit(2);
    },
  );
}
