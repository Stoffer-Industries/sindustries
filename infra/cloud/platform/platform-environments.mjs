/**
 * platform-environments.mjs — the explicit environment manifest for the
 * consolidated Fly platform (task fb1240c0, "Provision the production
 * environment").
 *
 * WHY THIS EXISTS
 * ---------------
 * The consolidated platform app (`sindustries-platform-staging`) was built
 * for staging and hard-coded its environment everywhere:
 *
 *   - `platform-services.mjs` exported the staging app name;
 *   - `platform-provision-secrets.mjs` read `STAGING_*` GitHub Environment
 *     secret names and derived one Neon database's three schemas;
 *   - `platform.fly.toml` named the staging app and the staging CORS
 *     origins.
 *
 * Production cannot be a copy of that: the alternative is two provisioning
 * contracts that drift, and a production app whose secrets were populated
 * from staging source names. So the environment-specific facts live HERE,
 * once, and the provisioner is parameterised by the environment id.
 *
 * WHAT BELONGS IN THIS FILE
 * -------------------------
 * Only facts that DIFFER between environments:
 *
 *   - the Fly app names;
 *   - the GitHub Environment whose secrets carry the live values;
 *   - the secret SOURCE names in that environment;
 *   - the schema names on the environment's database;
 *   - the public API base URLs and CORS origins;
 *   - the actors the approval-service credentials act as;
 *   - the value markers that must never appear in that environment.
 *
 * The child topology, the `PLATFORM_*` secret names, the supervisor and the
 * router are NOT here: they are environment-independent and live in
 * `platform-services.mjs`.
 *
 * FAIL-CLOSED SEPARATION
 * ----------------------
 * Production is the dangerous direction: a staging URL or a staging
 * credential that lands in production is indistinguishable from a correct
 * value at runtime, so it must be refused at the boundary rather than
 * discovered by an operator. Three guards encode that:
 *
 *   1. `assertEnvironmentManifest()` — structural. A production manifest
 *      that names a staging source, a staging app or a staging hostname is
 *      a programming error and is rejected when the manifest is loaded.
 *   2. `findForbiddenValues()` — value-level. Every secret value the
 *      provisioner derives is scanned for the environment's forbidden
 *      markers (staging/dev hostnames, placeholders, localhost).
 *   3. `assertEnvironmentValues()` — the combination: it fails closed when
 *      a production payload carries a staging marker, so the provisioner
 *      refuses to register anything before it touches Fly.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-environments.test.mjs
 */

