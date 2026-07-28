import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    session: { findUnique: vi.fn() },
    linkedCard: { findMany: vi.fn() }
  }
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';

const SESSION = { id: 'session_1', userId: 'user_1' };
const TOKEN = 'me-token-1';
const TOKEN_HASH = hashSessionToken(TOKEN);

describe('GET /api/v1/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.linkedCard.findMany.mockResolvedValue([]);
    mocks.prisma.session.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash && args.where.tokenHash === TOKEN_HASH) {
        return SESSION;
      }
      if (args?.where?.id && args.where.id === SESSION.id) {
        return {
          ...SESSION,
          user: { id: SESSION.userId, email: 'me@example.com' }
        };
      }
      return null;
    });
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await request(createApp()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when the Bearer token is invalid', async () => {
    const res = await request(createApp())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with the user payload when the Bearer token is valid', async () => {
    const res = await request(createApp())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: 'user_1', email: 'me@example.com' },
      cards: []
    });
  });

  it('returns the user with their cards when the Bearer token is valid and cards exist', async () => {
    mocks.prisma.linkedCard.findMany.mockResolvedValue([
      {
        id: 'card_1',
        displayName: 'Everyday account',
        last4: '1234'
      },
      {
        id: 'card_2',
        displayName: 'Savings',
        last4: '5678'
      }
    ]);
    const res = await request(createApp())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([
      { id: 'card_1', displayName: 'Everyday account', last4: '1234' },
      { id: 'card_2', displayName: 'Savings', last4: '5678' }
    ]);
  });
});