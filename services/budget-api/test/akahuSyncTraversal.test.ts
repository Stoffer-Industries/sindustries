import request from 'supertest';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetKeyCacheForTests,
  __setKeyForTests,
  encryptToken
} from '../src/lib/secretBox';

// These route-level fixtures deliberately do NOT mock `src/services/akahuClient.ts`.
// The whole point of the suite is to drive the *real* client against a mocked
// transport (`vi.stubGlobal('fetch', …)`) so the cursor traversal, the
// completeness contract and the deadlines are exercised end to end — the
// module-mocked suite in `akahuSync.test.ts` cannot see them.

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn() },
    akahuConnection: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    linkedCard: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    transaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn()
    },
    accountBalanceSnapshot: { create: vi.fn(), findMany: vi.fn() },
    cardMonthlyBudget: { findUnique: vi.fn() },
    notificationEvent: { create: vi.fn() },
    categorizationFeedback: { findFirst: vi.fn() }
  },
  evaluateAlertsForUser: vi.fn(),
  categorizeTransaction: vi.fn()
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/alerts.ts', () => ({
  evaluateAlertsForUser: mocks.evaluateAlertsForUser
}));
vi.mock('../src/services/categorizer.ts', () => ({
  categorizeTransaction: mocks.categorizeTransaction,
  categoryTaxonomy: []
}));

import { createApp } from '../src/app';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    headers: { get: () => null }
  };
}

function txn(index: number) {
  return {
    _id: `trans_${index}`,
    _account: 'acc_1',
    date: '2026-05-01T00:00:00.000Z',
    description: `SETTLED PURCHASE ${index}`,
    amount: -10,
    merchant: { name: 'Settled Merchant' }
  };
}

/**
 * A transport stub that answers accounts/pending immediately and serves the
 * settled-transaction pages from `pages` in order.
 */
function stubFetch(pages: Array<{ status: number; body: unknown; delayMs?: number }>) {
  let pageIndex = 0;
  return vi.fn(async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/accounts') {
      return jsonResponse(200, {
        success: true,
        items: [
          {
            _id: 'acc_1',
            name: 'Everyday account',
            balance: { current: 100, available: 100, currency: 'NZD' }
          }
        ]
      });
    }
    if (url.pathname === '/v1/transactions/pending') {
      return jsonResponse(200, { success: true, items: [] });
    }
    if (url.pathname === '/v1/transactions') {
      const page = pages[pageIndex];
      pageIndex += 1;
      if (!page) return jsonResponse(500, { success: false, message: 'no page queued' });
      if (page.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, page.delayMs));
      }
      return jsonResponse(page.status, page.body);
    }
    return jsonResponse(404, { success: false, message: 'unexpected endpoint' });
  });
}

function page(items: number[], next: string | null, from = 0) {
  return {
    status: 200,
    body: {
      success: true,
      items: Array.from({ length: items.length }, (_, i) => txn(from + i)),
      cursor: { next }
    }
  };
}