/** The environments the consolidated platform can be provisioned for. */
export const PLATFORM_ENVIRONMENTS = {
  staging: {
    id: 'staging',
    label: 'staging',
    /** The consolidated platform app: ONE app, ONE Machine, FOUR children. */
    platformApp: 'sindustries-platform-staging',
    /** The health-probe app that watches this environment. */
    healthProbeApp: 'sindustries-health-probe-staging',
    /** The GitHub Environment whose secrets carry the live values. */
    githubEnvironment: 'staging',
    /** The repository variable that names the Fly org for this environment. */
    flyOrgVariable: 'STAGING_FLY_ORG',
    /**
     * The schema names on this environment's database. Staging runs one
     * Neon database with three schemas (confirmed by Quinn on task
     * 219fb673); production follows the same shape (task fb1240c0 Q1).
     */
    schemas: {
      tasks: 'tasks_api',
      budget: 'budget_api',
      contentScheduler: 'content_scheduler',
    },
    /**
     * The secret SOURCE names in this environment's GitHub Environment.
     * The values are mapped onto the environment-independent `PLATFORM_*`
     * secret names by `platform-provision-secrets.mjs`.
     */
    sourceNames: {
      tasksDatabaseUrl: 'STAGING_TASKS_API_DATABASE_URL',
      budgetDatabaseUrl: 'STAGING_BUDGET_API_DATABASE_URL',
      contentSchedulerDatabaseUrl: 'STAGING_CONTENT_SCHEDULER_API_DATABASE_URL',
      redisUrl: 'HEALTH_PROBE_REDIS',
      tasksApprovalToken: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
      schedulerApprovalToken: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
    },
    /** The public API base URLs of this environment. */
    apiBaseUrls: {
      tasksApi: 'https://tasks-api.staging.sindustries.co.nz/api/v1',
      budgetApi: 'https://budget-api.staging.sindustries.co.nz/api/v1',
      contentSchedulerApi: 'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
    },
    /** The CORS allow-lists of this environment's frontends. */
    corsAllowedOrigins: {
      tasksApi: [
        'https://tasks.staging.sindustries.co.nz',
        'https://mission-control.staging.sindustries.co.nz',
      ],
      budgetApi: ['https://mission-control.staging.sindustries.co.nz'],
      contentSchedulerApi: ['https://mission-control.staging.sindustries.co.nz'],
    },
    /** The actors the approval-service credentials act as. */
    approvalActors: {
      tasks: 'staging-cloud-validate',
      contentScheduler: 'staging-cloud-validate',
    },
    /**
     * Value markers that must never appear in a secret value registered on
     * this environment's app. Staging has none: staging is the lower-risk
     * direction, and the staging values legitimately carry staging hostnames.
     */
    forbiddenValueMarkers: [],
    /**
     * Host labels that must never appear in a host of this environment.
     * Staging forbids none: staging values legitimately carry staging
     * hostnames.
     */
    forbiddenHostLabels: [],
    /**
     * Source names that must be present. `contentSchedulerDatabaseUrl` is
     * deliberately absent: it is optional in both environments because the
     * content-scheduler schema lives in the same database as tasks_api.
     */
    requiredSourceNames: [
      'tasksDatabaseUrl',
      'budgetDatabaseUrl',
      'redisUrl',
      'tasksApprovalToken',
      'schedulerApprovalToken',
    ],
  },

  production: {
    id: 'production',
    label: 'production',
    platformApp: 'sindustries-platform-production',
    healthProbeApp: 'sindustries-health-probe-production',
    githubEnvironment: 'production',
    flyOrgVariable: 'PRODUCTION_FLY_ORG',
    schemas: {
      tasks: 'tasks_api',
      budget: 'budget_api',
      contentScheduler: 'content_scheduler',
    },
    sourceNames: {
      tasksDatabaseUrl: 'PRODUCTION_TASKS_API_DATABASE_URL',
      budgetDatabaseUrl: 'PRODUCTION_BUDGET_API_DATABASE_URL',
      contentSchedulerDatabaseUrl: 'PRODUCTION_CONTENT_SCHEDULER_API_DATABASE_URL',
      redisUrl: 'PRODUCTION_HEALTH_PROBE_REDIS',
      tasksApprovalToken: 'PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
      schedulerApprovalToken:
        'PRODUCTION_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
    },
    apiBaseUrls: {
      tasksApi: 'https://tasks-api.sindustries.co.nz/api/v1',
      budgetApi: 'https://budget-api.sindustries.co.nz/api/v1',
      contentSchedulerApi: 'https://content-scheduler-api.sindustries.co.nz/api/v1',
    },
    corsAllowedOrigins: {
      tasksApi: [
        'https://tasks.sindustries.co.nz',
        'https://mission-control.sindustries.co.nz',
      ],
      budgetApi: ['https://mission-control.sindustries.co.nz'],
      contentSchedulerApi: ['https://mission-control.sindustries.co.nz'],
    },
    approvalActors: {
      tasks: 'production-cloud-validate',
      contentScheduler: 'production-cloud-validate',
    },
    // Security decision: `production-cloud-validate` is deliberately NOT in
    // the Tasks API `ACTOR_PERMISSIONS` map. It can use the ordinary
    // authenticated mutation routes, but every approval-row route fails
    // closed with `403 APPROVAL_ACTOR_FORBIDDEN`.
    //
    // This matches the staging automation actor and keeps production
    // deployment automation separate from human/agent approval authority.
    // Adding approval-row authority requires a separate, security-reviewed
    // change to `services/tasks-api/src/middleware/approvalAuth.ts`.
    /**
     * Markers that must never appear in a production secret value.
     *
     * The staging/dev hostnames and the retired apex are the values an
     * operator is most likely to copy by accident; the placeholders are
     * the values that were registered out of band on the staging app and
     * crash-looped the platform; `localhost` is the prodlike database that
     * must never be reachable from a production app.
     */
    forbiddenValueMarkers: [
      'staging.sindustries.co.nz',
      '.staging.',
      'sindustries-platform-staging',
      'sindustries-health-probe-staging',
      'sindustries-tasks-api-staging',
      'sindustries-budget-api-staging',
      'sindustries-content-scheduler-api-staging',
      'sindustries-auto-post-worker-staging',
      'sindustries.dev',
      'REPLACE_ME',
      'localhost',
      '127.0.0.1',
    ],
    forbiddenValuePatterns: [
      {
        label: 'staging hostname segment',
        pattern: /(?:^|[.-])staging(?:[.-]|$)/i,
      },
    ],
    /**
     * Environment labels that must never appear in a host of this
     * environment.
     *
     * Providers label their own endpoints, and they label them in more
     * than one shape:
     *
     *   - Neon writes the environment into the endpoint name:
     *     `ep-dev-blue-123.us-east-2.aws.neon.tech`;
     *   - Upstash does the same: `eu1-dev-redis.upstash.io`;
     *   - a DNS label carries it: `staging-db.neon.tech`,
     *     `staging.upstash.io`.
     *
     * A single substring denylist cannot separate those shapes from a
     * production endpoint whose endpoint name happens to contain a
     * similar substring, so the guard below splits the host into its
     * labels and compares them as WORDS: the label itself
     * (`staging.upstash.io`) and the hyphen-separated parts of a label
     * (`ep-dev-blue-123` -> `ep`, `dev`, `blue`, `123`).
     *
     * The list is the set of non-production environment words a provider
     * can expose. A production host that exposes NO environment label at
     * all (`ep-cool-blue-123...neon.tech`) is allowed: the provider does
     * not expose one, so there is nothing to contradict.
     */
    forbiddenHostLabels: [
      'staging',
      'dev',
      'test',
      'testing',
      'sandbox',
      'uat',
      'demo',
      'preview',
      'local',
    ],
    requiredSourceNames: [
      'tasksDatabaseUrl',
      'budgetDatabaseUrl',
      'redisUrl',
      'tasksApprovalToken',
      'schedulerApprovalToken',
    ],
  },
};

