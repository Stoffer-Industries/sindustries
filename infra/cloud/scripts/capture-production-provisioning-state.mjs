#!/usr/bin/env node
// capture-production-provisioning-state.mjs — task fb1240c0 (Slice D)
// Read-only capture of the production provisioning state.
//
// WHY THIS EXISTS
//
// The approved design (§5, Slice D) lists the live evidence this task must
// produce, and the repository owned none of the capture path: every heartbeat
// re-read four provider APIs by hand and wrote the result into prose. A prose
// observation cannot be compared between runs, cannot fail CI, and cannot
// tell a reviewer which of the nine Slice D steps is still open.
//
// This script is that capture path. It performs READ-ONLY requests against
// the production control planes — Neon, Fly (including its managed Upstash
// add-on), the GitHub `production` Environment and Cloudflare DNS — and
// writes a REDACTED artifact:
// names, flags, counts and one-way host fingerprints only. It never writes a
// credential value. It creates nothing,
// changes nothing, and deletes nothing; there is no mutation call anywhere in
// this file.
//
// The Cloudflare read is the AC3 read-back: the design's Slice D step 8
// ("Create only the production API DNS records and Fly certificates") and
// AC3's verification both rest on "the Cloudflare read-back shows only the
// production API records changed, and the staging hostnames keep their prior
// targets". Before this slice, AC3 was the one acceptance criterion whose
// live evidence the repository had no way to capture.
//
// The artifact is then decided by
// `tests/cloud/scripts/check-production-provisioning-state.mjs`, which fails
// closed on an unmet gate and names the owner of the open step.
//
// The artifact also carries WHEN production became publicly exposed: the
// Cloudflare record's creation time and the production health-probe app's
// release time. The approved design makes the production spend bound a
// hard gate BEFORE any public exposure, so the checker has to compare the
// bound's read-back time with the exposure time. Without those timestamps
// the order could only be asserted in prose, never checked.
//
// Usage:
//   node infra/cloud/scripts/capture-production-provisioning-state.mjs [--out <path>]
//        [--repo-root <path>] [--neon-project <name>]
//        [--github-repo <owner/name>] [--github-environment <name>]
//        [--operator-evidence <path>]
//
// The operator read-backs (the five obligations no machine can prove) are
// merged into the artifact from the committed operator-evidence JSON file.
// The capture performs no read for them: they are facts only the operator
// can observe. The committed file is the default; --operator-evidence
// overrides it for a one-off capture.
// The file carries a boolean, a read-back time, a POINTER to the
// read-back and the production surfaces it covered — never a value.
// Credentials (read from the environment, never from a file in the repo):
//   NEON_API_KEY          Neon management API
//   FLY_API_TOKEN         Fly GraphQL API
//   GITHUB_TOKEN          GitHub API (falls back to `gh auth token`)
//   CLOUDFLARE_API_TOKEN  Cloudflare DNS API (zone records read)
//
// The artifact also carries the FLY SOURCE ADDRESSES of the production
// Neon allowlist: the app-scoped static egress IPs allocated to each
// production app, and the Neon project's allowlist entries — both reduced
// to fingerprints. The Neon contract names those allocations as the
// allowlist's source, but nothing read them, so the allowlist gate could
// name the Neon account plan as the blocker while the addresses it would
// have to list did not exist.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROBE_TARGET_KEYS,
  hostFingerprint,
  hostOfTargetValue,
} from '../platform/probe-target-facts.mjs';
import {
  fingerprintIpSet,
  isIpv6Address,
} from '../platform/egress-allowlist-facts.mjs';
import { validateOperatorEvidence } from '../platform/production-operator-evidence.mjs';

const REPO_ROOT_DEFAULT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

const DEFAULT_OPERATOR_EVIDENCE_PATH = 'infra/cloud/evidence/production-operator-evidence.json';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const FLY_GRAPHQL_ENDPOINT = 'https://api.fly.io/graphql';
const FLY_MACHINES_API_BASE = 'https://api.machines.dev';

/**
 * The health-probe cadence keys the capture reads (task fb1240c0, AC6).
 *
 * Only these two keys are ever read out of an app's deployed environment.
 * The Machines API returns every environment variable the app carries, and
 * the production health-probe app's environment also holds the production
 * database and Redis URLs. Recording the whole map would write
 * credential-shaped values into an artifact that is committed, compared
 * between runs and pasted into a task comment, so the capture names the
 * keys it needs and drops everything else AT THE READ.
 *
 * The cadence is the AC6 evidence: the repository already declares the
 * production values (the production health-probe overlay) and asserts they
 * are tighter than the staging daily cadence, but nothing proved that the
 * DEPLOYED production probe carries them. A production probe left at the
 * staging 86400s would pass every check the repository owned while watching
 * nothing.
 */
const PROBE_CADENCE_KEYS = ['FLY_APP_PROBE_INTERVAL_SECONDS', 'DB_PROBE_INTERVAL_SECONDS'];

/**
 * The deployed platform app's CONFIGURATION keys (task fb1240c0, AC1/AC4).
 *
 * FLY MASKS SECRETS. The Machines API returns an app's NON-SECRET
 * environment only, so the deployed database and Redis URLs — which are Fly
 * secrets — are not readable at all (verified 2026-11-16 against the
 * staging platform app: its Machine carries nine plain values and none of
 * the `PLATFORM_*` secret names). The plain `[env]` values the platform
 * config declares ARE readable, and they are exactly the ones that say
 * WHICH environment the running app was deployed as.
 *
 * Without them a production platform app deployed from the shared staging
 * config passes every other gate the repository owns: the app exists, it
 * has a release, it carries the right secret NAMES — and it still serves
 * staging's environment id, staging's CORS allow-lists and staging's
 * process group. These are the values that say otherwise.
 */
const PLATFORM_CONFIG_KEYS = [
  'FLY_PROCESS_GROUP',
  'PLATFORM_ENVIRONMENT_ID',
  'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
];

/**
 * The CORS allow-list keys — the configuration values that are LISTS of
 * origins rather than single values.
 */
const PLATFORM_CORS_KEYS = [
  'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
];

/**
 * The shape a CORS origin must have to be recorded.
 *
 * Only an https origin with a host (and an optional port) is kept. A
 * value that is anything else — a path, a query, userinfo, a scheme the
 * platform does not serve — is DROPPED and counted, so an arbitrary
 * operator-supplied string can never ride into an artifact that is
 * committed, compared between runs and pasted into a task comment.
 *
 * The origins themselves are public hostnames: the manifest and the Fly
 * config already publish them, so they are recorded plainly — unlike the
 * probe's targets, which are secrets and are recorded as fingerprints.
 */
const ORIGIN_SHAPE = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

const GITHUB_API_BASE = 'https://api.github.com';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

