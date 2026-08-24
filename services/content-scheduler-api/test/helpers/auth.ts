// Test helper that injects the integration-test Bearer credential into every
// supertest call so a general-mutation auth gate accepts the request. Tests
// that need to assert rejection paths use plain `request(app)` instead.
//
// The credential must match the seeded entry in any test setup that gates on
// the Authorization header (`integration-test-token-long-enough`, actor
// "IntegrationTest"). Tests that mock prisma and want a different actor
// override this token at the call site with
// `.set('Authorization', 'Bearer <their-token>')`.
//
// NOTE: the extracted Content Scheduler service does not yet mount a
// `requireAuthenticatedUser` gate (see audit 2026-W35 finding T1.2), so
// this header is currently a no-op for these tests — it is included so
// that once T1.2 lands the test suite is already shaped correctly, and to
// match the helper contract used by the sibling tasks-api suite that
// these tests were extracted from.

import request from 'supertest';
import type { Express } from 'express';

export const INTEGRATION_TEST_BEARER = 'Bearer integration-test-token-long-enough';

export function authedRequest(app: Express) {
  const headers = { Authorization: INTEGRATION_TEST_BEARER };
  return {
    get: (path: string) => request(app).get(path).set(headers),
    post: (path: string) => request(app).post(path).set(headers),
    put: (path: string) => request(app).put(path).set(headers),
    patch: (path: string) => request(app).patch(path).set(headers),
    delete: (path: string) => request(app).delete(path).set(headers)
  };
}
