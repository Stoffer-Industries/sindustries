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
// Environment and Upstash — and writes a REDACTED artifact: names, flags and
// counts only. It never writes a value. It creates nothing, changes nothing,
// and deletes nothing; there is no mutation call anywhere in this file.
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

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT_DEFAULT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
})();

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const FLY_GRAPHQL_ENDPOINT = 'https://api.fly.io/graphql';
const UPSTASH_API_BASE = 'https://api.upstash.com/v2';
const GITHUB_API_BASE = 'https://api.github.com';

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
        apps.push({
          name: app.name ?? name,
          organization: organization.name ?? null,
          releaseVersion: app.currentRelease?.version ?? null,
          machineStates: (app.machines?.nodes ?? []).map((machine) => machine?.state),
        });
      }
    }

    // Fly's GraphQL API does not list secret names for these apps, so the
    // secret-name inventory stays with the deploy workflow (which registers
    // them) and with `flyctl secrets list`, which the operator runs. The
    // artifact records that the inventory was not captured rather than
    // implying the app has no secrets.
    return {
      captured: true,
      organization: organizations.map((organization) => organization?.name).filter(Boolean),
      apps,
      secretNamesCaptured: false,
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

async function main(argv) {
  const options = parseArgs(argv);
  const manifestUrl = pathToFileURL(
    join(options.repoRoot, 'infra/cloud/platform/platform-environments.mjs'),
  ).href;
  const manifest = await import(manifestUrl);
  const environment = manifest.getPlatformEnvironment('production');

  const [neon, fly, github, upstash] = await Promise.all([
    captureNeon({ projectName: options.neonProject }),
    captureFly({
      platformApp: environment.platformApp,
      healthProbeApp: environment.healthProbeApp,
    }),
    captureGitHub({ repo: options.githubRepo, environment: options.githubEnvironment }),
    captureUpstash(),
  ]);

  const artifact = {
    schemaVersion: 1,
    environment: 'production',
    capturedAt: new Date().toISOString(),
    providers: { neon, fly, github, upstash },
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  },
);
