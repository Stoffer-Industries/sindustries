// Runtime identity probe — GET /api/v1/auth/principal (task 3c004590).
//
// A deployment uses this endpoint to prove that every registered service
// credential still authenticates as its intended actor. It is non-mutating
// and returns ONLY the caller's own identity.
//
// Conventions follow the sibling suites in this service: supertest +
// vitest, plain `request(app)` for the rejection paths, a dynamic import
// of `../src/app.ts` AFTER the service-credential env var is set (the auth
// middleware parses it at module load), and a prisma mock so the
// cookie-session path never reaches a real database.

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyTokenMock } = vi.hoisted(() => ({ verifyTokenMock: vi.fn() }));
vi.mock('@clerk/backend', () => ({ verifyToken: verifyTokenMock }));

const PROBE_TOKEN = 'principal-probe-token-long-enough';
const PROBE_ACTOR = 'PrincipalProbeActor';
const OTHER_TOKEN = 'other-configured-token-long-enough';
const OTHER_ACTOR = 'OtherConfiguredActor';

const ORIGINAL_CREDENTIALS = process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;

// Two credentials are configured so the "no other actor leaks" assertion
// has something to assert against: the caller is PrincipalProbeActor and
// OtherConfiguredActor must never appear in the response.
process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  { token: PROBE_TOKEN, actor: PROBE_ACTOR, approvalTypes: [] },
  { token: OTHER_TOKEN, actor: OTHER_ACTOR, approvalTypes: ['tech_design'] }
]);
process.env.CLERK_JWT_KEY = 'test-public-key';
process.env.TASKS_API_CLERK_ISSUER = 'https://clerk.example.test';
process.env.TASKS_API_CLERK_AUTHORIZED_PARTIES = 'https://tasks.example.test';
process.env.TASKS_API_CLERK_AUTHORIZED_USERS = JSON.stringify([{ clerkUserId: 'user_tom', actor: 'Tom' }]);

const prismaMock: any = {
  approvalSession: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  task: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  taskComment: { create: vi.fn() },
  taskTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  tag: { findMany: vi.fn(), upsert: vi.fn() },
  taskDependency: { findFirst: vi.fn() },
  featureTaskAnalyticsEvent: { upsert: vi.fn() },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({ prisma: prismaMock }));

const { createApp } = await import('../src/app.ts');

describe('GET /api/v1/auth/principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyTokenMock.mockResolvedValue({ data: undefined, errors: [new Error('invalid')] });
  });

  afterAll(() => {
    if (ORIGINAL_CREDENTIALS === undefined) {
      delete process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
    } else {
      process.env.TASKS_API_APPROVAL_SERVICE_CREDENTIALS = ORIGINAL_CREDENTIALS;
    }
  });

  it('returns 200 with the caller actor and kind for a valid service credential', async () => {
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', `Bearer ${PROBE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.actor).toBe(PROBE_ACTOR);
    expect(res.body.kind).toBe('service');
  });

  it('returns 401 AUTH_REQUIRED for an unknown token', async () => {
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', 'Bearer not-a-registered-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(verifyTokenMock).toHaveBeenCalledWith('not-a-registered-token', expect.objectContaining({
      jwtKey: 'test-public-key',
      authorizedParties: ['https://tasks.example.test']
    }));
  });

  it('returns 401 AUTH_REQUIRED for a malformed Authorization header', async () => {
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', 'Basic YWxpY2U6c2VjcmV0');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 AUTH_REQUIRED without an Authorization header', async () => {
    const res = await request(createApp()).get('/api/v1/auth/principal');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('never returns token material, other actors, or approval types', async () => {
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', `Bearer ${PROBE_TOKEN}`);

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(PROBE_TOKEN);
    expect(serialized).not.toContain(OTHER_TOKEN);
    expect(serialized).not.toContain(OTHER_ACTOR);
    expect(serialized).not.toContain('tech_design');
    // The body carries the caller's own identity and nothing else.
    expect(Object.keys(res.body).sort()).toEqual(['actor', 'kind']);
  });

  it('maps a verified allowlisted Clerk subject to its Tasks actor', async () => {
    verifyTokenMock.mockResolvedValue({
      data: { sub: 'user_tom', iss: 'https://clerk.example.test' },
      errors: undefined
    });
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', 'Bearer clerk-session-jwt');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actor: 'Tom', kind: 'clerk_session' });
    expect(verifyTokenMock).toHaveBeenCalledWith('clerk-session-jwt', expect.objectContaining({
      jwtKey: 'test-public-key',
      authorizedParties: ['https://tasks.example.test']
    }));
  });

  it('returns 403 for a verified Clerk subject outside the product allowlist', async () => {
    verifyTokenMock.mockResolvedValue({
      data: { sub: 'user_other', iss: 'https://clerk.example.test' },
      errors: undefined
    });
    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Authorization', 'Bearer clerk-session-jwt');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });
});


describe('GET /api/v1/auth/session', () => {
  it('returns the mapped actor and approval capabilities for an authenticated browser client', async () => {
    const res = await request(createApp())
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${PROBE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        actor: PROBE_ACTOR,
        displayName: PROBE_ACTOR,
        approvalTypes: []
      }
    });
  });

  it.each(['post', 'delete'])('leaves retired %s session lifecycle routes unmounted', async (method) => {
    const res = await request(createApp())[method]('/api/v1/auth/session')
      .set('Authorization', `Bearer ${PROBE_TOKEN}`);

    expect(res.status).toBe(404);
  });
});
