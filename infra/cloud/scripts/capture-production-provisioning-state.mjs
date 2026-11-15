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
// the production control planes — Neon, Fly, the GitHub `production`
// Environment, Upstash and Cloudflare DNS — and writes a REDACTED artifact:
// names, flags and counts only. It never writes a value. It creates nothing,
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
// Usage:
//   node infra/cloud/scripts/capture-production-provisioning-state.mjs [--out <path>]
//        [--repo-root <path>] [--neon-project <name>]
//        [--github-repo <owner/name>] [--github-environment <name>]
//
// Credentials (read from the environment, never from a file in the repo):
//   NEON_API_KEY          Neon management API
//   FLY_API_TOKEN         Fly GraphQL API
//   UPSTASH_API_EMAIL     Upstash REST API (email)
//   UPSTASH_API_KEY       Upstash REST API (key)
//   GITHUB_TOKEN          GitHub API (falls back to `gh auth token`)
//   CLOUDFLARE_API_TOKEN  Cloudflare DNS API (zone records read)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT_DEFAULT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const FLY_GRAPHQL_ENDPOINT = 'https://api.fly.io/graphql';
const FLY_MACHINES_API_BASE = 'https://api.machines.dev';
const UPSTASH_API_BASE = 'https://api.upstash.com/v2';
const GITHUB_API_BASE = 'https://api.github.com';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

function parseArgs(argv) {
  const options = {
    out: null,
    repoRoot: REPO_ROOT_DEFAULT,
    neonProject: null,
    githubRepo: 'Stoffer-Industries/sindustries',
    githubEnvironment: 'production',
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
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
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
        protectedBranchesOnly: settings?.allowed_ips?.protected_branches_only === true,
        blockPublicConnections: settings?.block_public_connections === true,
      },
      branch: {
        id: productionBranch.id,
        name: productionBranch.name,
        state: branch.current_state ?? productionBranch.current_state ?? 'unknown',
        protected: branch.protected === true,
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
 * @returns {Promise<{secretNames: string[]|null, secretInventoryError?: string}>}
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
        secretInventoryError: 'the Fly app does not exist, so it carries no secret inventory',
      };
    }
    if (!response.ok) {
      return {
        secretNames: null,
        secretInventoryError: `the secret inventory could not be read (HTTP ${response.status})`,
      };
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.secrets)) {
      return {
        secretNames: null,
        secretInventoryError: 'the secret inventory response carried no secrets array',
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
      secretInventoryError: `the secret inventory could not be read (${error.message})`,
    };
  }
}

async function captureFly({ platformApp, healthProbeApp }) {
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

  try {
    const data = await query(
      '{ organizations { nodes { id name apps(first: 50) { nodes { name } } } } }',
    );
    const organizations = data?.organizations?.nodes ?? [];
    const wanted = new Set([platformApp, healthProbeApp]);

    const apps = [];
    for (const organization of organizations) {
      const names = (organization?.apps?.nodes ?? []).map((app) => app?.name).filter(Boolean);
      for (const name of names) {
        if (!wanted.has(name)) continue;
        const detail = await query(
          `{ app(id: ${JSON.stringify(name)}) { name currentRelease { version } machines(first: 20) { nodes { state } } } }`,
        );
        const app = detail?.app ?? {};
        const inventory = await readFlySecretNames(app.name ?? name, apiToken);
        apps.push({
          name: app.name ?? name,
          organization: organization.name ?? null,
          releaseVersion: app.currentRelease?.version ?? null,
          machineStates: (app.machines?.nodes ?? []).map((machine) => machine?.state),
          ...inventory,
        });
      }
    }

    // The secret inventory is read per app above, from the Machines API.
    // It is reported per app because that is where it is true: an app that
    // does not exist has no inventory, and an app whose inventory could
    // not be read has an unreadable one. Collapsing either into "the
    // provider captured no secrets" would hide the difference between an
    // app without secrets and a capture that could not look.
    return {
      captured: true,
      organization: organizations.map((organization) => organization?.name).filter(Boolean),
      apps,
      secretNamesCaptured: apps.length > 0 && apps.every((app) => Array.isArray(app.secretNames)),
    };
  } catch (error) {
    return failure(error.message);
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
    return {
      captured: true,
      repository: repo,
      environment,
      secretNames: (secrets?.secrets ?? []).map((secret) => secret?.name).filter(Boolean),
      variableNames: (variables?.variables ?? []).map((variable) => variable?.name).filter(Boolean),
    };
  } catch (error) {
    return failure(error.message);
  }
}

async function captureUpstash() {
  const email = process.env.UPSTASH_API_EMAIL;
  const key = process.env.UPSTASH_API_KEY;
  if (!email || !key) return failure('UPSTASH_API_EMAIL / UPSTASH_API_KEY are not set');

  try {
    const authorization = Buffer.from(`${email}:${key}`).toString('base64');
    const databases = await fetchJson(`${UPSTASH_API_BASE}/redis/databases`, {
      headers: { Authorization: `Basic ${authorization}` },
    });
    const rows = Array.isArray(databases) ? databases : (databases?.databases ?? []);
    return {
      captured: true,
      databaseNames: rows.map((row) => row?.database_name).filter(Boolean),
      databaseTypes: rows.map((row) => row?.database_type ?? row?.type ?? 'unknown'),
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
 * Only names, record types, targets and the proxy flag are recorded: a DNS
 * target is a public hostname, and the artifact never carries the API
 * credential that read it.
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

  const [neon, fly, github, upstash, cloudflare] = await Promise.all([
    captureNeon({ projectName: options.neonProject }),
    captureFly({
      platformApp: environment.platformApp,
      healthProbeApp: environment.healthProbeApp,
    }),
    captureGitHub({ repo: options.githubRepo, environment: options.githubEnvironment }),
    captureUpstash(),
    captureCloudflare(dnsScope),
  ]);

  const artifact = {
    schemaVersion: 1,
    environment: 'production',
    capturedAt: new Date().toISOString(),
    providers: { neon, fly, github, upstash, cloudflare },
  };

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
