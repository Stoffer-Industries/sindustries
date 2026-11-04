import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC6 — the bounded Akahu backfill (task a37b31c9).
 *
 * These fixtures drive the *real* backfill code path
 * (`src/services/akahuBackfill.ts`) against a mocked transport and a
 * stateful store double, so the three claims the acceptance criterion makes
 * are observable end to end:
 *
 *   - a dry run writes nothing (no transaction rows, no run record),
 *   - a second apply over the same window creates no duplicates,
 *   - a window outside the provider's configured historical allowance is
 *     refused before any transaction page is requested,
 *   - a concurrent writer that inserts the same provider transaction first
 *     is converged on rather than crashing the run, and is not rewritten
 *     when it belongs to another user.
 *
 * The store double is a faithful Prisma double rather than a set of spies:
 * `transaction.create` appends, `transaction.update` mutates in place, and
 * `transaction.findUnique` is keyed by `providerTransactionId` exactly as
 * the unique constraint is. That is what makes "no duplicates" an
 * observable property of the backfill rather than of the double.
 *
 * The real-Postgres counterpart of this file is
 * `test/akahuBackfillDb.test.ts`, which runs the same three claims against
 * the real Prisma client in CI's `budget-api-db-integration` job.
 */

type StoredTransaction = {
  id: string;
  userId: string;
  cardId: string;
  provider: string;
  providerTransactionId: string;
  occurredAt: Date;
  merchant: string | null;
  description: string | null;
  amountCents: number;
  direction: 'debit' | 'credit';
  category: string | null;
  categoryConfidence: number;
  categorySource: string;
};

type StoredRun = {
  id: string;
  userId: string;
  windowStartMs: bigint;
  windowEndMs: bigint;
  mode: string;
  status: string;
  pagesFetched: number;
  rowsSeen: number;
  rowsUpserted: number;
  startedAt: Date;
  finishedAt: Date | null;
};

const store = vi.hoisted(() => ({
  transactions: [] as any[],
  runs: [] as any[],
  cards: new Map<string, { id: string; userId: string }>()
}));

const mocks = vi.hoisted(() => ({
  prisma: {
    transaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    linkedCard: { findUnique: vi.fn(), upsert: vi.fn() },
    akahuBackfillRun: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
  },
  categorizeTransaction: vi.fn()
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/categorizer.ts', () => ({
  categorizeTransaction: mocks.categorizeTransaction,
  categoryTaxonomy: []
}));

import {
  runAkahuBackfill,
  resolveAkahuBackfillAllowance,
  AkahuBackfillWindowError
} from '../src/services/akahuBackfill';

const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z');
// The provider reports a bound: history only exists from 2026-01-01.
const ACCESS_GRANTED_AT = '2026-01-01T00:00:00.000Z';
const ACCESS_GRANTED_AT_MS = Date.parse(ACCESS_GRANTED_AT);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    headers: { get: () => null }
  };
}

function txn(index: number, account = 'acc_1') {
  return {
    _id: `trans_${index}`,
    _account: account,
    date: '2026-02-01T00:00:00.000Z',
    description: `BACKFILLED PURCHASE ${index}`,
    amount: -25,
    merchant: { name: 'Backfilled Merchant' }
  };
}

/**
 * A transport stub for the three provider endpoints the backfill uses:
 * `/v1/me` (the historical allowance), `/v1/accounts` (card mapping) and
 * `/v1/transactions` (the window itself, served page by page).
 *
 * The request paths are recorded so a test can assert that a refused window
 * never reached the transaction endpoint.
 */
function stubFetch(pages: Array<{ status: number; body: unknown }>) {
  const requestPaths: string[] = [];
  let pageIndex = 0;

  const fetchMock = vi.fn(async (input: any) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);

    if (url.pathname === '/v1/me') {
      return jsonResponse(200, { access_granted_at: ACCESS_GRANTED_AT });
    }
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
    if (url.pathname === '/v1/transactions') {
      const page = pages[pageIndex];
      pageIndex += 1;
      if (!page) return jsonResponse(500, { success: false, message: 'no page queued' });
      return jsonResponse(page.status, page.body);
    }
    return jsonResponse(404, { success: false, message: 'unexpected endpoint' });
  });

  return { fetchMock, requestPaths };
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

