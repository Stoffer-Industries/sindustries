// Vitest setup — sets the minimum required env vars so config.ts doesn't
// refuse to boot during tests. Each test file can override what it needs.
//
// `setupFiles` runs once per test file before any imports, so this ensures
// DATABASE_URL is set before src/app.ts (which imports config) loads.

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:6432/sindustries_test?schema=tasks_api';
process.env.X_CLIENT = process.env.X_CLIENT ?? 'fake';
process.env.CONTENT_SCHEDULER_JOB_ADAPTER = process.env.CONTENT_SCHEDULER_JOB_ADAPTER ?? 'in-process';
