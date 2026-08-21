import request from 'supertest';
import { authedRequest } from './helpers/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardPublish,
  getXClient,
  FakeXClient,
  RealXClient,
  checkActorSecret
} from '../src/routes/contentSchedulerPublish.ts';

// --- Prisma mock ---------------------------------------------------------

const prismaMock: any = {
  contentSchedulerItem: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn()
  },
  $transaction: vi.fn()
};

vi.mock('../src/lib/prisma.ts', () => ({
  prisma: prismaMock
}));

const { createApp } = await import('../src/app.ts');

function itemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    body: 'Hello world',
    source: 'manual',
    sourceRef: null,
    status: 'queued',
    scheduledFor: null,
    position: 0,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    publishedUrl: null,
    publishError: null,
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    removedAt: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cbOrOps: any) => {
    if (typeof cbOrOps === 'function') return cbOrOps(prismaMock);
    return Promise.all(cbOrOps);
  });
  // Default: empty queue for list endpoint
  prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
  prismaMock.contentSchedulerItem.aggregate.mockResolvedValue({ _max: { position: null } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Pure guardPublish tests ---------------------------------------------

describe('guardPublish', () => {
  const now = new Date('2026-07-10T08:00:00.000Z');

  it('returns ok when item is approved, no schedule, no day cap', () => {
    const result = guardPublish(
      itemFixture({ status: 'approved', approvedAt: now }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses NOT_APPROVED when item is queued', () => {
    const result = guardPublish(
      itemFixture({ status: 'queued' }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: false, code: 'NOT_APPROVED' });
  });

  it('refuses ALREADY_PUBLISHED when status is published', () => {
    const result = guardPublish(
      itemFixture({ status: 'published', approvedAt: now, publishedAt: now }),
      { publishedCount: 1, publishedItemId: itemFixture().id },
      now
    );
    expect(result).toEqual({ ok: false, code: 'ALREADY_PUBLISHED' });
  });

  it('refuses DAY_CAP_REACHED when a different item already published today', () => {
    const result = guardPublish(
      itemFixture({ id: 'aaaa', status: 'approved', approvedAt: now }),
      { publishedCount: 1, publishedItemId: 'bbbb' },
      now
    );
    expect(result).toEqual({ ok: false, code: 'DAY_CAP_REACHED' });
  });

  it('refuses SCHEDULED_IN_FUTURE when scheduledFor > now + 60s', () => {
    const future = new Date(now.getTime() + 5 * 60_000);
    const result = guardPublish(
      itemFixture({ status: 'approved', approvedAt: now, scheduledFor: future }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: false, code: 'SCHEDULED_IN_FUTURE' });
  });

  it('allows scheduledFor within the 60s grace window', () => {
    const future = new Date(now.getTime() + 30_000);
    const result = guardPublish(
      itemFixture({ status: 'approved', approvedAt: now, scheduledFor: future }),
      { publishedCount: 0, publishedItemId: null },
      now
    );
    expect(result).toEqual({ ok: true });
  });
});

// --- FakeXClient ----------------------------------------------------------

describe('FakeXClient', () => {
  it('returns a deterministic URL and a postedAt timestamp', async () => {
    const client = new FakeXClient();
    const a = await client.createTweet({ text: 'hello' });
    const b = await client.createTweet({ text: 'hello' });
    const c = await client.createTweet({ text: 'world' });
    expect(a.url).toMatch(/^https:\/\/x\.com\/sindustries\/status\/[0-9a-f]{16}$/);
    expect(a.url).toBe(b.url);
    expect(a.url).not.toBe(c.url);
    expect(a.postedAt).toBeInstanceOf(Date);
  });

  it('getTweetAuthor returns a deterministic fake handle', async () => {
    const client = new FakeXClient();
    const a = await client.getTweetAuthor('123');
    const b = await client.getTweetAuthor('123');
    const c = await client.getTweetAuthor('456');
    expect(a).toEqual(b);
    expect(a?.handle).not.toEqual(c?.handle);
    expect(a?.handle).toMatch(/^fake_author_[0-9a-f]{8}$/);
  });
});

// --- RealXClient ------------------------------------------------------------
//
// createTweet's JSON body previously double-stringified the `reply` field
// (`{reply: JSON.stringify({...})}` sent inside a JSON.stringify'd outer
// body, producing `"reply": "{\"in_reply_to_tweet_id\":...}"` — an escaped
// string, not the nested object X's API expects) and signed that same
// stringified value as an OAuth1.0a request parameter even though the
// request body is JSON, not form-urlencoded. Per the OAuth1.0a spec, only
// oauth_* params and (for GET) the query string belong in the signature
// base string for a non-form body — including body content there produces
// a signature X rejects with a generic 401. Both bugs were confirmed live
// against api.twitter.com on 2026-08-18 (a real reply attempt 401'd, and a
// corrected request with the same credentials succeeded through to X's own
// business-rule check). These tests guard the request *shape*; the
// signature math itself isn't independently re-derived here.
describe('RealXClient', () => {
  const client = new RealXClient('key', 'secret', 'token', 'tokenSecret', 'sindustries');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createTweet sends a properly-nested JSON body for a reply', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return {
          ok: true,
          json: async () => ({ data: { id: '999' } })
        } as Response;
      })
    );

    await client.createTweet({ text: 'hello', in_reply_to_tweet_id: '2087089133156208803' });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody as string);
    // The bug produced `reply` as an escaped JSON *string*; it must be a
    // nested object per X API v2's documented shape.
    expect(parsed).toEqual({
      text: 'hello',
      reply: { in_reply_to_tweet_id: '2087089133156208803' }
    });
  });

  it('createTweet omits reply entirely for a non-reply tweet', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return { ok: true, json: async () => ({ data: { id: '1' } }) } as Response;
      })
    );

    await client.createTweet({ text: 'no reply' });

    expect(JSON.parse(capturedBody as string)).toEqual({ text: 'no reply' });
  });

  it('getTweetAuthor resolves the handle from a v2 tweets-lookup response', async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { id: '2087089133156208803', text: '...' },
            includes: { users: [{ username: 'polydao' }] }
          })
        } as Response;
      })
    );

    const result = await client.getTweetAuthor('2087089133156208803');

    expect(result).toEqual({ handle: 'polydao' });
    expect(capturedUrl).toContain('/2/tweets/2087089133156208803');
    expect(capturedUrl).toContain('expansions=author_id');
    expect(capturedUrl).toContain('user.fields=username');
  });

  it('getTweetAuthor returns null on a 404 (deleted / not found)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '' }) as unknown as Response)
    );
    const result = await client.getTweetAuthor('999');
    expect(result).toBeNull();
  });

  it('getTweetAuthor returns null when the response has no users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: '999' }, includes: {} })
      }) as unknown as Response)
    );
    const result = await client.getTweetAuthor('999');
    expect(result).toBeNull();
  });

  it('getTweetAuthor throws on a non-404 error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }) as unknown as Response)
    );
    await expect(client.getTweetAuthor('999')).rejects.toThrow(/X API 500/);
  });
});

