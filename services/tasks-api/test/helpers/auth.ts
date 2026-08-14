// Test helper that injects the integration-test Bearer credential into every
// supertest call so the general-mutation auth gate (task 0719a8e3) accepts
// the request. Tests that need to assert rejection paths use plain
// `request(app)` instead.
//
// The credential must match the seeded entry in setup.ts
// (`integration-test-token-long-enough` / actor "IntegrationTest"). Tests
// that mock prisma and want a different actor override this token at the
// call site with `.set('Authorization', 'Bearer <their-token>')`.

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