function parseArgs(argv) {
  const options = {
    out: null,
    repoRoot: REPO_ROOT_DEFAULT,
    neonProject: null,
    githubRepo: 'Stoffer-Industries/sindustries',
    githubEnvironment: 'production',
    operatorEvidence: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--out':
        options.out = value;
        index += 1;
        break;
      case '--repo-root':
        options.repoRoot = resolve(value);
        index += 1;
        break;
      case '--neon-project':
        options.neonProject = value;
        index += 1;
        break;
      case '--github-repo':
        options.githubRepo = value;
        index += 1;
        break;
      case '--github-environment':
        options.githubEnvironment = value;
        index += 1;
        break;
      case '--operator-evidence':
        options.operatorEvidence = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Resolve the operator-evidence input for a capture.
 *
 * The committed evidence record is the default so a normal capture carries
 * the read-backs that have already been recorded in the repository. An
 * explicit --operator-evidence path wins for a one-off capture against a
 * different record.
 *
 * @param {{repoRoot: string, operatorEvidence?: string|null}} options
 * @returns {string}
 */
export function resolveOperatorEvidencePath(options) {
  if (options.operatorEvidence) return resolve(options.operatorEvidence);
  return join(options.repoRoot, DEFAULT_OPERATOR_EVIDENCE_PATH);
}

/**
 * Resolve the operator-evidence input that a capture should merge.
 *
 * The committed record is used when present. An explicit path is always
 * used so a missing or malformed override is refused rather than silently
 * falling back to the committed record.
 *
 * @param {{repoRoot: string, operatorEvidence?: string|null}} options
 * @returns {string|null}
 */
export function resolveOperatorEvidenceInput(options) {
  if (options.operatorEvidence) return resolveOperatorEvidencePath(options);
  const committedPath = resolveOperatorEvidencePath(options);
  return existsSync(committedPath) ? committedPath : null;
}

/**
 * Read the operator's read-backs from a file.
 *
 * The file is operator-owned and holds NO values: a boolean, a read-back
 * time, a pointer to the read-back and the production surfaces it covered.
 * A file that cannot be read, or that
 * carries a shape the checker would reject, is REFUSED rather than
 * dropped: a silently dropped read-back turns a recorded spend limit into
 * an unrecorded one and flips the ordering gate red with no explanation.
 *
 * @param {string} path
 * @param {{capturedAt?: string, repoRoot?: string}} [options] artifact context
 *   for cross-field checks; `capturedAt` bounds when a read-back may have
 *   happened and `repoRoot` makes every recorded pointer inspectable
 * @returns {{evidence: object|null, problems: string[]}}
 */
export function loadOperatorEvidence(path, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      evidence: null,
      problems: [`cannot read the operator evidence file ${path}: ${error.message}`],
    };
  }
  // The pointer is resolved inside the repository, so the root defaults to
  // the checkout this script lives in: a read-back that names a file in the
  // repository is inspectable without the caller having to know where the
  // repository is.
  const validation = validateOperatorEvidence(parsed, {
    ...options,
    repoRoot: options.repoRoot ?? REPO_ROOT_DEFAULT,
  });
  if (!validation.ok) {
    return { evidence: null, problems: validation.problems };
  }
  if (!validation.present) {
    return {
      evidence: null,
      problems: ['the operator evidence file records no operator evidence'],
    };
  }
  return { evidence: parsed, problems: [] };
}

/**
 * A provider read that failed is recorded, never thrown away.
 *
 * The artifact says "not captured" with the reason, and the checker turns
 * that into an unmet gate. A silent skip would make an unreadable provider
 * look like a satisfied one.
 */
