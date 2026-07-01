import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    linkedCard: { findUnique: vi.fn(), findMany: vi.fn() },
    cardMonthlyBudget: { findUnique: vi.fn(), upsert: vi.fn() },
    accountBalanceSnapshot: { findMany: vi.fn() },
    transaction: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    notificationEvent: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    balanceAlertConfig: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    akahuConnection: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    categorizationFeedback: { create: vi.fn() }
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

/**
 * Auth contract test (code-garden 2026-W27, Milestone 0 row 0-D).
 *
 * Today every budget-api route EXCEPT /me either reads userId from the request
 * body/query or resolves the record from a path parameter (:cardId, :alertId,
 * :transactionId) — without ever validating a Bearer token. /me is the only
 * route that requires an Authorization header.
 *
 * This spec exercises each IDOR-via-path-parameter route without an
 * Authorization header and asserts the *current* (broken) behavior — the route
 * proceeds to the database instead of returning 401. When Theme 1 (1-A
 * requireSession middleware + ownership lookups on path-parameter routes)
 * lands, every assertion below should flip to expect 401.
 *
 * Audit reference: docs/repo-audits/2026-W27.md, Milestone 0 row 0-D
 * (carried forward from W26 0-C). Precedent: PR #102 documented pagination
 * cursor/sort semantics against the current buggy behavior; the pagination
 * fix flipped that spec to enforce the rule.
 *
 * NOTE — Scope: this spec covers the seven IDOR-via-path-parameter routes that
 * the W27 audit calls out as new vectors in cards.ts and alerts.ts, plus the
 * PATCH /transactions/:transactionId/category route. A follow-up PR can extend
 * the same pattern to the userId-from-body/query routes (/akahu/sync,
 * /akahu/exchange, /akahu/authorize-url, /cards/balance-history, /transactions,
 * /alerts/evaluate, /alerts, /categories/timeseries, /categorize/predict).
 */
