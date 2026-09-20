// Vitest global setup.
//
// Seeds the integration-test service credential into process.env BEFORE
// any test file imports the app. The auth middleware
// (src/middleware/requireAuth.ts) parses
// CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS at module-load time
// and would fail-closed (401 on every gated write) if the var were
// unset at that point.
//
// The credential mirrors the seeded entry used by the tasks-api test
// suite (`services/tasks-api/test/setup.ts`) so the same Bearer token
// (`integration-test-token-long-enough`, actor "IntegrationTest")
// works across both services. Tests that need a different actor
// override the header at the call site with
// `.set('Authorization', 'Bearer <their-token>')`.
//
// DATABASE_URL is also seeded so test files that import `../src/app`
// (and therefore load `src/config/env.ts`) don't fail the env schema's
// `?schema=content_scheduler` check at module load. Tests that exercise
// the database override DATABASE_URL themselves; tests that only exercise
// the HTTP surface (e.g. test/health.test.ts) get a fake URL that never
// connects.
//
// Task: bd755ad4-314e-410d-84ec-0083178a7ea2 (W36 audit A1).
if (!process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS) {
  process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS =
    '[{"token":"integration-test-token-long-enough","actor":"IntegrationTest","approvalTypes":[]}]';
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgres://test:test@localhost:5432/test?schema=content_scheduler';
}
if (!process.env.CONTENT_SCHEDULER_JOB_ADAPTER) {
  process.env.CONTENT_SCHEDULER_JOB_ADAPTER = 'in-process';
}
