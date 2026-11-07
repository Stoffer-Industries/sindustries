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
 * THE DATABASE MAPPING — WRITE-CAPABLE SOURCES ONLY
 * --------------------------------------------------
 * The three staging databases are ONE Neon database with THREE schemas
 * (`tasks_api`, `budget_api`, `content_scheduler`), confirmed by Quinn on
 * task 219fb673.
 *
 * Every database source below MUST be a write-capable DSN. The platform
 * runs `prisma migrate deploy` in its `release_command` and the services
 * write normally, so a read-only role cannot satisfy the contract: the
 * first deploy would fail in the release/migration phase, and even with
 * migrations skipped the service could not perform a normal write.
 *
 * That rules out the database drill's `TASKS_API_SOURCE_DSN` and
 * `BUDGET_API_SOURCE_DSN`: those are the drill's READ-ONLY source DSNs
 * (.github/workflows/cloud-staging-db-drill.yml and
 * docs/runbooks/staging-database-migration-restore.md §1), and using them
 * here would discover the read-only role only on the first live deploy.
 * The sources are therefore the dedicated, write-capable staging DSNs —
 * `STAGING_TASKS_API_DATABASE_URL` and `STAGING_BUDGET_API_DATABASE_URL` —
 * and the script FAILS CLOSED when either is absent rather than falling
 * back to a read-only DSN.
 *
 * The staging environment exposes no dedicated content-scheduler DSN, so
 * that schema's URL is derived from the tasks-api DSN by setting the
 * `schema` query parameter to `content_scheduler` — same database,
 * different schema. The schema parameter is set explicitly for every
 * service, because Prisma picks the schema from the URL and a DSN without
 * one silently resolves to `public`.
 *
 * The credential-bearing part of a DSN is never re-encoded: the schema
 * parameter is rewritten textually, so a password containing reserved
 * characters survives the round trip untouched.
 *
 * THE CLI SEAM
 * ------------
 * Every process spawn and every log line goes through the IO object built
 * by `createIo()`. The CLI-level test drives the REAL code path with a
 * stubbed `flyctl` and asserts on exactly what the script would print —
 * which is what makes "no secret value reaches stdout/stderr" a checked
 * property rather than a hope.
 */

import { spawnSync } from 'node:child_process';

import { looksLikeRedisUrl } from './platform-services.mjs';

export const PLATFORM_APP = 'sindustries-platform-staging';
export const DEFAULT_ORG = 'personal';

/**
 * The staging GitHub environment secrets that carry the live values.
 *
 * The two database sources are write-capable on purpose — see the header
 * block. `contentSchedulerDatabaseUrl` is optional: when it is absent the
 * content-scheduler schema is derived from the tasks-api DSN (one Neon
 * database, three schemas).
 */
export const SOURCE_NAMES = {
  tasksDatabaseUrl: 'STAGING_TASKS_API_DATABASE_URL',
  budgetDatabaseUrl: 'STAGING_BUDGET_API_DATABASE_URL',
  contentSchedulerDatabaseUrl: 'STAGING_CONTENT_SCHEDULER_API_DATABASE_URL',
  redisUrl: 'HEALTH_PROBE_REDIS',
  tasksApprovalToken: 'TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
  schedulerApprovalToken: 'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN',
};

/**
 * The database sources that must be present and write-capable.
 *
 * The script fails closed when one of them is missing: there is no
 * read-only fallback, because a read-only role cannot run the platform's
 * migrations and would be discovered only on the first live deploy.
 */
export const REQUIRED_DATABASE_SOURCES = [
  SOURCE_NAMES.tasksDatabaseUrl,
  SOURCE_NAMES.budgetDatabaseUrl,
];

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
 * Build the IO seam: the process spawner and the log sinks.
 *
 * Defaults are the real process; the CLI-level test overrides them with a
 * stubbed `flyctl` and in-memory log sinks.
 *
 * @param {object} [overrides]
 * @param {Record<string, string|undefined>} [overrides.env]
 * @param {Function} [overrides.spawn]
 * @param {(message: string) => void} [overrides.log]
 * @param {(message: string) => void} [overrides.errorLog]
 * @returns {{env: Record<string, string|undefined>, spawn: Function, log: Function, errorLog: Function}}
 */
