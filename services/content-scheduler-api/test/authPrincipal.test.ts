// Runtime identity probe — GET /api/v1/auth/principal (task 3c004590).
//
// A deployment uses this endpoint to prove that every registered service
// credential still authenticates as its intended actor. It is non-mutating
// and returns ONLY the caller's own identity.
//
// Conventions follow the sibling suites in this service: supertest + vitest,
// plain `request(app)` for the rejection paths, a prisma mock plus a
// dynamic import of `../src/app.ts` AFTER the service-credential env var is
// set (the auth middleware parses it at module load), and no database
// access on any path.

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PROBE_TOKEN = 'principal-probe-token-long-enough';
const PROBE_ACTOR = 'PrincipalProbeActor';
const OTHER_TOKEN = 'other-configured-token-long-enough';
const OTHER_ACTOR = 'OtherConfiguredActor';

const ORIGINAL_CREDENTIALS =
  process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS;

// Two credentials are configured so the "no other actor leaks" assertion
// has something to assert against: the caller is PrincipalProbeActor and
// OtherConfiguredActor must never appear in the response.
process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS = JSON.stringify([
  { token: PROBE_TOKEN, actor: PROBE_ACTOR, approvalTypes: [] },
  { token: OTHER_TOKEN, actor: OTHER_ACTOR, approvalTypes: ['tech_design'] }
]);

const prismaMock: any = {
  contentSchedulerItem: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn()
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

describe('GET /api/v1/auth/principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no browser session row, so the cookie path never resolves
    // an actor and the Bearer path is the only way in.
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  afterAll(() => {
    if (ORIGINAL_CREDENTIALS === undefined) {
      delete process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS;
    } else {
      process.env.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS =
        ORIGINAL_CREDENTIALS;
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

  it('reports kind browser_session for a cookie session', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        id: '11111111-1111-1111-1111-111111111111',
        actor: 'BrowserSessionActor',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null
      }
    ]);

    const res = await request(createApp())
      .get('/api/v1/auth/principal')
      .set('Cookie', 'tasks_api_session=browser-session-token-long-enough');

    expect(res.status).toBe(200);
    expect(res.body.actor).toBe('BrowserSessionActor');
    // The `kind` discriminator comes from the middleware verbatim — it is
    // not a hardcoded string on this route.
    expect(res.body.kind).toBe('browser_session');
  });
});