function failure(reason) {
  return { captured: false, error: reason };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Is this branch part of the PRODUCTION environment?
 *
 * The cutover's source, destination and recovery databases must all be
 * PRODUCTION databases. A staging database cannot serve as the
 * destination: the harness's endpoint allowlist is operator-declared, so
 * a staging host that is declared passes the allowlist, and production
 * data would be restored into a staging database.
 *
 * The rule is a NAME rule because the capture already identifies the
 * production branch by name. It also lets an operator put the
 * destination and recovery databases on a DEDICATED production branch
 * (`production-cutover`) instead of adding databases to the live one.
 */
export function isProductionEnvironmentBranch(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  return normalized === 'production' || normalized.startsWith('production-');
}

/**
 * Read the DISTINCT databases the PRODUCTION branches serve.
 *
 * The production cutover needs three databases that are not the same
 * database: the SOURCE, a DESTINATION that is empty before the restore,
 * and a RECOVERY database that the destination's archive is restored into
 * and reconciled against. The workflow refuses a source and a destination
 * that share a host, and a recovery database that IS the destination
 * would make the reconcile compare a database with itself — evidence
 * that looks green and proves nothing.
 *
 * A database is identified by its endpoint host, so the count of distinct
 * endpoint hosts across the production branches is the count of databases
 * the cutover can choose between. It is a CAPACITY count, not a topology
 * claim: the gate that uses it asks whether three databases exist, not
 * which database plays which role.
 *
 * A branch whose endpoints cannot be read is recorded as a READ ERROR, not
 * as a branch with no databases: an unreadable branch makes the count a
 * lower bound, and a lower bound must never read as "the databases exist".
 *
 * @param {string} projectId
 * @param {Array<{id?: string, name?: string}>} branches
 * @param {string} apiKey
 * @returns {Promise<{captured: boolean, hostFingerprints: string[], readError: string|null, branchCount: number}>}
 */
export async function readNeonProductionDatabases(projectId, branches, apiKey) {
  const productionBranches = (Array.isArray(branches) ? branches : []).filter((branch) =>
    isProductionEnvironmentBranch(branch?.name),
  );

  const hostFingerprints = [];
  let readError = null;

  for (const branch of productionBranches) {
    const result = await readNeonBranchEndpointFingerprints(projectId, branch?.id, apiKey);
    if (!result.captured) {
      readError ??= `the endpoints of branch ${branch?.name ?? 'unknown'} could not be read: ${result.error}`;
      continue;
    }
    for (const fingerprint of result.hostFingerprints) {
      if (!hostFingerprints.includes(fingerprint)) hostFingerprints.push(fingerprint);
    }
  }

  return {
    captured: readError === null,
    hostFingerprints,
    readError,
    branchCount: productionBranches.length,
  };
}

/**
 * Read the FINGERPRINTS of the hosts that serve the named Neon branch.
 *
 * WHY THIS EXISTS
 *
 * The Neon v2 API does not put a branch's host on the BRANCH. It puts it
 * on the branch's ENDPOINTS — a separate resource, reached at
 * `/projects/{id}/branches/{branch_id}/endpoints`, which answers with
 * `host` and `hosts.read_write_host`. The branch resource answers with
 * ids, state, compute and protection fields and NO `host` at all.
 *
 * A capture that reads `branch.host` therefore reads a field the API
 * never sends: the value is always undefined, so the branch's host
 * fingerprint is always null, so the AC6 "the deployed probe points at
 * the production database" gate carries an empty expectation set and can
 * never be met — not because the environment is wrong, but because the
 * capture read the wrong resource. Nothing in the repository can tell
 * that apart from a real deployment failure, because a missing field and
 * a missing database look exactly the same in the artifact.
 *
 * The fingerprints are what the artifact carries: the host itself is a
 * production database endpoint and must not reach an artifact that is
 * committed and pasted into task comments.
 *
 * The read failures are kept apart, because they name different owners:
 * a read that failed (the provider could not be looked at) and a branch
 * that serves no endpoint (there is nothing serving it). Collapsing them
 * would blame the operator for a read the capture never managed.
 *
 * @param {string} projectId
 * @param {string} branchId
 * @param {string} apiKey
 * @returns {Promise<{captured: boolean, hostFingerprints?: string[], error?: string}>}
 */
export async function readNeonBranchEndpointFingerprints(projectId, branchId, apiKey) {
  if (!projectId || !branchId) {
    return {
      captured: false,
      error: 'no Neon project or branch id was supplied, so no endpoint host could be read',
    };
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  let response;
  try {
    response = await fetchJson(
      `${NEON_API_BASE}/projects/${projectId}/branches/${branchId}/endpoints`,
      { headers },
    );
  } catch (error) {
    return { captured: false, error: error.message };
  }
  const endpoints = Array.isArray(response?.endpoints) ? response.endpoints : [];
  const hostFingerprints = [];
  for (const endpoint of endpoints) {
    const host = endpoint?.host ?? endpoint?.hosts?.read_write_host ?? null;
    const fingerprint = hostFingerprint(host);
    // The direct and the pooled host of one endpoint are the same
    // database, so they share one fingerprint; a branch serving several
    // endpoints contributes each of them, because the probe may target
    // any endpoint of the production branch.
    if (fingerprint && !hostFingerprints.includes(fingerprint)) hostFingerprints.push(fingerprint);
  }
  return { captured: true, hostFingerprints };
}

async function captureNeon({ projectName }) {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return failure('NEON_API_KEY is not set');

  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    const organizations = await fetchJson(`${NEON_API_BASE}/users/me/organizations`, { headers });
    const orgs = organizations?.organizations ?? [];
    const organization =
      orgs.find((org) => /stoffer/i.test(String(org?.name ?? ''))) ?? orgs[0];
    if (!organization) return failure('the Neon account has no organization');

    const projectsResponse = await fetchJson(
      `${NEON_API_BASE}/projects?org_id=${encodeURIComponent(organization.id)}`,
      { headers },
    );
    const projects = projectsResponse?.projects ?? [];
    if (projects.length === 0) return failure('the Neon organization has no project');

    let project =
      projectName ? projects.find((entry) => entry?.name === projectName) : undefined;
    if (!project && !projectName) {
      // Prefer the project that actually carries a production branch.
      for (const candidate of projects) {
        const branches = await fetchJson(
          `${NEON_API_BASE}/projects/${candidate.id}/branches`,
          { headers },
        );
        if ((branches?.branches ?? []).some((branch) => branch?.name === 'production')) {
          project = candidate;
          break;
        }
      }
    }
    project ??= projects[0];

    const projectDetail = await fetchJson(`${NEON_API_BASE}/projects/${project.id}`, { headers });
    const settings = projectDetail?.project?.settings ?? projectDetail?.settings ?? {};
    const allowedIps = settings?.allowed_ips?.ips ?? [];

    const branchesResponse = await fetchJson(
      `${NEON_API_BASE}/projects/${project.id}/branches`,
      { headers },
    );
    const productionBranch = (branchesResponse?.branches ?? []).find(
      (branch) => branch?.name === 'production',
    );
    if (!productionBranch) return failure('the Neon project has no production branch');

    const branchDetail = await fetchJson(
      `${NEON_API_BASE}/projects/${project.id}/branches/${productionBranch.id}`,
      { headers },
    );
    const branch = branchDetail?.branch ?? branchDetail ?? productionBranch;

    const rolesResponse = await fetchJson(
      `${NEON_API_BASE}/projects/${project.id}/branches/${productionBranch.id}/roles`,
      { headers },
    );

    const endpointHosts = await readNeonBranchEndpointFingerprints(
      project.id,
      productionBranch.id,
      apiKey,
    );

    // The cutover needs three DISTINCT databases (source, an empty
    // destination, and a recovery database to reconcile against), so the
    // project's whole database inventory is counted — not only the
    // production branch's. The destination and the recovery database may
    // live on either, and a count that only saw the production branch
    // would report a shortfall that provisioning could not fix.
    const productionDatabases = await readNeonProductionDatabases(
      project.id,
      branchesResponse?.branches ?? [],
      apiKey,
    );

    return {
      captured: true,
      organization: {
        id: organization.id,
        name: organization.name,
        plan: organization.plan ?? organization.subscription_plan_id ?? 'unknown',
      },
      project: {
        id: project.id,
        name: project.name,
        allowedIpCount: Array.isArray(allowedIps) ? allowedIps.length : 0,
        // The allowlist ENTRIES, as fingerprints. The count alone cannot be
        // compared with the Fly addresses the contract says the allowlist
        // must carry: two allowlists of the same size can name different
        // addresses. The addresses themselves never reach the artifact.
        allowedIpFingerprints: fingerprintIpSet(allowedIps),
        protectedBranchesOnly: settings?.allowed_ips?.protected_branches_only === true,
        blockPublicConnections: settings?.block_public_connections === true,
        // How many branches the project has, and how many DISTINCT
        // databases those branches serve. The count is what tells the
        // readiness gate whether the destination and recovery databases
        // exist yet — six DSN secrets can be registered against databases
        // that do not exist, and the cutover would fail at the restore.
        branchCount: Array.isArray(branchesResponse?.branches)
          ? branchesResponse.branches.length
          : 0,
        productionBranchCount: productionDatabases.branchCount,
        databaseCount: productionDatabases.hostFingerprints.length,
        // A read that failed is recorded as a REASON, never as a count of
        // zero databases: an unreadable branch makes this a lower bound,
        // and a lower bound must not read as "the databases exist".
        databaseCountReadError: productionDatabases.captured
          ? null
          : productionDatabases.readError,
      },
      branch: {
        id: productionBranch.id,
        name: productionBranch.name,
        state: branch.current_state ?? productionBranch.current_state ?? 'unknown',
        protected: branch.protected === true,
        // The hosts that SERVE the production branch, as FINGERPRINTS. The
        // host itself is a production database endpoint and must not reach
        // an artifact that is committed and pasted into task comments —
        // but the fingerprint is what proves the deployed probe points at
        // THIS branch and not at another environment's database.
        //
        // The hosts come from the branch's ENDPOINTS resource, not from the
        // branch: the Neon v2 branch resource carries no `host` field, so
        // reading it yields a null fingerprint that no amount of correct
        // provisioning could ever change.
        endpointHostFingerprints: endpointHosts.captured
          ? endpointHosts.hostFingerprints
          : [],
        // A read that failed is recorded as a REASON, never as an empty
        // list: "the endpoint hosts could not be read" and "the branch
        // serves no endpoint" name different owners, and an empty list
        // would silently become the second one.
        endpointHostsReadError: endpointHosts.captured ? null : endpointHosts.error,
      },
      roleNames: (rolesResponse?.roles ?? []).map((role) => role?.name).filter(Boolean),
    };
  } catch (error) {
    return failure(error.message);
  }
}

/**
 * Read the secret NAMES registered on a Fly app.
 *
 * The GraphQL API cannot answer this. It replies `secrets: []` for an app
 * that does carry secrets — verified against the staging platform app on
 * 2026-11-16, where the Machines API lists the registered names and
 * GraphQL lists none — so a GraphQL read would report "no secrets" for an
 * app that has them. A capture built on it would make the Slice D step 5
 * gate report a fact that is simply not true.
 *
 * The Machines API answers with the real inventory: a name, a digest and
 * timestamps per secret. Only the NAMES are kept. Fly never returns a
 * value, and this artifact carries names, flags and counts only — a
 * digest is neither, so the digest read-back stays an operator step
 * (`flyctl secrets list` prints it next to each name).
 *
 * The read never throws. A failure is recorded as a reason so the gate can
 * name it; an unreadable inventory must not be reported as an empty one.
 *
 * @param {string} app
 * @param {string} apiToken
 * @returns {Promise<{secretNames: string[]|null, inventoryReadError?: string}>}
 */
export async function readFlySecretNames(app, apiToken) {
  try {
    const response = await fetch(
      `${FLY_MACHINES_API_BASE}/v1/apps/${encodeURIComponent(app)}/secrets`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (response.status === 404) {
      return {
        secretNames: null,
        inventoryReadError: 'the Fly app does not exist, so it carries no secret inventory',
      };
    }
    if (!response.ok) {
      return {
        secretNames: null,
        inventoryReadError: `the secret inventory could not be read (HTTP ${response.status})`,
      };
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.secrets)) {
      return {
        secretNames: null,
        inventoryReadError: 'the secret inventory response carried no secrets array',
      };
    }
    const names = payload.secrets
      .map((secret) => secret?.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
      .sort();
    return { secretNames: names };
  } catch (error) {
    return {
      secretNames: null,
      inventoryReadError: `the secret inventory could not be read (${error.message})`,
    };
  }
}

/**
 * Fetch the Machine inventory of a Fly app from the Machines API.
 *
 * This is the AUTHORITATIVE answer to "does this app exist, and is
 * anything deployed on it": the API answers 404 for an app that does not
 * exist, so the answer does not depend on a listing that could be
 * truncated. The organisation listing GraphQL offers is capped at 50 apps
 * per organisation, and an app beyond the cap never appears in it — so a
 * presence read from that listing is a presence read from a truncated
 * list, and an app that exists would be reported as one that does not.
 *
 * The three failure modes are kept apart, because they name different
 * owners: an app that does not exist (the operator has not created it), a
 * read that failed (the provider could not be looked at), and an app with
 * no Machine (there is nothing deployed to read). Collapsing them would
 * blame the operator for a read the capture never managed.
 *
 * The Machines API answers this path with a BARE ARRAY of machines
 * (verified 2026-11-16 against the staging health-probe app); the object
 * form (`{ machines: [...] }`) is accepted as well. Anything else is an
 * unreadable read, never an empty Machine list.
 *
 * @param {string} app
 * @param {string} apiToken
 * @returns {Promise<{read: boolean, missing: boolean, machines: object[], error?: string}>}
 */
export async function fetchFlyMachines(app, apiToken) {
  if (!app) {
    return {
      read: false,
      missing: false,
      machines: [],
      error: 'no Fly app name was supplied, so no Machine inventory could be read',
    };
  }
  try {
    const response = await fetch(
      `${FLY_MACHINES_API_BASE}/v1/apps/${encodeURIComponent(app)}/machines`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (response.status === 404) {
      return {
        read: false,
        missing: true,
        machines: [],
        error: `the Fly app ${app} does not exist, so it carries no Machine`,
      };
    }
    if (!response.ok) {
      return {
        read: false,
        missing: false,
        machines: [],
        error: `the Machine inventory of the Fly app ${app} could not be read (HTTP ${response.status})`,
      };
    }
    const payload = await response.json();
    const machines = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.machines)
        ? payload.machines
        : null;
    if (!machines) {
      return {
        read: false,
        missing: false,
        machines: [],
        error: `the Machine inventory read of the Fly app ${app} carried no machines`,
      };
    }
    return { read: true, missing: false, machines };
  } catch (error) {
    return {
      read: false,
      missing: false,
      machines: [],
      error: `the Machine inventory of the Fly app ${app} could not be read (${error.message})`,
    };
  }
}

/**
 * Read the deployment state of a Fly app as facts, not as a guess.
 *
 * `exists` is the fact the AC1 gate needs and it has three values, not
 * two: `true` (the app exists), `false` (it does not) and `null` (the read
 * could not be made). An unreadable read is never an absent app — that
 * confusion is how a provider failure turns into an accusation against the
 * operator.
 *
 * Only the Machine STATES are kept. The Machine objects carry the deployed
 * environment, which holds credential-shaped values, and nothing but the
 * state may reach the artifact.
 *
 * @param {string} app
 * @param {string} apiToken
 * @returns {Promise<{exists: boolean|null, machineStates: string[], machineCount: number, error?: string}>}
 */
export async function readFlyAppMachines(app, apiToken) {
  const inventory = await fetchFlyMachines(app, apiToken);
  if (!inventory.read) {
    return {
      exists: inventory.missing ? false : null,
      machineStates: [],
      machineCount: 0,
      error: inventory.error,
    };
  }
  const machineStates = inventory.machines.map((machine) =>
    typeof machine?.state === 'string' ? machine.state : 'unknown',
  );
  return { exists: true, machineStates, machineCount: inventory.machines.length };
}

/**
 * Read the deployed environment values of the named keys from a Fly app.
 *
 * The read is deliberately narrow: only the requested keys are kept, so the
 * artifact can never carry a value the capture did not name. Everything
 * else the API answers is dropped here.
 *
 * The three failure modes are kept apart, because they name different
 * owners: an app that does not exist (the operator has not created it), a
 * read that failed (the provider could not be looked at), and an app with
 * no Machine (there is nothing deployed to read an environment from).
 * Collapsing them into "no environment" would blame the operator for a
 * read the capture never managed.
 *
 * @param {string} app
 * @param {string} apiToken
 * @param {string[]} keys the only keys to read and record
 * @returns {Promise<{captured: boolean, env?: object, conflictingKeys?: string[], machineCount?: number, error?: string}>}
 */
export async function readFlyAppEnv(app, apiToken, keys) {
  if (!app) {
    return { captured: false, error: 'no Fly app name was supplied, so no environment could be read' };
  }
  const inventory = await fetchFlyMachines(app, apiToken);
  if (!inventory.read) {
    return { captured: false, error: inventory.error };
  }
  if (inventory.machines.length === 0) {
    return {
      captured: false,
      error: `the Fly app ${app} carries no Machine, so its deployed environment cannot be read`,
    };
  }
  const machines = inventory.machines;

  try {
    const values = new Map();
    for (const machine of machines) {
      const env = machine?.config?.env;
      if (!env || typeof env !== 'object') continue;
      for (const key of keys) {
        const value = env[key];
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        if (!values.has(key)) values.set(key, new Set());
        values.get(key).add(String(value));
      }
    }

    const env = {};
    const conflictingKeys = [];
    for (const key of keys) {
      const seen = values.get(key);
      // An absent key stays absent: "the app does not carry this variable"
      // is a different fact from "the read could not look".
      if (!seen || seen.size === 0) continue;
      // Machines that disagree are a real state (a rolling deploy with two
      // generations), and the gate must not pick a winner.
      if (seen.size > 1) {
        conflictingKeys.push(key);
        continue;
      }
      env[key] = [...seen][0];
    }

    return { captured: true, env, conflictingKeys, machineCount: machines.length };
  } catch (error) {
    return {
      captured: false,
      error: `the deployed environment of the Fly app ${app} could not be read (${error.message})`,
    };
  }
}

/**
 * Read the DEPLOYED probe's target fingerprints from its public metrics.
 *
 * AC6 says the production health probe must be "pointed at the new
 * production targets". The capture can prove the deployed cadence; it
 * could not prove where the probe looks. A production probe carrying the
 * production cadence while still pointed at the staging database and the
 * staging Redis passes every check the repository owns while watching the
 * wrong environment — the same false green the cadence gate exists to
 * remove.
 *
 * Fly deliberately masks secret values from the Machines API: config.env
 * contains only the plain `[env]` block. The probe therefore publishes a
 * value-free info metric derived inside the running process, where the
 * secrets are actually resolved. This reader keeps only the metric's target
 * label, target kind and 16-hex host fingerprint.
 *
 * @param {string} baseUrl
 * @returns {Promise<{captured: boolean, targets?: object, conflictingKeys?: string[], malformedTargets?: number, error?: string}>}
 */
export async function readHealthProbeTargets(baseUrl) {
  if (!baseUrl) {
    return {
      captured: false,
      error: 'no health-probe base URL was supplied, so no deployed target could be read',
    };
  }

  try {
    const metricsUrl = new URL('/metrics', baseUrl).href;
    const response = await fetch(metricsUrl, {
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    const keyForKind = {
      'fly-app': 'HEALTH_PROBE_FLY_APPS',
      database: 'HEALTH_PROBE_DATABASES',
      redis: 'HEALTH_PROBE_REDIS',
    };
    const byKey = new Map();
    let malformed = 0;
    for (const line of body.split('\n')) {
      if (!line.startsWith('sindustries_health_probe_target_info{')) continue;
      const labels = {};
      const block = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
      for (const match of block.matchAll(/([a-z_]+)="((?:\\.|[^"])*)"/g)) {
        labels[match[1]] = match[2]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      const key = keyForKind[labels.kind];
      if (!key || !labels.target || !/^[a-f0-9]{16}$/.test(labels.host_fingerprint ?? '')) {
        malformed += 1;
        continue;
      }
      const byLabel = byKey.get(key) ?? new Map();
      const seen = byLabel.get(labels.target) ?? new Set();
      seen.add(labels.host_fingerprint);
      byLabel.set(labels.target, seen);
      byKey.set(key, byLabel);
    }

    const targets = {};
    const conflictingKeys = new Set();
    for (const key of PROBE_TARGET_KEYS) {
      const byLabel = byKey.get(key);
      // An absent key stays absent: "the probe carries no target list" is a
      // different fact from "the read could not look".
      if (!byLabel) continue;
      const rows = [];
      for (const [label, seen] of byLabel.entries()) {
        // Machines that disagree are a real state (a rolling deploy with
        // two generations) and the gate must not pick a winner.
        if (seen.size > 1) {
          conflictingKeys.add(key);
          continue;
        }
        rows.push({ label, hostFingerprint: [...seen][0] });
      }
      targets[key] = rows;
    }

    return {
      captured: true,
      targets,
      conflictingKeys: [...conflictingKeys],
      malformedTargets: malformed,
      source: metricsUrl,
    };
  } catch (error) {
    return {
      captured: false,
      error: `the deployed health-probe target metrics could not be read (${error.message})`,
    };
  }
}

/**
 * Read the DEPLOYED platform app's CONFIGURATION as facts, not values.
 *
 * AC1 asks whether the production platform app was deployed as the
 * consolidated PRODUCTION platform, and AC4 asks whether its configuration
 * values are the real production ones. The app's existence, its release
 * and its secret NAMES are proved elsewhere in the artifact; none of them
 * says WHICH configuration the running app was deployed with.
 *
 * Only the named plain `[env]` values are read, and the CORS allow-lists
 * are reduced to validated origins at the read. The failure modes are
 * kept apart, because they name different owners: an app that does not
 * exist and an app with no Machine are the operator's to close, while a
 * read that could not be made is the capture's.
 *
 * @param {string} app
 * @param {string} apiToken
 * @returns {Promise<{captured: boolean, reason?: string, environmentId?: string|null, processGroup?: string|null, corsOrigins?: object, conflictingKeys?: string[], malformedOrigins?: number, machineCount?: number, error?: string}>}
 */
export async function readFlyAppPlatformConfig(app, apiToken) {
  if (!app) {
    return {
      captured: false,
      reason: 'unreadable',
      error: 'no Fly app name was supplied, so no deployed configuration could be read',
    };
  }
  const inventory = await fetchFlyMachines(app, apiToken);
  if (!inventory.read) {
    return {
      captured: false,
      reason: inventory.missing ? 'app-missing' : 'unreadable',
      error: inventory.error,
    };
  }
  if (inventory.machines.length === 0) {
    return {
      captured: false,
      reason: 'no-machine',
      error: `the Fly app ${app} carries no Machine, so its deployed configuration cannot be read`,
    };
  }

  try {
    // key -> the set of values seen for that key
    const values = new Map();
    for (const machine of inventory.machines) {
      const env = machine?.config?.env;
      if (!env || typeof env !== 'object') continue;
      for (const key of PLATFORM_CONFIG_KEYS) {
        const value = env[key];
        if (typeof value !== 'string' || value.length === 0) continue;
        if (!values.has(key)) values.set(key, new Set());
        values.get(key).add(value);
      }
    }

    const conflictingKeys = [];
    const config = {};
    for (const key of PLATFORM_CONFIG_KEYS) {
      const seen = values.get(key);
      // An absent key stays absent: "the app does not carry this value"
      // is a different fact from "the read could not look".
      if (!seen || seen.size === 0) continue;
      // Machines that disagree are a real state (a rolling deploy with two
      // generations) and the gate must not pick a winner.
      if (seen.size > 1) {
        conflictingKeys.push(key);
        continue;
      }
      config[key] = [...seen][0];
    }

    const corsOrigins = {};
    let malformedOrigins = 0;
    for (const key of PLATFORM_CORS_KEYS) {
      const raw = config[key];
      if (typeof raw !== 'string') continue;
      const origins = [];
      for (const chunk of raw.split(',')) {
        const entry = chunk.trim();
        if (!entry) continue;
        if (!ORIGIN_SHAPE.test(entry)) {
          malformedOrigins += 1;
          continue;
        }
        origins.push(entry.toLowerCase());
      }
      if (origins.length > 0) corsOrigins[key] = origins;
    }

    return {
      captured: true,
      environmentId:
        typeof config.PLATFORM_ENVIRONMENT_ID === 'string'
          ? config.PLATFORM_ENVIRONMENT_ID
          : null,
      processGroup: typeof config.FLY_PROCESS_GROUP === 'string' ? config.FLY_PROCESS_GROUP : null,
      corsOrigins,
      conflictingKeys,
      malformedOrigins,
      machineCount: inventory.machines.length,
    };
  } catch (error) {
    return {
      captured: false,
      reason: 'unreadable',
      error: `the deployed configuration of the Fly app ${app} could not be read (${error.message})`,
    };
  }
}

/** Read one Fly-managed Upstash add-on without recording its URL/password. */
export async function readFlyRedisAddon(addon, apiToken) {
  if (!addon?.name || !addon?.provider) {
    return { captured: false, exists: false, error: 'the Redis add-on manifest is incomplete' };
  }
  try {
    const response = await fetch(FLY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'query($name: String, $provider: String) { addOn(name: $name, provider: $provider) { name publicUrl status primaryRegion addOnPlan { displayName } organization { slug } } }',
        variables: { name: addon.name, provider: addon.provider },
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error) => error?.message).join('; '));
    }
    const actual = payload?.data?.addOn ?? null;
    if (!actual) return { captured: true, exists: false, name: addon.name };
    return {
      captured: true,
      exists: true,
      name: actual.name ?? null,
      provider: addon.provider,
      organization: actual.organization?.slug ?? null,
      plan: actual.addOnPlan?.displayName ?? null,
      primaryRegion: actual.primaryRegion ?? null,
      status: actual.status ?? null,
      endpointHostFingerprint: hostFingerprint(hostOfTargetValue(actual.publicUrl)),
    };
  } catch (error) {
    return {
      captured: false,
      exists: false,
      name: addon.name,
      error: `the Fly-managed Redis add-on ${addon.name} could not be read (${error.message})`,
    };
  }
}

