import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../src/lib/prisma';
import {
  runAkahuBackfill,
  AkahuBackfillWindowError
} from '../src/services/akahuBackfill';

/**
 * Real-Postgres AC6 evidence for the bounded Akahu backfill (task a37b31c9).
 *
 * The sibling `test/akahuBackfill.test.ts` proves the backfill's three
 * claims against a Prisma double. A double is only as faithful as the test
 * author made it, and "a second apply creates no duplicates" is precisely a
 * claim about a unique constraint. This file therefore runs the same three
 * claims against the real Prisma client and the real Postgres schema, so
 * "no duplicates" is enforced by the database's own unique index rather than
 * by the double's bookkeeping.
 *
 * Self-skip gate: the file only runs when `BUDGET_API_INTEGRATION_TEST ===
 * '1'`. The `budget-api-unit` CI job deliberately does not set that env var;
 * the `budget-api-db-integration` job does, and runs this file alongside
 * `ownership-contract-integration`.
 *
 * CI Postgres is throwaway (one container per job), so `TRUNCATE … CASCADE`
 * is safe here — no other job shares this database.
 */

const USER_ID = '33333333-1111-2222-3333-444444444444';

const ENABLED = process.env.BUDGET_API_INTEGRATION_TEST === '1';

const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z');
const ACCESS_GRANTED_AT = '2026-01-01T00:00:00.000Z';
const ACCESS_GRANTED_AT_MS = Date.parse(ACCESS_GRANTED_AT);
const WINDOW_START_MS = Date.parse('2026-02-01T00:00:00.000Z');
const WINDOW_END_MS = Date.parse('2026-03-01T00:00:00.000Z');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function txn(index: number) {
  return {
    _id: `trans_${index}`,
    _account: 'acc_1',
    date: '2026-02-05T00:00:00.000Z',
    description: `BACKFILLED PURCHASE ${index}`,
    amount: -25,
    merchant: { name: 'Backfilled Merchant' }
  };
}

/**
 * Stubs the three provider endpoints the backfill uses. The request paths
 * are recorded so a refused window can be shown to have never reached the
 * transaction endpoint.
 */
function stubAkahuFetch() {
  const requestPaths: string[] = [];
  const pages = [
    {
      success: true,
      items: [txn(0), txn(1), txn(2)],
      cursor: { next: 'page-2' }
    },
    {
      success: true,
      items: [txn(3), txn(4)],
      cursor: { next: null }
    }
  ];
  let pageIndex = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    requestPaths.push(parsed.pathname);

    if (parsed.pathname === '/v1/me') {
      return jsonResponse(200, { access_granted_at: ACCESS_GRANTED_AT });
    }
    if (parsed.pathname === '/v1/accounts') {
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
    if (parsed.pathname === '/v1/transactions') {
      const page = pages[pageIndex];
      pageIndex += 1;
      if (!page) return jsonResponse(500, { success: false, message: 'no page queued' });
      return jsonResponse(200, page);
    }
    return jsonResponse(404, { success: false, message: 'unexpected endpoint' });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requestPaths };
}

const d = ENABLED ? describe : describe.skip;

