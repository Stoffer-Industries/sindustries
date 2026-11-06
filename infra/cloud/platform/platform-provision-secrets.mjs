#!/usr/bin/env node
/**
 * platform-provision-secrets.mjs — provision the consolidated Fly staging
 * platform (task 219fb673) from the staging GitHub environment secrets.
 *
 * WHY THIS EXISTS
 * ---------------
 * The consolidated platform app (`sindustries-platform-staging`) needs
 * twelve app-level secrets before it can boot: three database URLs, six
 * Redis URLs and two approval-service credentials. Until now those values
 * were registered out of band by hand, and the CI guard only checked that
 * the app EXISTS:
 *
 *     .github/workflows/deploy-staging-platform.yml
 *     -> "Check that the platform app is provisioned"
 *
 * So an app created without its secrets was deployable, the supervisor
 * refused to start ("refusing to start: missing app-level secrets"), and
 * the deploy failed with a crash loop that looked like a platform bug.
 *
 * The values themselves are not readable from a developer's machine: Fly
 * exposes per-secret digests, not values, and the local
 * `infra/cloud/.env.local` does NOT reproduce the live staging apps (its
 * Redis entries disagree with the live inventory — the live apps carry ONE
 * Redis instance, the local file carries two). The one place the live
 * staging values ARE readable is the `staging` GitHub environment, because
 * that is where they were written.
 *
 * So the mapping below is the source of record: staging GitHub environment
 * secret -> platform app-level Fly secret. The values are read in the
 * workflow, mapped here, and handed to `flyctl secrets set` WITHOUT ever
 * being printed, logged, committed or passed through a shell.
 *
 * THE TWELVE NAMES
 * -----------------
 * The names are settled by the live Fly secret inventory (task 219fb673,
 * 2026-11-06): every live per-service app's secret names, plus the
 * `PLATFORM_*` indirection the supervisor maps onto each child
 * (`infra/cloud/platform/platform-services.mjs`). The registry is the
 * contract; this file only fills it in.
 *
 *   PLATFORM_TASKS_API_DATABASE_URL                     <- tasks-api DATABASE_URL
 *   PLATFORM_BUDGET_API_DATABASE_URL                    <- budget-api DATABASE_URL
 *   PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL         <- content-scheduler/worker DATABASE_URL
 *   PLATFORM_TASKS_API_REDIS_URL                        <- tasks-api REDIS_URL
 *   PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL            <- content-scheduler-api REDIS_URL
 *   PLATFORM_AUTO_POST_WORKER_REDIS_URL                 <- worker REDIS_URL
 *   PLATFORM_TASKS_API_CONTENT_SCHEDULER_REDIS_URL          (same live value)
 *   PLATFORM_CONTENT_SCHEDULER_API_CONTENT_SCHEDULER_REDIS_URL (same live value)
 *   PLATFORM_AUTO_POST_WORKER_CONTENT_SCHEDULER_REDIS_URL     (same live value)
 *   PLATFORM_CONTENT_SCHEDULER_API_BASE_URL             (public URL, no secret value)
 *   TASKS_API_APPROVAL_SERVICE_CREDENTIALS              <- approval credential (inherited)
 *   CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS   <- approval credential (inherited)
 *
 * The two approval credentials keep their own names: they are inherited by
 * every child through the app environment, not mapped through a
 * `PLATFORM_*` source. Their VALUES are the raw tokens held in the staging
 * environment; the services expect a JSON array of
 * `{token, actor, approvalTypes}` (see the per-service env examples), so
 * the token is wrapped into that shape here.
 *
 * THE DATABASE MAPPING
 * --------------------
 * The three staging databases are ONE Neon database with THREE schemas
 * (`tasks_api`, `budget_api`, `content_scheduler`), confirmed by Quinn on
 * task 219fb673. The staging environment exposes no dedicated
 * content-scheduler DSN, so its URL is derived from the tasks-api DSN by
 * setting the `schema` query parameter to `content_scheduler` — same
 * database, different schema. The schema parameter is set explicitly for
 * every service, because Prisma picks the schema from the URL and a DSN
 * without one silently resolves to `public`.
 *
 * The credential-bearing part of a DSN is never re-encoded: the schema
 * parameter is rewritten textually, so a password containing reserved
 * characters survives the round trip untouched.
 */

import { spawnSync } from 'node:child_process';

export const PLATFORM_APP = 'sindustries-platform-staging';
export const DEFAULT_ORG = 'personal';
export const DEFAULT_REGION = 'syd';