/**
 * Read an app's APP-SCOPED STATIC EGRESS ADDRESSES.
 *
 * The Neon contract names these as the source of the production Neon
 * allowlist: Fly's shared egress ranges are not a fixed set of
 * addresses, so the allowlist must be built from the addresses Fly
 * allocated to the production apps themselves.
 *
 * The read reports the COUNT, the REGION and the FINGERPRINT of each
 * address — never the address. An app that has allocated nothing and an
 * app whose read failed are different facts, and they name different
 * owners, so they are recorded differently: the second carries a
 * REASON, never an empty count.
 *
 * @param {string} name
 * @param {(body: string) => Promise<object>} query the GraphQL query function
 * @returns {Promise<{captured: boolean, ipv4Count: number, ipv6Count: number, regions: string[], fingerprints: string[], error: string|null}>}
 */
export async function readFlyEgressAddresses(name, query) {
  try {
    const detail = await query(
      `{ app(id: ${JSON.stringify(name)}) { name egressIpAddresses(first: 50) { totalCount nodes { ip region } } } }`,
    );
    const app = detail?.app ?? null;
    if (!app) {
      return {
        captured: false,
        ipv4Count: 0,
        ipv6Count: 0,
        regions: [],
        fingerprints: [],
        error: `the Fly app ${name} does not exist, so its egress addresses cannot be read`,
      };
    }
    const nodes = app.egressIpAddresses?.nodes ?? [];
    const addresses = nodes.map((node) => node?.ip).filter(Boolean);
    const regions = [
      ...new Set(nodes.map((node) => node?.region).filter((region) => typeof region === 'string')),
    ];
    return {
      captured: true,
      ipv4Count: addresses.filter((address) => !isIpv6Address(address)).length,
      ipv6Count: addresses.filter((address) => isIpv6Address(address)).length,
      regions,
      fingerprints: fingerprintIpSet(addresses),
      error: null,
    };
  } catch (error) {
    return {
      captured: false,
      ipv4Count: 0,
      ipv6Count: 0,
      regions: [],
      fingerprints: [],
      error: `the egress addresses of the Fly app ${name} could not be read (${error.message})`,
    };
  }
}

