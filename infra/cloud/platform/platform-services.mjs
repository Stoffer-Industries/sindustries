/**
 * platform-services.mjs — the single source of truth for the consolidated
 * Fly staging platform (task 219fb673, "Consolidate tasks-api/budget-api/
 * auto-post-worker/content-scheduler-api onto one Fly staging machine").
 *
 * Two files consume this registry:
 *
 *   - `platform-supervisor.mjs` — builds each child's environment and
 *     spawns it inside the one Machine.
 *   - `platform-migrate.mjs`   — runs the per-service Prisma migrations
 *     from the app's single `release_command`.
 *
 * They MUST agree on the secret names, so the mapping lives here once
 * rather than being duplicated in both.
 *
 * ---------------------------------------------------------------------------
 * Why the environment is mapped at all
 * ---------------------------------------------------------------------------
 * Fly secrets are app-scoped: every process group in one app sees the same
 * environment. Three of the four services read `DATABASE_URL`, and the
 * staging databases differ by schema (`?schema=tasks_api`, `?schema=budget_api`,
 * `?schema=content_scheduler` — one Neon database, three schemas, confirmed
 * by Quinn on task 219fb673). The platform therefore cannot hand three
 * different `DATABASE_URL` values to three children through the platform
 * itself; the differentiation has to happen inside the container.
 *
 * The app-level secret is therefore named `PLATFORM_<TARGET>_DATABASE_URL`,
 * and the supervisor maps it to the child's own `DATABASE_URL`. The services
 * keep reading exactly the variable names they read today — no service code
 * changes, no service env contract changes.
 *
 * ---------------------------------------------------------------------------
 * Deliberate deviation from the tech design
 * ---------------------------------------------------------------------------
 * The approved design (§3.3) proposes a single `PLATFORM_REDIS_URL`,
 * on the premise that "REDIS_URL is already shared by the content-scheduler
 * API and the worker today". Quinn's answer to Q2 explicitly made that
 * premise conditional: *"confirm the content-scheduler API and the worker
 * point at the same Upstash instance before collapsing to a single name"*.
 *
 * That confirmation has not happened yet, and tasks-api also reads
 * `REDIS_URL`. So Redis is mapped PER CHILD here
 * (`PLATFORM_TASKS_API_REDIS_URL`, `PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL`,
 * `PLATFORM_AUTO_POST_WORKER_REDIS_URL`), which preserves each service's
 * current instance exactly and needs no confirmation. If the instances turn
 * out to be identical, collapsing to one name is a one-line change in this
 * file plus a secret rename — no child, image or deploy change.
 */

export const PLATFORM_APP = 'sindustries-platform-staging';

/** Port the in-container nginx router listens on. */
export const ROUTER_PORT = 8080;

/** Port the supervisor's status endpoint listens on (loopback only). */
export const STATUS_PORT = 8081;

/** Path the supervisor exposes its status payload on. */
export const STATUS_PATH = '/status';

/** Path the router exposes the supervisor status on (public, read-only). */
export const ROUTER_STATUS_PATH = '/__status';

/**
 * The four children of the consolidated platform.
 *
 * `defaults` are applied unconditionally to the child's environment.
 * `envMap` maps a child variable name to the app-level variable it is
 * sourced from; the mapping is applied only when the source is present, so
 * an unset optional secret does not become an empty string.
 * `requiredSources` are app-level variables that MUST be present — the
 * supervisor refuses to boot without them rather than starting a service
 * that will crash on a missing database or Redis URL. Every source a child
 * genuinely needs is listed here, including the Redis ones: a missing
 * Redis URL otherwise fails at the first queue operation, long after the
 * boot that should have caught it.
 */
