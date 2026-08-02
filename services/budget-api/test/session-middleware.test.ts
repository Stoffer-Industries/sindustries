import request from 'supertest';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetKeyCacheForTests,
  __setKeyForTests,
  decryptToken
} from '../src/lib/secretBox';

const mocks = vi.hoisted(() => ({
  prisma: {
    session: { findUnique: vi.fn() },
    linkedCard: { findMany: vi.fn() },
    akahuConnection: { upsert: vi.fn() }
  },
  exchangeAuthorizationCode: vi.fn()
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/akahuClient.ts', () => ({
  exchangeAuthorizationCode: mocks.exchangeAuthorizationCode
}));

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';

const SESSION = { id: 'session_1', userId: 'user_1' };
const TOKEN = 'test-token-1';
const TOKEN_HASH = hashSessionToken(TOKEN);

describe('requireSession middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.linkedCard.findMany.mockResolvedValue([]);
    // Default: token resolves to user_1's session.
    mocks.prisma.session.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash && args.where.tokenHash === TOKEN_HASH) {
        return SESSION;
      }
      if (args?.where?.id && args.where.id === SESSION.id) {
        return {
          ...SESSION,
          user: { id: SESSION.userId, email: 'user@example.com' }
        };
      }
      return null;
    });
  });

  describe('rejects without a valid Bearer token', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(createApp()).get('/api/v1/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(mocks.prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is not Bearer', async () => {
      const res = await request(createApp())
        .get('/api/v1/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
      expect(mocks.prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token is empty', async () => {
      const res = await request(createApp())
        .get('/api/v1/me')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
    });

    it('returns 401 when the token does not match any session', async () => {
      const res = await request(createApp())
        .get('/api/v1/me')
        .set('Authorization', 'Bearer bogus-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(mocks.prisma.session.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: hashSessionToken('bogus-token') },
        select: { id: true, userId: true }
      });
    });
  });

  describe('attaches req.session and calls next() with a valid token', () => {
    it('GET /me returns 200 and the user payload with a valid Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ id: 'user_1', email: 'user@example.com' });
      expect(res.body.cards).toEqual([]);
    });

    it('POST /akahu/exchange with a valid Bearer token reads userId from req.session', async () => {
      mocks.exchangeAuthorizationCode.mockResolvedValue({
        accessToken: 'akahu_user_token',
        scope: 'ENDURING_CONSENT'
      });
      mocks.prisma.akahuConnection.upsert.mockResolvedValue({});
      // Inject a deterministic key so upsertAkahuConnection.encryptToken
      // doesn't reach for BUDGET_API_TOKEN_KEY in the env.
      __resetKeyCacheForTests();
      __setKeyForTests(createHash('sha256').update('session-mw-test-key').digest());

      const res = await request(createApp())
        .post('/api/v1/akahu/exchange')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ code: 'oauth_code_1' });

      expect(res.status).toBe(200);
      // The repo encrypts before writing, so the upsert's create/update
      // branches hold ciphertext Buffers (random nonce per call), not the
      // OAuth-exchange plaintext. Decrypt what the repo actually wrote and
      // assert the plaintext round-trips.
      expect(mocks.prisma.akahuConnection.upsert).toHaveBeenCalledTimes(1);
      const [upsertArgs] = mocks.prisma.akahuConnection.upsert.mock.calls[0];
      expect(upsertArgs.where).toEqual({ userId: 'user_1' });
      expect(upsertArgs.create.scope).toBe('ENDURING_CONSENT');
      expect(upsertArgs.update.scope).toBe('ENDURING_CONSENT');
      expect(decryptToken(upsertArgs.create.accessToken)).toBe('akahu_user_token');
      expect(decryptToken(upsertArgs.update.accessToken)).toBe('akahu_user_token');
    });

    it('POST /akahu/exchange with an invalid Bearer token returns 401 and never calls the upstream', async () => {
      const res = await request(createApp())
        .post('/api/v1/akahu/exchange')
        .set('Authorization', 'Bearer bogus-token')
        .send({ code: 'oauth_code_1' });

      expect(res.status).toBe(401);
      expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect(mocks.prisma.akahuConnection.upsert).not.toHaveBeenCalled();
    });
  });
});