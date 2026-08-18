import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` runs before `vi.mock` factories, which Vitest also hoists.
// We need the spy/mock fn handles available when the factory for
// contentSchedulerPublish.ts runs.
const { createTweetSpy, getTweetAuthorSpy, getXClientMock } = vi.hoisted(() => {
  return {
    createTweetSpy: vi.fn(),
    getTweetAuthorSpy: vi.fn(),
    getXClientMock: vi.fn()
  };
});

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

// Mock the contentSchedulerPublish module so we can:
//  - Override getXClient() to return null (AC5) or our spy (200/502 paths)
//  - Observe the createTweet input the route forwards.
vi.mock('../src/routes/contentSchedulerPublish.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/routes/contentSchedulerPublish.ts')>(
    '../src/routes/contentSchedulerPublish.ts'
  );
  return {
    ...actual,
    getXClient: getXClientMock
  };
});

const { createApp } = await import('../src/app.ts');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cbOrOps: any) => {
    if (typeof cbOrOps === 'function') return cbOrOps(prismaMock);
    return Promise.all(cbOrOps);
  });
  // Default: route resolves the client; createTweet succeeds.
  createTweetSpy.mockResolvedValue({
    url: 'https://x.com/sindustries/status/abc123',
    postedAt: new Date('2026-07-19T00:00:00.000Z')
  });
  getTweetAuthorSpy.mockResolvedValue({ handle: 'polydao' });
  getXClientMock.mockReturnValue({
    createTweet: createTweetSpy,
    getTweetAuthor: getTweetAuthorSpy
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- POST /api/v1/x/tweets ------------------------------------------------

describe('POST /api/v1/x/tweets', () => {
  it('returns 200 with url + postedAt when client.createTweet succeeds', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'hello world', in_reply_to_tweet_id: '1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      url: 'https://x.com/sindustries/status/abc123',
      postedAt: '2026-07-19T00:00:00.000Z'
    });
    expect(createTweetSpy).toHaveBeenCalledWith({
      text: 'hello world',
      in_reply_to_tweet_id: '1234567890'
    });
  });

  it('passes in_reply_to_tweet_id=undefined when omitted', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'no reply' });
    expect(res.status).toBe(200);
    expect(createTweetSpy).toHaveBeenCalledWith({
      text: 'no reply',
      in_reply_to_tweet_id: undefined
    });
  });

  it('returns 503 MISSING_CREDENTIALS when getXClient() returns null', async () => {
    getXClientMock.mockReturnValue(null);
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'doomed', in_reply_to_tweet_id: '1' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
    // AC5: no upstream X HTTP call attempted.
    expect(createTweetSpy).not.toHaveBeenCalled();
  });

  it('returns 400 TWEET_TOO_LONG when text exceeds 280 chars', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'x'.repeat(281) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TWEET_TOO_LONG');
    expect(res.body.error.maxLength).toBe(280);
    expect(res.body.error.length).toBe(281);
    expect(createTweetSpy).not.toHaveBeenCalled();
  });

  it('accepts text exactly 280 chars', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'x'.repeat(280) });
    expect(res.status).toBe(200);
  });

  it('returns 400 INVALID_BODY when text is empty', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/x/tweets').send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
    expect(createTweetSpy).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_BODY when text is missing', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/x/tweets').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('returns 400 INVALID_BODY when in_reply_to_tweet_id is not a string', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'ok', in_reply_to_tweet_id: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('returns 502 X_API_ERROR when client.createTweet throws', async () => {
    createTweetSpy.mockRejectedValue(new Error('X API 503: upstream down'));
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'will fail' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('X_API_ERROR');
    expect(res.body.error.message).toMatch(/X API 503/);
  });

  it('returns 502 X_API_ERROR when client throws a non-Error value', async () => {
    createTweetSpy.mockRejectedValue('string-failure');
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/x/tweets')
      .send({ text: 'will fail' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('X_API_ERROR');
    expect(typeof res.body.error.message).toBe('string');
  });
});

// --- GET /api/v1/x/tweets/:id/author --------------------------------------

describe('GET /api/v1/x/tweets/:id/author', () => {
  it('returns 200 with the resolved handle', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/x/tweets/2087089133156208803/author');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ handle: 'polydao' });
    expect(getTweetAuthorSpy).toHaveBeenCalledWith('2087089133156208803');
  });

  it('returns 400 INVALID_TWEET_ID for a non-numeric id', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/x/tweets/not-a-number/author');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TWEET_ID');
    expect(getTweetAuthorSpy).not.toHaveBeenCalled();
  });

  it('returns 404 TWEET_NOT_FOUND when the client resolves null', async () => {
    getTweetAuthorSpy.mockResolvedValue(null);
    const app = createApp();
    const res = await request(app).get('/api/v1/x/tweets/999/author');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TWEET_NOT_FOUND');
  });

  it('returns 503 MISSING_CREDENTIALS when getXClient() returns null', async () => {
    getXClientMock.mockReturnValue(null);
    const app = createApp();
    const res = await request(app).get('/api/v1/x/tweets/999/author');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
    expect(getTweetAuthorSpy).not.toHaveBeenCalled();
  });

  it('returns 502 X_API_ERROR when client.getTweetAuthor throws', async () => {
    getTweetAuthorSpy.mockRejectedValue(new Error('X API 500: boom'));
    const app = createApp();
    const res = await request(app).get('/api/v1/x/tweets/999/author');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('X_API_ERROR');
    expect(res.body.error.message).toMatch(/X API 500/);
  });
});