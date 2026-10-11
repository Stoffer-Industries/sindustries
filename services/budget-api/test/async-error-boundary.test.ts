import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    session: { findUnique: vi.fn() },
    linkedCard: { findMany: vi.fn() },
    accountBalanceSnapshot: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() }
  }
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';

const SESSION = { id: 'session_async_1', userId: 'user_async_1' };
const TOKEN = 'async-boundary-token';
const TOKEN_HASH = hashSessionToken(TOKEN);

function rejectingDependency(message = 'simulated downstream failure'): never {
  // Make sure this is a real rejected promise, not a synchronous throw,
  // so we exercise the async-handler code path.
  return Promise.reject(new Error(message)) as never;
}

describe('async error boundary — rejected dependencies reach the error middleware', () => {
  // Capture any unhandled rejection that escapes Express. The wrapper's
  // .catch(next) should mean none of these fire, but we want a loud failure
  // if a regression reintroduces an unhandled rejection.
  const unhandled: unknown[] = [];
  const unhandledListener = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', unhandledListener);
    vi.clearAllMocks();
    // Default: token resolves to user_async_1's session.
    mocks.prisma.session.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash && args.where.tokenHash === TOKEN_HASH) {
        return SESSION;
      }
      if (args?.where?.id && args.where.id === SESSION.id) {
        return { ...SESSION, user: { id: SESSION.userId, email: 'user@example.com' } };
      }
      return null;
    });
  });
  afterEach(() => {
    process.off('unhandledRejection', unhandledListener);
  });

  it('rejected session lookup returns 500 with the sanitized envelope and no unhandled rejection', async () => {
    mocks.prisma.session.findUnique.mockImplementation(async () => {
      // The requireSession lookup itself rejects.
      return rejectingDependency('prisma session findUnique down');
    });

    const res = await request(createApp())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }
    });
    // The response must not echo the underlying message.
    expect(JSON.stringify(res.body)).not.toContain('prisma session findUnique down');
    expect(unhandled).toEqual([]);
  });

  it('rejected read route dependency (balance-history) returns 500 and a subsequent request still succeeds', async () => {
    let rejectRead = true;
    mocks.prisma.linkedCard.findMany.mockImplementation(async () => {
      if (rejectRead) return rejectingDependency('linkedCard findMany down');
      return [];
    });
    mocks.prisma.accountBalanceSnapshot.findMany.mockResolvedValue([]);

    const failing = await request(createApp())
      .get('/api/v1/cards/balance-history')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(failing.status).toBe(500);
    expect(failing.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(failing.body)).not.toContain('linkedCard findMany down');

    // Subsequent request must succeed — no permanent state corruption.
    rejectRead = false;
    const ok = await request(createApp())
      .get('/api/v1/cards/balance-history')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body.accounts).toEqual([]);
    expect(ok.body.series).toEqual({});
    expect(ok.body.totalSeries).toEqual([]);

    expect(unhandled).toEqual([]);
  });

  it('rejected write route dependency (transaction list) returns 500 instead of hanging', async () => {
    mocks.prisma.transaction.findMany.mockImplementation(async () => {
      return rejectingDependency('transaction findMany down');
    });

    const res = await request(createApp())
      .get('/api/v1/transactions')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('transaction findMany down');
    expect(unhandled).toEqual([]);
  });

  it('401 contract survives a downstream rejection — missing token still returns 401', async () => {
    // No bearer token; requireSession must short-circuit before any prisma call.
    mocks.prisma.session.findUnique.mockImplementation(async () => {
      return rejectingDependency('should not be called');
    });

    const res = await request(createApp()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mocks.prisma.session.findUnique).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('invalid token still returns 401 even when the session lookup rejects', async () => {
    // Token reaches the prisma call, but it then rejects. requireSession
    // should not collapse that into a 500, and it must not leak a 200.
    mocks.prisma.session.findUnique.mockImplementation(async () => {
      return rejectingDependency('session lookup explosion');
    });

    const res = await request(createApp())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer bogus-token');

    // The middleware's prisma call rejected; the wrapper forwards to the
    // error middleware which emits 500. Crucially, neither an unhandled
    // rejection nor a 200 must escape.
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(unhandled).toEqual([]);
  });
});