describe('POST /api/v1/akahu/sync - cursor traversal and completeness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';
    process.env.AKAHU_CLIENT_ID = 'app_token_test';
    delete process.env.AKAHU_SYNC_BUDGET_MS;
    delete process.env.AKAHU_PER_CALL_TIMEOUT_MS;

    mocks.prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    mocks.prisma.session.findUnique.mockResolvedValue({ id: 'session_1', userId: 'user_1' });
    __resetKeyCacheForTests();
    __setKeyForTests(createHash('sha256').update('akahuTraversal-test-key').digest());
    mocks.prisma.akahuConnection.findUnique.mockResolvedValue({
      userId: 'user_1',
      accessToken: encryptToken('user_token'),
      lastSyncedAt: new Date('2026-05-10T00:00:00.000Z')
    });
    mocks.prisma.akahuConnection.update.mockResolvedValue({});
    mocks.prisma.linkedCard.findUnique.mockResolvedValue(null);
    mocks.prisma.linkedCard.upsert.mockResolvedValue({ id: 'card_1' });
    mocks.prisma.transaction.findUnique.mockResolvedValue(null);
    mocks.prisma.transaction.update.mockResolvedValue({});
    mocks.prisma.transaction.create.mockResolvedValue({});
    mocks.prisma.transaction.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.accountBalanceSnapshot.create.mockResolvedValue({});
    mocks.evaluateAlertsForUser.mockResolvedValue({ createdEventIds: [] });
    mocks.categorizeTransaction.mockResolvedValue({
      category: 'shopping',
      confidence: 0.8,
      source: 'model'
    });
  });

  it('persists every transaction in a multi-page window and advances the checkpoint', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => i);
    const secondPage = Array.from({ length: 100 }, (_, i) => i + 100);
    const thirdPage = Array.from({ length: 50 }, (_, i) => i + 200);
    const fetchMock = stubFetch([
      {
        status: 200,
        body: {
          success: true,
          items: firstPage.map((i) => txn(i)),
          cursor: { next: 'page-2' }
        }
      },
      {
        status: 200,
        body: {
          success: true,
          items: secondPage.map((i) => txn(i)),
          cursor: { next: 'page-3' }
        }
      },
      {
        status: 200,
        body: {
          success: true,
          items: thirdPage.map((i) => txn(i)),
          cursor: { next: null }
        }
      }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/v1/akahu/sync')
      .set('Authorization', 'Bearer test-token-1')
      .send({})
      .expect(200);

    const createdRows = mocks.prisma.transaction.create.mock.calls.map(([arg]) => arg.data);
    expect(createdRows).toHaveLength(250);
    expect(new Set(createdRows.map((r) => r.providerTransactionId)).size).toBe(250);
    expect(mocks.prisma.akahuConnection.update).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      data: { lastSyncedAt: expect.any(Date) }
    });
    expect(res.body).toMatchObject({
      ok: true,
      complete: true,
      checkpointAdvanced: true,
      pagesFetched: 3,
      transactionsFetched: 250,
      created: 250
    });

    // start/end are repeated on every page, and the cursor is only sent
    // after the first page.
    const transactionUrls = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === '/v1/transactions');
    expect(transactionUrls).toHaveLength(3);
    expect(transactionUrls[0].searchParams.get('cursor')).toBeNull();
    expect(transactionUrls[1].searchParams.get('cursor')).toBe('page-2');
    expect(transactionUrls[2].searchParams.get('cursor')).toBe('page-3');
    for (const url of transactionUrls) {
      expect(url.searchParams.get('start')).toBe(transactionUrls[0].searchParams.get('start'));
      expect(url.searchParams.get('end')).toBe(transactionUrls[0].searchParams.get('end'));
    }
  });

  it('does not advance the checkpoint when a later page fails and reports complete false', async () => {
    const fetchMock = stubFetch([
      {
        status: 200,
        body: {
          success: true,
          items: [txn(1), txn(2), txn(3)],
          cursor: { next: 'page-2' }
        }
      },
      { status: 500, body: { success: false, message: 'provider exploded' } },
      {
        status: 200,
        body: { success: true, items: [txn(4)], cursor: { next: null } }
      }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/v1/akahu/sync')
      .set('Authorization', 'Bearer test-token-1')
      .send({})
      .expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      complete: false,
      checkpointAdvanced: false,
      pagesFetched: 1,
      transactionsFetched: 3
    });
    expect(typeof res.body.error).toBe('string');
    // The checkpoint must be left untouched so the next sync re-requests the
    // same window.
    expect(mocks.prisma.akahuConnection.update).not.toHaveBeenCalled();
    // The rows that were fetched are still persisted (the upsert is
    // idempotent by providerTransactionId).
    expect(mocks.prisma.transaction.create).toHaveBeenCalledTimes(3);
  });

  it('reports rows with no card and leaves the checkpoint open for retry', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/accounts' || url.pathname === '/v1/transactions/pending') {
        return jsonResponse(200, { success: true, items: [] });
      }
      if (url.pathname === '/v1/transactions') {
        return jsonResponse(200, {
          success: true,
          items: [txn(1)],
          cursor: { next: null }
        });
      }
      return jsonResponse(404, { success: false, message: 'unexpected endpoint' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/v1/akahu/sync')
      .set('Authorization', 'Bearer test-token-1')
      .send({})
      .expect(200);

    expect(res.body).toMatchObject({
      complete: true,
      checkpointAdvanced: false,
      transactionsFetched: 1,
      transactionsSkippedNoCard: 1
    });
    expect(mocks.prisma.akahuConnection.update).not.toHaveBeenCalled();
    expect(mocks.prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('aborts the sync when the whole-sync budget is exceeded and leaves the checkpoint unchanged', async () => {
    process.env.AKAHU_SYNC_BUDGET_MS = '60';
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, items: [txn(1)], cursor: { next: null } }, delayMs: 400 }
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/v1/akahu/sync')
      .set('Authorization', 'Bearer test-token-1')
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe('AKAHU_TIMEOUT');
    expect(mocks.prisma.akahuConnection.update).not.toHaveBeenCalled();
  });
});