export function createIo(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    spawn: overrides.spawn ?? spawnSync,
    log: overrides.log ?? ((message) => console.log(message)),
    errorLog: overrides.errorLog ?? ((message) => console.error(message)),
  };
}

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
  if (distinct.some((value) => !looksLikeRedisUrl(value))) {
    throw new Error(
      'the Redis source secret does not contain a usable redis:// or rediss:// URL',
    );
  }
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
 * Mask anything that could be a credential before it is written to a log.
 *
 * The staging GitHub environment masks its OWN secret values in the CI log,
 * but not the values this script DERIVES: a schema-rewritten DSN, a
 * JSON-wrapped approval token. So anything the script echoes back from the
 * `flyctl` child process goes through here first.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactOutput(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    // URL credentials: postgres://user:password@host -> postgres://[redacted]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    // JSON credential fields: {"token":"..."} -> {"token":"[redacted]"}
    .replace(/("(?:token|password|secret|dsn|value)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    // Secret assignments: NAME=value -> NAME=[redacted]
    .replace(/\b([A-Z][A-Z0-9_]{2,})=[^\s]+/g, '$1=[redacted]');
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
  const budgetDsn = env[SOURCE_NAMES.budgetDatabaseUrl];
  const schedulerDsn = env[SOURCE_NAMES.contentSchedulerDatabaseUrl];
  const redisRaw = env[SOURCE_NAMES.redisUrl];
  const tasksToken = env[SOURCE_NAMES.tasksApprovalToken];
  const schedulerToken = env[SOURCE_NAMES.schedulerApprovalToken];

  // --- database URLs -------------------------------------------------
  // Write-capable sources only. A missing source is a hard stop: there is
  // deliberately no read-only fallback, because a read-only role cannot
  // run the platform's migrations or a normal service write.
  if (!tasksDsn) missing.push(SOURCE_NAMES.tasksDatabaseUrl);
  if (!budgetDsn) missing.push(SOURCE_NAMES.budgetDatabaseUrl);
  // The content-scheduler database has no dedicated staging DSN today; it
  // is derived from the tasks-api DSN (one database, three schemas). It
  // is only missing when the tasks-api source itself is missing.
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
      source: SOURCE_NAMES.budgetDatabaseUrl,
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
 * Run `flyctl` and capture its output.
 *
 * The child's output is captured rather than inherited so that nothing the
 * child prints can be echoed by this script: a derived secret value
 * (a schema-rewritten DSN, a JSON-wrapped approval token) is not masked
 * by GitHub, so the script never re-emits anything it did not construct
 * itself.
 *
 * @param {string[]} args
 * @param {object} io
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function flyctl(args, io) {
  const result = io.spawn('flyctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    io.errorLog(`::error::flyctl could not be run: ${result.error.message}`);
    return { status: 1, stdout: '', stderr: '' };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Does the Fly app exist?
 *
 * @param {string} app
 * @param {object} [io]
 * @returns {boolean}
 */
export function appExists(app, io = createIo()) {
  const { status, stdout } = flyctl(['apps', 'list', '--json'], io);
  if (status !== 0 || !stdout) {
    io.log(`Could not read the Fly app list (exit ${status}) — assuming ${app} is absent`);
    return false;
  }
  try {
    const apps = JSON.parse(stdout);
    // Fly's `apps list --json` schema uses `Name`; some sandboxed CLIs
    // return `name`. Tolerate both, and match EXACTLY: a same-prefix app
    // (`<app>-extra`) is not this app.
    return apps.some((entry) => (entry?.Name ?? entry?.name) === app);
  } catch {
    io.log(`Could not parse the Fly app list — assuming ${app} is absent`);
    return false;
  }
}

/**
 * Create the Fly app when it does not exist yet.
 *
 * The app name is passed POSITIONALLY: `flyctl apps create <name>`. The
 * pinned flyctl 0.4.102 accepts `--name`, `--generate-name`, `--network`,
 * `--machines`, `--yes`, `--save`, `--org` and `--json` — and no
 * `--region`, so a `--region` flag fails on the unknown flag before the
 * app is created. The region belongs to `platform.fly.toml`'s
 * `primary_region`, not to the create command.
 *
 * @param {string} app
 * @param {string} org
 * @param {object} [io]
 * @returns {number} exit code
 */
export function ensureApp(app, org, io = createIo()) {
  if (appExists(app, io)) {
    io.log(`Fly app ${app} already exists`);
    return 0;
  }
  io.log(`Fly app ${app} does not exist — creating it in org ${org}`);
  const { status, stderr } = flyctl(['apps', 'create', app, '--org', org, '--yes'], io);
  if (status !== 0) {
    io.errorLog(
      `::error::flyctl apps create ${app} failed with exit code ${status}` +
        (stderr ? `\n${redactOutput(stderr)}` : '')
    );
    return status;
  }
  io.log(`Fly app ${app} created`);
  return 0;
}

/**
 * Register the payload on the Fly app.
 *
 * The values are set DIRECTLY, not with `--stage`.
 *
 * `--stage` holds the values for the next release, and on the live
 * platform Machine that never happened: the deploy created the canary
 * Machine, and that Machine still carried the placeholder
 * (`REPLACE_ME_SEE_QUINN_NOTES`) that had been registered out of band.
 * The platform booted with a placeholder Redis URL, tasks-api rejected it
 * as an invalid URL and crash-looped, while `fly secrets list` showed the
 * staged values sitting on the app. Setting the values directly makes
 * them the app's live values, so every Machine -- including the one the
 * deploy creates -- starts with them.
 *
 * The write is DETACHED, so it is not health-gated on the image that is
 * currently running.
 *
 * `flyctl secrets set` does not just write the values: it also restarts
 * the app's Machines, and in the flyctl the deploy workflow pins (0.4.102)
 * that restart is a full Machine deployment whose progress flyctl follows.
 * When the running image is unhealthy -- exactly the state a deploy is
 * meant to repair -- the follow fails, `flyctl secrets set` exits
 * non-zero, and the workflow aborts BEFORE the canary deploy that carries
 * the fix. That is not a hypothetical: main CI run 42366203146 on merge
 * commit 27269dbb failed in the "Provision the platform app and its
 * secrets" step for exactly this reason. The Machine was listening on the
 * supervisor's 8081 and the children's 4001/4002/4003 but not on
 * 0.0.0.0:8080 (the router did not bind), so the health-gated restart
 * could not pass and the run never reached "Deploy (canary)" -- the step
 * that would have installed the fixed image.
 *
 * `--detach` removes that coupling. Upstream flyctl 0.4.102
 * (`internal/command/secrets/secrets.go`, `DeploySecrets`) passes
 * `SkipHealthChecks: args.Detach` and `SkipDNSChecks: args.Detach ||
 * !args.CheckDNS` to the restart-only Machine deployment, so the command
 * returns once the restart is issued instead of waiting for the running
 * image to become healthy. The health gate belongs to the deploy step
 * that follows: it installs the new image and the workflow's smoke checks
 * are what decide whether the platform serves.
 *
 * The write still fails closed on a real failure: a non-zero exit from
 * flyctl (a rejected value, an auth error, an API error) is still an
 * error, and the read-back below still fails when a secret NAME did not
 * land on the app.
 *
 * @param {string} app
 * @param {{name: string, value: string}[]} secrets
 * @param {object} [io]
 * @returns {number} exit code
 */
export function applySecrets(app, secrets, io = createIo()) {
  const args = ['secrets', 'set', '--app', app, '--detach'];
  for (const secret of secrets) args.push(`${secret.name}=${secret.value}`);
  io.log(`Registering ${secrets.length} secrets on ${app}`);
  const { status, stderr } = flyctl(args, io);
  if (status !== 0) {
    io.errorLog(
      `::error::flyctl secrets set on ${app} failed with exit code ${status}` +
        (stderr ? `\n${redactOutput(stderr)}` : '')
    );
    return status;
  }
  return verifySecretsRegistered(app, secrets, io);
}

/**
 * Read the app's registered secret names back and confirm every one of
 * them landed.
 *
 * `flyctl secrets set` exiting 0 says the command was accepted, not that
 * every name landed -- and a name that silently did not land is exactly
 * the failure this script exists to prevent.
 *
 * @param {string} app
 * @param {{name: string, value: string}[]} secrets
 * @param {object} [io]
 * @returns {number} exit code
 */
export function verifySecretsRegistered(app, secrets, io = createIo()) {
  const { status, stdout, stderr } = flyctl(['secrets', 'list', '--app', app, '--json'], io);
  if (status !== 0) {
    io.errorLog(
      `::error::could not read the secret list back from ${app} (exit ${status})` +
        (stderr ? `\n${redactOutput(stderr)}` : '')
    );
    return 1;
  }
  let registered = [];
  try {
    const parsed = JSON.parse(stdout);
    registered = (Array.isArray(parsed) ? parsed : [])
      .map((entry) => entry?.Name ?? entry?.name)
      .filter(Boolean);
  } catch {
    io.errorLog(`::error::could not parse the secret list read back from ${app}`);
    return 1;
  }
  const absent = secrets.map((secret) => secret.name).filter((name) => !registered.includes(name));
  if (absent.length > 0) {
    io.errorLog(
      `::error::${absent.length} secret(s) did not register on ${app}: ${absent.join(', ')}`,
    );
    return 1;
  }
  io.log(`Verified ${secrets.length} secret name(s) registered on ${app}`);
  return 0;
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @param {object} [overrides] the IO overrides (env, spawn, log, errorLog)
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), overrides = {}) {
  const io = createIo(overrides);

  let app = PLATFORM_APP;
  let org = DEFAULT_ORG;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') app = argv[++index];
    else if (arg === '--org') org = argv[++index];
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      io.log(
        'Usage: node infra/cloud/platform/platform-provision-secrets.mjs [--app NAME] [--org ORG] [--dry-run]'
      );
      return 0;
    } else {
      io.errorLog(`::error::Unknown argument ${arg}`);
      return 2;
    }
  }

  let payload;
  try {
    payload = buildPlatformSecretPayload(io.env);
  } catch (error) {
    io.errorLog(`::error::${error.message}`);
    return 1;
  }

  if (payload.missing.length > 0) {
    io.errorLog(
      `::error::Missing staging environment secret(s): ${payload.missing.join(', ')}. ` +
        'Register them on the staging GitHub environment (Settings > Environments > staging > Environment secrets). ' +
        `The database sources (${REQUIRED_DATABASE_SOURCES.join(', ')}) must be WRITE-CAPABLE: the platform runs ` +
        'prisma migrate deploy in its release command and the services write normally. The database drill\'s ' +
        'read-only source DSNs (TASKS_API_SOURCE_DSN, BUDGET_API_SOURCE_DSN) are not valid sources for this app.'
    );
    return 1;
  }

  for (const note of payload.notes) io.log(`note: ${note}`);

  if (dryRun) {
    for (const secret of payload.secrets) {
      io.log(`${secret.name} <- ${secret.source}`);
    }
    io.log(`${payload.secrets.length} secrets would be registered on ${app}`);
    return 0;
  }

  const created = ensureApp(app, org, io);
  if (created !== 0) {
    io.errorLog(`::error::Could not create Fly app ${app}; secrets were not registered`);
    return created;
  }

  return applySecrets(app, payload.secrets, io);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
