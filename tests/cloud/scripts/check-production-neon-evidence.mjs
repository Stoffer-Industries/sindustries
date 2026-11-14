#!/usr/bin/env node
// check-production-neon-evidence.mjs — task fb1240c0 (Slice D preparation)
// AC2 evidence gate.
//
// The production Neon treatment — the branch, its three schemas, the
// service roles that carry the DSNs, and the connectivity restriction —
// exists NOWHERE in this repository before this check: the manifest owns
// the schema NAMES, the source contract owns the secret NAMES, and nothing
// owns the roles or the restriction. AC2 asks for a production Neon branch
// that is "separated from staging/dev data, with connectivity restricted to
// production services", and the design's Slice D step 2 asks the operator to
// "prove staging/dev roles cannot connect to production". Both are
// unprovable while the expected shape is unwritten: the operator captures
// whatever the console happens to show, and the reviewer reads prose.
//
// This check is that shape, written down and enforced. The operator captures
// a REDACTED evidence artifact (names, flags and counts only — never a
// value) and this checker decides whether it proves AC2. It fails closed:
// an absent field, a missing schema, a read-only role, an empty IP
// allowlist, a staging role that could still connect, or a value-shaped
// credential in the artifact all fail with a named reason.
//
// The expected schema set is read from the environment manifest — the
// single source of truth — so the evidence cannot prove a shape the
// production environment does not actually use.
//
// Pure Node, no deps. Exits 0 when the evidence satisfies the contract, 1
// on any violation, 2 on a usage error.
//
// Usage:
//   node tests/cloud/scripts/check-production-neon-evidence.mjs <evidence-file> [<repo-root>]
//
// Default repo-root: three parents up from this script.

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

/**
 * Branch names that cannot be the production branch. Matched as WORDS on
 * hyphen/underscore boundaries, so `production` passes and
 * `production-staging` does not.
 */
const NON_PRODUCTION_BRANCH_MARKERS = [
  'staging',
  'dev',
  'test',
  'testing',
  'sandbox',
  'uat',
  'demo',
  'preview',
  'local',
];

/** Keys whose VALUE would carry a credential if it were ever populated. */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|dsn|connection_?string|credential|private_?key|api_?key)/i;

/** Value shapes that are credentials regardless of the key they sit under. */
const SECRET_VALUE_PATTERNS = [
  { name: 'a credential-bearing connection URL', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s]*@/i },
  { name: 'a JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** Paths that are allowed to carry the word "secret" in a NON-value sense. */
const SECRET_KEY_EXCEPTIONS = new Set(['redaction.containsSecretValues']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Require a date-time, not a bare date, and an explicit timezone.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
}

/**
 * Find a non-production environment marker in a branch name.
 *
 * @param {string} value
 * @returns {string|null} the marker, or null when the name is clean
 */
export function findNonProductionMarker(value) {
  if (!isNonEmptyString(value)) return null;
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return NON_PRODUCTION_BRANCH_MARKERS.find((marker) => words.includes(marker)) ?? null;
}

/**
 * Collect the JSON PATHS of anything in the artifact that looks like a
 * credential value. Paths only — a value is never echoed.
 *
 * @param {unknown} node
 * @param {string[]} [path]
 * @returns {string[]}
 */
export function findSecretValuePaths(node, path = []) {
  const found = [];
  if (Array.isArray(node)) {
    node.forEach((entry, index) => found.push(...findSecretValuePaths(entry, [...path, `[${index}]`])));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const childPath = [...path, key];
      if (SECRET_KEY_PATTERN.test(key) && !SECRET_KEY_EXCEPTIONS.has(childPath.join('.'))) {
        if (typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== false) {
          found.push(childPath.join('.'));
        }
      }
      found.push(...findSecretValuePaths(value, childPath));
    }
    return found;
  }
  if (typeof node === 'string') {
    for (const { pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(node)) {
        found.push([...path, '<value>'].join('.'));
        break;
      }
    }
  }
  return found;
}

