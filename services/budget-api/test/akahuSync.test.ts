import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    akahuConnection: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    linkedCard: { upsert: vi.fn(), findMany: vi.fn() },
    transaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn()
    },
    accountBalanceSnapshot: { create: vi.fn() },
    cardMonthlyBudget: { findUnique: vi.fn() },
    notificationEvent: { create: vi.fn() },
    categorizationFeedback: { findFirst: vi.fn() }
  },
  akahuGetAccounts: vi.fn(),
  akahuGetTransactions: vi.fn(),
  akahuGetPendingTransactions: vi.fn(),
  akahuRefreshAllAccounts: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  evaluateAlertsForUser: vi.fn(),
  categorizeTransaction: vi.fn()
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/akahuClient.ts', () => ({
  akahuGetAccounts: mocks.akahuGetAccounts,
  akahuGetTransactions: mocks.akahuGetTransactions,
  akahuGetPendingTransactions: mocks.akahuGetPendingTransactions,
  akahuRefreshAllAccounts: mocks.akahuRefreshAllAccounts,
  exchangeAuthorizationCode: mocks.exchangeAuthorizationCode
}));
vi.mock('../src/services/alerts.ts', () => ({
  evaluateAlertsForUser: mocks.evaluateAlertsForUser
}));
vi.mock('../src/services/categorizer.ts', () => ({
  categorizeTransaction: mocks.categorizeTransaction,
  categoryTaxonomy: []
}));

import { createApp } from '../src/app.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('POST /api/v1/akahu/sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    mocks.prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    mocks.prisma.akahuConnection.findUnique.mockResolvedValue({
      userId: 'user_1',
      accessToken: 'user_token',
      lastSyncedAt: new Date('2026-05-10T00:00:00.000Z')
    });
    mocks.prisma.akahuConnection.update.mockResolvedValue({});
    mocks.prisma.linkedCard.upsert.mockResolvedValue({ id: 'card_1' });
    mocks.prisma.transaction.findUnique.mockResolvedValue(null);
    mocks.prisma.transaction.update.mockResolvedValue({});
    mocks.prisma.transaction.create.mockResolvedValue({});
    mocks.prisma.transaction.deleteMany.mockResolvedValue({ count: 0 });

    mocks.akahuGetAccounts.mockResolvedValue([{ _id: 'acc_1', name: 'Credit card' }]);
    mocks.akahuGetTransactions.mockResolvedValue([
      {
        _id: 'trans_1',
        _account: 'acc_1',
        date: '2026-05-11T00:00:00.000Z',
        description: 'SETTLED PURCHASE',
        amount: -20,
        merchant: { name: 'Settled Merchant' }
      }
    ]);
    mocks.akahuGetPendingTransactions.mockResolvedValue([
      {
        _account: 'acc_1',
        date: '2026-05-12T00:00:00.000Z',
        description: 'PENDING PURCHASE',
        amount: -12.34,
        type: 'EFTPOS'
      }
    ]);
    mocks.akahuRefreshAllAccounts.mockResolvedValue({
      requested: true,
      rateLimited: false,
      message: null
    });
    mocks.evaluateAlertsForUser.mockResolvedValue({ createdEventIds: [] });
    mocks.categorizeTransaction.mockResolvedValue({
      category: 'shopping',
      confidence: 0.8,
      source: 'model'
    });
  });

  it('force-refreshes Akahu and rebuilds pending transactions', async () => {
    const res = await request(createApp())
      .post('/api/v1/akahu/sync')
      .send({ userId: 'user_1', force: true })
      .expect(200);

    expect(mocks.akahuRefreshAllAccounts).toHaveBeenCalledWith({ accessToken: 'user_token' });
    expect(mocks.akahuGetTransactions).toHaveBeenCalledWith({
      accessToken: 'user_token',
      startMs: new Date('2026-02-11T00:00:00.000Z').getTime(),
      endMs: new Date('2026-05-12T00:00:00.000Z').getTime()
    });
    expect(mocks.akahuGetPendingTransactions).toHaveBeenCalledWith({ accessToken: 'user_token' });
    expect(mocks.prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1',
        provider: 'akahu',
        providerTransactionId: { startsWith: 'akahu-pending:' }
      }
    });

    const createdRows = mocks.prisma.transaction.create.mock.calls.map(([arg]) => arg.data);
    expect(createdRows).toHaveLength(2);
    expect(createdRows[0]).toMatchObject({
      providerTransactionId: 'akahu:trans_1',
      merchant: 'Settled Merchant',
      amountCents: 2000,
      direction: 'debit'
    });
    expect(createdRows[1]).toMatchObject({
      merchant: null,
      description: 'PENDING PURCHASE',
      amountCents: 1234,
      direction: 'debit'
    });
    expect(createdRows[1].providerTransactionId).toMatch(/^akahu-pending:/);
    expect(mocks.prisma.akahuConnection.update).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      data: { lastSyncedAt: expect.any(Date) }
    });
    expect(res.body).toMatchObject({
      ok: true,
      accounts: 1,
      created: 1,
      updated: 0,
      pendingCreated: 1,
      refresh: { requested: true, rateLimited: false, message: null }
    });
  });

  it('uses last sync overlap without refreshing during incremental sync', async () => {
    await request(createApp()).post('/api/v1/akahu/sync').send({ userId: 'user_1' }).expect(200);

    expect(mocks.akahuRefreshAllAccounts).not.toHaveBeenCalled();
    expect(mocks.akahuGetTransactions).toHaveBeenCalledWith({
      accessToken: 'user_token',
      startMs: new Date('2026-05-03T00:00:00.000Z').getTime(),
      endMs: new Date('2026-05-12T00:00:00.000Z').getTime()
    });
  });

  it('marks Akahu pending rows when listing transactions', async () => {
    mocks.prisma.transaction.findMany.mockResolvedValue([
      {
        id: 'txn_1',
        occurredAt: new Date('2026-05-12T00:00:00.000Z'),
        merchant: null,
        description: 'PENDING PURCHASE',
        amountCents: 1234,
        direction: 'debit',
        category: 'shopping',
        categorySource: 'model',
        categoryConfidence: 0.8,
        providerTransactionId: 'akahu-pending:abc123'
      }
    ]);

    const res = await request(createApp())
      .get('/api/v1/transactions')
      .query({ userId: 'user_1' })
      .expect(200);

    expect(res.body.transactions[0]).toMatchObject({
      id: 'txn_1',
      pending: true
    });
  });
});