/**
 * The staging GitHub environment secrets that carry the live values.
 *
 * `budgetDatabaseUrl` prefers the DSN that is already proven Prisma-ready
 * against the live budget database (cloud-staging-validate.yml drives
 * `prisma:migrate` with it); `budgetDatabaseUrlFallback` is the database
 * drill's source DSN for the same database.
 */
export const SOURCE_NAMES = {
  tasksDatabaseUrl: 'TASKS_API_SOURCE_DSN',
  budgetDatabaseUrl: 'STAGING_BUDGET_API_DATABASE_URL',
  budgetDatabaseUrlFallback: 'BUDGET_API_SOURCE_DSN',
  contentSchedulerDatabaseUrl: 'CONTENT_SCHEDULER_API_DATABASE_URL',
  redisUrl: 'HEALTH_PROBE_REDIS',
  tasksApprovalToken: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
  schedulerApprovalToken: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
};

/**
 * The public base URL tasks-api and the auto-post worker use to reach
 * content-scheduler-api. No service reads it today (it is in the env
 * contract for parity), so it is registered as a plain value, not sourced
 * from a secret.
 */
export const DEFAULT_CONTENT_SCHEDULER_API_BASE_URL =
  'https://content-scheduler-api.staging.sindustries.co.nz/api/v1';

/** The actors the staging service credentials act as. */
export const TASKS_APPROVAL_ACTOR = 'staging-cloud-validate';
export const SCHEDULER_APPROVAL_ACTOR = 'staging-cloud-validate';

/**
 * Parse a `label=value,label=value` list into its entries.
 *
 * The health probe's `HEALTH_PROBE_DATABASES` / `HEALTH_PROBE_REDIS`
 * secrets use this shape (`content-scheduler=rediss://…`). A bare value
 * with no label is accepted as a single entry with an empty label.
 *
 * @param {string} raw
 * @returns {{label: string, value: string}[]}
 */
export function parseLabeledEntries(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator === -1) return { label: '', value: entry };
      return { label: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
    })
    .filter((entry) => entry.value !== '');
}

/**
 * Pick the single Redis URL out of the health probe's Redis secret.
 *
 * The live staging apps all carry ONE Redis instance — confirmed by Fly's
 * own per-secret digests being equal across every Redis secret on every
 * app — so a probe secret with several DISTINCT values cannot be mapped
 * without guessing, and guessing would point a child at the wrong
 * instance. Fail loudly instead.
 *
 * @param {string} raw
 * @returns {string} the Redis URL
 */
export function pickRedisUrl(raw) {
  const entries = parseLabeledEntries(raw);
  if (entries.length === 0) {
    throw new Error('no Redis URL found in the Redis source secret');
  }
  const distinct = [...new Set(entries.map((entry) => entry.value))];
  if (distinct.length > 1) {
    throw new Error(
      `the Redis source secret holds ${distinct.length} distinct URLs (labels: ${entries
        .map((entry) => entry.label || '(unlabelled)')
        .join(', ')}) — one live instance is expected, so this cannot be mapped safely`
    );
  }
  return distinct[0];
}

/**
 * Rewrite a Postgres DSN so it names `schema`, keeping every other query
 * parameter and the credential part of the URL byte-for-byte.
 *
 * The rewrite is textual on purpose: `new URL(...).toString()` re-encodes
 * the password, which can change it for DSNs whose password contains
 * reserved characters.
 *
 * @param {string} dsn
 * @param {string} schema
 * @returns {string} the DSN with the schema parameter set
 */
export function deriveDatabaseUrl(dsn, schema) {
  if (typeof dsn !== 'string' || dsn.trim() === '') {
    throw new Error('empty database URL');
  }
  const value = dsn.trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new Error('database URL is not a postgres:// URL');
  }
  const separator = value.indexOf('?');
  const base = separator === -1 ? value : value.slice(0, separator);
  const query = separator === -1 ? '' : value.slice(separator + 1);
  const kept = query
    .split('&')
    .filter(Boolean)
    .filter((param) => !/^schema=/i.test(param));
  kept.push(`schema=${schema}`);
  return `${base}?${kept.join('&')}`;
}

/**
 * Wrap a raw approval token in the JSON array shape the services parse:
 * `[{token, actor, approvalTypes}]`.
 *
 * @param {string} token
 * @param {string} actor
 * @param {string[]} [approvalTypes]
 * @returns {string} the JSON array
 */
export function buildServiceCredentials(token, actor, approvalTypes = []) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('empty approval token');
  }
  return JSON.stringify([{ token: token.trim(), actor, approvalTypes }]);
}