async function captureFly({ platformApp, healthProbeApp, healthProbeBaseUrl, redisAddon }) {
  const apiToken = process.env.FLY_API_TOKEN;
  if (!apiToken) return failure('FLY_API_TOKEN is not set');

  const query = async (body) => {
    const response = await fetch(FLY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: body }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error) => error?.message).join('; '));
    }
    return payload?.data ?? {};
  };

  /**
   * Read one app's current release from the GraphQL API.
   *
   * A per-app query does not depend on any listing, so the release of an
   * app is read the same way whether or not the organisation listing
   * mentions it. The read never throws: an app that does not exist and a
   * read that failed are different facts, and the Machine inventory is what
   * settles which of the two it is.
   *
   * The release's CREATION time is read as well as its version. The
   * approved design makes the production spend bound a hard gate BEFORE
   * any public exposure, so the checker has to know WHEN production became
   * publicly exposed in order to compare that with when the bound was read
   * back. Without a timestamp the ordering could only be asserted, never
   * checked.
   *
   * @param {string} name
   * @returns {Promise<{releaseVersion: number|string|null, releaseCreatedAt: string|null, releaseError: string|null}>}
   */
  const readRelease = async (name) => {
    try {
      const detail = await query(
        `{ app(id: ${JSON.stringify(name)}) { name currentRelease { version createdAt } } }`,
      );
      const app = detail?.app ?? null;
      if (!app) {
        return {
          releaseVersion: null,
          releaseCreatedAt: null,
          releaseError: `the Fly app ${name} has no release`,
        };
      }
      if (!app.currentRelease) {
        return {
          releaseVersion: null,
          releaseCreatedAt: null,
          releaseError: `the Fly app ${name} has no current release`,
        };
      }
      return {
        releaseVersion: app.currentRelease.version ?? null,
        releaseCreatedAt: app.currentRelease.createdAt ?? null,
        releaseError: null,
      };
    } catch (error) {
      return {
        releaseVersion: null,
        releaseCreatedAt: null,
        releaseError: `the release of the Fly app ${name} could not be read (${error.message})`,
      };
    }
  };

  let organizations = [];
  try {
    const data = await query(
      '{ organizations { nodes { id name apps(first: 50) { nodes { name } } } } }',
    );
    organizations = data?.organizations?.nodes ?? [];
  } catch (error) {
    return failure(error.message);
  }

  const organizationFor = (name) => {
    for (const organization of organizations) {
      const names = (organization?.apps?.nodes ?? []).map((app) => app?.name);
      if (names.includes(name)) return organization.name ?? null;
    }
    return null;
  };

  // Every production app is read on its OWN. The organisation listing above
  // is capped at 50 apps per organisation, so an app beyond the cap never
  // appears in it: a presence read from that listing is a presence read
  // from a truncated list, and an app that exists would be reported as one
  // that does not. The Machine inventory answers the same question without
  // a cap, and a per-app release query answers it without a listing at all.
  const apps = [];
  for (const name of [platformApp, healthProbeApp].filter(Boolean)) {
    const machines = await readFlyAppMachines(name, apiToken);
    const release = await readRelease(name);
    const inventory = await readFlySecretNames(name, apiToken);
    const egress = await readFlyEgressAddresses(name, query);
    apps.push({
      name,
      organization: organizationFor(name),
      exists: machines.exists,
      releaseVersion: release.releaseVersion,
      releaseCreatedAt: release.releaseCreatedAt,
      machineStates: machines.machineStates,
      machineCount: machines.machineCount,
      egressAddresses: {
        captured: egress.captured,
        ipv4Count: egress.ipv4Count,
        ipv6Count: egress.ipv6Count,
        regions: egress.regions,
        fingerprints: egress.fingerprints,
        ...(egress.error ? { error: egress.error } : {}),
      },
      ...(release.releaseError ? { releaseError: release.releaseError } : {}),
      ...(machines.error ? { machineInventoryError: machines.error } : {}),
      ...inventory,
    });
  }

  // The secret inventory is read per app above, from the Machines API.
    // It is reported per app because that is where it is true: an app that
    // does not exist has no inventory, and an app whose inventory could
    // not be read has an unreadable one. Collapsing either into "the
    // provider captured no secrets" would hide the difference between an
    // app without secrets and a capture that could not look.
  // The cadence read is its own section, separate from the app inventory:
  // it is the AC6 evidence (the DEPLOYED production probe cadence), and
  // it must be reportable even when the app does not exist.
  const healthProbeEnv = await readFlyAppEnv(
    healthProbeApp,
    apiToken,
    PROBE_CADENCE_KEYS,
  );

  // The probe's TARGETS are read separately from its cadence: the cadence
  // comes from plain Machine env, while target values are Fly secrets and
  // never appear there. The running probe publishes only labels and host
  // fingerprints on /metrics.
  const healthProbeTargets = await readHealthProbeTargets(healthProbeBaseUrl);
  const redis = await readFlyRedisAddon(redisAddon, apiToken);

  // The DEPLOYED platform app's CONFIGURATION is read separately from the
  // app inventory: it is the AC1/AC4 evidence that the running app was
  // deployed as the consolidated PRODUCTION platform, and it must be
  // reportable even when the app does not exist.
  const platformConfig = await readFlyAppPlatformConfig(platformApp, apiToken);

  return {
    captured: true,
    organization: organizations.map((organization) => organization?.name).filter(Boolean),
    apps,
    secretNamesCaptured: apps.length > 0 && apps.every((app) => Array.isArray(app.secretNames)),
    healthProbeEnv,
    healthProbeTargets,
    redis,
    platformConfig,
  };
}