// --- getXClient selection -------------------------------------------------

describe('getXClient', () => {
  it('returns FakeXClient by default', () => {
    delete process.env.X_CLIENT;
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
    const client = getXClient();
    expect(client).toBeInstanceOf(FakeXClient);
  });

  it('returns FakeXClient when X_CLIENT=fake', () => {
    process.env.X_CLIENT = 'fake';
    const client = getXClient();
    expect(client).toBeInstanceOf(FakeXClient);
  });

  it('returns null when X_CLIENT=real and any OAuth 1.0a credential is missing', () => {
    process.env.X_CLIENT = 'real';
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
    expect(getXClient()).toBeNull();
  });

  it('returns null when X_CLIENT=real and only some OAuth 1.0a credentials are set', () => {
    process.env.X_CLIENT = 'real';
    process.env.X_API_KEY = 'k';
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
    expect(getXClient()).toBeNull();
    delete process.env.X_API_KEY;
  });

  it('returns RealXClient when X_CLIENT=real and all OAuth 1.0a creds are set', () => {
    process.env.X_CLIENT = 'real';
    process.env.X_API_KEY = 'k';
    process.env.X_API_SECRET = 's';
    process.env.X_ACCESS_TOKEN = 't';
    process.env.X_ACCESS_TOKEN_SECRET = 'ts';
    const client = getXClient();
    expect(client).toBeInstanceOf(RealXClient);
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
  });
});

