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

import {
  TASKS_APPROVAL_TYPES,
  assertApprovalCredentialContract,
} from './platform-approval-credentials.mjs';

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
    /** The Fly-managed Upstash database dedicated to this environment. */
    redisAddon: {
      provider: 'upstash_redis',
      name: 'sindustries-staging',
      plan: 'Pay-as-you-go',
      primaryRegion: 'syd',
    },
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
      clerkSecretKey: 'STAGING_BUDGET_API_CLERK_SECRET_KEY',
      tasksClerkSecretKey: 'STAGING_TASKS_API_CLERK_SECRET_KEY',
      tasksClerkIssuer: 'STAGING_TASKS_API_CLERK_ISSUER',
      tasksClerkAuthorizedUsers: 'STAGING_TASKS_API_CLERK_AUTHORIZED_USERS',
    },
    /** The public API base URLs of this environment. */
    apiBaseUrls: {
      tasksApi: 'https://tasks-api.staging.sindustries.co.nz/api/v1',
      budgetApi: 'https://budget-api.staging.sindustries.co.nz/api/v1',
      contentSchedulerApi: 'https://content-scheduler-api.staging.sindustries.co.nz/api/v1',
    },
    /**
     * The public base URL of this environment's health probe.
     *
     * The probe is a separate Fly app with its own stable hostname, so
     * the probe deploy workflow needs one base URL of its own. It lives in
     * the manifest for the same reason the API base URLs do: the deploy
     * workflow resolves it at runtime instead of writing the hostname
     * into the workflow, where a second copy would drift.
     */
    healthProbeBaseUrl: 'https://health-probe.staging.sindustries.co.nz',
    /** The CORS allow-lists of this environment's frontends. */
    corsAllowedOrigins: {
      tasksApi: [
        'https://tasks.staging.sindustries.co.nz',
        'https://mission-control.staging.sindustries.co.nz',
      ],
      budgetApi: ['https://mission-control.staging.sindustries.co.nz'],
      contentSchedulerApi: ['https://mission-control.staging.sindustries.co.nz'],
    },
    /**
     * The approval-credential contract for this environment.
     *
     * ONE contract owns every approval-credential fact for a service:
     * the Fly secret the credential array is registered under, the
     * GitHub Environment sources the values come from, the platform's
     * own validation actor, and the exact operator actor set with the
     * approval types each actor may carry.
     *
     * The provisioner MERGES the platform actor with the operator set.
     * It used to REPLACE the live secret with a one-actor array, and
     * because the platform deploy workflow runs on every merge to
     * `main`, every routine merge silently wiped the agent
     * registrations and every agent write on production then failed with
     * `401 AUTH_REQUIRED` (task 3c004590).
     *
     * The operator set is deliberately SERVICE-SPECIFIC: registering the
     * Tasks actor set on the Content Scheduler would widen production
     * write access to callers that never write there. The set is
     * recorded here so drift is detectable, and the operator credential
     * array in the GitHub Environment must match it exactly — a missing
     * actor, an unknown actor or a widened approval scope fails the
     * deploy BEFORE anything is written to Fly.
     */
    approvalCredentials: {
      tasks: {
        /** The Fly app-level secret the merged array is registered under. */
        targetSecret: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
        /** The key of this service's base URL in `apiBaseUrls`. */
        apiBaseUrlKey: 'tasksApi',
        /** The source that carries the platform validation actor's token. */
        platformTokenSource: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
        /**
         * The source that carries the COMPLETE operator credential array
         * (`[{token, actor, approvalTypes}]`).
         */
        operatorCredentialsSource: 'TASKS_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS',
        /** The actor the platform's own validation token acts as. */
        platformActor: 'staging-cloud-validate',
        /**
         * Staging has NO agent writers today: its live credential set
         * carries the platform validation actor alone, and the agent
         * tooling writes to prodlike and production rather than to
         * staging. The operator source is therefore NOT required here,
         * and the operator set is empty.
         *
         * The shape is the same one production uses — same helper, same
         * contract fields, same code path — so bringing staging to
         * parity is ONE reviewed change: declare the actors here and
         * register the array in the staging GitHub Environment.
         */
        operatorCredentialsRequired: false,
        platformApprovalTypes: [],
        /** The operator actors that must be present, in registration order. */
        operatorActors: [],
      },
      contentScheduler: {
        targetSecret: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
        apiBaseUrlKey: 'contentSchedulerApi',
        platformTokenSource: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
        operatorCredentialsSource:
          'CONTENT_SCHEDULER_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS',
        platformActor: 'staging-cloud-validate',
        platformApprovalTypes: ['any'],
        /** Staging has no agent writers — see the tasks contract above. */
        operatorCredentialsRequired: false,
        operatorActors: [],
      },
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
      'tasksClerkSecretKey',
      'tasksClerkIssuer',
      'tasksClerkAuthorizedUsers',
    ],
  },

  production: {
    id: 'production',
    label: 'production',
    platformApp: 'sindustries-platform-production',
    healthProbeApp: 'sindustries-health-probe-production',
    githubEnvironment: 'production',
    flyOrgVariable: 'PRODUCTION_FLY_ORG',
    redisAddon: {
      provider: 'upstash_redis',
      name: 'sindustries-production',
      plan: 'Pay-as-you-go',
      primaryRegion: 'syd',
    },
    schemas: {
      tasks: 'tasks_api',
      budget: 'budget_api',
      contentScheduler: 'content_scheduler',
    },
    /**
     * The Neon service roles that CONNECT to the production schemas.
     *
     * The role names are part of the production topology: the provisioning
     * capture compares the provider's role inventory against these exact
     * names, so a similarly named read-only or broad role cannot satisfy
     * the schema-scoped connectivity control by substring accident.
     *
     * These roles do NOT own the production schemas (see
     * `databaseSchemaOwnerRole`), and they are NOT confined to their own
     * schema (see `databaseServiceRoleSharedAccess`). Both facts used to
     * be assumed rather than declared, and the cutover found both of them
     * the hard way.
     */
    databaseServiceRoles: {
      tasks: 'sindustries_tasks_api',
      budget: 'sindustries_budget_api',
      contentScheduler: 'sindustries_content_scheduler',
    },
    /**
     * The role that OWNS the production schemas.
     *
     * The production schemas are owned by the Neon database owner role,
     * not by the service roles. That makes `DROP SCHEMA ... CASCADE` and
     * `CREATE SCHEMA` owner-only statements: a service role cannot drop
     * a schema it does not own (it fails closed with "must be owner of
     * schema"), and a service role that creates the schema becomes its
     * owner — which would be a topology change nobody approved.
     *
     * The cutover harness therefore takes an optional schema-OWNER
     * connection for the destructive DDL and keeps the service roles on
     * their own DML-scoped connections for the data load.
     */
    databaseSchemaOwnerRole: 'neondb_owner',
    /**
     * Accepted cross-schema access between the production service roles.
     *
     * Per-schema confinement is NOT enforceable in the production Neon
     * role model, and that is a recorded decision rather than an open
     * question (task f2c23e26; Quinn recorded Tom's decision on
     * 2026-11-23 07:25 NZDT).
     *
     * WHY THE ACCESS EXISTS. Both production service roles are members of
     * `neon_superuser`, which carries `pg_read_all_data` and
     * `pg_write_all_data`. A member of such a role holds USAGE — and
     * read and write — on EVERY schema in the database, and no explicit
     * GRANT can withdraw it, because no explicit grant was the source.
     * The decision is to ACCEPT that shared access rather than revoke the
     * membership, which would be a wider change to the production role
     * model than the decision authorises.
     *
     * WHY IT IS DECLARED HERE. The cutover harness, the provisioning
     * gate and the recorded evidence must agree on WHICH pair of roles
     * the acceptance covers. This declaration is the single source of
     * truth for that pair: the gate refuses when the recorded evidence
     * names a different pair, and the harness refuses a run whose roles
     * are not the declared pair.
     *
     * `accepted: false` means the assertion is unconditional: any
     * cross-schema access refuses the run.
     */
    databaseServiceRoleSharedAccess: {
      accepted: true,
      roles: ['sindustries_tasks_api', 'sindustries_content_scheduler'],
      reason:
        'Neon role model: both production service roles are members of neon_superuser, which carries pg_read_all_data and pg_write_all_data, so each holds USAGE on every schema and no explicit GRANT can withdraw it. Per-schema confinement is not enforceable in this environment, so the shared access between these two roles is accepted rather than enforced as isolation (task f2c23e26; Tom\'s decision recorded by Quinn on 2026-11-23 07:25 NZDT).',
      decisionRef:
        'task f2c23e26 - Quinn recorded the decision on 2026-11-23 07:25 NZDT - accept per-schema confinement as not enforceable',
    },
    sourceNames: {
      tasksDatabaseUrl: 'PRODUCTION_TASKS_API_DATABASE_URL',
      budgetDatabaseUrl: 'PRODUCTION_BUDGET_API_DATABASE_URL',
      contentSchedulerDatabaseUrl: 'PRODUCTION_CONTENT_SCHEDULER_API_DATABASE_URL',
      redisUrl: 'PRODUCTION_HEALTH_PROBE_REDIS',
      clerkSecretKey: 'PRODUCTION_BUDGET_API_CLERK_SECRET_KEY',
      tasksClerkSecretKey: 'PRODUCTION_TASKS_API_CLERK_SECRET_KEY',
      tasksClerkIssuer: 'PRODUCTION_TASKS_API_CLERK_ISSUER',
      tasksClerkAuthorizedUsers: 'PRODUCTION_TASKS_API_CLERK_AUTHORIZED_USERS',
    },
    apiBaseUrls: {
      tasksApi: 'https://tasks-api.sindustries.co.nz/api/v1',
      budgetApi: 'https://budget-api.sindustries.co.nz/api/v1',
      contentSchedulerApi: 'https://content-scheduler-api.sindustries.co.nz/api/v1',
    },
    /**
     * The public base URL of this environment's health probe. See the
     * staging entry for why the probe's own base URL is an environment
     * fact rather than a hostname written into the deploy workflow.
     */
    healthProbeBaseUrl: 'https://health-probe.sindustries.co.nz',
    corsAllowedOrigins: {
      tasksApi: [
        'https://tasks.sindustries.co.nz',
        'https://mission-control.sindustries.co.nz',
      ],
      budgetApi: ['https://mission-control.sindustries.co.nz'],
      contentSchedulerApi: ['https://mission-control.sindustries.co.nz'],
    },
    /**
     * The approval-credential contract for this environment.
     *
     * The production actor set is the one that was measured on
     * 2026-11-24: production's Tasks API originally carried ONLY the
     * platform's `production-cloud-validate` actor, which is why every
     * agent token got a clean `401 AUTH_REQUIRED` on writes while reads
     * kept working. The nine operator actors below are the set that was
     * verified working live, and they are recorded HERE so the merge has
     * an authoritative target and so drift is detectable.
     *
     * The set is service-specific: the Content Scheduler carries only
     * the two actors that actually write to it. Registering the Tasks
     * actor set there would widen production write access to callers
     * that never write there.
     */
    approvalCredentials: {
      tasks: {
        /** The Fly app-level secret the merged array is registered under. */
        targetSecret: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
        /** The key of this service's base URL in `apiBaseUrls`. */
        apiBaseUrlKey: 'tasksApi',
        /** The source that carries the platform validation actor's token. */
        platformTokenSource: 'PRODUCTION_TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
        /**
         * The source that carries the COMPLETE operator credential array
         * (`[{token, actor, approvalTypes}]`).
         */
        operatorCredentialsSource:
          'PRODUCTION_TASKS_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS',
        /** The actor the platform's own validation token acts as. */
        platformActor: 'production-cloud-validate',
        /**
         * The platform validation actor holds NO approval-row authority:
         * it may use the ordinary authenticated routes, but every
         * approval-row route fails closed with
         * `403 APPROVAL_ACTOR_FORBIDDEN`.
         */
        platformApprovalTypes: [],
        /**
         * Production HAS agent writers, so the operator credential array
         * is REQUIRED. Stated explicitly rather than left to the
         * "required unless explicitly false" default, because the
         * default is exactly the sort of thing a reader has to know to
         * get right.
         */
        operatorCredentialsRequired: true,
        /** The operator actors that must be present, in registration order. */
        operatorActors: [
          { actor: 'Quinn', approvalTypes: ['tech_design'] },
          { actor: 'Rowan', approvalTypes: [] },
          { actor: 'Ivy', approvalTypes: [] },
          { actor: 'Lox', approvalTypes: [] },
          { actor: 'Ash', approvalTypes: ['qa_agent'] },
          { actor: 'feature_task_lobster', approvalTypes: [] },
          { actor: 'bookmark_lobster', approvalTypes: [] },
          { actor: 'Lobster', approvalTypes: [] },
          { actor: 'brain_spec_reconciler', approvalTypes: ['spec'] },
        ],
      },
      contentScheduler: {
        targetSecret: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
        apiBaseUrlKey: 'contentSchedulerApi',
        platformTokenSource:
          'PRODUCTION_CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
        operatorCredentialsSource:
          'PRODUCTION_CONTENT_SCHEDULER_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS',
        platformActor: 'production-cloud-validate',
        platformApprovalTypes: ['any'],
        /** See the tasks contract above: production requires the operator array. */
        operatorCredentialsRequired: true,
        operatorActors: [
          { actor: 'Ivy', approvalTypes: [] },
          { actor: 'tasks_app_browser', approvalTypes: [] },
        ],
      },
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
      'clerkSecretKey',
      'tasksClerkSecretKey',
      'tasksClerkIssuer',
      'tasksClerkAuthorizedUsers',
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
 * The environment that owns a Fly app name.
 *
 * The reverse of {@link getPlatformEnvironment}. Fly injects `FLY_APP_NAME`
 * into every Machine, so the app the Machine actually runs is a fact the
 * runtime can read independently of any configuration value — which is
 * what makes it usable to CHECK a configuration value rather than trust
 * it. A health-probe app name resolves to no platform environment, because
 * the probe has no nginx router.
 *
 * @param {string} appName
 * @returns {object|null} the environment entry, or null when no
 *   environment owns that app
 */
export function getPlatformEnvironmentByAppName(appName) {
  const needle = String(appName ?? '').trim();
  if (!needle) return null;
  for (const environment of Object.values(PLATFORM_ENVIRONMENTS)) {
    if (environment.platformApp === needle) return environment;
  }
  return null;
}

/**
 * Resolve the environment a Machine is running in, fail-closed.
 *
 * The router's hostnames are environment-owned, so "which environment is
 * this?" must be answered by a fact the runtime can read, never by a
 * default. Two independent facts are available:
 *
 *   - `FLY_APP_NAME` — injected by Fly into every Machine, and it names
 *     the app the Machine is actually running, so it cannot drift from
 *     the deployment the way a config value can;
 *   - `PLATFORM_ENVIRONMENT_ID` — declared in the Fly config's `[env]`
 *     table (staging in the shared config, production in the production
 *     overlay), and bound to the render at build time.
 *
 * The app name WINS, because it is the deployment rather than a claim
 * about the deployment. When both are present they must agree: a
 * mismatch means the config and the app disagree about the environment,
 * which is exactly the situation that would serve one environment's
 * hostnames from another environment's app.
 *
 * A missing or unknown environment is an error, never a fallback to
 * staging: a production Machine whose environment could not be resolved
 * must not boot serving staging hostnames.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object} the resolved environment entry
 * @throws {Error} when the environment cannot be resolved, or when the
 *   two facts disagree
 */
export function resolvePlatformEnvironment(env = {}) {
  const appName = String(env.FLY_APP_NAME ?? '').trim();
  const declaredId = String(env.PLATFORM_ENVIRONMENT_ID ?? '').trim();

  // An unknown declared id throws inside getPlatformEnvironment, so the
  // error names the bad value instead of degrading to a default.
  const declared = declaredId ? getPlatformEnvironment(declaredId) : null;

  const byApp = appName ? getPlatformEnvironmentByAppName(appName) : null;
  if (appName && !byApp) {
    throw new Error(
      `FLY_APP_NAME "${appName}" is not a known platform app (expected one of: ` +
        `${Object.values(PLATFORM_ENVIRONMENTS)
          .map((e) => e.platformApp)
          .join(', ')}) — refusing to start without a resolvable environment`,
    );
  }

  if (byApp && declared && byApp.id !== declared.id) {
    throw new Error(
      `FLY_APP_NAME "${appName}" belongs to the ${byApp.id} environment but ` +
        `PLATFORM_ENVIRONMENT_ID says "${declared.id}" — refusing to start, because the ` +
        'router would serve one environment\'s hostnames from another environment\'s app',
    );
  }

  const environment = byApp ?? declared;
  if (!environment) {
    throw new Error(
      'neither FLY_APP_NAME nor PLATFORM_ENVIRONMENT_ID is set — refusing to start, ' +
        'because the router hostnames are environment-owned and cannot be guessed',
    );
  }
  return environment;
}

/**
 * Resolve the environment the platform PROCESS runs in.
 *
 * On Fly, `FLY_APP_NAME` is injected into every Machine, so the strict
 * resolution above always applies there: an unknown app name, or a
 * declared id that disagrees with the app the Machine is actually
 * running, refuses to start. A local run has no Fly app and therefore
 * no other environment's traffic to serve, so when NEITHER fact is
 * present the local default applies — the only path that can reach it.
 *
 * The distinction matters because the two cases are not the same risk:
 * "a production Machine that cannot say which environment it is" would
 * serve the wrong hostnames, while "a local run that has not declared
 * one" has no traffic to misroute.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object} the resolved environment entry
 */
export function resolveRuntimeEnvironment(env = {}) {
  const appName = String(env.FLY_APP_NAME ?? '').trim();
  const declaredId = String(env.PLATFORM_ENVIRONMENT_ID ?? '').trim();
  if (appName || declaredId) {
    return resolvePlatformEnvironment(env);
  }
  return getPlatformEnvironment(DEFAULT_ENVIRONMENT_ID);
}

/**
 * The source names of an environment that must be present.
 *
 * The manifest's own `requiredSourceNames` list names the non-credential
 * sources. The approval-credential sources are required TOO, and they
 * are derived from the `approvalCredentials` contract rather than
 * listed separately: a contract source that was not required would
 * let the provisioner register a credential set built from a missing
 * operator array.
 *
 * @param {object} environment
 * @returns {string[]}
 */
export function requiredSourceNames(environment) {
  const declared = (environment.requiredSourceNames ?? []).map(
    (key) => environment.sourceNames[key],
  );
  const credentialSources = Object.values(environment.approvalCredentials ?? {}).flatMap(
    (contract) => [
      contract.platformTokenSource,
      ...(contract.operatorCredentialsRequired === false
        ? []
        : [contract.operatorCredentialsSource]),
    ],
  );
  return [...declared, ...credentialSources];
}

/**
 * EVERY source name an environment reads, required or not.
 *
 * The deploy-contract drift check compares this set against the source
 * names the deploy workflow actually provides. A source the manifest
 * reads but the workflow does not provide is a missing value at deploy
 * time; a source the workflow provides but the manifest does not read
 * is an unused secret. Both are drift, and the check refuses both.
 *
 * @param {object} environment
 * @returns {string[]}
 */
export function allSourceNames(environment) {
  const declared = Object.values(environment.sourceNames ?? {});
  const credentialSources = Object.values(environment.approvalCredentials ?? {}).flatMap(
    (contract) => [contract.platformTokenSource, contract.operatorCredentialsSource],
  );
  return [...declared, ...credentialSources];
}

/**
 * The approval-credential contract of an environment, per service.
 *
 * The contract is the ONE place that knows which actors a service's
 * credential set must carry and which approval types each of them may
 * hold (task 3c004590). It replaces the old
 * `sourceNames.tasksApprovalToken` / `sourceNames.schedulerApprovalToken`
 * / `approvalActors` triple, which described the credential shape in
 * three places that could disagree.
 *
 * @param {object} environment
 * @returns {Record<string, object>}
 */
export function approvalCredentialContracts(environment) {
  return environment.approvalCredentials ?? {};
}

/**
 * The credential source names of an environment.
 *
 * @param {object} environment
 * @returns {string[]}
 */
export function credentialSourceNames(environment) {
  return Object.values(approvalCredentialContracts(environment)).flatMap((contract) => [
    contract.platformTokenSource,
    contract.operatorCredentialsSource,
  ]);
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
  for (const key of ['provider', 'name', 'plan', 'primaryRegion']) {
    if (!environment.redisAddon?.[key]) {
      throw new Error(`platform environment "${environment.id}" has no Redis add-on ${key}`);
    }
  }
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
  // The approval-credential contract is a programming surface like the
  // rest of the manifest: a contract with a duplicate actor, an empty
  // operator list or two sources pointing at one value is rejected when
  // the manifest is loaded, not at the first deploy.
  const contracts = environment.approvalCredentials ?? {};
  for (const [service, contract] of Object.entries(contracts)) {
    assertApprovalCredentialContract(contract, {
      label: `platform environment "${environment.id}" ${service} approval credential contract`,
      allowedApprovalTypes:
        service === 'tasks' ? [...TASKS_APPROVAL_TYPES] : null,
    });
    if (!environment.apiBaseUrls?.[contract.apiBaseUrlKey]) {
      throw new Error(
        `platform environment "${environment.id}" has no apiBaseUrls.${contract.apiBaseUrlKey} ` +
          `for the ${service} approval credential contract`,
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
    // The credential sources are labelled the same way: a production
    // operator credential array read from an unlabelled source would be
    // a staging credential array registered on production.
    const credentialSourceNames = Object.values(environment.approvalCredentials ?? {}).flatMap(
      (contract) => [contract.platformTokenSource, contract.operatorCredentialsSource],
    );
    const unlabelledCredentials = credentialSourceNames.filter(
      (name) => !name.startsWith('PRODUCTION_'),
    );
    if (unlabelledCredentials.length > 0) {
      throw new Error(
        `production credential source names must carry the PRODUCTION_ label: ${unlabelledCredentials.join(', ')}`,
      );
    }
    if (environment.platformApp === staging.platformApp) {
      throw new Error('production must not reuse the staging platform app name');
    }
    if (environment.redisAddon.name === staging.redisAddon.name) {
      throw new Error('production must not reuse the staging Redis add-on name');
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
