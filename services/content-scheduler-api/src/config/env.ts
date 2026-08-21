import 'dotenv/config';
import { z } from 'zod';

const CsvList = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

const envSchema = z.object({
  PORT: z
    .string()
    .default('4003')
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.number().int().positive()),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (Content Scheduler Postgres connection).'),
  CORS_ALLOWED_ORIGINS: CsvList,
  CONTENT_SCHEDULER_API_RATE_LIMIT_WINDOW_MS: z
    .string()
    .default('60000')
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.number().int().positive()),
  CONTENT_SCHEDULER_API_RATE_LIMIT_MAX: z
    .string()
    .default('120')
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.number().int().positive()),

  // Content Scheduler — X (Twitter) publishing.
  X_CLIENT: z.enum(['fake', 'real']).default('fake'),
  X_API_KEY: z.string().min(1).optional(),
  X_API_SECRET: z.string().min(1).optional(),
  X_ACCESS_TOKEN: z.string().min(1).optional(),
  X_ACCESS_TOKEN_SECRET: z.string().min(1).optional(),
  X_ACTOR_SECRET: z
    .string()
    .min(32, 'X_ACTOR_SECRET must be at least 32 chars; generate with openssl rand -hex 32')
    .optional(),
  X_HANDLE: z.string().default('sindustries'),

  // Content Scheduler — trusted internal batch import (CTO Craft LangGraph
  // pipeline; see task 9dfe56e4). When set, callers MUST send a matching
  // x-content-ingest-secret header on POST /api/v1/content-scheduler/imports.
  // When UNSET (dev / local / CI), the import gate is pass-through so
  // local workflows stay usable.
  CONTENT_SCHEDULER_INGEST_SECRET: z
    .string()
    .min(32, 'CONTENT_SCHEDULER_INGEST_SECRET must be at least 32 chars; generate with openssl rand -hex 32')
    .optional(),

  // Content Scheduler — auto-post job adapter.
  CONTENT_SCHEDULER_JOB_ADAPTER: z.enum(['in-process', 'bullmq']).default('in-process'),
  CONTENT_SCHEDULER_REDIS_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  // OpenTelemetry — pass-through; the otel-node package reads these itself.
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_SERVICE_NAMESPACE: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_TRACES_EXPORTER: z.string().optional(),
  OTEL_METRICS_EXPORTER: z.string().optional(),
  OTEL_LOGS_EXPORTER: z.string().optional(),
  OTEL_ENVIRONMENT: z.string().optional(),
  OTEL_SDK_DISABLED: z.string().optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.X_CLIENT === 'real') {
    for (const key of ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const) {
      if (!cfg[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when X_CLIENT=real`,
        });
      }
    }
  }
  if (cfg.CONTENT_SCHEDULER_JOB_ADAPTER === 'bullmq' && !cfg.CONTENT_SCHEDULER_REDIS_URL && !cfg.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['CONTENT_SCHEDULER_REDIS_URL'],
      message: 'CONTENT_SCHEDULER_REDIS_URL or REDIS_URL is required when CONTENT_SCHEDULER_JOB_ADAPTER=bullmq',
    });
  }
  // DATABASE_URL must point to the content_scheduler schema.
  const matched = /[?&]schema=([a-zA-Z0-9_-]+)/.exec(cfg.DATABASE_URL);
  if (!matched || matched[1] !== 'content_scheduler') {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL must include ?schema=content_scheduler (this service owns the content_scheduler schema)',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

let _cached: Env | null = null;

export function loadEnv(): Env {
  if (_cached) return _cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`[content-scheduler-api] Invalid environment configuration:\n${issues}`);
    throw new ConfigValidationError('Invalid environment configuration');
  }
  _cached = parsed.data;
  return _cached;
}

export const config = loadEnv();