// --- HTTP routes ----------------------------------------------------------

describe('checkActorSecret (cloud-readiness x-actor-secret gate)', () => {
  const originalSecret = process.env.X_ACTOR_SECRET;

  beforeEach(() => {
    delete process.env.X_ACTOR_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.X_ACTOR_SECRET;
    else process.env.X_ACTOR_SECRET = originalSecret;
  });

  it('passes through when X_ACTOR_SECRET is unset (dev / local / CI)', () => {
    delete process.env.X_ACTOR_SECRET;
    const result = checkActorSecret(undefined);
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('passes through when X_ACTOR_SECRET is set to an empty string', () => {
    process.env.X_ACTOR_SECRET = '';
    const result = checkActorSecret('any-value');
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('refuses with MISSING_HEADER when secret is set and header is absent', () => {
    process.env.X_ACTOR_SECRET = 's3cret-value';
    expect(checkActorSecret(undefined)).toEqual({ ok: false, reason: 'MISSING_HEADER' });
    expect(checkActorSecret(null)).toEqual({ ok: false, reason: 'MISSING_HEADER' });
    expect(checkActorSecret('')).toEqual({ ok: false, reason: 'MISSING_HEADER' });
  });

  it('refuses with MISMATCH when secret is set and header is wrong', () => {
    process.env.X_ACTOR_SECRET = 's3cret-value';
    expect(checkActorSecret('wrong-value')).toEqual({ ok: false, reason: 'MISMATCH' });
    // Different length always mismatches (no timingSafeEqual on different-length buffers).
    expect(checkActorSecret('x')).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('passes when secret is set and header matches exactly', () => {
    process.env.X_ACTOR_SECRET = 's3cret-value';
    expect(checkActorSecret('s3cret-value')).toEqual({ ok: true, configured: true });
  });

  it('passes when secret is set and header matches with non-ASCII (utf-8 normalized)', () => {
    process.env.X_ACTOR_SECRET = 'π-secret';
    expect(checkActorSecret('π-secret')).toEqual({ ok: true, configured: true });
  });
});

describe('contentScheduler routes', () => {
  it('GET /api/v1/content-scheduler/items lists non-removed items', async () => {
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([itemFixture()]);
    const app = createApp();
    const res = await authedRequest(app).get('/api/v1/content-scheduler/items');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(prismaMock.contentSchedulerItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { not: 'removed' } }) })
    );
  });

  it('GET /api/v1/content-scheduler/items rejects unknown status filter', async () => {
    const app = createApp();
    const res = await authedRequest(app).get('/api/v1/content-scheduler/items?status=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS_FILTER');
  });

  it('POST /api/v1/content-scheduler/items rejects empty body', async () => {
    const app = createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/items')
      .send({ body: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('POST /api/v1/content-scheduler/items rejects body > 1000 chars', async () => {
    const app = createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/items')
      .send({ body: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('POST /api/v1/content-scheduler/items creates with position after max', async () => {
    prismaMock.contentSchedulerItem.aggregate.mockResolvedValue({ _max: { position: 4 } });
    prismaMock.contentSchedulerItem.create.mockResolvedValue(itemFixture({ position: 5 }));
    const app = createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/items')
      .send({ body: 'Tweet body', source: 'ops_notes' });
    expect(res.status).toBe(201);
    expect(prismaMock.contentSchedulerItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 5, status: 'queued' }) })
    );
  });

  it('POST /content-scheduler/items/:id/approve sets approvedAt + approvedBy', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'queued' }));
    prismaMock.contentSchedulerItem.update.mockResolvedValue(itemFixture({ status: 'approved', approvedAt: new Date(), approvedBy: 'IntegrationTest' }));
    const app = createApp();
    // Per task 0719a8e3 (requireAuthenticatedUser + AC2 actor authority),
    // the authenticated actor overrides the x-actor audit-trail header.
    // authedRequest() authenticates as 'IntegrationTest' so the route
    // uses that as approvedBy and logs a warn about the header mismatch.
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/items/11111111-1111-1111-1111-111111111111/approve')
      .set('x-actor', 'Tom');
    expect(res.status).toBe(200);
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedBy: 'IntegrationTest', status: 'approved' })
      })
    );
  });

  it('POST /content-scheduler/items/:id/approve returns 409 on already published', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'published' }));
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/11111111-1111-1111-1111-111111111111/approve');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PUBLISHED');
  });

  it('POST /content-scheduler/items/:id/publish refuses NOT_APPROVED', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'queued' }));
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/11111111-1111-1111-1111-111111111111/publish');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_APPROVED');
  });

  it('POST /content-scheduler/items/:id/publish refuses DAY_CAP_REACHED', async () => {
    const itemId = 'aaaa1111-1111-1111-1111-111111111111';
    const otherId = 'bbbb1111-1111-1111-1111-111111111111';
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(
      itemFixture({ status: 'approved', approvedAt: new Date(), id: itemId })
    );
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([{ id: otherId }]);
    const app = createApp();
    const res = await authedRequest(app).post(`/api/v1/content-scheduler/items/${itemId}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DAY_CAP_REACHED');
  });

  it('POST /content-scheduler/items/:id/publish succeeds with fake client + sets publishedAt/Url', async () => {
    process.env.X_CLIENT = 'fake';
    const item = itemFixture({
      id: 'cccc1111-1111-1111-1111-111111111111',
      status: 'approved',
      approvedAt: new Date()
    });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]); // today-status empty
    prismaMock.contentSchedulerItem.update.mockResolvedValue({ ...item, status: 'published', publishedUrl: 'https://x.com/sindustries/status/abc', publishedAt: new Date() });
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/cccc1111-1111-1111-1111-111111111111/publish');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
    expect(res.body.data.publishedUrl).toMatch(/^https:\/\/x\.com\//);
  });

  it('POST /content-scheduler/items/:id/publish returns 503 when credentials missing', async () => {
    process.env.X_CLIENT = 'real';
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
    const item = itemFixture({
      id: 'dddd1111-1111-1111-1111-111111111111',
      status: 'approved',
      approvedAt: new Date()
    });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/dddd1111-1111-1111-1111-111111111111/publish');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
    delete process.env.X_CLIENT;
  });

  // --- x-actor-secret gate (cloud-readiness task 38d2ee65) -------------

  it('POST /content-scheduler/items/:id/publish returns 401 when X_ACTOR_SECRET is set and x-actor-secret header is missing', async () => {
    process.env.X_ACTOR_SECRET = 'deploy-secret';
    const itemId = 'eeee1111-1111-1111-1111-111111111111';
    const item = itemFixture({ id: itemId, status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    const app = createApp();
    const res = await authedRequest(app).post(`/api/v1/content-scheduler/items/${itemId}/publish`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/Missing x-actor-secret/i);
    // Gate fires before any DB load — prisma.findUnique is never called.
    expect(prismaMock.contentSchedulerItem.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.contentSchedulerItem.update).not.toHaveBeenCalled();
    delete process.env.X_ACTOR_SECRET;
  });

  it('POST /content-scheduler/items/:id/publish returns 401 when x-actor-secret header is wrong', async () => {
    process.env.X_ACTOR_SECRET = 'deploy-secret';
    const itemId = 'ffff1111-1111-1111-1111-111111111111';
    const item = itemFixture({ id: itemId, status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    const app = createApp();
    const res = await authedRequest(app)
      .post(`/api/v1/content-scheduler/items/${itemId}/publish`)
      .set('x-actor-secret', 'not-the-right-value');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/Invalid x-actor-secret/i);
    expect(prismaMock.contentSchedulerItem.findUnique).not.toHaveBeenCalled();
    delete process.env.X_ACTOR_SECRET;
  });

  it('POST /content-scheduler/items/:id/publish succeeds when x-actor-secret header matches', async () => {
    process.env.X_ACTOR_SECRET = 'deploy-secret';
    process.env.X_CLIENT = 'fake';
    const itemId = 'aaaa2222-1111-1111-1111-111111111111';
    const item = itemFixture({ id: itemId, status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    prismaMock.contentSchedulerItem.update.mockResolvedValue({
      ...item,
      status: 'published',
      publishedUrl: 'https://x.com/sindustries/status/abc',
      publishedAt: new Date()
    });
    const app = createApp();
    const res = await authedRequest(app)
      .post(`/api/v1/content-scheduler/items/${itemId}/publish`)
      .set('x-actor-secret', 'deploy-secret');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
    delete process.env.X_ACTOR_SECRET;
    delete process.env.X_CLIENT;
  });

  it('POST /content-scheduler/items/:id/publish gate stays pass-through when X_ACTOR_SECRET is unset (dev/local/CI)', async () => {
    delete process.env.X_ACTOR_SECRET;
    process.env.X_CLIENT = 'fake';
    const itemId = 'bbbb2222-1111-1111-1111-111111111111';
    const item = itemFixture({ id: itemId, status: 'approved', approvedAt: new Date() });
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(item);
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    prismaMock.contentSchedulerItem.update.mockResolvedValue({
      ...item,
      status: 'published',
      publishedUrl: 'https://x.com/sindustries/status/abc',
      publishedAt: new Date()
    });
    const app = createApp();
    // No x-actor-secret header sent — should still succeed because the gate is disabled.
    const res = await authedRequest(app).post(`/api/v1/content-scheduler/items/${itemId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
    delete process.env.X_CLIENT;
  });

  it('POST /content-scheduler/reorder writes positions in a transaction', async () => {
    const idA = 'aaaa1111-1111-1111-1111-111111111111';
    const idB = 'bbbb1111-1111-1111-1111-111111111111';
    const idC = 'cccc1111-1111-1111-1111-111111111111';
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([
      { id: idA, status: 'queued' },
      { id: idB, status: 'queued' },
      { id: idC, status: 'queued' }
    ]);
    prismaMock.contentSchedulerItem.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, position: data.position }));
    const app = createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/reorder')
      .send({ ids: [idC, idA, idB] });
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledTimes(3);
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: { position: 0 } }));
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: { position: 1 } }));
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenNthCalledWith(3, expect.objectContaining({ data: { position: 2 } }));
  });

  it('POST /content-scheduler/reorder refuses when an id is in a terminal status', async () => {
    const idA = 'aaaa1111-1111-1111-1111-111111111111';
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([
      { id: idA, status: 'published' }
    ]);
    const app = createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/reorder')
      .send({ ids: [idA] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TERMINAL_STATUS');
  });

  it('POST /content-scheduler/items/:id/remove soft-deletes to removed', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'queued' }));
    prismaMock.contentSchedulerItem.update.mockResolvedValue(itemFixture({ status: 'removed', removedAt: new Date() }));
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/11111111-1111-1111-1111-111111111111/remove');
    expect(res.status).toBe(200);
    expect(prismaMock.contentSchedulerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'removed' }) })
    );
  });

  it('POST /content-scheduler/items/:id/remove refuses when already published', async () => {
    prismaMock.contentSchedulerItem.findUnique.mockResolvedValue(itemFixture({ status: 'published' }));
    const app = createApp();
    const res = await authedRequest(app).post('/api/v1/content-scheduler/items/11111111-1111-1111-1111-111111111111/remove');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PUBLISHED');
  });

  it('GET /content-scheduler/today-status returns publishedCount + cap', async () => {
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([]);
    const app = createApp();
    const res = await authedRequest(app).get('/api/v1/content-scheduler/today-status');
    expect(res.status).toBe(200);
    expect(res.body.data.publishedCount).toBe(0);
    expect(res.body.data.cap).toBe(1);
    expect(typeof res.body.data.date).toBe('string');
  });
});