/**
 * Read the `production` Environment's APPROVAL GATE.
 *
 * WHY THIS EXISTS
 *
 * The production data cutover (task f2c23e26) has three independent keys,
 * and the FIRST of them is the `production` GitHub Environment's required
 * reviewers — the runbook states that "a dispatch that has not been
 * approved never starts"
 * (docs/runbooks/production-data-migration-restore.md §2). Nothing in the
 * repository read that setting, so the key could be INERT while the
 * runbook still claimed it was live: a protection-rule list of zero means
 * no reviewer, no approval, and a dispatch that starts unattended.
 *
 * Only the rule TYPES and a reviewer COUNT are recorded. A reviewer's
 * login is a person's identity and no gate needs it, so it never reaches
 * the artifact.
 *
 * A read that fails is reported as a failed capture, not as an absent
 * gate: "not captured" is not "fine", and the checker turns an unreadable
 * environment into an OPEN gate rather than a silent pass.
 */
export async function readEnvironmentApprovalGate({ repo, environment, headers }) {
  try {
    const payload = await fetchJson(
      `${GITHUB_API_BASE}/repos/${repo}/environments/${environment}`,
      { headers },
    );
    const rules = Array.isArray(payload?.protection_rules) ? payload.protection_rules : [];
    const reviewerRules = rules.filter((rule) => rule?.type === 'required_reviewers');
    const waitTimerRule = rules.find((rule) => rule?.type === 'wait_timer');
    return {
      captured: true,
      protectionRuleTypes: rules.map((rule) => rule?.type).filter(Boolean),
      requiredReviewerCount: reviewerRules.reduce(
        (total, rule) => total + (Array.isArray(rule?.reviewers) ? rule.reviewers.length : 0),
        0,
      ),
      waitTimerMinutes: Number.isFinite(waitTimerRule?.wait_timer) ? waitTimerRule.wait_timer : null,
      canAdminsBypass:
        typeof payload?.can_admins_bypass === 'boolean' ? payload.can_admins_bypass : null,
    };
  } catch (error) {
    return { captured: false, error: error.message };
  }
}