export const CHILDREN = [
  {
    name: 'tasks-api',
    role: 'service',
    // `npm run start --workspace …` runs the service's own `prestart`
    // (`prisma generate`) before `start`, exactly as it does today.
    command: ['npm', 'run', 'start', '--workspace', 'services/tasks-api'],
    port: 4001,
    defaults: {
      NODE_ENV: 'production',
      PORT: '4001',
      OTEL_SERVICE_NAME: 'tasks-api',
      // Documented escape hatch for the cloud case where DATABASE_URL points
      // at Neon staging (port 5432) rather than the prodlike 7432 pairing.
      // See services/tasks-api/src/server.ts (assertApiPortDbPortPairing).
      ALLOW_PORT_DB_MISMATCH: '1',
    },
    envMap: {
      DATABASE_URL: 'PLATFORM_TASKS_API_DATABASE_URL',
      REDIS_URL: 'PLATFORM_TASKS_API_REDIS_URL',
      CONTENT_SCHEDULER_REDIS_URL: 'PLATFORM_TASKS_API_CONTENT_SCHEDULER_REDIS_URL',
      CONTENT_SCHEDULER_API_BASE_URL: 'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
      CORS_ALLOWED_ORIGINS: 'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
    },
    requiredSources: [
      'PLATFORM_TASKS_API_DATABASE_URL',
      'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
      // The staging tasks-api app carries REDIS_URL today; without it the
      // service fails on its first Redis operation instead of at boot.
      'PLATFORM_TASKS_API_REDIS_URL',
    ],
  },
  {
    name: 'budget-api',
    role: 'service',
    command: ['npm', 'run', 'start', '--workspace', 'services/budget-api'],
    port: 4002,
    defaults: {
      NODE_ENV: 'production',
      PORT: '4002',
      OTEL_SERVICE_NAME: 'budget-api',
    },
    envMap: {
      DATABASE_URL: 'PLATFORM_BUDGET_API_DATABASE_URL',
      CORS_ALLOWED_ORIGINS: 'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
    },
    requiredSources: [
      'PLATFORM_BUDGET_API_DATABASE_URL',
      'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
    ],
  },
  {
    name: 'content-scheduler-api',
    role: 'service',
    command: ['npm', 'run', 'start', '--workspace', 'services/content-scheduler-api'],
    port: 4003,
    defaults: {
      NODE_ENV: 'production',
      PORT: '4003',
      OTEL_SERVICE_NAME: 'content-scheduler-api',
      // BullMQ is the production adapter; `in-process` would not survive a
      // restart. Matches the existing content-scheduler-api fly.toml [env].
      CONTENT_SCHEDULER_JOB_ADAPTER: 'bullmq',
    },
    envMap: {
      DATABASE_URL: 'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      REDIS_URL: 'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
      CONTENT_SCHEDULER_REDIS_URL: 'PLATFORM_CONTENT_SCHEDULER_API_CONTENT_SCHEDULER_REDIS_URL',
      CORS_ALLOWED_ORIGINS: 'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
    },
    requiredSources: [
      'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
      'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
    ],
  },
  {
    name: 'auto-post-worker',
    role: 'service',
    // The worker is queue-bound: no HTTP listener, no route. Its health is
    // observed through content-scheduler-api, exactly as today.
    command: ['npm', 'run', 'content-scheduler:worker', '--workspace', 'services/content-scheduler-api'],
    port: null,
    defaults: {
      NODE_ENV: 'production',
      OTEL_SERVICE_NAME: 'auto-post-worker',
      CONTENT_SCHEDULER_JOB_ADAPTER: 'bullmq',
    },
    envMap: {
      // The worker shares the content_scheduler schema with
      // content-scheduler-api — one Neon database, three schemas.
      DATABASE_URL: 'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      REDIS_URL: 'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
      CONTENT_SCHEDULER_REDIS_URL: 'PLATFORM_AUTO_POST_WORKER_CONTENT_SCHEDULER_REDIS_URL',
      CONTENT_SCHEDULER_API_BASE_URL: 'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
    },
    requiredSources: [
      'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      // The worker is a BullMQ consumer: no Redis, no queue.
      'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
    ],
  },
];

/**
 * The router (nginx) runs alongside the children in the same Machine. It is
 * listed separately from `CHILDREN` because it is not a service: it owns no
 * listener of its own beyond the router port and serves the status proxy.
 */
export const ROUTER = {
  name: 'nginx',
  role: 'router',
  // The config path is ABSOLUTE on purpose.
  //
  // nginx resolves a relative `-c` path against its own compile-time
  // prefix (`/var/lib/nginx` on alpine), NOT against the child's cwd --
  // so the relative form failed on the live platform Machine with
  // `nginx: [emerg] open() "/var/lib/nginx/infra/cloud/platform/nginx.conf"
  // failed (2: No such file or directory)` and the router crash-looped.
  // The image puts this file at /app/infra/cloud/platform/nginx.conf
  // (platform.Dockerfile: WORKDIR /app, then COPY infra/cloud/platform
  // ./infra/cloud/platform), so the absolute path is the one that exists.
  command: ['nginx', '-c', '/app/infra/cloud/platform/nginx.conf', '-g', 'daemon off;'],
  port: ROUTER_PORT,
};

/**
 * Per-service Prisma migrations, run from the app's single
 * `release_command`. The three schemas are independent, so the order is a
 * convention (tasks-api first, matching today's deploy order), not a
 * correctness requirement.
 */
export const MIGRATION_STEPS = [
  { workspace: 'services/tasks-api', databaseUrlSource: 'PLATFORM_TASKS_API_DATABASE_URL' },
  { workspace: 'services/budget-api', databaseUrlSource: 'PLATFORM_BUDGET_API_DATABASE_URL' },
  {
    workspace: 'services/content-scheduler-api',
    databaseUrlSource: 'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
  },
];