describe('budget-api auth contract (W27 0-D) — path-parameter IDOR vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    // Default mocks so routes proceed into the database layer instead of
    // returning early on a not-found. The point of this spec is to observe
    // that they proceed at all without a Bearer token.
    mocks.prisma.linkedCard.findUnique.mockResolvedValue({
      id: 'card_1',
      userId: 'user_1',
      displayName: 'Everyday account',
      provider: 'akahu',
      providerCardId: 'acc_1'
    });
    mocks.prisma.cardMonthlyBudget.findUnique.mockResolvedValue(null);
    mocks.prisma.cardMonthlyBudget.upsert.mockResolvedValue({
      id: 'budget_1',
      cardId: 'card_1',
      userId: 'user_1',
      month: '2026-04',
      monthlyLimitCents: 50_000
    });
    mocks.prisma.transaction.findMany.mockResolvedValue([]);
    mocks.prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn_1',
      userId: 'user_1',
      merchant: 'Acme',
      description: 'Acme purchase',
      category: 'shopping',
      categorySource: 'model',
      categoryConfidence: 0.8
    });
    mocks.prisma.transaction.update.mockResolvedValue({
      id: 'txn_1',
      userId: 'user_1',
      merchant: 'Acme',
      description: 'Acme purchase',
      category: 'dining'
    });
    mocks.prisma.notificationEvent.findUnique.mockResolvedValue({
      id: 'alert_1',
      userId: 'user_1',
      type: 'warning80',
      title: '80% of monthly budget',
      body: 'You are close to your limit',
      createdAt: new Date('2026-04-15T00:00:00.000Z')
    });
    mocks.prisma.balanceAlertConfig.findUnique.mockResolvedValue(null);
    mocks.prisma.balanceAlertConfig.upsert.mockResolvedValue({
      id: 'config_1',
      cardId: 'card_1',
      userId: 'user_1',
      condition: 'more-than',
      thresholdCents: 10_000,
      pushEnabled: true,
      emailEnabled: false
    });
    mocks.prisma.categorizationFeedback.create.mockResolvedValue({});
  });

  describe('IDOR via :cardId path parameter (cards.ts)', () => {
    it('POST /cards/:cardId/budget upserts a budget without a Bearer token', async () => {
      // Current behavior: route resolves the card from path id and upserts the
      // budget (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .post('/api/v1/cards/card_1/budget')
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(200);
    });

    it('GET /cards/:cardId/spend-summary reads spend without a Bearer token', async () => {
      // Current behavior: route reads transactions by path cardId (200).
      // After 1-A lands this should return 401.
      const res = await request(createApp())
        .get('/api/v1/cards/card_1/spend-summary')
        .query({ month: '2026-04' });
      expect(res.status).toBe(200);
    });
  });

  describe('IDOR via :alertId path parameter (alerts.ts)', () => {
    it('DELETE /alerts/:alertId deletes an alert without a Bearer token', async () => {
      // Current behavior: route looks up the alert by path id and deletes it
      // (200). After 1-A lands this should return 401.
      const res = await request(createApp()).delete('/api/v1/alerts/alert_1');
      expect(res.status).toBe(200);
    });
  });

  describe('IDOR via :cardId path parameter on alert-config routes (alerts.ts)', () => {
    it('GET /cards/:cardId/alert-config reads the config without a Bearer token', async () => {
      // Current behavior: route reads balanceAlertConfig by path cardId (200).
      // After 1-A lands this should return 401.
      const res = await request(createApp()).get('/api/v1/cards/card_1/alert-config');
      expect(res.status).toBe(200);
    });

    it('POST /cards/:cardId/alert-config upserts the config without a Bearer token', async () => {
      // Current behavior: route looks up the card from path id and upserts
      // the alert config (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .post('/api/v1/cards/card_1/alert-config')
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(200);
    });

    it('DELETE /cards/:cardId/alert-config deletes the config without a Bearer token', async () => {
      mocks.prisma.balanceAlertConfig.findUnique.mockResolvedValueOnce({
        id: 'config_1',
        cardId: 'card_1',
        userId: 'user_1',
        condition: 'more-than',
        thresholdCents: 10_000,
        pushEnabled: true,
        emailEnabled: false
      });
      // Current behavior: route looks up the config by path cardId and deletes
      // it (200). After 1-A lands this should return 401.
      const res = await request(createApp()).delete('/api/v1/cards/card_1/alert-config');
      expect(res.status).toBe(200);
    });
  });

  describe('IDOR via :transactionId path parameter (transactions.ts)', () => {
    it('PATCH /transactions/:transactionId/category mutates the transaction without a Bearer token', async () => {
      // Current behavior: route looks up the txn by path id and updates its
      // category (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .patch('/api/v1/transactions/txn_1/category')
        .send({ category: 'dining' });
      expect(res.status).toBe(200);
    });
  });

  describe('control: GET /me already enforces auth (the model to mirror)', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(createApp()).get('/api/v1/me');
      expect(res.status).toBe(401);
    });
  });
});

/**
 * Auth contract test (code-garden 2026-W27, follow-up to PR #144).
 *
 * PR #144 documented the IDOR-via-path-parameter routes (cards.ts, alerts.ts,
 * transactions.ts). This companion spec covers the userId-from-body/query
 * routes that the W27 audit calls out as the original vector class — routes
 * that take a userId from the request body or query and operate on that user
 * without verifying a Bearer token. When Theme 1 (1-A requireSession
 * middleware) lands, every assertion below should flip to expect 401.
 *
 * Audit reference: docs/repo-audits/2026-W27.md, Critical finding under
 * "Architecture & Design" (carried forward from W26). The audit lists the
 * affected routes as /akahu/sync, /akahu/exchange, /akahu/authorize-url,
 * /cards/balance-history, /transactions, /alerts/evaluate, /alerts,
 * /categories/timeseries, /categorize/predict.
 *
 * NOTE — Scope: this spec covers the six non-Akahu routes that share a small
 * mock footprint (linkedCard.findMany, transaction.findMany,
 * notificationEvent.findMany, accountBalanceSnapshot.findMany, evaluateAlerts
 * ForUser, categorizeTransaction). The three Akahu routes (/akahu/sync,
 * /akahu/exchange, /akahu/authorize-url) need additional akahuClient mocks
 * and env-var setup; they are tracked as a separate follow-up.
 */