async function captureGitHub({ repo, environment }) {
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      token = null;
    }
  }
  if (!token) return failure('no GitHub token (GITHUB_TOKEN unset and `gh auth token` failed)');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const secrets = await fetchJson(
      `${GITHUB_API_BASE}/repos/${repo}/environments/${environment}/secrets`,
      { headers },
    );
    let variables = { variables: [] };
    try {
      variables = await fetchJson(
        `${GITHUB_API_BASE}/repos/${repo}/environments/${environment}/variables`,
        { headers },
      );
    } catch {
      // The variables endpoint is absent on some environments; the secret
      // inventory is the part AC4 binds.
    }
    // The approval gate is read alongside the secret inventory: both are
    // properties of the SAME `production` Environment, and the cutover
    // needs both before it may be dispatched.
    const approvalGate = await readEnvironmentApprovalGate({ repo, environment, headers });

    return {
      captured: true,
      repository: repo,
      environment,
      secretNames: (secrets?.secrets ?? []).map((secret) => secret?.name).filter(Boolean),
      variableNames: (variables?.variables ?? []).map((variable) => variable?.name).filter(Boolean),
      approvalGate,
    };
  } catch (error) {
    return failure(error.message);
  }
}

/**
 * The DNS records this task is responsible for.
 *
 * The hostname matrix is the source of truth for the stable hostnames and
 * their CNAME targets. This task owns the FLY-HOSTED surfaces only: the
 * design's Slice D step 8 says "Create only the production API DNS records
 * and Fly certificates. Do not move the apex or any frontend production
 * traffic in this task", and the Vercel frontends CNAME to Vercel's shared
 * managed target in every environment, so DNS carries no environment
 * identity for them.
 *
 * The staging hostnames are read as well: AC3 requires the staging domains
 * to be unaffected, and "unaffected" can only be evidenced by reading them.
 *
 * @param {string} repoRoot
 * @returns {{zoneName: string, hostnames: string[]}}
 */
