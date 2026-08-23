import { config } from './env.ts';

export {
  config,
  loadEnv,
  ConfigValidationError,
  type Env,
} from './env.ts';

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