describe('budget-api auth contract (W27 0-D follow-up) — userId-from-body/query vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    // Default mocks so routes proceed past the userId validation and into the
    // database layer without returning early. The point of this spec is to
    // observe that the routes proceed at all without a Bearer token.
    mocks.prisma.user.findUnique.mockResolvedValue({ id: 'user_1' });
    mocks.prisma.linkedCard.findMany.mockResolvedValue([]);
    mocks.prisma.accountBalanceSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.transaction.findMany.mockResolvedValue([]);
    mocks.prisma.notificationEvent.findMany.mockResolvedValue([]);
    mocks.evaluateAlertsForUser.mockResolvedValue({
      createdEventIds: [],
      evaluatedCards: 0
    });
    mocks.categorizeTransaction.mockResolvedValue({
      category: 'dining',
      confidence: 0.7,
      source: 'rule'
    });
  });

  describe('IDOR via userId query parameter', () => {
    it('GET /transactions returns 200 without a Bearer token', async () => {
      // Current behavior: route reads userId from query and lists txns (200).
      // After 1-A lands this should return 401.
      const res = await request(createApp())
        .get('/api/v1/transactions')
        .query({ userId: 'user_1' });
      expect(res.status).toBe(200);
    });

    it('GET /alerts returns 200 without a Bearer token', async () => {
      // Current behavior: route reads userId from query and lists alerts (200).
      // After 1-A lands this should return 401.
      const res = await request(createApp())
        .get('/api/v1/alerts')
        .query({ userId: 'user_1' });
      expect(res.status).toBe(200);
    });

    it('GET /cards/balance-history returns 200 without a Bearer token', async () => {
      mocks.prisma.linkedCard.findMany.mockResolvedValueOnce([
        {
          id: 'card_1',
          displayName: 'Everyday account',
          provider: 'akahu',
          providerCardId: 'acc_1',
          createdAt: new Date('2026-04-01T00:00:00.000Z')
        }
      ]);
      mocks.prisma.accountBalanceSnapshot.findMany.mockResolvedValueOnce([]);
      // Current behavior: route reads userId from query and reads snapshots
      // (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .get('/api/v1/cards/balance-history')
        .query({ userId: 'user_1', from: '2026-04-01', to: '2026-05-01' });
      expect(res.status).toBe(200);
    });

    it('GET /categories/timeseries returns 200 without a Bearer token', async () => {
      // Current behavior: route reads userId from query and groups txns into
      // a timeseries (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .get('/api/v1/categories/timeseries')
        .query({ userId: 'user_1', from: '2026-04-01', to: '2026-05-01' });
      expect(res.status).toBe(200);
    });
  });

  describe('IDOR via userId body parameter', () => {
    it('POST /alerts/evaluate returns 200 without a Bearer token', async () => {
      // Current behavior: route reads userId from body and evaluates alerts
      // (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .post('/api/v1/alerts/evaluate')
        .send({ userId: 'user_1', month: '2026-04' });
      expect(res.status).toBe(200);
    });

    it('POST /categorize/predict returns 200 without a Bearer token', async () => {
      // Current behavior: route reads userId from body and runs the
      // categorizer (200). After 1-A lands this should return 401.
      const res = await request(createApp())
        .post('/api/v1/categorize/predict')
        .send({ userId: 'user_1', merchant: 'Acme', amountCents: 1500 });
      expect(res.status).toBe(200);
    });
  });

  describe('control: GET /me already enforces auth (the model to mirror)', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(createApp()).get('/api/v1/me');
      expect(res.status).toBe(401);
    });
  });
});