d('Akahu bounded backfill — real Postgres (task a37b31c9, AC6)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "budget_api"."AkahuBackfillRun",
        "budget_api"."CategorizationFeedback",
        "budget_api"."BalanceAlertConfig",
        "budget_api"."NotificationEvent",
        "budget_api"."CardMonthlyBudget",
        "budget_api"."Transaction",
        "budget_api"."AccountBalanceSnapshot",
        "budget_api"."AkahuConnection",
        "budget_api"."LinkedCard",
        "budget_api"."Session",
        "budget_api"."User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.create({
      data: { id: USER_ID, email: `akahu-backfill-${crypto.randomBytes(4).toString('hex')}@budget-api.test` }
    });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.AKAHU_CLIENT_ID = 'app_token_test';
    delete process.env.AKAHU_PER_CALL_TIMEOUT_MS;

    await prisma.akahuBackfillRun.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.linkedCard.deleteMany({});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it('a dry run writes nothing', async () => {
    stubAkahuFetch();

    const result = await runAkahuBackfill({
      userId: USER_ID,
      accessToken: 'user_token',
      startMs: WINDOW_START_MS,
      endMs: WINDOW_END_MS,
      dryRun: true,
      nowMs: NOW_MS
    });

    expect(result.applied).toBe(false);
    expect(result.rowsSeen).toBe(5);
    expect(await prisma.transaction.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await prisma.akahuBackfillRun.count({ where: { userId: USER_ID } })).toBe(0);
  });

  it('a second apply creates no duplicates', async () => {
    stubAkahuFetch();

    const options = {
      userId: USER_ID,
      accessToken: 'user_token',
      startMs: WINDOW_START_MS,
      endMs: WINDOW_END_MS,
      dryRun: false,
      nowMs: NOW_MS
    };

    const first = await runAkahuBackfill(options);
    expect(first.rowsUpserted).toBe(5);
    expect(await prisma.transaction.count({ where: { userId: USER_ID } })).toBe(5);

    stubAkahuFetch();
    const second = await runAkahuBackfill(options);

    const total = await prisma.transaction.count({ where: { userId: USER_ID } });
    const distinct = await prisma.transaction.findMany({
      where: { userId: USER_ID },
      select: { providerTransactionId: true }
    });
    expect(total).toBe(5);
    expect(new Set(distinct.map((t) => t.providerTransactionId)).size).toBe(5);
    expect(second.rowsUpserted).toBe(5);
    expect(second.rowsUpdated).toBe(5);

    const runs = await prisma.akahuBackfillRun.findMany({ where: { userId: USER_ID } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].rowsUpserted).toBe(5);
  });

  it('leaves a provider transaction owned by another user untouched', async () => {
    // `providerTransactionId` is globally unique, not scoped per user, so
    // the same provider transaction can already exist under a different
    // budget-api user (an Akahu account linked twice, or a reconnect that
    // re-points the connection). The backfill must not rewrite that user's
    // record.
    const otherUserId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: otherUserId,
        email: `akahu-backfill-other-${crypto.randomBytes(4).toString('hex')}@budget-api.test`
      }
    });
    // The other user's card carries a different provider account id: a
    // `LinkedCard` is unique on (provider, providerCardId) globally, so the
    // same provider account cannot be linked to two users.
    const otherCard = await prisma.linkedCard.create({
      data: {
        userId: otherUserId,
        provider: 'akahu',
        providerCardId: 'acc_other_user',
        displayName: 'Other user card'
      }
    });
    await prisma.transaction.create({
      data: {
        userId: otherUserId,
        cardId: otherCard.id,
        provider: 'akahu',
        providerTransactionId: 'akahu:trans_0',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        merchant: 'Other User Merchant',
        description: 'OTHER USER PURCHASE',
        amountCents: 999,
        direction: 'debit'
      }
    });

    stubAkahuFetch();

    const result = await runAkahuBackfill({
      userId: USER_ID,
      accessToken: 'user_token',
      startMs: WINDOW_START_MS,
      endMs: WINDOW_END_MS,
      dryRun: false,
      nowMs: NOW_MS
    });

    // The other user's row is untouched — same owner, same amount, same
    // merchant, same description.
    const other = await prisma.transaction.findUnique({
      where: { providerTransactionId: 'akahu:trans_0' },
      select: { userId: true, amountCents: true, merchant: true, description: true }
    });
    expect(other).toEqual({
      userId: otherUserId,
      amountCents: 999,
      merchant: 'Other User Merchant',
      description: 'OTHER USER PURCHASE'
    });

    // The skip is reported rather than silently dropped, and the other four
    // transactions are still written for the requesting user.
    expect(result.rowsSkippedCrossTenant).toBe(1);
    expect(result.rowsUpserted).toBe(4);
    expect(await prisma.transaction.count({ where: { userId: USER_ID } })).toBe(4);
  });

  it('refuses a window outside the configured historical allowance', async () => {
    const { requestPaths } = stubAkahuFetch();

    await expect(
      runAkahuBackfill({
        userId: USER_ID,
        accessToken: 'user_token',
        startMs: ACCESS_GRANTED_AT_MS - 30 * 24 * 60 * 60 * 1000,
        endMs: NOW_MS,
        dryRun: false,
        nowMs: NOW_MS
      })
    ).rejects.toBeInstanceOf(AkahuBackfillWindowError);

    expect(requestPaths).not.toContain('/v1/transactions');
    expect(await prisma.transaction.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await prisma.akahuBackfillRun.count({ where: { userId: USER_ID } })).toBe(0);
  });
});
