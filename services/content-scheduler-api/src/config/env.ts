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
    console.error(
      `[content-scheduler-api] Invalid environment configuration:\n${issues}`,
    );
    throw new ConfigValidationError('Invalid environment configuration');
  }
  _cached = parsed.data;
  return _cached;
}

export const config = loadEnv();