/** The default environment — the one every existing call site means. */
export const DEFAULT_ENVIRONMENT_ID = 'staging';

/**
 * Look up an environment manifest by id.
 *
 * @param {string} id
 * @returns {object} the manifest entry
 */
export function getPlatformEnvironment(id = DEFAULT_ENVIRONMENT_ID) {
  const key = String(id ?? '').trim().toLowerCase();
  const environment = PLATFORM_ENVIRONMENTS[key];
  if (!environment) {
    throw new Error(
      `unknown platform environment "${id}" (expected one of: ${Object.keys(
        PLATFORM_ENVIRONMENTS,
      ).join(', ')})`,
    );
  }
  return environment;
}

/**
 * The source names of an environment that must be present.
 *
 * @param {object} environment
 * @returns {string[]}
 */
export function requiredSourceNames(environment) {
  return (environment.requiredSourceNames ?? []).map(
    (key) => environment.sourceNames[key],
  );
}

/**
 * The database source names that must be present AND write-capable.
 *
 * @param {object} environment
 * @returns {string[]}
 */
export function requiredDatabaseSourceNames(environment) {
  return [environment.sourceNames.tasksDatabaseUrl, environment.sourceNames.budgetDatabaseUrl];
}

/**
 * Structural guards on a manifest entry.
 *
 * These are programming errors, not runtime data errors: they catch a
 * manifest that was edited to point production at staging, which is the
 * one mistake that no later value-level guard can undo.
 *
 * @param {object} environment
 * @returns {void}
 */
export function assertEnvironmentManifest(environment) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('platform environment manifest is missing');
  }
  const sourceNames = Object.values(environment.sourceNames ?? {});
  const requiredKeys = ['tasksDatabaseUrl', 'budgetDatabaseUrl', 'redisUrl'];
  for (const key of requiredKeys) {
    if (!environment.sourceNames?.[key]) {
      throw new Error(`platform environment "${environment.id}" has no source name for ${key}`);
    }
  }
  for (const key of environment.requiredSourceNames ?? []) {
    if (!environment.sourceNames?.[key]) {
      throw new Error(
        `platform environment "${environment.id}" requires unknown source key ${key}`,
      );
    }
  }
  for (const key of ['tasksApi', 'budgetApi', 'contentSchedulerApi']) {
    const origins = environment.corsAllowedOrigins?.[key];
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new Error(
        `platform environment "${environment.id}" has no CORS origins for ${key}`,
      );
    }
  }
  if (environment.id === 'production') {
    const staging = PLATFORM_ENVIRONMENTS.staging;
    const stagingSources = new Set(Object.values(staging.sourceNames));
    const offenders = sourceNames.filter((name) => stagingSources.has(name));
    if (offenders.length > 0) {
      throw new Error(
        `production must not read staging source names: ${offenders.join(', ')}`,
      );
    }
    const unlabelled = sourceNames.filter((name) => !name.startsWith('PRODUCTION_'));
    if (unlabelled.length > 0) {
      throw new Error(
        `production source names must carry the PRODUCTION_ label: ${unlabelled.join(', ')}`,
      );
    }
    if (environment.platformApp === staging.platformApp) {
      throw new Error('production must not reuse the staging platform app name');
    }
    const stagingHosts = Object.values(staging.apiBaseUrls);
    const productionHosts = Object.values(environment.apiBaseUrls ?? {});
    const leaked = productionHosts.filter((host) => stagingHosts.includes(host));
    if (leaked.length > 0) {
      throw new Error(`production must not reuse staging base URLs: ${leaked.join(', ')}`);
    }
    // The separation contract itself is structural: a manifest that drops
    // the forbidden host labels would silently accept a dev endpoint, so
    // the two labels the design names are required, not optional.
    const requiredForbiddenLabels = ['staging', 'dev'];
    const missingLabels = requiredForbiddenLabels.filter(
      (label) => !(environment.forbiddenHostLabels ?? []).includes(label),
    );
    if (missingLabels.length > 0) {
      throw new Error(
        `production must forbid these host environment labels: ${missingLabels.join(', ')}`,
      );
    }
  }
}

