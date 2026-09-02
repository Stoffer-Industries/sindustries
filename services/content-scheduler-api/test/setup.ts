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
// Task: bd755ad4-314e-410d-84ec-0083178a7ea2 (W36 audit A1).
if (!process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS) {
  process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS =
    '[{"token":"integration-test-token-long-enough","actor":"IntegrationTest","approvalTypes":[]}]';
}