/**
 * Decide whether a redacted evidence artifact proves the production Neon
 * treatment AC2 asks for.
 *
 * @param {unknown} evidence the parsed artifact
 * @param {{expectedSchemas?: string[]}} [options]
 * @returns {{ok: boolean, failures: {code: string, message: string}[]}}
 */
export function evaluateNeonEvidence(evidence, options = {}) {
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      ok: false,
      failures: [{ code: 'evidence_not_an_object', message: 'the evidence must be a JSON object' }],
    };
  }

  if (evidence.environment !== 'production') {
    fail(
      'environment_not_production',
      `environment must be "production", read ${JSON.stringify(evidence.environment ?? null)}`,
    );
  }

  if (!isIsoTimestamp(evidence.capturedAt)) {
    fail(
      'captured_at_not_iso8601',
      `capturedAt must be an ISO-8601 timestamp with a timezone, read ${JSON.stringify(evidence.capturedAt ?? null)}`,
    );
  }

  const database = evidence.database && typeof evidence.database === 'object' ? evidence.database : {};
  if (!isNonEmptyString(database.project)) {
    fail('database_project_missing', 'database.project must name the Neon project');
  }
  if (!isNonEmptyString(database.branch)) {
    fail('database_branch_missing', 'database.branch must name the Neon branch');
  } else {
    const marker = findNonProductionMarker(database.branch);
    if (marker) {
      fail(
        'database_branch_not_production',
        `database.branch ${JSON.stringify(database.branch)} carries the non-production marker "${marker}"`,
      );
    }
  }

  const expectedSchemas = [...(options.expectedSchemas ?? [])];
  const observedSchemas = Array.isArray(database.schemas)
    ? [...new Set(database.schemas.filter(isNonEmptyString))]
    : [];
  if (expectedSchemas.length > 0) {
    const missing = expectedSchemas.filter((schema) => !observedSchemas.includes(schema));
    const unexpected = observedSchemas.filter((schema) => !expectedSchemas.includes(schema));
    if (missing.length > 0) {
      fail('schema_missing', `the evidence does not prove these schemas exist: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      fail(
        'schema_unexpected',
        `the evidence names schemas the production manifest does not define: ${unexpected.join(', ')}`,
      );
    }
  }

  const roles = Array.isArray(evidence.roles) ? evidence.roles : [];
  for (const schema of expectedSchemas) {
    const matching = roles.filter((role) => role && typeof role === 'object' && role.schema === schema);
    if (matching.length === 0) {
      fail('role_missing_for_schema', `no role is recorded for schema "${schema}"`);
      continue;
    }
    if (matching.length > 1) {
      fail(
        'role_ambiguous_for_schema',
        `schema "${schema}" has ${matching.length} roles; the contract is exactly one role per schema`,
      );
    }
    for (const role of matching) {
      if (!isNonEmptyString(role.name)) {
        fail('role_name_missing', `the role for schema "${schema}" has no name`);
      }
      if (role.canLogin !== true) {
        fail('role_not_login_capable', `the role for schema "${schema}" is not marked canLogin`);
      }
      if (role.canWrite !== true) {
        fail(
          'role_not_write_capable',
          `the role for schema "${schema}" is not marked canWrite; the platform database sources are write-capable`,
        );
      }
    }
  }
  const roleSchemas = roles
    .map((role) => (role && typeof role === 'object' ? role.schema : null))
    .filter(isNonEmptyString);
  const strayRoleSchemas = [...new Set(roleSchemas.filter((schema) => !expectedSchemas.includes(schema)))];
  if (strayRoleSchemas.length > 0) {
    fail(
      'role_for_unexpected_schema',
      `the evidence records roles for schemas the production manifest does not define: ${strayRoleSchemas.join(', ')}`,
    );
  }

  const connectivity =
    evidence.connectivity && typeof evidence.connectivity === 'object' ? evidence.connectivity : {};
  if (connectivity.ipAllowlistConfigured !== true) {
    fail(
      'ip_allowlist_not_configured',
      'connectivity.ipAllowlistConfigured must be true: production must not be reachable from an unrestricted network',
    );
  }
  if (!Number.isInteger(connectivity.ipAllowlistEntryCount) || connectivity.ipAllowlistEntryCount < 1) {
    fail(
      'ip_allowlist_empty',
      'connectivity.ipAllowlistEntryCount must be an integer of at least 1',
    );
  }
  if (connectivity.stagingRoleConnectDenied !== true) {
    fail(
      'staging_role_not_denied',
      'connectivity.stagingRoleConnectDenied must be true: AC2 requires proof that a staging role cannot connect to production',
    );
  }
  if (connectivity.devRoleConnectDenied !== true) {
    fail(
      'dev_role_not_denied',
      'connectivity.devRoleConnectDenied must be true: AC2 requires proof that a dev role cannot connect to production',
    );
  }

  const redaction =
    evidence.redaction && typeof evidence.redaction === 'object' ? evidence.redaction : {};
  if (redaction.containsSecretValues !== false) {
    fail(
      'redaction_not_declared',
      'redaction.containsSecretValues must be false: the evidence is committed to a public repository',
    );
  }

  const leaks = findSecretValuePaths(evidence);
  if (leaks.length > 0) {
    fail(
      'evidence_contains_secret_values',
      `the evidence carries credential-shaped data at: ${leaks.join(', ')} (paths only; no value is printed)`,
    );
  }

  return { ok: failures.length === 0, failures };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { usage: true, evidencePath: null, repoRoot: DEFAULTS };
  }
  if (args[0] === '--help' || args[0] === '-h') {
    return { usage: true, evidencePath: null, repoRoot: DEFAULTS };
  }
  const evidencePath = resolve(args[0]);
  const repoRoot = resolve(args[1] ?? DEFAULTS);
  return { usage: false, evidencePath, repoRoot };
}

async function loadProductionSchemas(repoRoot) {
  const manifestUrl = pathToFileURL(
    join(repoRoot, 'infra/cloud/platform/platform-environments.mjs'),
  ).href;
  const manifest = await import(manifestUrl);
  const production = manifest.PLATFORM_ENVIRONMENTS?.production;
  if (!production?.schemas) {
    throw new Error(
      `the production environment manifest at ${repoRoot} does not define production schemas`,
    );
  }
  return Object.values(production.schemas).filter(isNonEmptyString);
}

export async function main(argv = process.argv) {
  const { usage, evidencePath, repoRoot } = parseArgs(argv);
  if (usage) {
    stdout.write(
      'Usage: node tests/cloud/scripts/check-production-neon-evidence.mjs <evidence-file> [<repo-root>]\n',
    );
    return 2;
  }

  let raw;
  try {
    raw = readFileSync(evidencePath, 'utf8');
  } catch (error) {
    stderr.write(`[check-production-neon-evidence] cannot read ${evidencePath}: ${error.message}\n`);
    return 1;
  }

  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch (error) {
    stderr.write(`[check-production-neon-evidence] ${evidencePath} is not valid JSON: ${error.message}\n`);
    return 1;
  }

  let expectedSchemas;
  try {
    expectedSchemas = await loadProductionSchemas(repoRoot);
  } catch (error) {
    stderr.write(`[check-production-neon-evidence] ${error.message}\n`);
    return 1;
  }

  const { ok, failures } = evaluateNeonEvidence(evidence, { expectedSchemas });
  if (ok) {
    stdout.write(
      `[check-production-neon-evidence] OK — evidence proves the production Neon treatment ` +
        `(${expectedSchemas.length} schemas, one write-capable role per schema, restricted connectivity).\n`,
    );
    return 0;
  }

  stderr.write('[check-production-neon-evidence] FAILED\n');
  for (const failure of failures) {
    stderr.write(`  - ${failure.code}: ${failure.message}\n`);
  }
  return 1;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await main(process.argv);
  exit(code);
}
