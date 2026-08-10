// Production runtime configuration for tasks-api.
//
// Single source of truth for what tasks-api reads from the environment, and
// the single sanctioned entry point for service code. The shape (key name,
// type, optionality, cross-field constraints) is the contract; the secret
// manager (chosen by the sibling `cloud-deployment-foundation` task) only
// decides how the values reach the process.
//
// Fail-safe behaviour: if any required value is missing or malformed the
// process exits with a structured JSON log line that names the offending
// key(s) and the remediation hint. The exit is non-zero so an orchestrator
// (systemd, fly, k8s) can detect the misconfiguration and refuse to mark
// the deployment healthy. No secret values are ever logged.
//
// See docs/runbooks/production-runtime-config.md for the operator-facing
// view of this contract (every key, owner, rotation expectation, source of
// truth, failure mode). See docs/specs/cloud-readiness-production-runtime-
// configuration-tech-design.md for the design rationale.

import { z } from 'zod';

/**
 * JSON-string validator. Legacy approval config has been a JSON string in
 * env (serverless-friendly), so we keep the wire shape as a string and
 * validate the JSON structure without transforming — the redactor uses
 * the raw string to match against log rows.
 *
 * Validation reports two distinct error messages so callers can distinguish
 * "could not parse" from "valid JSON but not an array".
 */
function jsonStringSchema(ctxPath: string) {
  return z.string().default('[]').superRefine((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: `${ctxPath} must be valid JSON` });
      return;
    }
    if (!Array.isArray(parsed)) {
      ctx.addIssue({ code: 'custom', message: `${ctxPath} must be a JSON array` });
    }
  });
}

const CORS_ALLOWED_ORIGINS = z.string().default('').transform((raw) =>
  raw.split(',').map((s) => s.trim()).filter(Boolean)
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  ALLOW_PORT_DB_MISMATCH: z.enum(['0', '1']).optional(),

  DATABASE_URL: z.string().url().refine(
    (u) => new URL(u).protocol === 'postgresql:',
    'DATABASE_URL must be a postgresql:// URL'
  ),

  CORS_ALLOWED_ORIGINS,

  // Approval auth. Stored as JSON strings on the wire; parsed lazily by
  // the consumers (approvalAuth, approvalSessions) so the redactor can
  // match the raw string against log rows.
  TASKS_API_APPROVAL_USERS: jsonStringSchema('TASKS_API_APPROVAL_USERS'),
  TASKS_API_APPROVAL_SERVICE_CREDENTIALS: jsonStringSchema('TASKS_API_APPROVAL_SERVICE_CREDENTIALS'),
  TASKS_API_APPROVAL_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),

  // Content Scheduler — X (Twitter) publishing.
  X_CLIENT: z.enum(['fake', 'real']).default('fake'),
  X_API_KEY: z.string().min(1).optional(),
  X_API_SECRET: z.string().min(1).optional(),
  X_ACCESS_TOKEN: z.string().min(1).optional(),
  X_ACCESS_TOKEN_SECRET: z.string().min(1).optional(),
  X_ACTOR_SECRET: z.string().min(32, 'X_ACTOR_SECRET must be at least 32 chars; generate with openssl rand -hex 32').optional(),
  X_HANDLE: z.string().default('sindustries'),

  // Content Scheduler — auto-post job adapter.
  CONTENT_SCHEDULER_JOB_ADAPTER: z.enum(['in-process', 'bullmq']).default('in-process'),
  CONTENT_SCHEDULER_REDIS_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  // HTTP hardening.
  TASKS_API_JSON_LIMIT: z.string().default('100kb'),
  TASKS_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  TASKS_API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // OpenTelemetry — pass-through; the otel-node package reads these itself.
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_SERVICE_NAMESPACE: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_TRACES_EXPORTER: z.string().optional(),
  OTEL_METRICS_EXPORTER: z.string().optional(),
  OTEL_LOGS_EXPORTER: z.string().optional(),
  OTEL_ENVIRONMENT: z.string().optional(),
  OTEL_SDK_DISABLED: z.string().optional()
}).superRefine((cfg, ctx) => {
  if (cfg.X_CLIENT === 'real') {
    // X_ACTOR_SECRET is intentionally NOT in this list: it is an opt-in
    // x-actor-secret header gate for the content-scheduler X publish path
    // (see src/routes/contentSchedulerPublish.ts). When unset, that gate
    // passes through (dev / local / CI), matching the route contract
    // covered by test/contentScheduler.test.ts. Adding it here would
    // block boot whenever X_CLIENT=real without the secret configured
    // (e.g. the local prodlike .env, which intentionally omits it).
    for (const key of ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const) {
      if (!cfg[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when X_CLIENT=real`
        });
      }
    }
  }
  if (cfg.CONTENT_SCHEDULER_JOB_ADAPTER === 'bullmq' && !cfg.CONTENT_SCHEDULER_REDIS_URL && !cfg.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['CONTENT_SCHEDULER_REDIS_URL'],
      message: 'CONTENT_SCHEDULER_REDIS_URL or REDIS_URL is required when CONTENT_SCHEDULER_JOB_ADAPTER=bullmq'
    });
  }
  // DATABASE_URL must point to a tasks-api schema.
  const matched = /[?&]schema=([a-zA-Z0-9_-]+)/.exec(cfg.DATABASE_URL);
  if (!matched || matched[1] !== 'tasks_api') {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL must include ?schema=tasks_api (this service owns the tasks_api schema)'
    });
  }
});

/**
 * Names of every config field that holds a secret. Used by the logger
 * redactor (env.ts→redact()) and the /health handler to confirm no secret
 * value can reach a client-visible response. Keep this list in sync with
 * the schema; the test asserts coverage.
 */
export const TASKS_API_SECRET_KEYS = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
  'X_ACTOR_SECRET',
  'TASKS_API_APPROVAL_USERS',
  'TASKS_API_APPROVAL_SERVICE_CREDENTIALS',
  'DATABASE_URL'
] as const;

export type TasksApiSecretKey = (typeof TASKS_API_SECRET_KEYS)[number];

export class ConfigValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(`ConfigValidationError: tasks-api config validation failed: ${issues.length} issue(s) — ${summary}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

function parseConfig(): Readonly<z.infer<typeof schema>> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message
    }));
    // Structured log, NEVER includes values. Operator-facing.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'fatal',
      event: 'config_validation_failed',
      service: 'tasks-api',
      issues
    }));
    // Throw instead of calling process.exit so tests can assert on the
    // error and entry points (server.ts, autoPostWorkerMain.ts) can decide
    // whether to exit or surface the error to the user.
    throw new ConfigValidationError(issues);
  }
  return Object.freeze(parsed.data) as Readonly<z.infer<typeof schema>>;
}