/**
 * A hostname-shaped authority: dot-separated labels of `[a-z0-9-]`.
 *
 * A value that does not match is not a host and is not scanned: an
 * approval credential blob, a token, or an app name must never be read
 * as a hostname.
 */
const HOSTNAME_SHAPE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Extract the host of a URL, a bare hostname, or an authority.
 *
 * @param {string} value
 * @returns {string|null} the lower-cased host, or null when the value is
 *   not host-shaped
 */
export function extractHost(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let authority = trimmed;
  const schemeAt = trimmed.indexOf('://');
  if (schemeAt !== -1) authority = trimmed.slice(schemeAt + 3);
  authority = authority.split(/[/?#]/, 1)[0];

  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  const colon = authority.indexOf(':');
  if (colon !== -1) authority = authority.slice(0, colon);

  const host = authority.trim().toLowerCase();
  return HOSTNAME_SHAPE.test(host) ? host : null;
}

/**
 * Every host named by a value.
 *
 * A value can be a single URL, a comma-separated allow-list (the CORS
 * values), or a bare hostname. The whole value and each of its
 * comma-separated entries are parsed, so a value whose password carries a
 * comma still yields its host.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function extractHosts(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  push(extractHost(value));
  for (const part of value.split(/[,\s]+/)) {
    push(extractHost(part));
  }
  return hosts;
}

/**
 * Public suffixes that are reserved for testing and can never name a real
 * production host, so the final label is not read as an environment label
 * when it is one of these.
 */
const RESERVED_HOST_SUFFIXES = new Set(['test', 'example', 'invalid', 'localhost']);

/**
 * The forbidden environment label a host carries, if any.
 *
 * The label is compared as a WORD, both as the DNS label itself and as
 * the hyphen-separated parts of a label, so `ep-dev-blue-123` carries
 * `dev` and `staging-db.neon.tech` carries `staging`.
 *
 * The final label is skipped when it is a reserved testing suffix
 * (`.test`, `.example`): those can never name a production host, and the
 * repository's own fixtures use them.
 *
 * @param {string} host
 * @param {string[]} labels
 * @returns {string|null} the offending label
 */
export function findForbiddenHostLabel(host, labels) {
  const forbidden = new Set(
    (labels ?? []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  );
  if (forbidden.size === 0) return null;
  const parts = String(host).split('.');
  for (const [index, label] of parts.entries()) {
    if (index === parts.length - 1 && RESERVED_HOST_SUFFIXES.has(label)) continue;
    if (forbidden.has(label)) return label;
    for (const token of label.split(/[-_]/)) {
      if (forbidden.has(token)) return token;
    }
  }
  return null;
}

/**
 * Find the forbidden markers present in a set of values.
 *
 * @param {object} environment
 * @param {Record<string, string>} values  label -> value
 * @returns {{label: string, marker: string}[]}
 */
export function findForbiddenValues(environment, values) {
  const markers = environment.forbiddenValueMarkers ?? [];
  const patterns = environment.forbiddenValuePatterns ?? [];
  const hostLabels = environment.forbiddenHostLabels ?? [];
  if (markers.length === 0 && patterns.length === 0 && hostLabels.length === 0) return [];
  const found = [];
  for (const [label, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'string' || value === '') continue;
    let matched = false;
    for (const marker of markers) {
      if (value.includes(marker)) {
        found.push({ label, marker });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const entry of patterns) {
      if (entry.pattern.test(value)) {
        found.push({ label, marker: entry.label });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // The host-label guard: a provider that exposes its own environment
    // label must not expose a non-production one.
    for (const host of extractHosts(value)) {
      const offending = findForbiddenHostLabel(host, hostLabels);
      if (offending) {
        found.push({ label, marker: `environment label "${offending}"` });
        break;
      }
    }
  }
  return found;
}

/**
 * Fail closed when a payload carries a marker this environment forbids.
 *
 * The message names the SECRET NAME and the marker — never the value.
 *
 * @param {object} environment
 * @param {{name: string, value: string}[]} secrets
 * @returns {void}
 */
export function assertEnvironmentValues(environment, secrets) {
  const found = findForbiddenValues(
    environment,
    Object.fromEntries((secrets ?? []).map((secret) => [secret.name, secret.value])),
  );
  if (found.length === 0) return;
  const detail = found
    .map((entry) => `${entry.label} contains a forbidden marker (${entry.marker})`)
    .join('; ');
  throw new Error(
    `${environment.id} environment refuses these values: ${detail}. ` +
      'A production secret must not carry a staging/dev hostname, a placeholder, ' +
      'or a localhost address.',
  );
}
