// Vitest setup — sets the minimum required env vars so config.ts doesn't
// refuse to boot during tests. Each test file can override what it needs.
//
// `setupFiles` runs once per test file before any imports, so this ensures
// DATABASE_URL is set before src/app.ts (which imports config) loads.

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:6432/sindustries_test?schema=tasks_api';
process.env.X_CLIENT = process.env.X_CLIENT ?? 'fake';
process.env.CONTENT_SCHEDULER_JOB_ADAPTER = process.env.CONTENT_SCHEDULER_JOB_ADAPTER ?? 'in-process';

// Ambient Clerk configuration must never reach a test process. A real
// production secret in the caller's environment would otherwise be loaded
// into config and could be echoed in assertion output. Suites that need
// Clerk set their own deterministic values after this file runs.
delete process.env.CLERK_SECRET_KEY;
delete process.env.CLERK_JWT_KEY;
delete process.env.TASKS_API_CLERK_ISSUER;
delete process.env.TASKS_API_CLERK_AUTHORIZED_USERS;
delete process.env.TASKS_API_CLERK_AUTHORIZED_PARTIES;
// Seed a default test service credential so the general-mutation auth gate
// (task 0719a8e3) accepts the integration tests' Bearer header. Tests that
// need to assert auth-rejection paths override TASKS_API_APPROVAL_SERVICE_CREDENTIALS
// before dynamically importing app.ts (see mutationAuthIntegration.test.ts).
process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS =
  process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS ??
  JSON.stringify([
    {
      token: 'integration-test-token-long-enough',
      actor: 'IntegrationTest',
      approvalTypes: []
    },
    {
      token: 'quinn-test-token-long-enough',
      actor: 'Quinn',
      approvalTypes: ['tech_design']
    }
  ]);