function readDnsScope(repoRoot) {
  const matrix = JSON.parse(
    readFileSync(join(repoRoot, 'infra/cloud/hostname-matrix.json'), 'utf8'),
  );
  const surfaces = (matrix.surfaces ?? []).filter(
    (surface) =>
      typeof surface?.cnameTargets?.production === 'string' &&
      surface.cnameTargets.production.endsWith('.fly.dev'),
  );
  const hostnames = new Set();
  for (const surface of surfaces) {
    if (surface.production) hostnames.add(surface.production);
    if (surface.staging) hostnames.add(surface.staging);
  }
  return { zoneName: matrix.apexDomain, hostnames: [...hostnames] };
}

/**
 * Read the production DNS records — the AC3 read-back.
 *
 * Only names, record types, targets, the proxy flag and the record's
 * creation time are recorded: a DNS target is a public hostname, and the
 * artifact never carries the API credential that read it. The creation
 * time is the exposure time the spend-bound ORDER gate compares against.
 *
 * @param {{zoneName: string, hostnames: string[]}} scope
 */
async function captureCloudflare({ zoneName, hostnames }) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return failure('CLOUDFLARE_API_TOKEN is not set');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    const zonesResponse = await fetchJson(
      `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(zoneName)}`,
      { headers },
    );
    const zone = (zonesResponse?.result ?? []).find(
      (entry) => entry?.name === zoneName && entry?.id,
    );
    if (!zone) return failure(`no Cloudflare zone named ${zoneName}`);

    const records = [];
    for (const hostname of hostnames) {
      const response = await fetchJson(
        `${CLOUDFLARE_API_BASE}/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`,
        { headers },
      );
      for (const record of response?.result ?? []) {
        // Cloudflare returns the record name as stored; only the exact
        // hostname belongs to this scope.
        if (record?.name !== hostname) continue;
        records.push({
          name: record.name,
          type: record.type ?? 'unknown',
          content: record.content ?? null,
          proxied: record.proxied === true,
          // WHEN the record was published. This is the exposure time the
          // approved design orders against: the production spend bound has
          // to be in place BEFORE a production hostname is published, and
          // a record without a publication time cannot prove that order.
          createdOn: record.created_on ?? null,
        });
      }
    }

    return { captured: true, zoneName, records };
  } catch (error) {
    return failure(error.message);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const manifestUrl = pathToFileURL(
    join(options.repoRoot, 'infra/cloud/platform/platform-environments.mjs'),
  ).href;
  const manifest = await import(manifestUrl);
  const environment = manifest.getPlatformEnvironment('production');
  const dnsScope = readDnsScope(options.repoRoot);

  const [neon, fly, github, cloudflare] = await Promise.all([
    captureNeon({ projectName: options.neonProject }),
    captureFly({
      platformApp: environment.platformApp,
      healthProbeApp: environment.healthProbeApp,
      healthProbeBaseUrl: environment.healthProbeBaseUrl,
      redisAddon: environment.redisAddon,
    }),
    captureGitHub({ repo: options.githubRepo, environment: options.githubEnvironment }),
    captureCloudflare(dnsScope),
  ]);

  const capturedAt = new Date().toISOString();
  const artifact = {
    // Version 4: the production Neon branch carries the FINGERPRINTS of the
    // hosts that serve it, read from the branch's ENDPOINTS resource, plus
    // the reason when that read failed. Version 3 carried a single
    // `branch.hostFingerprint` read from the BRANCH resource — but the Neon
    // v2 branch resource has no `host` field (the host lives on the
    // endpoints), so that value was always null, the AC6 database-target
    // expectation set was always empty, and the gate could never be met no
    // matter how correctly production was provisioned. Version 3 also
    // recorded the probe's deployed TARGETS, so AC6's "pointed at the new
    // production targets" half can be decided.
    // Version 5: the deployed production PLATFORM app's configuration is
    // recorded — the environment id, the process group Fly scheduled the
    // Machine in, and the CORS allow-lists, reduced to validated origins.
    // Version 4 proved the deployed PROBE's cadence and targets; nothing
    // proved which configuration the platform app itself was deployed
    // with, so a production app deployed from the shared staging config
    // passed every gate the repository owns.
    // Version 6: the OPERATOR EVIDENCE section is recorded. The five
    // obligations no machine can prove (the Fly spend-limit read-back, the
    // Neon separation denial proof, one successful production probe
    // interval, the production API health responses and the DNS/TLS
    // read-back) had nowhere to be recorded, so they were reported as
    // `operator-required` forever and the chain could never reach green —
    // AC5 could not be satisfied even after the operator had set the
    // limit. Version 6 carries the operator's value-free read-backs, and
    // the checker binds them to the obligations they close.
    // Version 8: Redis is read from Fly's managed Upstash add-on API, and
    // deployed probe targets come from the probe's value-free info metric.
    // Fly never exposes secret values in Machine config.env, so version 7's
    // Machines-API target read could only return an empty target set.
    // Version 9: the production Neon allowlist's SOURCE is read. The Neon
    // contract names Fly's app-scoped static egress addresses as the
    // addresses the allowlist must carry, but nothing read them: the
    // allowlist gate could name the Neon account plan as the blocker while
    // the addresses it would have to list had never been allocated. Version
    // 9 carries the per-app egress allocation (count, region and
    // fingerprints) and the Neon allowlist entries as fingerprints, so the
    // two can be compared without either side disclosing an address.
    // Version 10: the Neon connectivity control is read from the provider
    // plan instead of being assumed. Neon Free cannot express an IP
    // allowlist, so the AC2 gate now chooses between the IP-allowlist path
    // and the accepted schema-scoped service-role control, and reports the
    // IP-allowlist gates as not applicable when that accepted control is in
    // place. The operator evidence carries the acceptance itself, the
    // role-scope read-back that backs it, and the spend-ordering deviation
    // that closes the Fly spend-bound ordering gate.
    // Version 11: the `production` Environment's APPROVAL GATE is read —
    // its protection rule types, the required-reviewer count, the wait
    // timer and whether admins may bypass. The cutover's first key is that
    // gate, and nothing read it: the key could be inert while the runbook
    // still claimed a dispatch cannot start unapproved. Rule types and a
    // count only — a reviewer's login is a person's identity and no gate
    // needs it.
    schemaVersion: 12,
    environment: 'production',
    capturedAt,
    providers: { neon, fly, github, cloudflare },
  };

  const operatorEvidencePath = resolveOperatorEvidenceInput(options);
  if (operatorEvidencePath) {
    const loaded = loadOperatorEvidence(operatorEvidencePath, {
      capturedAt,
      repoRoot: options.repoRoot,
    });
    if (loaded.problems.length > 0) {
      throw new Error(
        `the operator evidence file ${operatorEvidencePath} is not usable: ${loaded.problems.join('; ')}`,
      );
    }
    artifact.operatorEvidence = loaded.evidence;
  }

  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (options.out) {
    writeFileSync(resolve(options.out), serialized);
    process.stdout.write(`captured production provisioning state → ${options.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(2);
    },
  );
}