/**
 * Variable names that belong to a child service and are therefore never
 * inherited from the app environment.
 *
 * The mapping targets are the names the services read today
 * (`DATABASE_URL`, `REDIS_URL`, `CONTENT_SCHEDULER_REDIS_URL`,
 * `CONTENT_SCHEDULER_API_BASE_URL`, `CORS_ALLOWED_ORIGINS`), plus `PORT`.
 * The per-service apps each carry a plain `REDIS_URL` secret, so it is
 * easy to register a bare `REDIS_URL` on the platform app; if it were
 * inherited, a missing `PLATFORM_*_REDIS_URL` would silently point three
 * of the four children at the wrong instance, with no error anywhere.
 * Stripping these names means "unset" always means absent, and a child
 * only ever sees the value its own `PLATFORM_*` source maps onto it.
 */
export const RESERVED_CHILD_VARIABLES = new Set([
  'PORT',
  ...new Set(CHILDREN.flatMap((child) => Object.keys(child.envMap ?? {}))),
]);

/**
 * Build the environment for one child.
 *
 * Rules:
 *   1. The parent (app) environment is inherited, minus every `PLATFORM_*`
 *      variable and minus every variable a child's own mapping owns — those
 *      are the platform's indirection layer and the services' own contract,
 *      and neither may leak into a child that has no business seeing them.
 *   2. The child's `defaults` are applied.
 *   3. The child's `envMap` is applied for every source that is present.
 *
 * @param {object} child   a CHILDREN entry
 * @param {object} parentEnv  the app-level environment
 * @returns {object} the child's environment
 */
export function buildChildEnv(child, parentEnv) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (key.startsWith('PLATFORM_')) continue;
    if (RESERVED_CHILD_VARIABLES.has(key)) continue;
    if (value === undefined) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(child.defaults ?? {})) {
    env[key] = value;
  }
  for (const [target, source] of Object.entries(child.envMap ?? {})) {
    const value = parentEnv?.[source];
    if (value === undefined || value === '') continue;
    env[target] = value;
  }
  return env;
}

/**
 * The app-level variables a child needs but that are missing. An empty
 * array means the child can start.
 *
 * @param {object} child        a CHILDREN entry
 * @param {object} parentEnv    the app-level environment
 * @returns {string[]} missing source names
 */
export function missingRequiredSources(child, parentEnv) {
  return (child.requiredSources ?? []).filter((source) => {
    const value = parentEnv?.[source];
    return value === undefined || value === '';
  });
}

/**
 * Does this value look like a Redis URL?
 *
 * The check is a protocol prefix, not `new URL()`: a Redis password may
 * carry characters that make `new URL()` throw, and a false negative here
 * would refuse to start a platform whose secret is perfectly valid.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeRedisUrl(value) {
  return /^rediss?:\/\/\S+$/i.test(value);
}

/**
 * Does this value look like a Postgres DSN?
 *
 * Protocol prefix only, for the same reason as the Redis check.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikePostgresUrl(value) {
  return /^postgres(?:ql)?:\/\/\S+$/i.test(value);
}

/**
 * The app-level variables a child needs that are PRESENT but not usable.
 *
 * A required source that exists but carries a placeholder passes the
 * presence check and then breaks the child at boot with an opaque error:
 * the platform app was seeded out of band with `REPLACE_ME_SEE_QUINN_NOTES`,
 * so tasks-api received that as REDIS_URL, rejected it as an invalid URL
 * and crash-looped. The shape is checked here so the platform refuses to
 * start with one clear message instead.
 *
 * @param {object} child        a CHILDREN entry
 * @param {object} parentEnv    the app-level environment
 * @returns {string[]} source names whose value has the wrong shape
 */
export function invalidRequiredSources(child, parentEnv) {
  return (child.requiredSources ?? []).filter((source) => {
    const value = parentEnv?.[source];
    if (value === undefined || value === '') return false;
    if (source.endsWith('_REDIS_URL')) return !looksLikeRedisUrl(value);
    if (source.endsWith('_DATABASE_URL')) return !looksLikePostgresUrl(value);
    return false;
  });
}

/**
 * Exponential backoff for a crashed child, capped so a permanently broken
 * child does not spin. First restart is immediate (a crash on boot is
 * usually a transient dependency race); the delay grows from there.
 *
 * @param {number} restarts  how many times the child has already restarted
 * @param {number} [baseMs]  initial delay
 * @param {number} [maxMs]   delay ceiling
 * @returns {number} delay in milliseconds
 */
export function backoffDelay(restarts, baseMs = 1000, maxMs = 30000) {
  if (restarts <= 1) return 0;
  const exponent = Math.min(restarts - 2, 10);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}
