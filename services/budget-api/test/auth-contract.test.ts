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
 * Auth contract test (code-garden 2026-W27, Milestone 0 row 0-D), post-1-A.
 *
 * After task ec42d3a1 (1-A requireSession middleware) lands, every budget-api
 * user-data route returns 401 without an Authorization: Bearer header. The
 * spec/doc behavior flipped from "documents the gap" to "expects 401".
 *
 * Cross-user ownership assertions (cards/alerts/transactions owned by another
 * user) live in the sibling ownership task f39a20a7 — this file stays focused
 * on the bare 401 contract.
 *
 * Audit reference: docs/repo-audits/2026-W27.md, Milestone 0 row 0-D
 * (carried forward from W26 0-C).
 */
describe('budget-api auth contract (W27 0-D) — path-parameter IDOR vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    // Default mocks so routes would proceed into the database layer IF they
    // reached it. They should never reach it without an Authorization header,
    // because requireSession rejects with 401 first.
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

  describe('IDOR via :cardId path parameter (cards.ts) — gated by requireSession', () => {
    it('POST /cards/:cardId/budget returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .post('/api/v1/cards/card_1/budget')
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(401);
    });

    it('GET /cards/:cardId/spend-summary returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/cards/card_1/spend-summary')
        .query({ month: '2026-04' });
      expect(res.status).toBe(401);
    });
  });

  describe('IDOR via :alertId path parameter (alerts.ts) — gated by requireSession', () => {
    it('DELETE /alerts/:alertId returns 401 without a Bearer token', async () => {
      const res = await request(createApp()).delete('/api/v1/alerts/alert_1');
      expect(res.status).toBe(401);
    });
  });

  describe('IDOR via :cardId path parameter on alert-config routes (alerts.ts) — gated by requireSession', () => {
    it('GET /cards/:cardId/alert-config returns 401 without a Bearer token', async () => {
      const res = await request(createApp()).get('/api/v1/cards/card_1/alert-config');
      expect(res.status).toBe(401);
    });

    it('POST /cards/:cardId/alert-config returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .post('/api/v1/cards/card_1/alert-config')
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(401);
    });

    it('DELETE /cards/:cardId/alert-config returns 401 without a Bearer token', async () => {
      const res = await request(createApp()).delete('/api/v1/cards/card_1/alert-config');
      expect(res.status).toBe(401);
    });
  });

  describe('IDOR via :transactionId path parameter (transactions.ts) — gated by requireSession', () => {
    it('PATCH /transactions/:transactionId/category returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .patch('/api/v1/transactions/txn_1/category')
        .send({ category: 'dining' });
      expect(res.status).toBe(401);
    });
  });

  describe('control: GET /me also enforces auth', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(createApp()).get('/api/v1/me');
      expect(res.status).toBe(401);
    });
  });
});

/**
 * Auth contract test (code-garden 2026-W27 follow-up to PR #144), post-1-A.
 *
 * After task ec42d3a1 (1-A requireSession middleware) lands, every user-data
 * route — regardless of how it sourced its userId before (body, query, or
 * path param) — returns 401 without a Bearer token. The spec/doc behavior
 * flipped from "documents the gap" to "expects 401".
 *
 * Audit reference: docs/repo-audits/2026-W27.md, Critical finding under
 * "Architecture & Design" (carried forward from W26). The audit lists the
 * affected routes as /akahu/sync, /akahu/exchange, /akahu/authorize-url,
 * /cards/balance-history, /transactions, /alerts/evaluate, /alerts,
 * /categories/timeseries, /categorize/predict.
 */
describe('budget-api auth contract (W27 0-D follow-up) — userId-from-body/query vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    // Default mocks so routes would proceed into the database layer IF they
    // reached it. They should never reach it without an Authorization header.
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

  describe('IDOR via userId query parameter — gated by requireSession', () => {
    it('GET /transactions returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/transactions')
        .query({ userId: 'user_1' });
      expect(res.status).toBe(401);
    });

    it('GET /alerts returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/alerts')
        .query({ userId: 'user_1' });
      expect(res.status).toBe(401);
    });

    it('GET /cards/balance-history returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/cards/balance-history')
        .query({ userId: 'user_1', from: '2026-04-01', to: '2026-05-01' });
      expect(res.status).toBe(401);
    });

    it('GET /categories/timeseries returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .get('/api/v1/categories/timeseries')
        .query({ userId: 'user_1', from: '2026-04-01', to: '2026-05-01' });
      expect(res.status).toBe(401);
    });
  });

  describe('IDOR via userId body parameter — gated by requireSession', () => {
    it('POST /alerts/evaluate returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .post('/api/v1/alerts/evaluate')
        .send({ userId: 'user_1', month: '2026-04' });
      expect(res.status).toBe(401);
    });

    it('POST /categorize/predict returns 401 without a Bearer token', async () => {
      const res = await request(createApp())
        .post('/api/v1/categorize/predict')
        .send({ userId: 'user_1', merchant: 'Acme', amountCents: 1500 });
      expect(res.status).toBe(401);
    });
  });

  describe('control: GET /me also enforces auth', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(createApp()).get('/api/v1/me');
      expect(res.status).toBe(401);
    });
  });
});