// Boot-time snapshot. Stable reference for callers that read config
// per-request (middleware, routes) and want the values parsed at startup
// even if env is later mutated by tests or operational tooling. The
// frozen shape documents the contract: nothing mutates config in place.
export const config: Readonly<z.infer<typeof schema>> = parseConfig();

/**
 * Re-read `process.env` and return a fresh, validated config snapshot.
 *
 * Tests that mutate env vars after module load can use this in two
 * ways:
 *  - **Direct:** call `loadConfig()` to assert that the schema parses
 *    a mutated env the way you expect (e.g. config.test.ts).
 *  - **Indirect via `vi.resetModules()`:** tests that need the mutated
 *    env to flow into a downstream consumer (e.g. `createApp()` reading
 *    `TASKS_API_JSON_LIMIT` for the body parser, or
 *    `TASKS_API_RATE_LIMIT_MAX` for the write-endpoint limiter) call
 *    `vi.resetModules()` and re-import the consumer. The next import
 *    re-runs `parseConfig()` against the mutated env, so the boot-time
 *    `config` export gets re-bound with the mutated values.
 *
 * Production callers generally prefer the `config` export for the
 * stable boot-time snapshot — there is no production path that needs
 * `loadConfig()` today. Each call re-parses env (bounded cost: zod
 * schema of ~30 fields), so memoization isn't worth the cognitive
 * overhead of invalidating the cache in tests.
 */
export function loadConfig(): Readonly<z.infer<typeof schema>> {
  return parseConfig();
}

/**
 * Resolve the Redis URL in CONTENT_SCHEDULER_REDIS_URL → REDIS_URL → dev
 * default order. Lives as a helper next to the schema so the helper stays
 * in sync with the contract.
 */
export function resolveRedisUrl(): string {
  if (config.CONTENT_SCHEDULER_REDIS_URL) return config.CONTENT_SCHEDULER_REDIS_URL;
  if (config.REDIS_URL) return config.REDIS_URL;
  return 'redis://localhost:6379';
}

/**
 * Redact secret values from a structured log row. Used by the content
 * scheduler worker and any future logger. Returns a new object — never
 * mutates the input. The redactor is sourced from the schema rather than
 * a hard-coded list so the test for AC2 can rely on the schema as the
 * source of truth.
 */
export function redact<T extends Record<string, unknown>>(row: T): T {
  const secretValuesFor = (key: string): string[] => {
    if (!(TASKS_API_SECRET_KEYS as readonly string[]).includes(key)) return [];
    const value = (config as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return [value];
    return [];
  };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const secrets = secretValuesFor(key);
    if (secrets.length > 0 && typeof value === 'string') {
      let redacted = value;
      for (const secret of secrets) {
        if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
      }
      result[key] = redacted;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redact(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