/**
 * Build the platform app's secret payload from the staging environment.
 *
 * @param {Record<string, string|undefined>} env  the staging environment
 * @param {object} [options]
 * @returns {{secrets: {name: string, value: string, source: string}[], missing: string[], notes: string[]}}
 */
export function buildPlatformSecretPayload(env = {}, options = {}) {
  const {
    contentSchedulerApiBaseUrl = DEFAULT_CONTENT_SCHEDULER_API_BASE_URL,
    tasksApprovalActor = TASKS_APPROVAL_ACTOR,
    schedulerApprovalActor = SCHEDULER_APPROVAL_ACTOR,
  } = options;

  const secrets = [];
  const missing = [];
  const notes = [];

  const tasksDsn = env[SOURCE_NAMES.tasksDatabaseUrl];
  const budgetDsn = env[SOURCE_NAMES.budgetDatabaseUrl] || env[SOURCE_NAMES.budgetDatabaseUrlFallback];
  const budgetSource = env[SOURCE_NAMES.budgetDatabaseUrl]
    ? SOURCE_NAMES.budgetDatabaseUrl
    : env[SOURCE_NAMES.budgetDatabaseUrlFallback]
      ? SOURCE_NAMES.budgetDatabaseUrlFallback
      : null;
  const schedulerDsn = env[SOURCE_NAMES.contentSchedulerDatabaseUrl];
  const redisRaw = env[SOURCE_NAMES.redisUrl];
  const tasksToken = env[SOURCE_NAMES.tasksApprovalToken];
  const schedulerToken = env[SOURCE_NAMES.schedulerApprovalToken];

  // --- database URLs -------------------------------------------------
  if (!tasksDsn) missing.push(SOURCE_NAMES.tasksDatabaseUrl);
  if (!budgetDsn) {
    missing.push(SOURCE_NAMES.budgetDatabaseUrl);
    missing.push(SOURCE_NAMES.budgetDatabaseUrlFallback);
  }
  // The content-scheduler database has no dedicated staging DSN today; it
  // is derived from the tasks-api DSN (one database, three schemas). It
  // is only missing when neither source exists.
  if (!schedulerDsn && !tasksDsn) missing.push(SOURCE_NAMES.contentSchedulerDatabaseUrl);

  if (tasksDsn) {
    secrets.push({
      name: 'PLATFORM_TASKS_API_DATABASE_URL',
      value: deriveDatabaseUrl(tasksDsn, 'tasks_api'),
      source: SOURCE_NAMES.tasksDatabaseUrl,
    });
  }
  if (budgetDsn) {
    secrets.push({
      name: 'PLATFORM_BUDGET_API_DATABASE_URL',
      value: deriveDatabaseUrl(budgetDsn, 'budget_api'),
      source: budgetSource ?? SOURCE_NAMES.budgetDatabaseUrl,
    });
  }
  if (schedulerDsn) {
    secrets.push({
      name: 'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      value: deriveDatabaseUrl(schedulerDsn, 'content_scheduler'),
      source: SOURCE_NAMES.contentSchedulerDatabaseUrl,
    });
  } else if (tasksDsn) {
    // One Neon database, three schemas (Quinn, task 219fb673): the
    // content-scheduler schema lives in the same database as tasks_api.
    secrets.push({
      name: 'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL',
      value: deriveDatabaseUrl(tasksDsn, 'content_scheduler'),
      source: `${SOURCE_NAMES.tasksDatabaseUrl} (schema=content_scheduler)`,
    });
    notes.push(
      'PLATFORM_CONTENT_SCHEDULER_API_DATABASE_URL is derived from the tasks-api DSN with schema=content_scheduler; ' +
        `register the staging environment secret ${SOURCE_NAMES.contentSchedulerDatabaseUrl} to set it explicitly.`
    );
  }

  // --- redis --------------------------------------------------------
  let redisUrl = null;
  if (!redisRaw) {
    missing.push(SOURCE_NAMES.redisUrl);
  } else {
    try {
      redisUrl = pickRedisUrl(redisRaw);
    } catch (error) {
      throw new Error(`${SOURCE_NAMES.redisUrl}: ${error.message}`);
    }
  }
  if (redisUrl) {
    // Every live Redis secret on every live app carries the SAME value
    // (equal Fly digests), so all six names take it. Registering all six
    // reproduces the live per-service apps exactly.
    for (const name of [
      'PLATFORM_TASKS_API_REDIS_URL',
      'PLATFORM_TASKS_API_CONTENT_SCHEDULER_REDIS_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_REDIS_URL',
      'PLATFORM_CONTENT_SCHEDULER_API_CONTENT_SCHEDULER_REDIS_URL',
      'PLATFORM_AUTO_POST_WORKER_REDIS_URL',
      'PLATFORM_AUTO_POST_WORKER_CONTENT_SCHEDULER_REDIS_URL',
    ]) {
      secrets.push({ name, value: redisUrl, source: SOURCE_NAMES.redisUrl });
    }
  }

  // --- approval credentials (inherited names, unchanged) -------------
  if (!tasksToken) missing.push(SOURCE_NAMES.tasksApprovalToken);
  if (!schedulerToken) missing.push(SOURCE_NAMES.schedulerApprovalToken);
  if (tasksToken) {
    secrets.push({
      name: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
      value: buildServiceCredentials(tasksToken, tasksApprovalActor, []),
      source: SOURCE_NAMES.tasksApprovalToken,
    });
  }
  if (schedulerToken) {
    secrets.push({
      name: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS',
      value: buildServiceCredentials(schedulerToken, schedulerApprovalActor, ['any']),
      source: SOURCE_NAMES.schedulerApprovalToken,
    });
  }

  // --- public base URL ----------------------------------------------
  if (contentSchedulerApiBaseUrl) {
    secrets.push({
      name: 'PLATFORM_CONTENT_SCHEDULER_API_BASE_URL',
      value: contentSchedulerApiBaseUrl,
      source: 'workflow default (public URL, not a secret value)',
    });
  }

  return { secrets, missing: [...new Set(missing)], notes };
}