describe('Akahu bounded backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.transactions = [];
    store.runs = [];
    store.cards.clear();
    process.env.AKAHU_CLIENT_ID = 'app_token_test';
    delete process.env.AKAHU_PER_CALL_TIMEOUT_MS;

    // Faithful Prisma double: appends, mutates in place, and is keyed by
    // the same unique column the real schema declares.
    mocks.prisma.linkedCard.findUnique.mockImplementation(async (args: any) => {
      const cardId = args.where.provider_providerCardId.providerCardId;
      const found = store.cards.get(cardId);
      // The lookup selects the owner: `LinkedCard` is unique on
      // (provider, providerCardId) globally, so the card it finds may
      // belong to another user.
      return found ? { id: found.id, userId: found.userId } : null;
    });
    mocks.prisma.linkedCard.upsert.mockImplementation(async (args: any) => {
      const cardId = args.where.provider_providerCardId.providerCardId;
      if (!store.cards.has(cardId)) {
        store.cards.set(cardId, { id: `card_${cardId}`, userId: args.create.userId });
      }
      return store.cards.get(cardId);
    });
    mocks.prisma.transaction.findUnique.mockImplementation(async (args: any) => {
      const found = store.transactions.find(
        (t) => t.providerTransactionId === args.where.providerTransactionId
      );
      // The lookup selects the owner as well as the id: `providerTransactionId`
      // is globally unique, so the row it finds may belong to another user.
      return found ? { id: found.id, userId: found.userId } : null;
    });
    mocks.prisma.transaction.create.mockImplementation(async (args: any) => {
      const row: StoredTransaction = {
        id: `txn_${store.transactions.length + 1}`,
        ...args.data
      };
      store.transactions.push(row);
      return row;
    });
    mocks.prisma.transaction.update.mockImplementation(async (args: any) => {
      const found = store.transactions.find(
        (t) =>
          (args.where.id && t.id === args.where.id) ||
          (!args.where.id && t.providerTransactionId === args.where.providerTransactionId)
      );
      if (found) Object.assign(found, args.data);
      return found;
    });
    mocks.prisma.akahuBackfillRun.findFirst.mockImplementation(async (args: any) => {
      const found = store.runs.find(
        (r) =>
          r.userId === args.where.userId &&
          r.windowStartMs === args.where.windowStartMs &&
          r.windowEndMs === args.where.windowEndMs
      );
      return found ? { id: found.id } : null;
    });
    mocks.prisma.akahuBackfillRun.create.mockImplementation(async (args: any) => {
      const row: StoredRun = { id: `run_${store.runs.length + 1}`, ...args.data };
      store.runs.push(row);
      return { id: row.id };
    });
    mocks.prisma.akahuBackfillRun.update.mockImplementation(async (args: any) => {
      const found = store.runs.find((r) => r.id === args.where.id);
      if (found) Object.assign(found, args.data);
      return { id: args.where.id };
    });
    mocks.categorizeTransaction.mockResolvedValue({
      category: 'shopping',
      confidence: 0.8,
      source: 'model'
    });
  });

  it('a dry run writes nothing', async () => {
    const { fetchMock } = stubFetch([page([0, 1, 2], null)]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAkahuBackfill({
      userId: 'user_1',
      accessToken: 'user_token',
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
      dryRun: true,
      nowMs: NOW_MS
    });

    expect(result.applied).toBe(false);
    expect(result.rowsSeen).toBe(3);
    expect(result.runId).toBeNull();
    // A dry run writes nothing at all: no transaction rows and no run record.
    expect(store.transactions).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it('a second apply creates no duplicates', async () => {
    const pages = [page([0, 1, 2], 'page-2'), page([3, 4], null, 3)];
    const { fetchMock } = stubFetch(pages);
    vi.stubGlobal('fetch', fetchMock);

    const options = {
      userId: 'user_1',
      accessToken: 'user_token',
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
      dryRun: false,
      nowMs: NOW_MS
    };

    const first = await runAkahuBackfill(options);
    expect(first.rowsUpserted).toBe(5);
    expect(store.transactions).toHaveLength(5);

    // Second run over the same window: the same rows are re-fetched, and
    // the upsert must not duplicate them.
    const { fetchMock: secondFetch } = stubFetch(pages);
    vi.stubGlobal('fetch', secondFetch);
    const second = await runAkahuBackfill(options);

    expect(store.transactions).toHaveLength(5);
    expect(
      new Set(store.transactions.map((t) => t.providerTransactionId)).size
    ).toBe(5);
    expect(second.rowsUpserted).toBe(5);
    expect(second.rowsUpdated).toBe(5);
    // The run record for the same window is updated, not duplicated.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].rowsUpserted).toBe(5);
    expect(store.runs[0].status).toBe('completed');
  });

  it('leaves a provider transaction owned by another user untouched', async () => {
    // `providerTransactionId` is globally unique, so the same provider
    // transaction can already exist under a different budget-api user (an
    // Akahu account linked twice, or a reconnect that re-points the
    // connection). The backfill must not rewrite that user's record.
    store.transactions.push({
      id: 'txn_other_user',
      userId: 'user_2',
      cardId: 'card_acc_1',
      provider: 'akahu',
      providerTransactionId: 'akahu:trans_0',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      merchant: 'Other User Merchant',
      description: 'OTHER USER PURCHASE',
      amountCents: 999,
      direction: 'debit',
      category: 'other',
      categoryConfidence: 0.5,
      categorySource: 'model'
    });

    const { fetchMock } = stubFetch([page([0, 1, 2], null)]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAkahuBackfill({
      userId: 'user_1',
      accessToken: 'user_token',
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
      dryRun: false,
      nowMs: NOW_MS
    });

    // The other user's row is byte-for-byte what it was.
    const other = store.transactions.find((t) => t.id === 'txn_other_user');
    expect(other.userId).toBe('user_2');
    expect(other.amountCents).toBe(999);
    expect(other.merchant).toBe('Other User Merchant');
    expect(other.description).toBe('OTHER USER PURCHASE');

    // It is reported, not silently dropped, and the other two transactions
    // are still written for the requesting user.
    expect(result.rowsSkippedCrossTenant).toBe(1);
    expect(result.rowsUpserted).toBe(2);
    const mine = store.transactions.filter((t) => t.userId === 'user_1');
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.providerTransactionId !== 'akahu:trans_0')).toBe(true);
  });

  it('converges on a row a concurrent writer inserted', async () => {
    // The write path is a read-then-write, so two backfills over the same
    // window can both miss the row and race to create it. The loser of
    // that race gets a unique-constraint violation; it must converge on
    // the row the winner inserted rather than failing the run.
    //
    // `prisma.transaction.create` throws P2002 *after* the concurrent
    // writer's row lands in the store, which is the race the real unique
    // constraint produces.
    const winner: StoredTransaction = {
      id: 'txn_concurrent_winner',
      userId: 'user_1',
      cardId: 'card_acc_1',
      provider: 'akahu',
      providerTransactionId: 'akahu:trans_0',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      merchant: 'STALE MERCHANT',
      description: 'STALE DESCRIPTION',
      amountCents: 1,
      direction: 'debit',
      category: 'stale',
      categoryConfidence: 0.1,
      categorySource: 'model'
    };
    mocks.prisma.transaction.create.mockImplementationOnce(async () => {
      store.transactions.push(winner);
      const err: any = new Error('Unique constraint failed on the fields: (`providerTransactionId`)');
      err.code = 'P2002';
      throw err;
    });

    const { fetchMock } = stubFetch([page([0], null)]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAkahuBackfill({
      userId: 'user_1',
      accessToken: 'user_token',
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
      dryRun: false,
      nowMs: NOW_MS
    });

    // The run did not fail, and it did not duplicate the row: the single
    // transaction in the page resolves to the one row the concurrent
    // writer inserted.
    expect(store.transactions).toHaveLength(1);
    expect(store.transactions[0].id).toBe('txn_concurrent_winner');
    // And it converged on the winner's row with this run's settlement
    // values, rather than leaving the stale ones in place.
    expect(store.transactions[0].amountCents).toBe(2500);
    expect(store.transactions[0].merchant).toBe('Backfilled Merchant');
    expect(store.transactions[0].description).toBe('BACKFILLED PURCHASE 0');
    expect(store.transactions[0].userId).toBe('user_1');
    expect(result.rowsUpdated).toBe(1);
  });

  it('does not rewrite a row a concurrent writer inserted for another user', async () => {
    // Same race, but the winner's row belongs to a different budget-api
    // user. `providerTransactionId` is globally unique, so converging on it
    // would rewrite another user's financial record. The row must be left
    // exactly as the other writer wrote it and reported as skipped.
    const winner: StoredTransaction = {
      id: 'txn_other_user_winner',
      userId: 'user_2',
      cardId: 'card_acc_1',
      provider: 'akahu',
      providerTransactionId: 'akahu:trans_0',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      merchant: 'Other User Merchant',
      description: 'OTHER USER PURCHASE',
      amountCents: 999,
      direction: 'debit',
      category: 'other',
      categoryConfidence: 0.5,
      categorySource: 'model'
    };
    mocks.prisma.transaction.create.mockImplementationOnce(async () => {
      store.transactions.push(winner);
      const err: any = new Error('Unique constraint failed on the fields: (`providerTransactionId`)');
      err.code = 'P2002';
      throw err;
    });

    const { fetchMock } = stubFetch([page([0], null)]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAkahuBackfill({
      userId: 'user_1',
      accessToken: 'user_token',
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
      dryRun: false,
      nowMs: NOW_MS
    });

    // Byte-for-byte what the other user wrote.
    const other = store.transactions.find((t) => t.id === 'txn_other_user_winner');
    expect(other.userId).toBe('user_2');
    expect(other.amountCents).toBe(999);
    expect(other.merchant).toBe('Other User Merchant');
    expect(other.description).toBe('OTHER USER PURCHASE');
    expect(other.category).toBe('other');

    // Reported, not silently dropped, and no write was attempted on it.
    expect(result.rowsSkippedCrossTenant).toBe(1);
    expect(result.rowsUpdated).toBe(0);
    expect(mocks.prisma.transaction.update).not.toHaveBeenCalled();
  });

  it('refuses a window outside the configured historical allowance', async () => {
    const { fetchMock, requestPaths } = stubFetch([page([0], null)]);
    vi.stubGlobal('fetch', fetchMock);

    // The window starts before the provider's own `access_granted_at`.
    await expect(
      runAkahuBackfill({
        userId: 'user_1',
        accessToken: 'user_token',
        startMs: ACCESS_GRANTED_AT_MS - 30 * 24 * 60 * 60 * 1000,
        endMs: NOW_MS,
        dryRun: false,
        nowMs: NOW_MS
      })
    ).rejects.toBeInstanceOf(AkahuBackfillWindowError);

    // Refused before any transaction page was requested, and nothing was
    // written.
    expect(requestPaths).not.toContain('/v1/transactions');
    expect(store.transactions).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it('refuses to guess an allowance when the provider does not report one', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/me') {
        return jsonResponse(200, { success: true });
      }
      return jsonResponse(404, { success: false, message: 'unexpected endpoint' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runAkahuBackfill({
        userId: 'user_1',
        accessToken: 'user_token',
        startMs: ACCESS_GRANTED_AT_MS,
        endMs: NOW_MS,
        dryRun: true,
        nowMs: NOW_MS
      })
    ).rejects.toThrow(/--max-lookback-days/);
  });

  it('always reads the provider allowance and lets an override narrow but never widen it', async () => {
    const { fetchMock, requestPaths } = stubFetch([]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveAkahuBackfillAllowance({
      accessToken: 'user_token',
      maxLookbackDays: 365,
      nowMs: NOW_MS
    });

    expect(requestPaths).toContain('/v1/me');
    expect(result).toEqual({ earliestAllowedMs: ACCESS_GRANTED_AT_MS, source: 'provider' });
  });

  it('requires and records an override when the provider omits its allowance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { success: true })));

    const result = await resolveAkahuBackfillAllowance({
      accessToken: 'user_token',
      maxLookbackDays: 30,
      nowMs: NOW_MS
    });

    expect(result).toEqual({
      earliestAllowedMs: NOW_MS - 30 * 24 * 60 * 60 * 1000,
      source: 'override-required'
    });
  });
});