/**
 * Run a command without a shell and without echoing its arguments.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @returns {number} the exit code
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    console.error(`::error::${command} could not be run: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Does the Fly app exist?
 *
 * @param {string} app
 * @returns {boolean}
 */
export function appExists(app) {
  const result = spawnSync('flyctl', ['apps', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) return false;
  try {
    const apps = JSON.parse(result.stdout);
    return apps.some((entry) => entry?.Name === app);
  } catch {
    return false;
  }
}

/**
 * Create the Fly app when it does not exist yet.
 *
 * @param {string} app
 * @param {string} org
 * @param {string} region
 * @returns {number} exit code
 */
export function ensureApp(app, org, region) {
  if (appExists(app)) {
    console.log(`Fly app ${app} already exists`);
    return 0;
  }
  console.log(`Fly app ${app} does not exist — creating it in ${org}/${region}`);
  return run('flyctl', ['apps', 'create', '--org', org, '--region', region, app]);
}

/**
 * Register the payload on the Fly app.
 *
 * `--stage` sets the secrets without deploying, so the app is never left
 * running with a partial secret set: the deploy that follows is what
 * starts the Machine, and the supervisor refuses to boot without its
 * required sources.
 *
 * @param {string} app
 * @param {{name: string, value: string}[]} secrets
 * @returns {number} exit code
 */
export function applySecrets(app, secrets) {
  const args = ['secrets', 'set', '--app', app, '--stage'];
  for (const secret of secrets) args.push(`${secret.name}=${secret.value}`);
  console.log(`Registering ${secrets.length} secrets on ${app}`);
  return run('flyctl', args);
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  let app = PLATFORM_APP;
  let org = DEFAULT_ORG;
  let region = DEFAULT_REGION;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') app = argv[++index];
    else if (arg === '--org') org = argv[++index];
    else if (arg === '--region') region = argv[++index];
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node infra/cloud/platform/platform-provision-secrets.mjs [--app NAME] [--org ORG] [--region REGION] [--dry-run]'
      );
      return 0;
    } else {
      console.error(`::error::Unknown argument ${arg}`);
      return 2;
    }
  }

  let payload;
  try {
    payload = buildPlatformSecretPayload(process.env);
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }

  if (payload.missing.length > 0) {
    console.error(
      `::error::Missing staging environment secret(s): ${payload.missing.join(', ')}. ` +
        'Register them on the staging GitHub environment (Settings > Environments > staging > Environment secrets).'
    );
    return 1;
  }

  for (const note of payload.notes) console.log(`note: ${note}`);

  if (dryRun) {
    for (const secret of payload.secrets) {
      console.log(`${secret.name} <- ${secret.source}`);
    }
    console.log(`${payload.secrets.length} secrets would be registered on ${app}`);
    return 0;
  }

  const created = ensureApp(app, org, region);
  if (created !== 0) {
    console.error(`::error::Could not create Fly app ${app}; secrets were not registered`);
    return created;
  }

  return applySecrets(app, payload.secrets);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
